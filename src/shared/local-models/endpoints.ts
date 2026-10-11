/**
 * Local Models endpoints: model servers the USER runs, which Maestro talks to.
 *
 * The other kind of model source is a download (see `model-catalog.ts`): bytes
 * Maestro fetches, verifies, and loads itself. An endpoint is the opposite. It is
 * an already-running server (Ollama, LM Studio, or any OpenAI-compatible base URL
 * such as a LiteLLM or vLLM host) that serves text generation and embeddings with
 * nothing to download. Many users already run one, which makes it the cheapest
 * route to a working local model.
 *
 * The configured list is persisted under the `localModelEndpoints` setting.
 * Everything here is pure so the renderer, the main process, and the CLI all
 * validate an endpoint by the same rules.
 */

import { isBlankEnvValue, isValidEnvVarName } from '../agentEnvironment';

/**
 * Which wire dialect the server speaks. All three serve `/v1/chat/completions`;
 * they differ in how models are listed (`/api/tags` for Ollama, `/v1/models` for
 * the others) and in the extras a client may fall back to.
 */
export type LocalModelEndpointKind = 'ollama' | 'lmstudio' | 'openai-compatible';

export const LOCAL_MODEL_ENDPOINT_KINDS: readonly LocalModelEndpointKind[] = [
	'ollama',
	'lmstudio',
	'openai-compatible',
];

/** Where each local server listens out of the box. `openai-compatible` has no default. */
export const DEFAULT_ENDPOINT_BASE_URLS: Readonly<Partial<Record<LocalModelEndpointKind, string>>> =
	{
		ollama: 'http://127.0.0.1:11434',
		lmstudio: 'http://127.0.0.1:1234',
	};

export interface LocalModelEndpoint {
	/** Stable id, assigned when the endpoint is added. Never derived from the URL. */
	id: string;
	/** What the user calls it ("Ollama on the workstation"). */
	name: string;
	kind: LocalModelEndpointKind;
	/** Scheme, host, optional port and path prefix. Stored without a trailing slash. */
	baseUrl: string;
	/**
	 * The NAME of an environment variable holding the API key, never the key.
	 *
	 * Settings are a plain JSON file that ends up in debug packages, backups, and
	 * `maestro-cli settings list`, so a secret written into an endpoint record
	 * would leak through every one of them. Instead the key lives where the user
	 * already keeps secrets, the global Settings -> Environment layer
	 * (`shellEnvVars`), and is looked up by name at call time with
	 * {@link resolveEndpointApiKey}. Rotating a key is then one edit in one place,
	 * and a key the user removes stops being sent on the next request.
	 */
	apiKeyEnvVar?: string;
	/** A disabled endpoint stays configured but is never called. */
	enabled: boolean;
}

export type LocalModelEndpointField =
	| 'id'
	| 'name'
	| 'kind'
	| 'baseUrl'
	| 'apiKeyEnvVar'
	| 'enabled';

export interface LocalModelEndpointIssue {
	field: LocalModelEndpointField;
	message: string;
}

export type LocalModelEndpointValidation =
	| { ok: true; endpoint: LocalModelEndpoint }
	| { ok: false; issues: LocalModelEndpointIssue[] };

export function isLocalModelEndpointKind(value: unknown): value is LocalModelEndpointKind {
	return (
		typeof value === 'string' && (LOCAL_MODEL_ENDPOINT_KINDS as readonly string[]).includes(value)
	);
}

/**
 * Why a base URL is unusable, or `null` when it is fine.
 *
 * Only http and https are accepted: anything else is not a model server. A URL
 * carrying `user:password@` is refused outright rather than stripped, because the
 * credentials would be persisted to settings in the clear, which is the exact
 * leak `apiKeyEnvVar` exists to prevent. Query strings and fragments are refused
 * too: the client appends paths like `/v1/models` to the base, and a `?` or `#`
 * in the middle would swallow them.
 */
export function endpointBaseUrlProblem(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === '') return 'Base URL is required.';
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return `"${trimmed}" is not a valid URL.`;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return `Only http and https URLs are supported (got "${url.protocol.replace(/:$/, '')}").`;
	}
	if (url.hostname === '') return 'Base URL has no host.';
	if (url.username !== '' || url.password !== '') {
		return 'Do not put credentials in the URL. Name an environment variable for the API key instead.';
	}
	if (url.search !== '' || url.hash !== '') {
		return 'Base URL must not contain a query string or fragment.';
	}
	return null;
}

