/**
 * The Local Models text-generation service: one call, two kinds of source.
 *
 * Every consumer that wants a few hundred tokens of text (the voice Conductor
 * Brain, and the housekeeping tasks behind the task router) calls
 * {@link generateText} and names a source: a catalog model run in-process on
 * llama.cpp, or a model on a user-run endpoint (Ollama, LM Studio, any
 * OpenAI-compatible server). The caller gets the same result shape either way.
 *
 * **One local model is resident, app-wide.** A GGUF is a gigabyte or more of
 * RAM, and llama.cpp takes seconds to open one, so the model is loaded lazily,
 * held between calls, and freed after {@link DEFAULT_IDLE_UNLOAD_MS} of silence
 * by one shared {@link LocalTextEngine}. Voice and housekeeping go through the
 * same engine, so a tab name generated mid-conversation reuses the model the
 * Conductor already loaded instead of opening a second copy. Asking for a
 * different model unloads the resident one first: two at once is how a laptop
 * starts swapping.
 *
 * **Calls are serialized.** The context has one sequence, and a second turn
 * started while the first holds it fails with "No sequences left". A queue in
 * front of the engine turns that crash into a short wait.
 *
 * **A source that cannot run fails as itself.** A missing model, a runtime that
 * will not load, or an endpoint that is down throws a classified error naming
 * it. Nothing in here reaches for a different model or a cloud agent: that
 * would spend resources (or money) the user did not choose to spend.
 */

import { getLocalModel } from '../../shared/local-models/model-catalog';
import { extractJsonObject } from '../../shared/jsonUtils';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import { chatWithLocalModelEndpoint } from './endpoint-service';
import type { EndpointChatMessage } from './endpoint-client';
import {
	isLocalModelCancelled,
	LocalModelError,
	localModelCancelledError,
	throwIfLocalModelCancelled,
} from './errors';
import { isInstalled, modelFilePath } from './model-store';
import { LLAMA_GET_OPTIONS } from './runtime/llama-options';
import { loadLocalRuntime } from './runtime/load-runtime';
import { runtimeSetupLocation } from './runtime/runtime-consumers';
import type { LocalModelSource } from './sources';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Where the text comes from. */
export type TextGenSource = LocalModelSource;

export interface GenerateTextRequest {
	source: TextGenSource;
	prompt: string;
	system?: string;
	maxTokens: number;
	/**
	 * Sampling temperature. Defaults to 0: housekeeping output should be
	 * reproducible, and a bad answer that cannot be reproduced cannot be fixed.
	 */
	temperature?: number;
	/**
	 * A JSON Schema the reply must satisfy. A local model is grammar-constrained
	 * to it (structurally unable to emit anything else); an endpoint is sent it as
	 * a response format.
	 */
	jsonSchema?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface GenerateTextResult {
	text: string;
	/**
	 * The reply parsed as JSON, present only when `jsonSchema` was given AND the
	 * reply parsed. Schema-valid is not guaranteed for an endpoint (servers vary
	 * in how strictly they honor a response format), so a caller still validates.
	 */
	json?: unknown;
	source: TextGenSource;
	/** Wall time of the call with machine sleep removed. Includes a cold load. */
	durationMs: number;
	tokensIn?: number;
	tokensOut?: number;
}

/**
 * Generate text from a local model or an endpoint.
 *
 * Throws a {@link LocalModelError} for a local source and a
 * `LocalModelEndpointError` for an endpoint; both carry a message written for a
 * person and a code a caller can switch on.
 */
export async function generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
	const span = beginSleepAwareSpan();
	const temperature = request.temperature ?? 0;
	const { source } = request;

	let reply: LocalTextReply;
	if (source.type === 'local') {
		reply = await getLocalTextEngine().generate(source.modelId, {
			prompt: request.prompt,
			system: request.system,
			maxTokens: request.maxTokens,
			temperature,
			jsonSchema: request.jsonSchema,
			signal: request.signal,
		});
	} else {
		const messages: EndpointChatMessage[] = [
			...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
			{ role: 'user', content: request.prompt },
		];
		const result = await chatWithLocalModelEndpoint(source.endpointId, {
			model: source.model,
			messages,
			maxTokens: request.maxTokens,
			temperature,
			...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
			...(request.signal ? { signal: request.signal } : {}),
		});
		reply = {
			text: result.content,
			tokensIn: result.usage?.promptTokens,
			tokensOut: result.usage?.completionTokens,
		};
	}

