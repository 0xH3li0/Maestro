/**
 * The always-local wake word.
 *
 * openWakeWord, on `onnxruntime-node`, loaded through `native-loader.ts` and fed
 * the same 16 kHz PCM frames the rest of the pipeline already produces. It runs
 * whether the user picked Whisper or OpenAI for speech-to-text, and that is not
 * a preference: **no audio may leave this machine until a wake phrase has
 * actually fired.** An always-listening feature that streams a room to a service
 * on the off chance somebody says a name is not a feature anyone should have to
 * opt out of.
 *
 * The invariant is enforced structurally rather than by discipline. The detector
 * has exactly one outward edge - `onWake` - and its scorer is typed with a
 * literal `tier: 'local'`, so a hosted scorer will not compile and, if one is
 * cast in anyway, the constructor throws. The detector never sees a provider,
 * never holds a socket, and cannot be handed one.
 *
 * **It is not the speech recogniser and must not become one.** The STT engine
 * stays unloaded while this runs: a wake word that keeps a 148 MB model resident
 * for the life of the app is the reason "always listening" gets a bad name. The
 * front end here is two small ONNX graphs and a per-phrase classifier.
 *
 * A global phrase plus per-agent phrases, so "hey scout" lands in that agent's
 * context without a routing round trip. Every phrase carries its own sensitivity,
 * because a two-syllable agent name and "hey maestro" do not false-fire at the
 * same threshold, and every hit is debounced, because one spoken phrase produces
 * several consecutive scoring windows over the threshold and each of them would
 * otherwise be a session.
 */

import { ACAPPELLA_AUDIO_FRAME_SAMPLES } from '../../../shared/acappella/audio-host';
import { OPENWAKEWORD_BASE_ID } from '../../../shared/acappella/model-catalog';
import type { VoiceScope } from '../../../shared/acappella/protocol';
import {
	DEFAULT_WAKE_DEBOUNCE_MS,
	DEFAULT_WAKE_PHRASE,
	DEFAULT_WAKE_SENSITIVITY,
	MIN_WAKE_THRESHOLD,
} from '../../../shared/acappella/voice-controls';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { AudioFrameRing } from '../audio/audio-pipeline';
import {
	GLOBAL_WAKE_PHRASE_ID,
	WAKE_WORD_PROVIDER_ID,
	wakeClassifierPath,
} from '../models/capability-gate';
import { modelFilePath } from '../models/model-store';
import { loadLocalRuntime } from '../providers/local/runtime';

const LOG_CONTEXT = 'ACappella';

export {
	DEFAULT_WAKE_DEBOUNCE_MS,
	DEFAULT_WAKE_PHRASE,
	DEFAULT_WAKE_SENSITIVITY,
	MIN_WAKE_THRESHOLD,
} from '../../../shared/acappella/voice-controls';

// Defined beside the classifier path in the gate; re-exported so importers keep
// their one import site.
export { GLOBAL_WAKE_PHRASE_ID } from '../models/capability-gate';

/**
 * openWakeWord's hop: 1280 samples at 16 kHz, which is four of our 20 ms frames.
 * The models are trained on this cadence, so it is a property of the graph and
 * not a tuning knob.
 */
export const WAKE_HOP_SAMPLES = 1280;

const FRAMES_PER_HOP = Math.ceil(WAKE_HOP_SAMPLES / ACAPPELLA_AUDIO_FRAME_SAMPLES);

/** Int16 full scale, for the conversion to the float range the models want. */
const INT16_SCALE = 32768;

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

/** One thing the detector is listening for. */
export interface WakePhrase {
	/** Stable id. Also the classifier model's file stem. */
	id: string;
	/** What the user says. Display text; the classifier is what actually matches. */
	phrase: string;
	/** Where a hit takes the session. The global phrase resolves to the Conductor. */
	scope: VoiceScope;
	/** 0 to 1, higher is easier to trigger. Defaults to {@link DEFAULT_WAKE_SENSITIVITY}. */
	sensitivity?: number;
	/** False parks the phrase without forgetting it. Defaults to true. */
	enabled?: boolean;
}

/** The global phrase, bound to the Conductor. */
export function globalWakePhrase(
	phrase: string = DEFAULT_WAKE_PHRASE,
	sensitivity?: number
): WakePhrase {
	return {
		id: GLOBAL_WAKE_PHRASE_ID,
		phrase,
		scope: { kind: 'conductor' },
		sensitivity,
	};
}

