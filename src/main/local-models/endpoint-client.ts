/**
 * The client for user-run model servers: Ollama, LM Studio, and any
 * OpenAI-compatible base URL (LiteLLM, vLLM, ...).
 *
 * Three calls, one transport. Every request goes through `fetchWithTimeout`, so
 * a server that accepted the connection and then went quiet cannot hang an IPC
 * handler forever, and every failure comes back as a `LocalModelEndpointError`
 * that names the endpoint and, for an HTTP failure, the status.
 *
 * The dialects overlap more than they differ. All three serve
 * `/v1/chat/completions` and `/v1/embeddings`; only listing differs (Ollama's
 * `/api/tags` is the one route every Ollama version has, where `/v1/models` is
 * newer). Ollama's native routes are kept as FALLBACKS for the cases an older
 * Ollama cannot serve on `/v1`: a 404 (the compat layer predates the route) and,
 * for structured output, a 400 (the compat layer predates `json_schema`).
 *
 * Non-streaming only for now. Note that the timeout covers the response
 * headers; a non-streaming server sends those once generation is done, so for
 * chat the budget is effectively the whole generation.
 *
 * Whether an endpoint is `enabled` is the CALLER's question, not this module's:
 * a consumer picking a server skips disabled ones, while "Test" in Settings must
 * work on an endpoint before the user switches it on.
 */

import {
	resolveEndpointApiKey,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import { fetchWithTimeout, isFetchTimeoutError } from '../utils/fetchWithTimeout';
import { LocalModelEndpointError, type LocalModelEndpointErrorKind } from './errors';

/** Listing is a metadata read; a healthy local server answers in milliseconds. */
export const ENDPOINT_LIST_TIMEOUT_MS = 5_000;

/**
 * Generous on purpose: the first request after idle makes Ollama and LM Studio
 * load the model into memory, which alone can take tens of seconds.
 */
export const ENDPOINT_CHAT_TIMEOUT_MS = 120_000;

export const ENDPOINT_EMBED_TIMEOUT_MS = 60_000;

/** Longest server-supplied error detail quoted into a message. */
const MAX_ERROR_DETAIL_CHARS = 200;

/** Options every call accepts. */
export interface EndpointCallOptions {
	/**
	 * Settings -> Environment (`shellEnvVars`), where the endpoint's API key is
	 * looked up by name at call time. Never the key itself; see
	 * `LocalModelEndpoint.apiKeyEnvVar` for why.
	 */
	shellEnvVars?: Record<string, string>;
	/** Request budget. Each call has its own default. */
	timeoutMs?: number;
	/** Caller cancellation, composed with the timeout. */
	signal?: AbortSignal;
}

export interface EndpointModel {
	/** The id to pass back as `model` in a chat or embed request. */
	id: string;
	/** On-disk size, when the server reports it (Ollama does; `/v1/models` does not). */
	sizeBytes?: number;
}

export interface EndpointChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface EndpointChatRequest extends EndpointCallOptions {
	model: string;
	messages: EndpointChatMessage[];
	maxTokens?: number;
	temperature?: number;
	/**
	 * A JSON Schema the reply must satisfy. Sent as an OpenAI `json_schema`
	 * response format, or as Ollama's native `format` on the fallback route.
	 */
	jsonSchema?: Record<string, unknown>;
	/** Schema name for the OpenAI response format. Defaults to `response`. */
	jsonSchemaName?: string;
}

export interface EndpointChatResult {
	content: string;
	/** The model the server says answered, which can differ from the one asked for (aliases). */
	model: string;
	finishReason?: string;
	usage?: { promptTokens: number; completionTokens: number };
}

export interface EndpointEmbedRequest extends EndpointCallOptions {
	model: string;
	input: string[];
}

export interface EndpointEmbedResult {
	/** One vector per input, in input order. */
	embeddings: number[][];
	model: string;
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

/** The models the server can serve right now. */
export async function listEndpointModels(
	endpoint: LocalModelEndpoint,
	options: EndpointCallOptions = {}
): Promise<EndpointModel[]> {
	const call = { ...options, timeoutMs: options.timeoutMs ?? ENDPOINT_LIST_TIMEOUT_MS };

	if (endpoint.kind === 'ollama') {
		const body = await requestJson(endpoint, 'GET', '/api/tags', undefined, call);
		const models = (body as { models?: unknown }).models;
		if (!Array.isArray(models)) throw malformed(endpoint, '/api/tags', 'no "models" list');
		return models.map((entry) => {
			const record = entry as { name?: unknown; model?: unknown; size?: unknown };
			const id = typeof record.name === 'string' ? record.name : record.model;
			if (typeof id !== 'string' || id === '') {
				throw malformed(endpoint, '/api/tags', 'a model with no name');
			}
			return typeof record.size === 'number' ? { id, sizeBytes: record.size } : { id };
		});
	}

	const body = await requestJson(endpoint, 'GET', '/v1/models', undefined, call);
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) throw malformed(endpoint, '/v1/models', 'no "data" list');
	return data.map((entry) => {
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== 'string' || id === '') {
			throw malformed(endpoint, '/v1/models', 'a model with no id');
		}
		return { id };
	});
}

