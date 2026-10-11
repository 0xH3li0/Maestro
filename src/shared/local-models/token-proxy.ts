/**
 * The Maestro token proxy: addressing and routing, as pure functions.
 *
 * The proxy is an HTTP server on this machine's loopback interface that an
 * agent reaches through its Local Models gateway (`gateway.ts`). The base URL
 * the agent is given encodes the upstream as its first path segment:
 *
 *   http://127.0.0.1:<port>/anthropic   ->  https://api.anthropic.com
 *   http://127.0.0.1:<port>/openai/v1   ->  https://api.openai.com/v1
 *   http://127.0.0.1:<port>/chatgpt     ->  https://chatgpt.com/backend-api/codex
 *
 * so one port serves every provider and a request never has to be inspected to
 * learn where it goes. The server (`src/main/local-models/proxy/`) owns sockets
 * and lifecycle; everything that is only arithmetic on a URL lives here, so the
 * server, the settings UI and the CLI cannot disagree about what a gateway URL
 * means.
 */

import { isLoopbackGatewayUrl } from './gateway';

/** The only interface the proxy listens on. Never a wildcard address. */
export const TOKEN_PROXY_HOST = '127.0.0.1';

/** The name every error and log line uses, so a failure names its source. */
export const TOKEN_PROXY_NAME = 'Maestro token proxy';

export type TokenProxyRouteId = 'anthropic' | 'openai' | 'chatgpt';

export interface TokenProxyRoute {
	/** The real upstream. A path here is prepended to the forwarded path. */
	upstream: string;
	/**
	 * What follows the port in the base URL an agent is given. Not always the
	 * bare route: `OPENAI_BASE_URL` conventionally ends in `/v1`.
	 */
	gatewayPath: string;
	/** Who this route is for, for a person. */
	label: string;
}

/**
 * Route prefix -> upstream. The proxy forwards to these hosts and no others: a
 * request cannot name its own destination, so the proxy cannot be used to reach
 * an arbitrary host.
 *
 * `chatgpt` is where Codex sends a ChatGPT login's traffic (it is not
 * api.openai.com, which rejects that token). It has not been confirmed against
 * a real run yet; `anthropic` and `openai` are the providers' documented API
 * hosts.
 */
export const TOKEN_PROXY_ROUTES: Record<TokenProxyRouteId, TokenProxyRoute> = {
	anthropic: {
		upstream: 'https://api.anthropic.com',
		gatewayPath: '/anthropic',
		label: 'Claude Code',
	},
	openai: {
		upstream: 'https://api.openai.com',
		gatewayPath: '/openai/v1',
		label: 'Codex with an OpenAI API key',
	},
	chatgpt: {
		upstream: 'https://chatgpt.com/backend-api/codex',
		gatewayPath: '/chatgpt',
		label: 'Codex with a ChatGPT login',
	},
};

/** Route prefix -> upstream base URL: the shape the server routes with. */
export type TokenProxyUpstreams = Record<string, string>;

/** The default upstream table, derived from {@link TOKEN_PROXY_ROUTES}. */
export function defaultTokenProxyUpstreams(): TokenProxyUpstreams {
	const upstreams: TokenProxyUpstreams = {};
	for (const [id, route] of Object.entries(TOKEN_PROXY_ROUTES)) upstreams[id] = route.upstream;
	return upstreams;
}

/**
 * The API a forwarded request speaks. Every path under a route is forwarded
 * (a provider CLI also calls token counting, model lists and the like); only
 * these three carry a message list a later phase may compress.
 */
export type TokenProxyRequestKind =
	| 'anthropic-messages'
	| 'openai-chat-completions'
	| 'openai-responses'
	| 'other';

/** Classify a forwarded path (the part after the route prefix, no query). */
export function classifyTokenProxyPath(method: string, path: string): TokenProxyRequestKind {
	if (method.toUpperCase() !== 'POST') return 'other';
	const trimmed = path.replace(/\/+$/, '');
	if (trimmed.endsWith('/v1/messages')) return 'anthropic-messages';
	if (trimmed.endsWith('/chat/completions')) return 'openai-chat-completions';
	if (trimmed.endsWith('/responses')) return 'openai-responses';
	return 'other';
}

export type TokenProxyTarget =
	| {
			ok: true;
			route: string;
			/** The route's upstream base URL, as the table has it. */
			upstream: string;
			/** The request path without the route prefix or the query. */
			path: string;
			/** The query string with its `?`, or empty. */
			query: string;
			kind: TokenProxyRequestKind;
	  }
	| { ok: false; error: string };

/**
 * Where a request goes. `requestUrl` is the request line's target
 * (`/anthropic/v1/messages?beta=true`). The path and query are carried over as
 * text, never re-encoded: a re-serialized URL is a different request. The
 * upstream receives the upstream base's own path, then `path`, then `query`.
 */
export function resolveTokenProxyTarget(
	method: string,
	requestUrl: string,
	upstreams: TokenProxyUpstreams = defaultTokenProxyUpstreams()
): TokenProxyTarget {
	const queryAt = requestUrl.indexOf('?');
	const rawPath = queryAt === -1 ? requestUrl : requestUrl.slice(0, queryAt);
	const query = queryAt === -1 ? '' : requestUrl.slice(queryAt);
	const match = /^\/([^/]+)(\/.*)?$/.exec(rawPath);
	const route = match?.[1] ?? '';
	const upstream = Object.prototype.hasOwnProperty.call(upstreams, route)
		? upstreams[route]
		: undefined;
	if (!match || upstream === undefined) {
		const known = Object.keys(upstreams)
			.map((id) => `/${id}`)
			.join(', ');
		return {
			ok: false,
			error: `${TOKEN_PROXY_NAME} has no upstream for "${rawPath || '/'}". A gateway URL that points at it ends in one of: ${known}.`,
		};
	}
	const path = match[2] ?? '';
	return {
		ok: true,
		route,
		upstream,
		path,
		query,
		kind: classifyTokenProxyPath(method, path),
	};
}

/** The base URL an agent is given to reach `route` through the proxy. */
export function tokenProxyGatewayUrl(port: number, route: TokenProxyRouteId): string {
	return `http://${TOKEN_PROXY_HOST}:${port}${TOKEN_PROXY_ROUTES[route].gatewayPath}`;
}

/**
 * Whether an agent's stored gateway URL reaches the Maestro proxy on `port`.
 * Any loopback spelling counts (`localhost` as well as 127.0.0.1): the question
 * is whether the proxy has to be up for this agent, and a wrong route on the
 * right port is answered by the proxy itself, by name, which beats a refused
 * connection.
 */
export function gatewayPointsAtTokenProxy(
	gatewayUrl: string | null | undefined,
	port: number
): boolean {
	const raw = gatewayUrl?.trim() ?? '';
	if (raw === '' || !isLoopbackGatewayUrl(raw)) return false;
	try {
		return new URL(raw).port === String(port);
	} catch {
		return false;
	}
}

export type TokenProxyErrorCode =
	/** The request named no route the proxy knows. */
	| 'unknown-route'
	/** The upstream could not be reached, or dropped before answering. */
	| 'upstream-unreachable';

/**
 * The body of an error the PROXY raises (an upstream's own error is forwarded
 * untouched and never takes this shape). One object that both provider SDKs
 * read: Anthropic takes `error.message` under a top-level `type: "error"`,
 * OpenAI takes `error.message`.
 */
export function tokenProxyErrorBody(code: TokenProxyErrorCode, message: string): string {
	return JSON.stringify({
		type: 'error',
		error: { type: 'maestro_token_proxy_error', code, message },
	});
}
