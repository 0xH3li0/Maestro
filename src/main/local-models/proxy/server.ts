/**
 * The Maestro token proxy's HTTP server: an exact passthrough.
 *
 * A request arrives on loopback, its first path segment names the upstream
 * (`resolveTokenProxyTarget`), and it is forwarded there with its headers and
 * body bytes unchanged. The response comes back the same way, streamed chunk
 * by chunk. This module changes NOTHING in either direction; it only counts
 * the bytes it carried.
 *
 * Built on Node's `http` / `https` rather than `fetch` (and so not on
 * `fetchWithTimeout`) on purpose. `fetch` decodes a compressed response and
 * re-frames the body, which is a different response; it also wants a total
 * timeout, and a model stream runs for minutes. Raw `http` hands over the
 * bytes as they came and leaves the timeout to the two ends that own it: the
 * provider CLI and the provider.
 *
 * What "unchanged" means precisely:
 *
 * - Headers are forwarded from `rawHeaders`, so casing, order and duplicates
 *   survive. Only hop-by-hop headers (RFC 9110 section 7.6.1, plus anything the
 *   `Connection` header lists) are dropped, and `Host` is rewritten to the
 *   upstream's, which TLS virtual hosting requires. `Authorization`,
 *   `x-api-key` and every other credential pass through; the proxy adds none of
 *   its own, so it gives a local caller nothing it could not get by calling the
 *   upstream directly.
 * - Bodies are never decoded. A request with `content-encoding: zstd` (Codex
 *   has sent one) is forwarded as the bytes it is, and so is a compressed
 *   response.
 * - An upstream error (a 429, a 529, an auth failure) is a response like any
 *   other and is forwarded whole. Only a failure of the proxy itself (no such
 *   route, upstream unreachable) is answered by the proxy, and that body names
 *   the proxy (`tokenProxyErrorBody`).
 * - A stream the upstream drops mid-response is dropped to the client too. The
 *   proxy never ends a truncated response cleanly.
 */

import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import {
	defaultTokenProxyUpstreams,
	resolveTokenProxyTarget,
	TOKEN_PROXY_HOST,
	TOKEN_PROXY_NAME,
	tokenProxyErrorBody,
	type TokenProxyErrorCode,
	type TokenProxyRequestKind,
	type TokenProxyUpstreams,
} from '../../../shared/local-models/token-proxy';

/** How one request ended. */
export type TokenProxyRequestOutcome =
	/** The upstream's response (whatever its status) reached the client whole. */
	| 'completed'
	/** The client went away before the response finished. */
	| 'client-aborted'
	/** The upstream could not be reached, or dropped mid-response. */
	| 'upstream-failed'
	/** The request named no route; nothing was forwarded. */
	| 'unknown-route';

/** What the proxy carried for one request. Never a header or a body. */
export interface TokenProxyRequestLog {
	/** The route prefix, or null when the request named none. */
	route: string | null;
	kind: TokenProxyRequestKind;
	method: string;
	/** The forwarded path, without the route prefix or the query string. */
	path: string;
	/** The status sent to the client, or 0 when none was. */
	status: number;
	/** Request body bytes received from the client and sent upstream. */
	requestBytes: number;
	/** Response body bytes received from the upstream and sent to the client. */
	responseBytes: number;
	durationMs: number;
	outcome: TokenProxyRequestOutcome;
	/** The failure, when the proxy itself failed. */
	error?: string;
}

export interface TokenProxyServerOptions {
	/** Route prefix -> upstream base URL. Defaults to the real providers. */
	upstreams?: TokenProxyUpstreams;
	/** Called once per request, when it has ended. */
	onRequest?: (entry: TokenProxyRequestLog) => void;
}

export interface TokenProxyServer {
	/** Bind loopback on `port` (0 picks a free one). Resolves the bound port. */
	listen(port: number): Promise<number>;
	/** The bound port, or null while not listening. */
	port(): number | null;
	/**
	 * Stop accepting connections and release the port at once. Requests in
	 * flight finish unless `force` is set, which cuts them. Resolves when the
	 * last connection has ended.
	 */
	close(options?: { force?: boolean }): Promise<void>;
}

/** Headers that describe one connection, not the message (RFC 9110 7.6.1). */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

/**
 * The headers of a message that belong to the next hop, in `rawHeaders` form
 * (`[name, value, name, value, ...]`). Everything is kept as it arrived except
 * hop-by-hop headers, headers the `Connection` header names, and `alsoDrop`.
 */
export function forwardableHeaders(
	rawHeaders: readonly string[],
	alsoDrop: readonly string[] = []
): string[] {
	const drop = new Set<string>(HOP_BY_HOP_HEADERS);
	for (const name of alsoDrop) drop.add(name.toLowerCase());
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (rawHeaders[i].toLowerCase() !== 'connection') continue;
		for (const token of rawHeaders[i + 1].split(',')) {
			const name = token.trim().toLowerCase();
			if (name !== '') drop.add(name);
		}
	}
	const kept: string[] = [];
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (!drop.has(rawHeaders[i].toLowerCase())) kept.push(rawHeaders[i], rawHeaders[i + 1]);
	}
	return kept;
}

function errorText(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code && !message.includes(code) ? `${code}: ${message}` : message;
}

