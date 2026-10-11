/**
 * @file endpoint-client.test.ts
 *
 * The endpoint client against a mocked `fetch`, for all three kinds. Pins the
 * routes each kind is asked on, the Ollama fallbacks (404 to the native route,
 * 400-with-schema to `format`), API key resolution from Settings ->
 * Environment, and the error classification a person reads.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	endpointChat,
	endpointEmbed,
	listEndpointModels,
} from '../../../main/local-models/endpoint-client';
import {
	LocalModelEndpointError,
	isLocalModelEndpointError,
} from '../../../main/local-models/errors';
import type {
	LocalModelEndpoint,
	LocalModelEndpointKind,
} from '../../../shared/local-models/endpoints';

function endpoint(
	kind: LocalModelEndpointKind,
	extra: Partial<LocalModelEndpoint> = {}
): LocalModelEndpoint {
	return {
		id: `ep-${kind}`,
		name: `My ${kind}`,
		kind,
		baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234',
		enabled: true,
		...extra,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(text),
		text: async () => text,
	} as unknown as Response;
}

/** Answers each request from a `path -> response` table; unknown paths are a test bug. */
function routeFetch(routes: Record<string, Response | (() => Response)>) {
	const mock = vi.fn(async (url: string) => {
		const path = new URL(url).pathname;
		const route = routes[path];
		if (!route) throw new Error(`unexpected request to ${path}`);
		return typeof route === 'function' ? route() : route;
	});
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

function requestBody(mock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
	return JSON.parse((mock.mock.calls[call][1] as RequestInit).body as string);
}

function requestHeaders(mock: ReturnType<typeof vi.fn>, call: number): Record<string, string> {
	return (mock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

async function rejection(promise: Promise<unknown>): Promise<LocalModelEndpointError> {
	try {
		await promise;
	} catch (error) {
		expect(isLocalModelEndpointError(error)).toBe(true);
		return error as LocalModelEndpointError;
	}
	throw new Error('expected a rejection');
}

describe('endpoint-client', () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});

	describe('listEndpointModels', () => {
		it('lists Ollama models from /api/tags with their size', async () => {
			const mock = routeFetch({
				'/api/tags': jsonResponse(200, {
					models: [{ name: 'llama3.2:3b', size: 2_000_000_000 }, { model: 'nomic-embed-text' }],
				}),
			});

			const models = await listEndpointModels(endpoint('ollama'));

			expect(models).toEqual([
				{ id: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
				{ id: 'nomic-embed-text' },
			]);
			expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
		});

		it.each(['lmstudio', 'openai-compatible'] as const)(
			'lists %s models from /v1/models',
			async (kind) => {
				const mock = routeFetch({
					'/v1/models': jsonResponse(200, { data: [{ id: 'qwen2.5-7b' }, { id: 'phi-4' }] }),
				});

				expect(await listEndpointModels(endpoint(kind))).toEqual([
					{ id: 'qwen2.5-7b' },
					{ id: 'phi-4' },
				]);
				expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:1234/v1/models');
			}
		);

		it('reports a malformed body naming the endpoint', async () => {
			routeFetch({ '/v1/models': jsonResponse(200, { models: [] }) });

			const error = await rejection(listEndpointModels(endpoint('lmstudio')));

			expect(error.kind).toBe('malformed');
			expect(error.message).toContain('"My lmstudio"');
			expect(error.message).toContain('/v1/models');
		});

		it('reports a body that is not JSON as malformed', async () => {
			routeFetch({ '/api/tags': jsonResponse(200, '<html>not json</html>') });

			const error = await rejection(listEndpointModels(endpoint('ollama')));

			expect(error.kind).toBe('malformed');
		});

		it('classifies a timeout and names the endpoint', async () => {
			globalThis.fetch = vi.fn(
				(_url: string, init: RequestInit = {}) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					})
			) as unknown as typeof fetch;

			const error = await rejection(listEndpointModels(endpoint('ollama'), { timeoutMs: 20 }));

			expect(error.kind).toBe('timeout');
			expect(error.message).toContain('"My ollama" (http://127.0.0.1:11434)');
			expect(error.endpointId).toBe('ep-ollama');
		});

		it('classifies a caller abort as cancelled, not as a timeout', async () => {
			globalThis.fetch = vi.fn(
				(_url: string, init: RequestInit = {}) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					})
			) as unknown as typeof fetch;
			const controller = new AbortController();

			const pending = rejection(
				listEndpointModels(endpoint('ollama'), { signal: controller.signal })
			);
			controller.abort();

			expect((await pending).kind).toBe('cancelled');
		});

		it('classifies a refused connection as network', async () => {
			globalThis.fetch = vi.fn(async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch;

			const error = await rejection(listEndpointModels(endpoint('lmstudio')));

			expect(error.kind).toBe('network');
			expect(error.message).toContain('Check that the server is running');
		});
	});

	describe('API keys', () => {
		it('sends the key named by apiKeyEnvVar, resolved from shellEnvVars', async () => {
			const mock = routeFetch({ '/v1/models': jsonResponse(200, { data: [] }) });

			await listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
				shellEnvVars: { LITELLM_KEY: ' sk-local ' },
			});

			expect(requestHeaders(mock, 0).Authorization).toBe('Bearer sk-local');
		});

		it('sends no Authorization header when no key is named', async () => {
			const mock = routeFetch({ '/api/tags': jsonResponse(200, { models: [] }) });

			await listEndpointModels(endpoint('ollama'));

			expect(requestHeaders(mock, 0).Authorization).toBeUndefined();
		});

		it('refuses before sending when the named key is not set', async () => {
			const mock = routeFetch({ '/v1/models': jsonResponse(200, { data: [] }) });

			const error = await rejection(
				listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
					shellEnvVars: {},
				})
			);

			expect(error.kind).toBe('missing-key');
			expect(error.message).toContain('LITELLM_KEY');
			expect(mock).not.toHaveBeenCalled();
		});

		it('classifies a 401 as auth with the status', async () => {
			routeFetch({
				'/v1/models': jsonResponse(401, { error: { message: 'Invalid API key' } }),
			});

			const error = await rejection(
				listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
					shellEnvVars: { LITELLM_KEY: 'sk-wrong' },
				})
			);

			expect(error.kind).toBe('auth');
			expect(error.httpStatus).toBe(401);
			expect(error.message).toContain('HTTP 401');
			expect(error.message).toContain('Invalid API key');
		});
	});

	describe('endpointChat', () => {
		const completion = jsonResponse(200, {
			model: 'qwen2.5-7b',
			choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 1 },
		});

		it.each(['ollama', 'lmstudio', 'openai-compatible'] as const)(
			'posts %s chat to /v1/chat/completions',
			async (kind) => {
				const mock = routeFetch({ '/v1/chat/completions': completion });

				const result = await endpointChat(endpoint(kind), {
					model: 'qwen2.5-7b',
					messages: [{ role: 'user', content: 'hi' }],
					maxTokens: 16,
					temperature: 0,
				});

				expect(result).toEqual({
					content: 'hello',
					model: 'qwen2.5-7b',
					finishReason: 'stop',
					usage: { promptTokens: 12, completionTokens: 1 },
				});
				expect(requestBody(mock, 0)).toEqual({
					model: 'qwen2.5-7b',
					messages: [{ role: 'user', content: 'hi' }],
					stream: false,
					max_tokens: 16,
					temperature: 0,
				});
			}
		);

		it('sends a json_schema response format when a schema is given', async () => {
			const mock = routeFetch({ '/v1/chat/completions': completion });
			const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

			await endpointChat(endpoint('lmstudio'), {
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				jsonSchema: schema,
				jsonSchemaName: 'verdict',
			});

			expect(requestBody(mock, 0).response_format).toEqual({
				type: 'json_schema',
				json_schema: { name: 'verdict', schema },
			});
		});

		it('falls back to Ollama /api/chat with format when the compat layer rejects the schema', async () => {
			const schema = { type: 'object' };
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(400, { error: 'invalid response format' }),
				'/api/chat': jsonResponse(200, {
					model: 'llama3.2:3b',
					message: { role: 'assistant', content: '{}' },
					done_reason: 'stop',
					prompt_eval_count: 5,
					eval_count: 2,
				}),
			});

			const result = await endpointChat(endpoint('ollama'), {
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
				maxTokens: 8,
				jsonSchema: schema,
			});

			expect(result).toEqual({
				content: '{}',
				model: 'llama3.2:3b',
				finishReason: 'stop',
				usage: { promptTokens: 5, completionTokens: 2 },
			});
			expect(requestBody(mock, 1)).toEqual({
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				format: schema,
				options: { num_predict: 8 },
			});
		});

		it('falls back to Ollama /api/chat on a 404 from an older Ollama', async () => {
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(404, '404 page not found'),
				'/api/chat': jsonResponse(200, { message: { content: 'hello' } }),
			});

			const result = await endpointChat(endpoint('ollama'), {
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
			});

			expect(result.content).toBe('hello');
			expect(mock).toHaveBeenCalledTimes(2);
		});

		it('does not fall back for a non-Ollama 404, and names the status', async () => {
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(404, { error: { message: 'model not loaded' } }),
			});

			const error = await rejection(
				endpointChat(endpoint('lmstudio'), {
					model: 'missing',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('not-found');
			expect(error.httpStatus).toBe(404);
			expect(error.message).toContain('HTTP 404');
			expect(error.message).toContain('model not loaded');
			expect(mock).toHaveBeenCalledTimes(1);
		});

		it('does not fall back on a 400 when no schema was sent', async () => {
			routeFetch({ '/v1/chat/completions': jsonResponse(400, { error: 'bad request' }) });

			const error = await rejection(
				endpointChat(endpoint('ollama'), {
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('http');
			expect(error.httpStatus).toBe(400);
		});

		it('reports a completion with no content as malformed', async () => {
			routeFetch({ '/v1/chat/completions': jsonResponse(200, { choices: [] }) });

			const error = await rejection(
				endpointChat(endpoint('openai-compatible'), {
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('malformed');
		});
	});

	describe('endpointEmbed', () => {
		it.each(['ollama', 'lmstudio', 'openai-compatible'] as const)(
			'embeds %s input via /v1/embeddings in index order',
			async (kind) => {
				const mock = routeFetch({
					'/v1/embeddings': jsonResponse(200, {
						model: 'nomic-embed-text',
						data: [
							{ index: 1, embedding: [0.3, 0.4] },
							{ index: 0, embedding: [0.1, 0.2] },
						],
					}),
				});

				const result = await endpointEmbed(endpoint(kind), {
					model: 'nomic-embed-text',
					input: ['a', 'b'],
				});

				expect(result).toEqual({
					model: 'nomic-embed-text',
					embeddings: [
						[0.1, 0.2],
						[0.3, 0.4],
					],
				});
				expect(requestBody(mock, 0)).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
			}
		);

		it('falls back to Ollama /api/embed on a 404', async () => {
			const mock = routeFetch({
				'/v1/embeddings': jsonResponse(404, '404 page not found'),
				'/api/embed': jsonResponse(200, { model: 'nomic-embed-text', embeddings: [[1, 2]] }),
			});

			const result = await endpointEmbed(endpoint('ollama'), {
				model: 'nomic-embed-text',
				input: ['a'],
			});

			expect(result.embeddings).toEqual([[1, 2]]);
			expect(mock.mock.calls[1][0]).toBe('http://127.0.0.1:11434/api/embed');
		});

		it('does not fall back for a non-Ollama 404', async () => {
			const mock = routeFetch({ '/v1/embeddings': jsonResponse(404, {}) });

			const error = await rejection(
				endpointEmbed(endpoint('openai-compatible'), { model: 'm', input: ['a'] })
			);

			expect(error.kind).toBe('not-found');
			expect(mock).toHaveBeenCalledTimes(1);
		});

		it('reports a vector count that does not match the input as malformed', async () => {
			routeFetch({
				'/v1/embeddings': jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }),
			});

			const error = await rejection(
				endpointEmbed(endpoint('lmstudio'), { model: 'm', input: ['a', 'b'] })
			);

			expect(error.kind).toBe('malformed');
			expect(error.message).toContain('1 embeddings for 2 inputs');
		});

		it('reports a non-numeric vector as malformed', async () => {
			routeFetch({
				'/v1/embeddings': jsonResponse(200, { data: [{ index: 0, embedding: ['x'] }] }),
			});

			const error = await rejection(
				endpointEmbed(endpoint('lmstudio'), { model: 'm', input: ['a'] })
			);

			expect(error.kind).toBe('malformed');
		});
	});
});