	const json = request.jsonSchema ? parseJsonReply(reply.text) : undefined;
	return {
		text: reply.text,
		...(json !== undefined ? { json } : {}),
		source,
		durationMs: sleepAwareElapsedMs(span),
		...(reply.tokensIn !== undefined ? { tokensIn: reply.tokensIn } : {}),
		...(reply.tokensOut !== undefined ? { tokensOut: reply.tokensOut } : {}),
	};
}

/**
 * Parse a reply as JSON: the whole text first (any root type), then the first
 * object inside prose or a code fence, which is how an unconstrained model
 * answers however it is told.
 */
function parseJsonReply(text: string): unknown {
	try {
		return JSON.parse(text.trim());
	} catch {
		return extractJsonObject(text) ?? undefined;
	}
}

// ---------------------------------------------------------------------------
// The shared local engine
// ---------------------------------------------------------------------------

/**
 * How long a local model stays resident after the last call.
 *
 * Five minutes is longer than a pause in a conversation and shorter than a
 * coffee break, which is the line this timer is trying to draw: warm within a
 * burst of work, cold between them.
 */
export const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000;

/** Small context: a roster, a tab transcript excerpt, one request. Never a codebase. */
const CONTEXT_SIZE = 4096;

/** Who the core names when a runtime failure reaches a caller. */
const CONSUMER_ID = 'local-models:text-gen';

/** The one queue key: there is one resident model, so there is one line. */
const ENGINE_QUEUE_KEY = 'llama';

/** The node-llama-cpp surface this engine uses, structurally. */
interface LlamaGrammar {
	readonly _grammar?: unknown;
}

interface LlamaTokenMeter {
	usedInputTokens?: unknown;
	usedOutputTokens?: unknown;
}

interface LlamaContextSequence {
	tokenMeter?: LlamaTokenMeter;
}

interface LlamaChatSessionInstance {
	prompt(text: string, options?: Record<string, unknown>): Promise<string>;
	dispose?(): Promise<void> | void;
}

interface LlamaContextInstance {
	getSequence(): unknown;
	dispose?(): Promise<void> | void;
}

interface LlamaModelInstance {
	createContext(options?: Record<string, unknown>): Promise<LlamaContextInstance>;
	dispose?(): Promise<void> | void;
}

interface LlamaInstance {
	loadModel(options: { modelPath: string }): Promise<LlamaModelInstance>;
	createGrammarForJsonSchema(schema: unknown): Promise<LlamaGrammar>;
}

interface LlamaModule {
	getLlama(options?: Record<string, unknown>): Promise<LlamaInstance>;
	LlamaChatSession: new (options: Record<string, unknown>) => LlamaChatSessionInstance;
}

/** Everything one resident model holds, so unloading is one object to drop. */
interface LoadedModel {
	modelId: string;
	model: LlamaModelInstance;
	context: LlamaContextInstance;
	ChatSession: LlamaModule['LlamaChatSession'];
	/** Compile a JSON-schema grammar on this load's llama instance. */
	createGrammar(schema: unknown): Promise<LlamaGrammar | null>;
	/**
	 * Compiled grammars by schema, built once per schema per load: compiling one
	 * is not free and a caller's schema rarely changes. `null` records a build
	 * of llama.cpp that cannot compile JSON-schema grammars.
	 */
	grammars: Map<string, Promise<LlamaGrammar | null>>;
}

/** One turn's options, after `generateText` has applied its defaults. */
export interface LocalTextOptions {
	prompt: string;
	system?: string;
	maxTokens: number;
	temperature: number;
	jsonSchema?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface LocalTextReply {
	text: string;
	tokensIn?: number;
	tokensOut?: number;
}

export interface LocalTextEngineOptions {
	/** Idle time before the resident model is freed. 0 keeps it loaded forever. */
	idleUnloadMs?: number;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
	/** Injected in tests; production resolves an installed catalog GGUF. */
	resolveModelPath?: (modelId: string) => Promise<string>;
}

/**
 * The installed GGUF for a catalog text-generation model, or a classified refusal.
 *
 * Checked on every load (not every turn), with the store's cheap check (manifest
 * plus byte lengths, never a re-hash), so a model deleted or half-downloaded
 * since the last run is named as such instead of surfacing as an opaque
 * llama.cpp open failure.
 */
export async function resolveInstalledTextModelPath(modelId: string): Promise<string> {
	const entry = getLocalModel(modelId);
	const gguf =
		entry && entry.kind === 'text-gen' && entry.runtime === 'llama'
			? entry.files.find((file) => file.path.toLowerCase().endsWith('.gguf'))
			: undefined;
	if (!entry || !gguf) {
		throw new LocalModelError(`"${modelId}" is not a local text-generation model.`, {
			code: 'model-unsupported',
			recovery: 'Choose a text-generation model from the Local Models catalog.',
			consumerId: CONSUMER_ID,
		});
	}
	if (!(await isInstalled(modelId))) {
		throw new LocalModelError(`${entry.displayName} is not downloaded.`, {
			code: 'model-not-installed',
			recovery: `Download it in ${runtimeSetupLocation('llama')}.`,
			consumerId: CONSUMER_ID,
		});
	}
	return modelFilePath(modelId, gguf.path);
}

/**
 * Holds the one resident llama model and runs turns against it, one at a time.
 *
 * Exported for tests and for consumers that need to inject one (the voice
 * provider's tests); production code shares {@link getLocalTextEngine}.
 */
export class LocalTextEngine {
	private readonly idleUnloadMs: number;
	private readonly loadRuntime: typeof loadLocalRuntime;
	private readonly resolveModelPath: (modelId: string) => Promise<string>;
	private readonly queue = createKeyedWriteQueue();

