/**
 * @file text-gen.test.ts
 *
 * The Local Models text-generation service. Two halves, with the llama binding
 * and `fetch` mocked:
 *
 *   - the shared local engine: one resident model, loaded lazily, reused across
 *     turns, freed when idle, swapped (never doubled) when another model is
 *     asked for, and turns serialized so a one-sequence context cannot fail
 *     with "No sequences left";
 *   - `generateText`: one result shape for a local model and an endpoint, with
 *     every failure classified and named, never substituted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const store = vi.hoisted(() => ({ isInstalled: vi.fn(async (_id: string) => true) }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../main/local-models/model-store', () => ({
	isInstalled: store.isInstalled,
	modelFilePath: (id: string, file: string) => `/models/${id}/${file}`,
}));

import {
	__setLocalTextEngine,
	generateText,
	isTextGenCancelled,
	LocalTextEngine,
	resolveInstalledTextModelPath,
	type LocalTextOptions,
} from '../../../main/local-models/text-gen';
import { LocalModelError } from '../../../main/local-models/errors';
import { LocalModelEndpointError } from '../../../main/local-models/errors';
import { PARAKEET_TDT_V2_ID, QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';

// ---------------------------------------------------------------------------
// A mocked node-llama-cpp
// ---------------------------------------------------------------------------

interface MockOptions {
	reply?: string | ((text: string) => string);
	/** Make `prompt` wait on this before answering. */
	gate?: Promise<void>;
	promptError?: Error;
	loadError?: Error;
	grammarError?: Error;
	tokens?: { input: number; output: number };
}

function mockLlama(options: MockOptions = {}) {
	const events: string[] = [];
	const promptCalls: Array<{ text: string; options: Record<string, unknown>; system?: unknown }> =
		[];
	const getLlama = vi.fn(async (_options?: Record<string, unknown>) => ({
		loadModel: vi.fn(async ({ modelPath }: { modelPath: string }) => {
			if (options.loadError) throw options.loadError;
			events.push(`load:${modelPath}`);
			return {
				// Like node-llama-cpp's default context: ONE sequence, handed back only
				// when it is disposed.
				createContext: async () => {
					let held = false;
					return {
						getSequence: () => {
							if (held) throw new Error('No sequences left');
							held = true;
							return {
								tokenMeter: options.tokens
									? {
											usedInputTokens: options.tokens.input,
											usedOutputTokens: options.tokens.output,
										}
									: undefined,
								dispose: () => {
									held = false;
								},
							};
						},
						dispose: () => events.push(`dispose-context:${modelPath}`),
					};
				},
				dispose: () => events.push(`dispose-model:${modelPath}`),
			};
		}),
		createGrammarForJsonSchema: vi.fn(async (schema: unknown) => {
			if (options.grammarError) throw options.grammarError;
			events.push('grammar');
			return { schema };
		}),
	}));

	class LlamaChatSession {
		private readonly opts: {
			contextSequence: { dispose(): void };
			autoDisposeSequence?: boolean;
			systemPrompt?: string;
		};
		constructor(opts: LlamaChatSession['opts']) {
			this.opts = opts;
		}
		async prompt(text: string, promptOptions: Record<string, unknown> = {}) {
			promptCalls.push({ text, options: promptOptions, system: this.opts.systemPrompt });
			if (options.gate) await options.gate;
			const signal = promptOptions.signal as AbortSignal | undefined;
			if (signal?.aborted) throw new Error('aborted');
			if (options.promptError) throw options.promptError;
			const reply = options.reply ?? 'ok';
			return typeof reply === 'function' ? reply(text) : reply;
		}
		dispose() {
			if (this.opts.autoDisposeSequence) this.opts.contextSequence.dispose();
		}
	}

	const module = { getLlama, LlamaChatSession };
	return {
		events,
		promptCalls,
		getLlama,
		loadRuntime: vi.fn(async () => module as never),
	};
}

function engineFor(llama: ReturnType<typeof mockLlama>, idleUnloadMs = 0) {
	return new LocalTextEngine({
		loadRuntime: llama.loadRuntime as never,
		resolveModelPath: async (modelId) => `/models/${modelId}.gguf`,
		idleUnloadMs,
	});
}