/** One non-streaming chat completion. */
export async function endpointChat(
	endpoint: LocalModelEndpoint,
	request: EndpointChatRequest
): Promise<EndpointChatResult> {
	const call = { ...request, timeoutMs: request.timeoutMs ?? ENDPOINT_CHAT_TIMEOUT_MS };
	const body = {
		model: request.model,
		messages: request.messages,
		stream: false,
		...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
		...(request.jsonSchema
			? {
					response_format: {
						type: 'json_schema',
						json_schema: {
							name: request.jsonSchemaName ?? 'response',
							schema: request.jsonSchema,
						},
					},
				}
			: {}),
	};

	let payload: unknown;
	try {
		payload = await requestJson(endpoint, 'POST', '/v1/chat/completions', body, call);
	} catch (error) {
		if (endpoint.kind !== 'ollama' || !shouldUseOllamaChatFallback(error, request)) throw error;
		return ollamaNativeChat(endpoint, request, call);
	}

	const choice = (payload as { choices?: unknown }).choices;
	const first = Array.isArray(choice) ? (choice[0] as Record<string, unknown> | undefined) : null;
	const content = (first?.message as { content?: unknown } | undefined)?.content;
	if (typeof content !== 'string') {
		throw malformed(endpoint, '/v1/chat/completions', 'no message content');
	}
	const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
		.usage;
	return {
		content,
		model: stringOr((payload as { model?: unknown }).model, request.model),
		...(typeof first?.finish_reason === 'string' ? { finishReason: first.finish_reason } : {}),
		...(usage &&
		typeof usage.prompt_tokens === 'number' &&
		typeof usage.completion_tokens === 'number'
			? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } }
			: {}),
	};
}

/** Embed every input, returning vectors in input order. */
export async function endpointEmbed(
	endpoint: LocalModelEndpoint,
	request: EndpointEmbedRequest
): Promise<EndpointEmbedResult> {
	const call = { ...request, timeoutMs: request.timeoutMs ?? ENDPOINT_EMBED_TIMEOUT_MS };
	const body = { model: request.model, input: request.input };

	let payload: unknown;
	try {
		payload = await requestJson(endpoint, 'POST', '/v1/embeddings', body, call);
	} catch (error) {
		if (endpoint.kind !== 'ollama' || !isEndpointStatus(error, 404)) throw error;
		const native = await requestJson(endpoint, 'POST', '/api/embed', body, call);
		const vectors = (native as { embeddings?: unknown }).embeddings;
		return {
			embeddings: requireVectors(endpoint, '/api/embed', vectors, request.input.length),
			model: stringOr((native as { model?: unknown }).model, request.model),
		};
	}

	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw malformed(endpoint, '/v1/embeddings', 'no "data" list');
	// The spec carries an `index` per vector and does not promise order, so sort
	// by it when every entry has one rather than trusting array position.
	const indexed = data.every((entry) => typeof (entry as { index?: unknown }).index === 'number');
	const ordered = indexed
		? [...data].sort((a, b) => (a as { index: number }).index - (b as { index: number }).index)
		: data;
	return {
		embeddings: requireVectors(
			endpoint,
			'/v1/embeddings',
			ordered.map((entry) => (entry as { embedding?: unknown }).embedding),
			request.input.length
		),
		model: stringOr((payload as { model?: unknown }).model, request.model),
	};
}