	private loaded: LoadedModel | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Bumped when a turn STARTS. An idle unload captures it when scheduled and
	 * does nothing if it moved, so a timer that fired just as a new turn began
	 * cannot free the model out from under that turn's follow-up.
	 */
	private useToken = 0;

	constructor(options: LocalTextEngineOptions = {}) {
		this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
		this.resolveModelPath = options.resolveModelPath ?? resolveInstalledTextModelPath;
	}

	/** The id of the resident model, or null when nothing is loaded. */
	get loadedModelId(): string | null {
		return this.loaded?.modelId ?? null;
	}

	/** Run one turn on `modelId`, loading it (and unloading any other) first. */
	async generate(modelId: string, options: LocalTextOptions): Promise<LocalTextReply> {
		throwIfCancelled(options.signal);
		return this.queue.enqueue(ENGINE_QUEUE_KEY, async () => {
			// It may have waited behind another turn; the caller may have gone.
			throwIfCancelled(options.signal);
			this.useToken++;
			this.clearIdleTimer();
			try {
				const loaded = await this.ensureLoaded(modelId);
				return await this.runTurn(loaded, options);
			} finally {
				// Restarted after every turn, not before: the clock runs from the last
				// request, not from the start of a slow inference.
				this.scheduleIdleUnload();
			}
		});
	}

	/**
	 * Free the resident model now. With `modelId`, only when that model is the
	 * resident one, so one consumer tearing down cannot evict another's model.
	 * Waits for an in-flight turn rather than disposing under it.
	 */
	unload(modelId?: string): Promise<void> {
		return this.queue.enqueue(ENGINE_QUEUE_KEY, async () => {
			if (modelId !== undefined && this.loaded?.modelId !== modelId) return;
			this.clearIdleTimer();
			await this.disposeLoaded();
		});
	}

	// -- Internals -----------------------------------------------------------

	private async ensureLoaded(modelId: string): Promise<LoadedModel> {
		if (this.loaded?.modelId === modelId) return this.loaded;
		// One resident model: free the old one before opening the next, never after.
		await this.disposeLoaded();

		// Both throw classified errors of their own (runtime-unavailable,
		// model-unsupported, model-not-installed); they pass through untouched.
		const modelPath = await this.resolveModelPath(modelId);
		const module = await this.loadRuntime<LlamaModule>('llama', CONSUMER_ID);

		try {
			const llama = await module.getLlama({ ...LLAMA_GET_OPTIONS });
			const model = await llama.loadModel({ modelPath });
			let context: LlamaContextInstance;
			try {
				context = await model.createContext({ contextSize: CONTEXT_SIZE });
			} catch (error) {
				await safeDispose(() => model.dispose?.());
				throw error;
			}
			this.loaded = {
				modelId,
				model,
				context,
				ChatSession: module.LlamaChatSession,
				createGrammar: (schema) =>
					llama
						.createGrammarForJsonSchema(schema)
						// A build of llama.cpp without JSON-schema grammars still generates;
						// it just relies on the prompt and the caller's parser instead of
						// being unable to emit bad JSON.
						.catch(() => null),
				grammars: new Map(),
			};
			return this.loaded;
		} catch (error) {
			throw new LocalModelError(`${modelLabel(modelId)} could not be opened.`, {
				code: 'generation-failed',
				recovery: `Verify or re-download it in ${runtimeSetupLocation('llama')}.`,
				consumerId: CONSUMER_ID,
				cause: error,
			});
		}
	}