export function createTokenProxyServer(options: TokenProxyServerOptions = {}): TokenProxyServer {
	const upstreams = options.upstreams ?? defaultTokenProxyUpstreams();
	// Keep-alive to the upstream, so a turn's requests do not each pay a TLS
	// handshake. Owned here (not the global agent) so closing the proxy closes
	// exactly its own upstream sockets.
	const httpAgent = new http.Agent({ keepAlive: true });
	const httpsAgent = new https.Agent({ keepAlive: true });

	const server = http.createServer((req, res) => handleRequest(req, res));
	// Both agents die with the server: only after the last connection ended, so
	// a graceful close does not cut the upstream half of a request in flight.
	server.on('close', () => {
		httpAgent.destroy();
		httpsAgent.destroy();
	});

	function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const startedAt = Date.now();
		const method = req.method ?? 'GET';
		const target = resolveTokenProxyTarget(method, req.url ?? '/', upstreams);
		const entry: TokenProxyRequestLog = {
			route: target.ok ? target.route : null,
			kind: target.ok ? target.kind : 'other',
			method,
			path: target.ok ? target.path : (req.url ?? '/').split('?')[0],
			status: 0,
			requestBytes: 0,
			responseBytes: 0,
			durationMs: 0,
			outcome: 'completed',
		};
		let failure: { outcome: TokenProxyRequestOutcome; error: string } | null = null;
		let closed = false;
		let upstreamRequest: http.ClientRequest | null = null;

		// 'close' is the one event every ending reaches: a finished response, a
		// client that went away, and a response this module destroyed.
		res.once('close', () => {
			closed = true;
			entry.durationMs = Date.now() - startedAt;
			if (failure) {
				entry.outcome = failure.outcome;
				entry.error = failure.error;
			} else if (!res.writableFinished) {
				entry.outcome = 'client-aborted';
				// The client leaving ends the upstream request too, so an
				// abandoned turn stops generating (and billing) at the provider.
				upstreamRequest?.destroy();
			}
			options.onRequest?.(entry);
		});

		/** Answer as the proxy. Only possible while nothing has been sent. */
		const answerAsProxy = (
			status: number,
			code: TokenProxyErrorCode,
			outcome: TokenProxyRequestOutcome,
			message: string
		): void => {
			// Nobody is left to answer, and the request is already accounted for.
			if (failure || closed) return;
			failure = { outcome, error: message };
			if (res.headersSent) {
				// The upstream's status line is already with the client. Cutting
				// the connection is the only honest signal left.
				res.destroy();
				return;
			}
			const body = Buffer.from(tokenProxyErrorBody(code, message), 'utf-8');
			entry.status = status;
			entry.responseBytes = body.length;
			res.writeHead(status, {
				'content-type': 'application/json',
				'content-length': body.length,
			});
			res.end(body);
		};

		if (!target.ok) {
			// Drain what the client is still sending so the 404 is delivered.
			req.resume();
			answerAsProxy(404, 'unknown-route', 'unknown-route', target.error);
			return;
		}

		let upstream: URL;
		try {
			upstream = new URL(target.upstream);
		} catch {
			req.resume();
			answerAsProxy(
				502,
				'upstream-unreachable',
				'upstream-failed',
				`${TOKEN_PROXY_NAME} has no usable upstream address for route "/${target.route}".`
			);
			return;
		}
		const secure = upstream.protocol === 'https:';
		const outgoing = (secure ? https : http).request({
			protocol: upstream.protocol,
			hostname: upstream.hostname.replace(/^\[|\]$/g, ''),
			port: upstream.port || undefined,
			method,
			// The client's path and query are appended as the text they arrived
			// as. Only the upstream base (a constant) goes through `URL`.
			path: `${upstream.pathname.replace(/\/+$/, '')}${target.path}${target.query}` || '/',
			headers: [...forwardableHeaders(req.rawHeaders, ['host']), 'Host', upstream.host],
			agent: secure ? httpsAgent : httpAgent,
		});
		upstreamRequest = outgoing;

		const upstreamFailed = (error: unknown): void => {
			answerAsProxy(
				502,
				'upstream-unreachable',
				'upstream-failed',
				`${TOKEN_PROXY_NAME} could not complete the request to ${upstream.origin} (${errorText(error)}). The request was not sent anywhere else.`
			);
		};

		outgoing.on('error', upstreamFailed);
		outgoing.on('response', (upstreamResponse) => {
			entry.status = upstreamResponse.statusCode ?? 0;
			try {
				res.writeHead(
					upstreamResponse.statusCode ?? 502,
					upstreamResponse.statusMessage || undefined,
					forwardableHeaders(upstreamResponse.rawHeaders)
				);
			} catch (error) {
				upstreamResponse.destroy();
				upstreamFailed(error);
				return;
			}
			// Send the status line now and every chunk as it lands: a server-sent
			// event must not wait for the next one to fill a packet.
			res.flushHeaders();
			res.socket?.setNoDelay(true);
			upstreamResponse.on('data', (chunk: Buffer) => {
				entry.responseBytes += chunk.length;
			});
			upstreamResponse.on('error', upstreamFailed);
			upstreamResponse.on('close', () => {
				if (!upstreamResponse.complete)
					upstreamFailed(new Error('the upstream closed mid-response'));
			});
			upstreamResponse.pipe(res);
		});

		req.on('data', (chunk: Buffer) => {
			entry.requestBytes += chunk.length;
		});
		// A client that drops mid-upload is handled by the response's 'close'
		// above; this only keeps the stream error from going unhandled.
		req.on('error', () => {});
		req.pipe(outgoing);
	}

	return {
		listen(port: number): Promise<number> {
			return new Promise<number>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				server.once('error', onError);
				server.listen(port, TOKEN_PROXY_HOST, () => {
					server.off('error', onError);
					resolve((server.address() as AddressInfo).port);
				});
			});
		},
		port(): number | null {
			const address = server.address();
			return address && typeof address === 'object' ? address.port : null;
		},
		close(closeOptions: { force?: boolean } = {}): Promise<void> {
			return new Promise<void>((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(() => resolve());
				if (closeOptions.force) server.closeAllConnections();
				else server.closeIdleConnections();
			});
		},
	};
}