/** A phrase bound to one agent, so saying it jumps straight into that agent's context. */
export function agentWakePhrase(
	agentSessionId: string,
	phrase: string,
	sensitivity?: number
): WakePhrase {
	return {
		id: `agent:${agentSessionId}`,
		phrase,
		scope: { kind: 'agent', sessionId: agentSessionId },
		sensitivity,
	};
}

/** The score a phrase has to clear. Derived so the slider and the gate cannot disagree. */
export function wakeThresholdFor(phrase: WakePhrase, fallback = DEFAULT_WAKE_SENSITIVITY): number {
	const raw = phrase.sensitivity ?? fallback;
	const sensitivity = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback;
	return Math.max(MIN_WAKE_THRESHOLD, 1 - sensitivity);
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Scores one 80 ms hop against every armed phrase.
 *
 * `tier` is a literal, not a `VoiceProviderTier`. That is the compile-time half
 * of the no-egress invariant: a cloud provider's tier is `'cloud'`, so a hosted
 * scorer is not assignable here and the mistake is a type error rather than a
 * privacy incident. The constructor checks it again at runtime for anything that
 * arrives through a cast or across an IPC boundary.
 */
export interface WakePhraseScorer {
	readonly tier: 'local';
	/**
	 * @param hop Mono float samples in [-1, 1], {@link WAKE_HOP_SAMPLES} long.
	 * @returns Score per phrase id, 0 to 1. Ids the scorer does not know are omitted.
	 */
	score(hop: Float32Array, phrases: readonly WakePhrase[]): Record<string, number>;
	dispose?(): void | Promise<void>;
}

/**
 * Throws unless the scorer is local.
 *
 * Exported because the wiring layer resolves the scorer and should fail there,
 * loudly, rather than constructing a detector that quietly does nothing.
 */
export function assertWakeScorerLocal(scorer: WakePhraseScorer): void {
	if (scorer.tier !== 'local') {
		throw new Error(
			'A Cappella wake word refuses a non-local scorer: no audio may leave the machine before a wake phrase fires.'
		);
	}
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** A wake phrase fired. */
export interface WakeDetection {
	phraseId: string;
	/** The phrase as the user says it, for the `wake` event and the HUD. */
	phrase: string;
	/** Where the session this opens is bound. */
	scope: VoiceScope;
	score: number;
	/** Epoch ms, so a debounce and a log line agree on when. */
	at: number;
	/**
	 * The audio immediately around the phrase, oldest frame first.
	 *
	 * Handed to STT ahead of the live frames. Without it, "Maestro, what's the
	 * status" reaches the recogniser as "...what's the status", because the floor
	 * does not open until after the phrase has been said.
	 */
	preRoll: Int16Array[];
}

/** The pre-roll the detection carries. `AudioFrameRing` satisfies it structurally. */
export interface WakePreRoll {
	push(samples: Int16Array): void;
	drain(): Int16Array[];
	clear(): void;
}

export interface WakeDetectorOptions {
	/**
	 * The armed phrases, read per hop rather than captured, so adding an agent
	 * phrase takes effect without restarting the detector.
	 */
	getPhrases: () => readonly WakePhrase[];
	/**
	 * The scorer. Omitted means `start()` builds the ONNX one; null means the
	 * detector runs inert, which is what a machine with no wake model does.
	 */
	scorer?: WakePhraseScorer | null;
	/** Builds the scorer on `start()`. Defaults to {@link createOnnxWakeScorer}. */
	createScorer?: () => Promise<WakePhraseScorer | null>;
	/** Sensitivity for phrases that do not state one. */
	defaultSensitivity?: number;
	/** Minimum gap between two hits of the same phrase. */
	debounceMs?: number;
	/**
	 * The pre-roll buffer.
	 *
	 * Pass the AUDIO PIPELINE's ring when wiring this for real, so there is one
	 * buffer rather than two: a detector with its own copy would hand STT the same
	 * half second the pipeline is about to replay. The default exists so the
	 * detector is usable, and testable, on its own.
	 */
	preRoll?: WakePreRoll;
	/** Pre-roll length when the detector builds its own ring. */
	preRollMs?: number;
	/** A phrase fired. The only outward edge this module has. */
	onWake: (detection: WakeDetection) => void;
	/** Injected clock, for tests. */
	now?: () => number;
}

/** Counters. Every wake-word failure is silent, so it has to be counted to be seen. */
export interface WakeDetectorStats {
	framesReceived: number;
	hopsScored: number;
	detections: number;
	/** Hits suppressed because the same phrase fired inside the debounce window. */
	debounced: number;
	/** Throws out of `score()`. Counted, not propagated: see {@link WakeDetector.pushFrame}. */
	scoreErrors: number;
	/**
	 * Highest score any phrase reached this run, fired or not. The one number
	 * that tells "the model heard nothing" from "it heard you, just under the
	 * threshold", which is the difference between a dead mic and a slider to move.
	 */
	peakScore: number;
	/**
	 * Loudest frame this run, as RMS from 0 to 1. Zero-ish means the microphone
	 * delivered silence (wrong device, a mute, echo cancellation eating the
	 * source); a healthy level with a low peak score means the phrase was heard
	 * and not recognised.
	 */
	peakLevel: number;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export class WakeDetector {
	private readonly options: WakeDetectorOptions;
	private readonly preRoll: WakePreRoll;
	private readonly debounceMs: number;
	private readonly defaultSensitivity: number;
	private readonly now: () => number;

	private scorer: WakePhraseScorer | null = null;
	/**
	 * Whether `stop()` may release the scorer.
	 *
	 * A scorer the detector BUILT holds ONNX sessions and must be freed; a scorer
	 * the caller passed in belongs to the caller, and disposing it would leave a
	 * restarted detector inert with no way to say why.
	 */
	private ownsScorer = false;
	private running = false;
	/** Accumulates 20 ms frames into one 80 ms hop. */
	private readonly hop: Int16Array;
	private hopFill = 0;
	private readonly lastFiredAt = new Map<string, number>();
	private readonly stats: WakeDetectorStats = {
		framesReceived: 0,
		hopsScored: 0,
		detections: 0,
		debounced: 0,
		scoreErrors: 0,
		peakScore: 0,
		peakLevel: 0,
	};

	constructor(options: WakeDetectorOptions) {
		this.options = options;
		if (options.scorer) assertWakeScorerLocal(options.scorer);
		this.scorer = options.scorer ?? null;
		this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS);
		this.defaultSensitivity = options.defaultSensitivity ?? DEFAULT_WAKE_SENSITIVITY;
		this.now = options.now ?? Date.now;
		this.hop = new Int16Array(WAKE_HOP_SAMPLES);
		this.preRoll =
			options.preRoll ??
			new AudioFrameRing(
				Math.max(FRAMES_PER_HOP, Math.round((options.preRollMs ?? 500) / 20)) // 20 ms frames
			);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** True when there is a scorer behind the detector. False means it is inert. */
	get isArmed(): boolean {
		return this.running && this.scorer !== null;
	}

	getStats(): Readonly<WakeDetectorStats> {
		return { ...this.stats };
	}

	/**
	 * Build the scorer and start consuming frames.
	 *
	 * A scorer that cannot be built is NOT an error: a machine that has not
	 * downloaded the wake model has a perfectly good hotkey. The detector runs
	 * inert and says so, and the capability gate is what tells the user why
	 * hands-free is unavailable.
	 */
	async start(): Promise<void> {
		if (this.running) return;
		if (!this.scorer) {
			const build = this.options.createScorer ?? createOnnxWakeScorer;
			try {
				const built = await build();
				if (built) assertWakeScorerLocal(built);
				this.scorer = built;
				this.ownsScorer = built !== null;
			} catch (err) {
				// Classified failures are already remembered by the native loader for
				// the capability gate; anything else is a real bug and goes to Sentry.
				logger.warn(`Wake word scorer unavailable: ${(err as Error).message}`, LOG_CONTEXT);
				this.scorer = null;
			}
		}
		this.running = true;
		this.hopFill = 0;
		this.lastFiredAt.clear();
		logger.info(
			this.scorer ? 'Wake word detector armed' : 'Wake word detector running without a model',
			LOG_CONTEXT
		);
	}

	/**
	 * Stop consuming frames and release the models.
	 *
	 * The pre-roll is cleared: audio held for a wake phrase that will not now be
	 * spoken is audio kept for no reason.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.hopFill = 0;
		this.lastFiredAt.clear();
		this.preRoll.clear();
		if (!this.ownsScorer) return;
		const scorer = this.scorer;
		this.scorer = null;
		this.ownsScorer = false;
		try {
			await scorer?.dispose?.();
		} catch (err) {
			logger.warn(`Wake word scorer dispose failed: ${(err as Error).message}`, LOG_CONTEXT);
		}
	}

	/**
	 * One 20 ms frame.
	 *
	 * Frames go into the pre-roll first and into the hop second, so a phrase that
	 * fires on this hop carries the audio that produced it. Nothing else happens
	 * to them: this method has no path to a provider, a socket, or a file.
	 */
	pushFrame(samples: Int16Array): void {
		if (!this.running) return;
		this.stats.framesReceived += 1;
		let sumSquares = 0;
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i] / INT16_SCALE;
			sumSquares += sample * sample;
		}
		const level = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
		if (level > this.stats.peakLevel) this.stats.peakLevel = level;
		this.preRoll.push(samples);

		let offset = 0;
		while (offset < samples.length) {
			const take = Math.min(WAKE_HOP_SAMPLES - this.hopFill, samples.length - offset);
			this.hop.set(samples.subarray(offset, offset + take), this.hopFill);
			this.hopFill += take;
			offset += take;
			if (this.hopFill === WAKE_HOP_SAMPLES) {
				this.hopFill = 0;
				this.scoreHop();
			}
		}
	}

	// -- Internals -----------------------------------------------------------

	private scoreHop(): void {
		if (!this.scorer) return;

		const phrases = this.options.getPhrases().filter((p) => p.enabled !== false);
		if (!phrases.length) return;

		const hop = new Float32Array(WAKE_HOP_SAMPLES);
		for (let i = 0; i < WAKE_HOP_SAMPLES; i++) hop[i] = this.hop[i] / INT16_SCALE;

		let scores: Record<string, number>;
		try {
			scores = this.scorer.score(hop, phrases);
		} catch (err) {
			// Counted rather than thrown, for the same reason the audio pipeline
			// counts feed errors: this runs fifty times a second on an audio callback,
			// and one bad inference must not become fifty unhandled exceptions.
			this.stats.scoreErrors += 1;
			if (this.stats.scoreErrors === 1) {
				logger.error(`Wake word scoring failed: ${(err as Error).message}`, LOG_CONTEXT);
				void captureException(err as Error, { context: 'acappella.wakeDetector.score' });
			}
			return;
		}
		this.stats.hopsScored += 1;
		for (const value of Object.values(scores)) {
			if (typeof value === 'number' && value > this.stats.peakScore) this.stats.peakScore = value;
		}

		// Best match wins rather than first: two phrases can clear their thresholds
		// on the same hop, and firing both would open two sessions for one sentence.
		let best: { phrase: WakePhrase; score: number } | null = null;
		for (const phrase of phrases) {
			const score = scores[phrase.id];
			if (typeof score !== 'number' || Number.isNaN(score)) continue;
			if (score < wakeThresholdFor(phrase, this.defaultSensitivity)) continue;
			if (!best || score > best.score) best = { phrase, score };
		}
		if (!best) return;

		const at = this.now();
		const last = this.lastFiredAt.get(best.phrase.id);
		if (last !== undefined && at - last < this.debounceMs) {
			this.stats.debounced += 1;
			return;
		}
		this.lastFiredAt.set(best.phrase.id, at);
		this.stats.detections += 1;

		this.emit({
			phraseId: best.phrase.id,
			phrase: best.phrase.phrase,
			scope: best.phrase.scope,
			score: best.score,
			at,
			// Drained, not copied: the frames are being handed to STT, and leaving
			// them in the ring would replay the same half second again when the floor
			// opens.
			preRoll: this.preRoll.drain(),
		});
	}

	private emit(detection: WakeDetection): void {
		logger.info(
			`Wake phrase '${detection.phrase}' fired (${detection.score.toFixed(2)})`,
			LOG_CONTEXT
		);
		try {
			this.options.onWake(detection);
		} catch (err) {
			// A subscriber's failure is not the detector's failure; swallowing it here
			// keeps the always-on path alive for the next phrase.
			logger.error(`Wake handler threw: ${(err as Error).message}`, LOG_CONTEXT);
			void captureException(err as Error, { context: 'acappella.wakeDetector.onWake' });
		}
	}
}

/** Sugar, matching the rest of A Cappella's factories. */
export function createWakeDetector(options: WakeDetectorOptions): WakeDetector {
	return new WakeDetector(options);
}

// ---------------------------------------------------------------------------
// The ONNX scorer
// ---------------------------------------------------------------------------

/** The `onnxruntime-node` surface used here, structurally. */
interface OnnxTensorCtor {
	new (type: string, data: Float32Array, dims: number[]): OnnxTensor;
}

interface OnnxTensor {
	data: Float32Array;
	dims: readonly number[];
}

interface OnnxSession {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

interface OnnxRuntime {
	InferenceSession: { create(path: string): Promise<OnnxSession> };
	Tensor: OnnxTensorCtor;
}

/** Mel frames the embedding graph consumes at once. A property of the trained model. */
const EMBEDDING_WINDOW_MEL_FRAMES = 76;

/** Embeddings the per-phrase classifier consumes at once. Also a property of the model. */
const CLASSIFIER_WINDOW_EMBEDDINGS = 16;

/** Mel bins openWakeWord's front end produces. */
const MEL_BINS = 32;

/**
 * Samples of the previous hop fed in front of each new one.
 *
 * The mel graph is unpadded with a 160-sample stride, so a 1280-sample hop on
 * its own yields fewer frames than the hop covers. openWakeWord's reference
 * streams the last 480 samples ahead of each hop and keeps the newest frames.
 */
const MEL_CONTEXT_SAMPLES = 480;

/** Mel frames per 80 ms hop: one per 160-sample stride. */
const MEL_FRAMES_PER_HOP = 8;

/**
 * Hops allowed to wait behind a slow inference chain before the stream is reset.
 * About two seconds: past that the scores describe audio the user finished
 * saying long ago, and the rolling windows would splice two moments together.
 */
const MAX_PENDING_HOPS = 25;

/**
 * The real openWakeWord front end: mel spectrogram, then embedding, then one
 * small classifier per phrase.
 *
 * Returns null when the runtime or the model files are missing, which is the
 * ordinary state of a machine that has not opted into hands-free. The caller
 * runs the detector inert rather than failing: the capability gate is where a
 * missing model becomes a sentence the user can act on.
 *
 * A phrase's classifier is resolved from its TEXT through `wakeClassifierPath`:
 * only pretrained phrases have one. A phrase with no classifier is simply never
 * scored, so a custom phrase that was never trained cannot fire on another
 * phrase's model.
 *
 * **The front end must match openWakeWord's reference exactly**, and it did not:
 * three departures together scored a clear "hey jarvis" at 0.009 where the
 * reference scores 0.999. The mel graph takes samples at INT16 scale (not
 * [-1, 1]); each hop needs the previous 480 samples in front of it; and the mel
 * output is rescaled `x / 10 + 2` before the embedding graph sees it.
 */
export async function createOnnxWakeScorer(): Promise<WakePhraseScorer | null> {
	let ort: OnnxRuntime;
	try {
		ort = await loadLocalRuntime<OnnxRuntime>('onnx', WAKE_WORD_PROVIDER_ID);
	} catch (err) {
		logger.info(`Wake word runtime unavailable: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}

	let melSession: OnnxSession;
	let embeddingSession: OnnxSession;
	try {
		melSession = await ort.InferenceSession.create(
			modelFilePath(OPENWAKEWORD_BASE_ID, 'melspectrogram.onnx')
		);
		embeddingSession = await ort.InferenceSession.create(
			modelFilePath(OPENWAKEWORD_BASE_ID, 'embedding_model.onnx')
		);
	} catch (err) {
		logger.info(`Wake word models unavailable: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}

	/** Keyed by classifier file, so two phrase ids sharing a phrase share a session. */
	const classifiers = new Map<string, OnnxSession | null>();
	/** Rolling mel frames, and rolling embeddings. Both are the model's own memory. */
	const melRing: Float32Array[] = [];
	const embeddingRing: Float32Array[] = [];
	/** The tail of the previous hop, at int16 scale, fed in front of the next one. */
	let context = new Float32Array(0);
	/** The scores from the last completed classifier window, per phrase. */
	let latest: Record<string, number> = {};
	/**
	 * Hops waiting for the chain. Queued rather than dropped: the windows are a
	 * continuous stream, so a skipped hop is a hole in the audio the classifier
	 * then scores as if it were contiguous.
	 */
	const pending: Array<{ hop: Float32Array; phrases: readonly WakePhrase[] }> = [];
	let draining = false;

	function resetStream(): void {
		melRing.length = 0;
		embeddingRing.length = 0;
		context = new Float32Array(0);
	}

	async function classifierFor(phrase: WakePhrase): Promise<OnnxSession | null> {
		const path = wakeClassifierPath(phrase.phrase);
		if (!path) {
			if (!classifiers.has(`untrained:${phrase.id}`)) {
				classifiers.set(`untrained:${phrase.id}`, null);
				logger.info(
					`No wake classifier was trained for '${phrase.phrase}'; it will never fire`,
					LOG_CONTEXT
				);
			}
			return null;
		}
		const cached = classifiers.get(path);
		if (cached !== undefined) return cached;
		let session: OnnxSession | null = null;
		try {
			session = await ort.InferenceSession.create(path);
		} catch (err) {
			logger.info(
				`Wake classifier for '${phrase.phrase}' could not be opened: ${(err as Error).message}`,
				LOG_CONTEXT
			);
		}
		classifiers.set(path, session);
		return session;
	}

	async function advance(hop: Float32Array, phrases: readonly WakePhrase[]): Promise<void> {
		// Int16 scale, previous tail in front.
		const input = new Float32Array(context.length + hop.length);
		input.set(context, 0);
		for (let i = 0; i < hop.length; i++) input[context.length + i] = hop[i] * 32768;
		context = input.slice(Math.max(0, input.length - MEL_CONTEXT_SAMPLES));

		const melOut = await melSession.run({
			[melSession.inputNames[0]]: new ort.Tensor('float32', input, [1, input.length]),
		});
		const mel = melOut[melSession.outputNames[0]];
		const frames: Float32Array[] = [];
		for (let i = 0; i + MEL_BINS <= mel.data.length; i += MEL_BINS) {
			const frame = mel.data.slice(i, i + MEL_BINS);
			for (let j = 0; j < frame.length; j++) frame[j] = frame[j] / 10 + 2;
			frames.push(frame);
		}
		// The context overlaps the previous hop; only the newest frames are new.
		melRing.push(...frames.slice(-MEL_FRAMES_PER_HOP));
		while (melRing.length > EMBEDDING_WINDOW_MEL_FRAMES) melRing.shift();
		if (melRing.length < EMBEDDING_WINDOW_MEL_FRAMES) return;

		const melWindow = new Float32Array(EMBEDDING_WINDOW_MEL_FRAMES * MEL_BINS);
		melRing.forEach((frame, index) => melWindow.set(frame, index * MEL_BINS));
		const embedOut = await embeddingSession.run({
			[embeddingSession.inputNames[0]]: new ort.Tensor('float32', melWindow, [
				1,
				EMBEDDING_WINDOW_MEL_FRAMES,
				MEL_BINS,
				1,
			]),
		});
		const embedding = embedOut[embeddingSession.outputNames[0]];
		embeddingRing.push(Float32Array.from(embedding.data));
		while (embeddingRing.length > CLASSIFIER_WINDOW_EMBEDDINGS) embeddingRing.shift();
		if (embeddingRing.length < CLASSIFIER_WINDOW_EMBEDDINGS) return;

		const width = embeddingRing[0].length;
		const window = new Float32Array(CLASSIFIER_WINDOW_EMBEDDINGS * width);
		embeddingRing.forEach((vector, index) => window.set(vector, index * width));

		const next: Record<string, number> = {};
		for (const phrase of phrases) {
			const session = await classifierFor(phrase);
			if (!session) continue;
			const out = await session.run({
				[session.inputNames[0]]: new ort.Tensor('float32', window, [
					1,
					CLASSIFIER_WINDOW_EMBEDDINGS,
					width,
				]),
			});
			next[phrase.id] = out[session.outputNames[0]].data[0];
		}
		latest = next;
	}

	async function drain(): Promise<void> {
		draining = true;
		try {
			while (pending.length > 0) {
				const { hop, phrases } = pending.shift()!;
				try {
					await advance(hop, phrases);
				} catch (err) {
					logger.warn(`Wake inference failed: ${(err as Error).message}`, LOG_CONTEXT);
					resetStream();
				}
			}
		} finally {
			draining = false;
		}
	}

	return {
		tier: 'local',
		/**
		 * Synchronous by contract, asynchronous underneath.
		 *
		 * The hop is queued for the inference chain and the latest COMPLETED
		 * window's scores are returned. A hop arrives every 80 ms and a chain takes
		 * a few milliseconds, so the queue is normally empty; awaiting the chain
		 * inside an audio callback would make the microphone path wait on the CPU.
		 */
		score(hop, phrases) {
			if (pending.length >= MAX_PENDING_HOPS) {
				// The CPU is not keeping up. Start the stream over rather than score a
				// window stitched from two different moments.
				pending.length = 0;
				resetStream();
			}
			pending.push({ hop: Float32Array.from(hop), phrases });
			if (!draining) void drain();
			return latest;
		},
		async dispose() {
			latest = {};
			pending.length = 0;
			resetStream();
			await melSession.release?.();
			await embeddingSession.release?.();
			for (const session of classifiers.values()) await session?.release?.();
			classifiers.clear();
		},
	};
}