/**
 * Canonical spelling of a valid base URL: trimmed, no trailing slash, so
 * `${baseUrl}/v1/models` never produces a double slash. Call only after
 * {@link endpointBaseUrlProblem} returned `null`.
 */
export function normalizeEndpointBaseUrl(raw: string): string {
	const url = new URL(raw.trim());
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.protocol}//${url.host}${path}`;
}

/**
 * Validate one endpoint record, returning a normalized copy when it is valid.
 * Every problem is reported at once so a form can mark all bad fields together.
 */
export function validateLocalModelEndpoint(value: unknown): LocalModelEndpointValidation {
	const issues: LocalModelEndpointIssue[] = [];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, issues: [{ field: 'id', message: 'Endpoint must be an object.' }] };
	}
	const record = value as Record<string, unknown>;

	const id = typeof record.id === 'string' ? record.id.trim() : '';
	if (id === '') issues.push({ field: 'id', message: 'Endpoint id is required.' });

	const name = typeof record.name === 'string' ? record.name.trim() : '';
	if (name === '') issues.push({ field: 'name', message: 'Endpoint name is required.' });

	if (!isLocalModelEndpointKind(record.kind)) {
		issues.push({
			field: 'kind',
			message: `Kind must be one of: ${LOCAL_MODEL_ENDPOINT_KINDS.join(', ')}.`,
		});
	}

	const rawUrl = typeof record.baseUrl === 'string' ? record.baseUrl : '';
	const urlProblem = endpointBaseUrlProblem(rawUrl);
	if (urlProblem) issues.push({ field: 'baseUrl', message: urlProblem });

	let apiKeyEnvVar: string | undefined;
	if (record.apiKeyEnvVar !== undefined && record.apiKeyEnvVar !== null) {
		const envName = typeof record.apiKeyEnvVar === 'string' ? record.apiKeyEnvVar.trim() : '';
		if (envName === '') {
			apiKeyEnvVar = undefined;
		} else if (!isValidEnvVarName(envName)) {
			issues.push({
				field: 'apiKeyEnvVar',
				message: `"${envName}" is not a valid environment variable name.`,
			});
		} else {
			apiKeyEnvVar = envName;
		}
	}

	if (typeof record.enabled !== 'boolean') {
		issues.push({ field: 'enabled', message: 'Enabled must be true or false.' });
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		endpoint: {
			id,
			name,
			kind: record.kind as LocalModelEndpointKind,
			baseUrl: normalizeEndpointBaseUrl(rawUrl),
			...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
			enabled: record.enabled as boolean,
		},
	};
}

/**
 * Read the persisted `localModelEndpoints` setting. Anything that is not a list
 * reads as empty, invalid records are dropped, and a repeated id keeps its first
 * record, so a hand-edited settings file cannot hand a caller an endpoint it
 * would refuse to save.
 */
export function parseLocalModelEndpoints(value: unknown): LocalModelEndpoint[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const endpoints: LocalModelEndpoint[] = [];
	for (const entry of value) {
		const result = validateLocalModelEndpoint(entry);
		if (!result.ok || seen.has(result.endpoint.id)) continue;
		seen.add(result.endpoint.id);
		endpoints.push(result.endpoint);
	}
	return endpoints;
}

/**
 * The API key for an endpoint, read at call time from Settings -> Environment.
 * `undefined` when the endpoint names no variable, or the variable is missing or
 * blank (a blank value means "unset" everywhere in Maestro; see
 * `isBlankEnvValue`). The caller decides whether a missing key is an error: a
 * local Ollama needs none.
 */
export function resolveEndpointApiKey(
	endpoint: Pick<LocalModelEndpoint, 'apiKeyEnvVar'>,
	shellEnvVars: Record<string, string> | undefined
): string | undefined {
	if (!endpoint.apiKeyEnvVar) return undefined;
	const value = shellEnvVars?.[endpoint.apiKeyEnvVar];
	if (value === undefined || isBlankEnvValue(value)) return undefined;
	return value.trim();
}