	private grammarFor(
		loaded: LoadedModel,
		schema: Record<string, unknown>
	): Promise<LlamaGrammar | null> {
		const key = JSON.stringify(schema);
		let grammar = loaded.grammars.get(key);
		if (!grammar) {
			grammar = loaded.createGrammar(schema);
			loaded.grammars.set(key, grammar);
		}
		return grammar;
	}

	/**
	 * One turn against the resident context.
	 *
	 * A fresh chat session per call, on the same context: no consumer wants
	 * memory between calls (each prompt carries what it needs), and a session
	 * that accumulated history would grow until it evicted the system prompt.
	 */
	private async runTurn(loaded: LoadedModel, options: LocalTextOptions): Promise<LocalTextReply> {
		const grammar = options.jsonSchema ? await this.grammarFor(loaded, options.jsonSchema) : null;
		const sequence = loaded.context.getSequence() as LlamaContextSequence;
		const session = new loaded.ChatSession({
			contextSequence: sequence,
			...(options.system ? { systemPrompt: options.system } : {}),
			// The context has ONE sequence, and a session does not give it back on
			// dispose unless told to. Without this the first turn holds it forever
			// and every later turn fails with "No sequences left" - found by the
			// on-device E2E, which mocked unit tests could not see.
			autoDisposeSequence: true,
		});

		try {
			const text = await session.prompt(options.prompt, {
				temperature: options.temperature,
				maxTokens: options.maxTokens,
				// No reasoning segment. A thinking model (Qwen3 is one) opens a
				// free-text reply with a thought the chat session strips from what it
				// returns, and that thought is charged against `maxTokens`: on real
				// hardware a 400-token summary turn came back as an EMPTY string,
				// because every token went to thinking. A grammar turn never thinks
				// (its first token is already constrained), so this only changes
				// free-text turns, and every consumer here wants the answer, not the
				// deliberation.
				budgets: { thoughtTokens: 0 },
				...(grammar ? { grammar } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			// Read before the session disposes the sequence. A fresh sequence per
			// turn means the meter counts this turn only.
			return {
				text,
				tokensIn: tokenCount(sequence.tokenMeter?.usedInputTokens),
				tokensOut: tokenCount(sequence.tokenMeter?.usedOutputTokens),
			};
		} catch (error) {
			if (options.signal?.aborted) throw cancelledError();
			throw new LocalModelError(
				`${modelLabel(loaded.modelId)} failed on this request: ${(error as Error).message}`,
				{
					code: 'generation-failed',
					recovery: 'Try again. If it keeps failing, verify the model in Local Models settings.',
					consumerId: CONSUMER_ID,
					cause: error,
				}
			);
		} finally {
			await safeDispose(() => session.dispose?.());
		}
	}

	private async disposeLoaded(): Promise<void> {
		const loaded = this.loaded;
		this.loaded = null;
		if (!loaded) return;
		// Innermost first: disposing a model out from under a live context is how
		// llama.cpp gets a use-after-free instead of a clean shutdown.
		await safeDispose(() => loaded.context.dispose?.());
		await safeDispose(() => loaded.model.dispose?.());
	}

	private scheduleIdleUnload(): void {
		this.clearIdleTimer();
		if (this.idleUnloadMs <= 0 || !this.loaded) return;
		const token = this.useToken;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			void this.queue.enqueue(ENGINE_QUEUE_KEY, async () => {
				if (this.useToken !== token) return;
				await this.disposeLoaded();
			});
		}, this.idleUnloadMs);
		// The timer must never be the reason the app stays alive.
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}

let sharedEngine: LocalTextEngine | null = null;

/** The app-wide engine every local text consumer shares. */
export function getLocalTextEngine(): LocalTextEngine {
	sharedEngine ??= new LocalTextEngine();
	return sharedEngine;
}

/** Tests only: replace (or with null, forget) the shared engine. */
export function __setLocalTextEngine(engine: LocalTextEngine | null): void {
	sharedEngine = engine;
}

/** True when an error from {@link generateText} means the caller cancelled. */
export const isTextGenCancelled = isLocalModelCancelled;

function modelLabel(modelId: string): string {
	return getLocalModel(modelId)?.displayName ?? modelId;
}

function cancelledError(): LocalModelError {
	return localModelCancelledError(CONSUMER_ID);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	throwIfLocalModelCancelled(signal, CONSUMER_ID);
}

function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Teardown must not throw: it runs from `finally` blocks and from disposal. */
async function safeDispose(dispose: () => Promise<void> | void | undefined): Promise<void> {
	try {
		await dispose();
	} catch {
		/* best-effort */
	}
}