const TURN: LocalTextOptions = { prompt: 'name this tab', maxTokens: 32, temperature: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	settings.clear();
	store.isInstalled.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe('LocalTextEngine', () => {
	it('loads once and reuses the model across turns', async () => {
		const llama = mockLlama({ reply: 'Auth refactor' });
		const engine = engineFor(llama);

		await expect(engine.generate('m1', TURN)).resolves.toMatchObject({ text: 'Auth refactor' });
		await engine.generate('m1', TURN);

		expect(llama.events.filter((event) => event.startsWith('load:'))).toEqual([
			'load:/models/m1.gguf',
		]);
		expect(engine.loadedModelId).toBe('m1');
		expect(llama.promptCalls).toHaveLength(2);
	});

	it('never lets node-llama-cpp compile llama.cpp from source', async () => {
		const llama = mockLlama();
		await engineFor(llama).generate('m1', TURN);

		expect(llama.getLlama.mock.calls[0][0]).toMatchObject({ build: 'never', skipDownload: true });
	});

	it('passes the system prompt, temperature, and token budget to the turn', async () => {
		const llama = mockLlama();
		await engineFor(llama).generate('m1', {
			prompt: 'p',
			system: 'be brief',
			maxTokens: 12,
			temperature: 0.3,
		});

		expect(llama.promptCalls[0]).toMatchObject({
			text: 'p',
			system: 'be brief',
			options: { maxTokens: 12, temperature: 0.3 },
		});
	});

	it('reports the token meter for the turn', async () => {
		const llama = mockLlama({ tokens: { input: 40, output: 7 } });

		await expect(engineFor(llama).generate('m1', TURN)).resolves.toEqual({
			text: 'ok',
			tokensIn: 40,
			tokensOut: 7,
		});
	});

	it('compiles a JSON-schema grammar once per schema and constrains the turn with it', async () => {
		const llama = mockLlama({ reply: '{"name":"x"}' });
		const engine = engineFor(llama);
		const schema = { type: 'object', properties: { name: { type: 'string' } } };

		await engine.generate('m1', { ...TURN, jsonSchema: schema });
		await engine.generate('m1', { ...TURN, jsonSchema: { ...schema } });
		await engine.generate('m1', TURN);

		expect(llama.events.filter((event) => event === 'grammar')).toHaveLength(1);
		expect(llama.promptCalls[0].options.grammar).toEqual({ schema });
		expect(llama.promptCalls[1].options.grammar).toEqual({ schema });
		expect(llama.promptCalls[2].options).not.toHaveProperty('grammar');
	});

	it('still generates, unconstrained, on a build that cannot compile grammars', async () => {
		const llama = mockLlama({ grammarError: new Error('no json schema support') });

		await expect(
			engineFor(llama).generate('m1', { ...TURN, jsonSchema: { type: 'object' } })
		).resolves.toMatchObject({ text: 'ok' });
		expect(llama.promptCalls[0].options).not.toHaveProperty('grammar');
	});

	it('serializes concurrent turns on the one-sequence context', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const llama = mockLlama({ gate, reply: (text) => `re:${text}` });
		const engine = engineFor(llama);

		const first = engine.generate('m1', { ...TURN, prompt: 'a' });
		const second = engine.generate('m1', { ...TURN, prompt: 'b' });
		release();

		// Run in parallel, the second turn would take the held sequence and fail.
		await expect(Promise.all([first, second])).resolves.toMatchObject([
			{ text: 're:a' },
			{ text: 're:b' },
		]);
	});

	it('keeps one model resident: switching frees the old one before opening the next', async () => {
		const llama = mockLlama();
		const engine = engineFor(llama);

		await engine.generate('m1', TURN);
		await engine.generate('m2', TURN);

		expect(llama.events).toEqual([
			'load:/models/m1.gguf',
			'dispose-context:/models/m1.gguf',
			'dispose-model:/models/m1.gguf',
			'load:/models/m2.gguf',
		]);
		expect(engine.loadedModelId).toBe('m2');
	});

	it('unloads a named model only when it is the resident one', async () => {
		const llama = mockLlama();
		const engine = engineFor(llama);
		await engine.generate('m1', TURN);

		await engine.unload('m2');
		expect(engine.loadedModelId).toBe('m1');

		await engine.unload('m1');
		expect(engine.loadedModelId).toBeNull();
		expect(llama.events).toContain('dispose-model:/models/m1.gguf');
	});

	it('frees the model after the idle window and reloads on the next turn', async () => {
		vi.useFakeTimers();
		try {
			const llama = mockLlama();
			const engine = engineFor(llama, 1_000);

			await engine.generate('m1', TURN);
			expect(engine.loadedModelId).toBe('m1');

			await vi.advanceTimersByTimeAsync(1_100);
			expect(engine.loadedModelId).toBeNull();
			expect(llama.events).toContain('dispose-context:/models/m1.gguf');

			await engine.generate('m1', TURN);
			expect(engine.loadedModelId).toBe('m1');
		} finally {
			vi.useRealTimers();
		}
	});

	it('restarts the idle window on every turn', async () => {
		vi.useFakeTimers();
		try {
			const llama = mockLlama();
			const engine = engineFor(llama, 1_000);

			await engine.generate('m1', TURN);
			await vi.advanceTimersByTimeAsync(800);
			await engine.generate('m1', TURN);
			await vi.advanceTimersByTimeAsync(800);

			expect(engine.loadedModelId).toBe('m1');
		} finally {
			vi.useRealTimers();
		}
	});

	it('passes a runtime that will not load through as its own classified failure', async () => {
		const engine = new LocalTextEngine({
			loadRuntime: (async () => {
				throw new LocalModelError('llama.cpp is not downloaded.', {
					code: 'runtime-unavailable',
					recovery: 'Download it.',
					consumerId: 'local-models:text-gen',
				});
			}) as never,
			resolveModelPath: async () => '/m.gguf',
			idleUnloadMs: 0,
		});

		await expect(engine.generate('m1', TURN)).rejects.toMatchObject({
			code: 'runtime-unavailable',
		});
	});

	it('classifies a model that will not open', async () => {
		const llama = mockLlama({ loadError: new Error('bad magic') });

		await expect(engineFor(llama).generate('m1', TURN)).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
		});
	});

	it('classifies a failure mid-turn and gives the sequence back', async () => {
		const llama = mockLlama({ promptError: new Error('context is full') });
		const engine = engineFor(llama);

		await expect(engine.generate('m1', TURN)).rejects.toMatchObject({
			code: 'generation-failed',
			message: expect.stringContaining('context is full'),
		});
		// The sequence came back: the next turn reaches the model instead of
		// failing on "No sequences left".
		await expect(engine.generate('m1', TURN)).rejects.toMatchObject({
			message: expect.stringContaining('context is full'),
		});
	});

	it('refuses an already-cancelled request without loading anything', async () => {
		const llama = mockLlama();
		const controller = new AbortController();
		controller.abort();

		await expect(
			engineFor(llama).generate('m1', { ...TURN, signal: controller.signal })
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(llama.loadRuntime).not.toHaveBeenCalled();
	});

	it('reports an abort during the turn as cancelled, not as a failure', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const llama = mockLlama({ gate });
		const controller = new AbortController();

		const turn = engineFor(llama).generate('m1', { ...TURN, signal: controller.signal });
		await vi.waitFor(() => expect(llama.promptCalls).toHaveLength(1));
		controller.abort();
		release();

		const error = await turn.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: 'cancelled' });
		expect(isTextGenCancelled(error)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Resolving a catalog model
// ---------------------------------------------------------------------------

describe('resolveInstalledTextModelPath', () => {
	it('resolves an installed catalog text model to its GGUF', async () => {
		await expect(resolveInstalledTextModelPath(QWEN3_1_7B_ID)).resolves.toBe(
			`/models/${QWEN3_1_7B_ID}/Qwen3-1.7B-Q4_K_M.gguf`
		);
	});

	it('refuses an id that is not in the catalog', async () => {
		await expect(resolveInstalledTextModelPath('gpt-9')).rejects.toMatchObject({
			code: 'model-unsupported',
		});
	});

	it('refuses a catalog model that does not generate text', async () => {
		await expect(resolveInstalledTextModelPath(PARAKEET_TDT_V2_ID)).rejects.toMatchObject({
			code: 'model-unsupported',
		});
	});

	it('names a model that is not downloaded', async () => {
		store.isInstalled.mockResolvedValue(false);

		await expect(resolveInstalledTextModelPath(QWEN3_1_7B_ID)).rejects.toMatchObject({
			code: 'model-not-installed',
			message: expect.stringContaining('Qwen3'),
		});
	});
});

// ---------------------------------------------------------------------------
// generateText
// ---------------------------------------------------------------------------

describe('generateText', () => {
	describe('local source', () => {
		afterEach(() => __setLocalTextEngine(null));

		it('runs on the shared engine and returns one result shape', async () => {
			const llama = mockLlama({ reply: 'Auth refactor', tokens: { input: 20, output: 3 } });
			__setLocalTextEngine(engineFor(llama));

			const result = await generateText({
				source: { type: 'local', modelId: 'm1' },
				prompt: 'name this tab',
				system: 'reply with a short title',
				maxTokens: 16,
			});

			expect(result).toMatchObject({
				text: 'Auth refactor',
				source: { type: 'local', modelId: 'm1' },
				tokensIn: 20,
				tokensOut: 3,
			});
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result).not.toHaveProperty('json');
			// Deterministic by default.
			expect(llama.promptCalls[0].options).toMatchObject({ temperature: 0, maxTokens: 16 });
		});

		it('parses the reply when a schema was given', async () => {
			__setLocalTextEngine(engineFor(mockLlama({ reply: '{"name":"Auth"}' })));

			const result = await generateText({
				source: { type: 'local', modelId: 'm1' },
				prompt: 'p',
				maxTokens: 16,
				jsonSchema: { type: 'object' },
			});

			expect(result.json).toEqual({ name: 'Auth' });
		});

		it('leaves json out when the reply does not parse', async () => {
			__setLocalTextEngine(engineFor(mockLlama({ reply: 'not json at all' })));

			const result = await generateText({
				source: { type: 'local', modelId: 'm1' },
				prompt: 'p',
				maxTokens: 16,
				jsonSchema: { type: 'object' },
			});

			expect(result.text).toBe('not json at all');
			expect(result).not.toHaveProperty('json');
		});
	});

	describe('endpoint source', () => {
		const realFetch = globalThis.fetch;
		const saved = {
			id: 'ep-1',
			name: 'Gateway',
			kind: 'openai-compatible',
			baseUrl: 'http://127.0.0.1:1234',
			apiKeyEnvVar: 'GATEWAY_KEY',
			enabled: true,
		};

		function mockFetch(reply: string) {
			const mock = vi.fn(async (_url: string, _init?: RequestInit) => {
				const text = JSON.stringify({
					model: 'llama3.2',
					choices: [{ message: { content: reply }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 30, completion_tokens: 5 },
				});
				return {
					ok: true,
					status: 200,
					json: async () => JSON.parse(text),
					text: async () => text,
				} as unknown as Response;
			});
			globalThis.fetch = mock as unknown as typeof fetch;
			return mock;
		}

		beforeEach(() => {
			settings.set('localModelEndpoints', [saved, { ...saved, id: 'ep-off', enabled: false }]);
			settings.set('shellEnvVars', { GATEWAY_KEY: 'sk-test' });
		});

		afterEach(() => {
			globalThis.fetch = realFetch;
		});

		it('sends a chat completion and returns the same result shape', async () => {
			const fetchMock = mockFetch('{"name":"Auth"}');

			const result = await generateText({
				source: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' },
				prompt: 'name this tab',
				system: 'reply as JSON',
				maxTokens: 16,
				jsonSchema: { type: 'object' },
			});

			expect(result).toMatchObject({
				text: '{"name":"Auth"}',
				json: { name: 'Auth' },
				source: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' },
				tokensIn: 30,
				tokensOut: 5,
			});

			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
			const body = JSON.parse(init!.body as string);
			expect(body).toMatchObject({
				model: 'llama3.2',
				messages: [
					{ role: 'system', content: 'reply as JSON' },
					{ role: 'user', content: 'name this tab' },
				],
				max_tokens: 16,
				temperature: 0,
				response_format: { type: 'json_schema' },
			});
			// The key comes from Settings -> Environment, by name.
			expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
		});

		it('omits the system message when there is none', async () => {
			const fetchMock = mockFetch('hi');

			await generateText({
				source: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' },
				prompt: 'p',
				maxTokens: 4,
			});

			const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
			expect(body.messages).toEqual([{ role: 'user', content: 'p' }]);
			expect(body).not.toHaveProperty('response_format');
		});

		it('refuses an endpoint id that is not saved, without sending anything', async () => {
			const fetchMock = mockFetch('hi');

			const error = await generateText({
				source: { type: 'endpoint', endpointId: 'ep', model: 'm' },
				prompt: 'p',
				maxTokens: 4,
			}).catch((caught: unknown) => caught);

			// An exact id only: "ep" is a prefix of "ep-1", and a prefix must never
			// quietly pick a server.
			expect(error).toBeInstanceOf(LocalModelEndpointError);
			expect(error).toMatchObject({ kind: 'invalid' });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('refuses a disabled endpoint, without sending anything', async () => {
			const fetchMock = mockFetch('hi');

			await expect(
				generateText({
					source: { type: 'endpoint', endpointId: 'ep-off', model: 'm' },
					prompt: 'p',
					maxTokens: 4,
				})
			).rejects.toMatchObject({ kind: 'invalid', message: expect.stringContaining('disabled') });
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