// ---------------------------------------------------------------------------
// Ollama native fallback
// ---------------------------------------------------------------------------

/**
 * A 404 means this Ollama predates `/v1/chat/completions`. A 400 on a request
 * carrying a schema means it predates `json_schema` in the compat layer; the
 * native route has taken a schema as `format` for longer. Any other failure is
 * the real answer and is rethrown.
 */
function shouldUseOllamaChatFallback(error: unknown, request: EndpointChatRequest): boolean {
	if (isEndpointStatus(error, 404)) return true;
	return request.jsonSchema !== undefined && isEndpointStatus(error, 400);
}

async function ollamaNativeChat(
	endpoint: LocalModelEndpoint,
	request: EndpointChatRequest,
	call: EndpointCallOptions
): Promise<EndpointChatResult> {
	const modelOptions = {
		...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
	};
	const payload = await requestJson(
		endpoint,
		'POST',
		'/api/chat',
		{
			model: request.model,
			messages: request.messages,
			stream: false,
			...(request.jsonSchema ? { format: request.jsonSchema } : {}),
			...(Object.keys(modelOptions).length > 0 ? { options: modelOptions } : {}),
		},
		call
	);
	const record = payload as {
		model?: unknown;
		message?: { content?: unknown };
		done_reason?: unknown;
		prompt_eval_count?: unknown;
		eval_count?: unknown;
	};
	const content = record.message?.content;
	if (typeof content !== 'string') throw malformed(endpoint, '/api/chat', 'no message content');
	return {
		content,
		model: stringOr(record.model, request.model),
		...(typeof record.done_reason === 'string' ? { finishReason: record.done_reason } : {}),
		...(typeof record.prompt_eval_count === 'number' && typeof record.eval_count === 'number'
			? { usage: { promptTokens: record.prompt_eval_count, completionTokens: record.eval_count } }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** "Ollama" (http://127.0.0.1:11434), the way every message names an endpoint. */
function describeEndpoint(endpoint: LocalModelEndpoint): string {
	return `"${endpoint.name}" (${endpoint.baseUrl})`;
}

function endpointError(
	endpoint: LocalModelEndpoint,
	kind: LocalModelEndpointErrorKind,
	message: string,
	url: string,
	extra: { httpStatus?: number; cause?: unknown } = {}
): LocalModelEndpointError {
	return new LocalModelEndpointError(message, {
		kind,
		endpointId: endpoint.id,
		endpointName: endpoint.name,
		url,
		...extra,
	});
}

function malformed(
	endpoint: LocalModelEndpoint,
	path: string,
	what: string,
	cause?: unknown
): LocalModelEndpointError {
	return endpointError(
		endpoint,
		'malformed',
		`${describeEndpoint(endpoint)} returned an unreadable answer for ${path}: ${what}. Check that its kind (${endpoint.kind}) is right.`,
		`${endpoint.baseUrl}${path}`,
		{ cause }
	);
}

function isEndpointStatus(error: unknown, status: number): boolean {
	return error instanceof LocalModelEndpointError && error.httpStatus === status;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

function requireVectors(
	endpoint: LocalModelEndpoint,
	path: string,
	vectors: unknown,
	expected: number
): number[][] {
	if (!Array.isArray(vectors)) throw malformed(endpoint, path, 'no embeddings');
	if (vectors.length !== expected) {
		throw malformed(endpoint, path, `${vectors.length} embeddings for ${expected} inputs`);
	}
	for (const vector of vectors) {
		if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number')) {
			throw malformed(endpoint, path, 'an embedding that is not a list of numbers');
		}
	}
	return vectors as number[][];
}

/**
 * The server's own one-line explanation, when it sent JSON with one. OpenAI
 * shapes it `{ error: { message } }`, Ollama `{ error: "..." }`. A non-JSON body
 * (a proxy's HTML error page) is not quoted.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
	const text = await response.text().catch(() => '');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const error = (parsed as { error?: unknown; message?: unknown })?.error;
	const detail =
		typeof error === 'string'
			? error
			: typeof (error as { message?: unknown })?.message === 'string'
				? (error as { message: string }).message
				: typeof (parsed as { message?: unknown })?.message === 'string'
					? (parsed as { message: string }).message
					: null;
	if (!detail) return null;
	const trimmed = detail.trim();
	return trimmed.length > MAX_ERROR_DETAIL_CHARS
		? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
		: trimmed;
}

/**
 * One request, answered with the parsed JSON body or a classified failure.
 *
 * A named key that does not resolve is refused BEFORE the request: sending the
 * call unauthenticated would come back as a 401 that blames the server for a
 * setting the user never finished.
 */
async function requestJson(
	endpoint: LocalModelEndpoint,
	method: 'GET' | 'POST',
	path: string,
	body: unknown,
	options: EndpointCallOptions
): Promise<unknown> {
	const url = `${endpoint.baseUrl}${path}`;
	const apiKey = resolveEndpointApiKey(endpoint, options.shellEnvVars);
	if (endpoint.apiKeyEnvVar && !apiKey) {
		throw endpointError(
			endpoint,
			'missing-key',
			`${describeEndpoint(endpoint)} uses the API key in ${endpoint.apiKeyEnvVar}, which is not set. Add it in Settings -> Environment.`,
			url
		);
	}

	const headers: Record<string, string> = { Accept: 'application/json' };
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	let response: Response;
	try {
		response = await fetchWithTimeout(
			url,
			{
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			},
			options.timeoutMs
		);
	} catch (error) {
		if (options.signal?.aborted) {
			throw endpointError(
				endpoint,
				'cancelled',
				`The request to ${describeEndpoint(endpoint)} was cancelled.`,
				url,
				{ cause: error }
			);
		}
		if (isFetchTimeoutError(error)) {
			throw endpointError(
				endpoint,
				'timeout',
				`${describeEndpoint(endpoint)} did not answer ${path} within ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`,
				url,
				{ cause: error }
			);
		}
		throw endpointError(
			endpoint,
			'network',
			`Could not reach ${describeEndpoint(endpoint)}. Check that the server is running.`,
			url,
			{ cause: error }
		);
	}

	if (!response.ok) {
		const status = response.status;
		const detail = await readErrorDetail(response);
		const suffix = detail ? `: ${detail}` : '.';
		const kind: LocalModelEndpointErrorKind =
			status === 401 || status === 403 ? 'auth' : status === 404 ? 'not-found' : 'http';
		const lead =
			kind === 'auth'
				? `${describeEndpoint(endpoint)} rejected the request (HTTP ${status}). Check the API key in ${endpoint.apiKeyEnvVar ?? 'Settings -> Environment'}`
				: `${describeEndpoint(endpoint)} answered HTTP ${status} for ${path}`;
		throw endpointError(endpoint, kind, `${lead}${suffix}`, url, { httpStatus: status });
	}

	try {
		const parsed: unknown = await response.json();
		if (typeof parsed !== 'object' || parsed === null) {
			throw new Error('Body is not a JSON object');
		}
		return parsed;
	} catch (error) {
		throw malformed(endpoint, path, 'the body is not a JSON object', error);
	}
}
