/**
 * The Sketch Book guardrail gate (spec sections 8.2 to 8.4 and 8.8): every
 * third-party input passes here before an agent can read it, and it fails
 * closed.
 *
 * - {@link SketchGuardrail.screenText} decides one value: a guest's `@bot`
 *   chat (I1) or one element's screened canvas text (I2). It scores through
 *   the neutral `scoreInjectionText()` with a 60 s deadline. `off`,
 *   `unavailable`, a timeout, a throw, or a cloud engine the room has not
 *   confirmed are all `unscreened`; a score at or above
 *   `DEFAULT_INJECTION_THRESHOLD` is `flagged`.
 * - Conductor and bot input skips the screen. Canvas text is third-party when
 *   a guest has ever written it (`guestTouched`) or its author is unknown (a
 *   snapshot delivered it), so a conductor move of a guest element is still
 *   screened (spec section 7).
 * - Cloud screening (section 8.10). A cloud engine is used only when the
 *   cloud policy allows it for the room (consent, live confirmation, and the
 *   server's `screening: cloud` echo; `sketch-cloud-consent.ts` registers the
 *   policy with {@link setSketchCloudScreeningPolicy}, and until it does no
 *   cloud engine is ever used). H1: text written before the room's `since`
 *   (or with no write time) never goes to the cloud engine. It is screened on
 *   an installed local classifier, resolved explicitly, or left `unscreened`.
 *   The check runs again on the source the run actually resolved
 *   (`allowSource`), so an engine switch mid-call cannot leak text.
 * - The verdict cache (section 8.4) keys a verdict by the source that gave it
 *   and `sha256` of the screened text, so a move or restyle never rescans and
 *   a cloud verdict is never reused for text that must stay local. Bounded
 *   (10,000 entries) and cleared when the `injection-screen` assignment
 *   changes. Only scores are cached, never `unscreened`.
 * - The report rule: at most one canvas `guardrail_rejected` per
 *   `(actorId, elementId)`, only for `flagged`, only with the `opSeq` of the
 *   op that delivered the version. Reports go out as `canvas-report` events
 *   on {@link sketchGuardrailEvents}; the room client sends the frame.
 * - The eager canvas pass screens an element once its text has been unchanged
 *   for 3 s, so a flag reaches the server close to the edit.
 * - The audit log `userData/sketches/<agentId>/<sketchId>.audit.jsonl`: one
 *   line per decision, never the text or an excerpt (section 8.8).
 * - D2 (section 8.3 rule 7): {@link visibleWhenOff} lets `unscreened` guest
 *   canvas text through, labelled, only when the task is `off` and the turn is
 *   restricted.
 *
 * {@link screenForAgent} is the batch entry the read tools, the renders and
 * the digest call.
 */

import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	DEFAULT_INJECTION_THRESHOLD,
	type InjectionScore,
	type InjectionSourceInfo,
	type InjectionSourceResolution,
} from '../../shared/local-models/injection-screen';
import {
	formatLocalModelAssignmentSpec,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import { sketchRestrictedPostureBlocker } from '../../shared/sketch/restricted-posture';
import type {
	SketchActor,
	SketchActorKind,
	SketchScreenLocality,
	SketchScreenStatus,
	SketchScreenVerdict,
	SketchTurnPosture,
	WithheldReason,
} from '../../shared/sketch/types';
import {
	resolveInjectionSource,
	resolveLocalInjectionClassifier,
	scoreInjectionText,
	type InjectionScoreRequest,
	type LocalInjectionClassifier,
} from '../local-models/injection-screen';
import { readLocalModelAssignments } from '../local-models/sources';
import { getLiveSessions } from '../stores/getters';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getSketchStore } from './sketch-store';

const LOG_CTX = '[SketchBook][Guardrail]';

/** The gate's own deadline for one score (spec section 8.7). Past it the text is `unscreened`. */
export const SKETCH_SCREEN_TIMEOUT_MS = 60_000;

/** Verdicts the cache holds (spec section 8.4). */
export const SKETCH_VERDICT_CACHE_SIZE = 10_000;

/** How long canvas text must stay unchanged before the eager pass screens it (section 8.4). */
export const SKETCH_EAGER_SCREEN_DELAY_MS = 3_000;

/** The audit log beside each scene (section 8.8). */
export const SKETCH_AUDIT_EXTENSION = '.audit.jsonl';

/** Scores in flight at once for one batch, so a 500-element read does not swamp the model. */
const SCREEN_CONCURRENCY = 4;

/** The source labels of decisions no model made. */
const LABEL_NO_TEXT = 'No text';
const LABEL_SCREEN_OFF = 'Screen off';
const LABEL_SCREEN_UNAVAILABLE = 'Screen unavailable';
const LABEL_NO_LOCAL_CLASSIFIER = 'No local classifier';

export type { SketchScreenLocality, SketchScreenStatus, SketchScreenVerdict, SketchTurnPosture };

/** The value being screened (spec section 8.2). */
export type SketchScreenSubject =
	| {
			kind: 'chat';
			/** The chat message id the bot would reply to. */
			replyTo: string;
			/** The server `chat.ts` (ms). Missing counts as written before any `since` (H1). */
			ts?: number;
	  }
	| {
			kind: 'canvas';
			elementId: string;
			version: number;
			/** From the author map: a guest has ever written the text. */
			guestTouched?: boolean;
			/** From the author map: server `ts` of the latest guest text op. Missing counts as older (H1). */
			guestTextAt?: number;
			/** The op that delivered this version; absent for a snapshot (no server report then). */
			opSeq?: number;
	  };

export interface SketchScreenTextRequest {
	sketchId: string;
	subject: SketchScreenSubject;
	/** The envelope actor of the subject, or null when unknown (snapshot-delivered). */
	actor: SketchActor | null;
	/** The screened text: the chat body, or the element's screened fields joined. */
	text: string;
	/** The agent the text is for, kept on the decision record. */
	agentId?: string;
}

/** A canvas report the room client sends as `guardrail_rejected {opSeq, reason}`. */
export interface SketchCanvasReport {
	sketchId: string;
	opSeq: number;
	reason: 'injection';
}

/**
 * What the cloud consent module decides (spec section 8.10, G2 to G4, H1).
 * `sketch-cloud-consent.ts` registers the real one.
 */
export interface SketchCloudScreeningPolicy {
	/** A consent exists for this engine (and OpenJev host). B2 availability reads it. */
	hasConsent(source: InjectionSourceInfo): boolean;
	/** Consent, live confirmation, and the server's `cloud` echo for this room. */
	isCloudScreeningAllowed(sketchId: string, source: InjectionSourceInfo): boolean;
	/** The server's `since` (ms) for the room's cloud screening, or null when not confirmed. */
	cloudScreeningSince(sketchId: string): number | null;
}

/** Until the consent module registers, no cloud engine is ever used (G1). */
const NO_CLOUD_SCREENING: SketchCloudScreeningPolicy = {
	hasConsent: () => false,
	isCloudScreeningAllowed: () => false,
	cloudScreeningSince: () => null,
};

/** One audit line (spec section 8.8). Never the text, never an excerpt. */
export interface SketchAuditEntry {
	ts: number;
	sketchId: string;
	subject: { replyTo: string } | { elementId: string; version: number };
	actor: { id: string; kind: SketchActorKind; capId?: string } | null;
	status: SketchScreenStatus;
	score?: number;
	source: string;
	locality: SketchScreenLocality;
	reported: boolean;
}

export interface SketchGuardrailDeps {
	score?: (request: InjectionScoreRequest) => Promise<InjectionScore>;
	resolveSource?: () => Promise<InjectionSourceResolution>;
	resolveLocalClassifier?: () => Promise<LocalInjectionClassifier | null>;
	/** The `injection-screen` assignment as one string; the cache clears when it changes. */
	assignmentKey?: () => string;
	/** Where a sketch's audit log lives, or null when the sketch is unknown. */
	auditPath?: (sketchId: string) => Promise<string | null>;
	appendAudit?: (filePath: string, line: string) => Promise<void>;
	/** Why the agent's provider cannot run restricted turns, or null when it can. */
	restrictedPostureBlocker?: (agentId: string) => string | null;
	now?: () => number;
	timeoutMs?: number;
	eagerDelayMs?: number;
	cacheSize?: number;
}

/** A Map in least-recently-used order, cut to `limit`. */
class LruMap<K, V> {
	private readonly entries = new Map<K, V>();
	constructor(private readonly limit: number) {}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > this.limit) {
			this.entries.delete(this.entries.keys().next().value as K);
		}
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

/** Events for the room client: `canvas-report` with a {@link SketchCanvasReport}. */
export const sketchGuardrailEvents = new EventEmitter();

let cloudPolicy: SketchCloudScreeningPolicy = NO_CLOUD_SCREENING;

/** Register the cloud consent policy (section 8.10). Pass null to fall back to "never cloud". */
export function setSketchCloudScreeningPolicy(policy: SketchCloudScreeningPolicy | null): void {
	cloudPolicy = policy ?? NO_CLOUD_SCREENING;
}

/** The policy in force. */
export function getSketchCloudScreeningPolicy(): SketchCloudScreeningPolicy {
	return cloudPolicy;
}

/** `sha256` of the screened text, lowercase hex: the verdict cache key (section 8.4). */
export function sketchScreenHash(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The text the gate scores for an element: its screened fields
 * (`sketchTextFields()` order), empty ones dropped and repeats folded, so a
 * text element's `text` and `originalText` are read once.
 */
export function sketchScreenText(fields: readonly (string | null)[]): string {
	const seen = new Set<string>();
	for (const field of fields) {
		if (field && field.trim()) seen.add(field);
	}
	return [...seen].join('\n');
}

/**
 * Whether the gate must screen the value (spec sections 7 and 8.2): chat from
 * a guest, or canvas text a guest has ever written or whose author is unknown.
 * Conductor and bot input skips it.
 */
export function isThirdPartySubject(
	subject: SketchScreenSubject,
	actor: SketchActor | null
): boolean {
	if (subject.kind === 'chat') return actor?.kind === 'guest';
	return actor === null || subject.guestTouched === true;
}

/**
 * D2 (spec section 8.3 rule 7): whether `unscreened` guest canvas text may
 * reach the agent anyway, labelled `unscreened: true`. Only when the task is
 * `off` AND the turn is restricted. Never for `unavailable`, a timeout, a
 * flag, missing consent or pre-`since` text (none of those is `off`), never
 * on a full-access turn, never for chat or a guest image.
 */
export function visibleWhenOff({
	verdict,
	posture,
	kind,
}: {
	verdict: SketchScreenVerdict;
	posture: SketchTurnPosture;
	kind: 'canvas' | 'chat' | 'image';
}): boolean {
	return (
		kind === 'canvas' &&
		verdict.status === 'unscreened' &&
		verdict.off === true &&
		posture === 'restricted'
	);
}

/** A source's identity in the cache: verdicts never cross sources. */
function sourceKey(source: InjectionSourceInfo): string {
	return `${source.kind}|${source.host ?? ''}|${source.label}`;
}

/** The subject in log and audit form. */
function auditSubject(subject: SketchScreenSubject): SketchAuditEntry['subject'] {
	return subject.kind === 'chat'
		? { replyTo: subject.replyTo }
		: { elementId: subject.elementId, version: subject.version };
}

/** The H1 write time: `chat.ts` for chat, `guestTextAt` for canvas. */
function writtenAt(subject: SketchScreenSubject): number | undefined {
	return subject.kind === 'chat' ? subject.ts : subject.guestTextAt;
}

function isSourceInfo(resolution: InjectionSourceResolution): resolution is InjectionSourceInfo {
	return !('status' in resolution);
}

/** Why `isB2Available()` says no. */
export type SketchB2Availability = { ok: true } | { ok: false; reason: string };

/** One element version the batch entry decides (spec section 8.2, I2 and I3). */
export interface AgentScreenSubject {
	elementId: string;
	version: number;
	type: string;
	/** Envelope actor of the current version, or null when unknown (section 7). */
	author: SketchActor | null;
	/** The author map's text hash for this version (section 8.4), when it has one. */
	textHash?: string;
	/** From the author map: a guest has ever written the text. */
	guestTouched?: boolean;
	/** From the author map: server `ts` of the latest guest text op (H1). */
	guestTextAt?: number;
	/** The op that delivered this version, for the one server report. */
	opSeq?: number;
	/** The screened fields, `sketchTextFields()` order: text, originalText, name, link. */
	fields: (string | null)[];
}

export interface AgentScreenRequest {
	sketchId: string;
	/** The agent that will read the result. */
	agentId: string;
	/**
	 * The posture of the turn reading the result. Defaults to `full`, so D2
	 * never applies unless the caller says the turn is restricted.
	 */
	posture?: SketchTurnPosture;
	subjects: AgentScreenSubject[];
}

/**
 * What the gate decided for one subject. `clear` with `unscreened` is D2:
 * the caller must label the element so the agent knows nobody checked it.
 */
export type AgentScreenVerdict =
	| { status: 'clear'; unscreened?: true }
	| { status: 'withheld'; reason: WithheldReason };

export interface SketchGuardrail {
	screenText(request: SketchScreenTextRequest): Promise<SketchScreenVerdict>;
	screenForAgent(request: AgentScreenRequest): Promise<Map<string, AgentScreenVerdict>>;
	/** Note canvas text for the eager pass; it is screened once unchanged for 3 s. */
	noteCanvasText(request: SketchScreenTextRequest): void;
	/** Drop a sketch's pending eager screens (the sketch closed). */
	cancelEager(sketchId: string): void;
	/**
	 * Whether B2 (guests may ask the bot) can be offered for the agent's
	 * sketches: never while the screen is `off` or unusable, while the engine
	 * is cloud without consent, or on a provider that cannot run restricted
	 * turns (`sketchRestrictedPostureBlocker()`, risk K1).
	 */
	isB2Available(input: { agentId: string }): Promise<SketchB2Availability>;
	clearVerdictCache(): void;
	/** Stop every timer. */
	dispose(): void;
}

/** The default audit location: beside the scene, under the owning agent. */
async function defaultAuditPath(sketchId: string): Promise<string | null> {
	const store = getSketchStore();
	const record = await store.getSketch(sketchId);
	if (!record) return null;
	return path.join(
		store.sketchesDir(),
		record.ownerAgentId,
		`${sketchId}${SKETCH_AUDIT_EXTENSION}`
	);
}

function defaultAssignmentKey(): string {
	return formatLocalModelAssignmentSpec(
		resolveLocalModelAssignment(readLocalModelAssignments(), 'injection-screen')
	);
}

/**
 * Why the agent `agentId` cannot run a restricted turn (risk K1), or null.
 * Read by `isB2Available()` and by bot turn delivery (sketch-bot-turns.ts).
 */
export function sketchAgentRestrictedPostureBlocker(agentId: string): string | null {
	const session = getLiveSessions().find((candidate) => candidate.id === agentId);
	if (!session) return 'The owner agent was removed.';
	return sketchRestrictedPostureBlocker(
		session.toolType,
		getAgentDefinition(session.toolType)?.readOnlyArgs
	);
}

export function createSketchGuardrail(deps: SketchGuardrailDeps = {}): SketchGuardrail {
	const score = deps.score ?? scoreInjectionText;
	const resolveSource = deps.resolveSource ?? resolveInjectionSource;
	const resolveLocalClassifier = deps.resolveLocalClassifier ?? resolveLocalInjectionClassifier;
	const assignmentKey = deps.assignmentKey ?? defaultAssignmentKey;
	const auditPath = deps.auditPath ?? defaultAuditPath;
	const appendAudit =
		deps.appendAudit ?? ((filePath: string, line: string) => fs.appendFile(filePath, line, 'utf8'));
	const restrictedPostureBlocker =
		deps.restrictedPostureBlocker ?? sketchAgentRestrictedPostureBlocker;
	const now = deps.now ?? Date.now;
	const timeoutMs = deps.timeoutMs ?? SKETCH_SCREEN_TIMEOUT_MS;
	const eagerDelayMs = deps.eagerDelayMs ?? SKETCH_EAGER_SCREEN_DELAY_MS;
	const cacheSize = deps.cacheSize ?? SKETCH_VERDICT_CACHE_SIZE;

	/** `sourceKey|textHash` -> the score that source gave. */
	const verdicts = new LruMap<string, { score: number; source: InjectionSourceInfo }>(cacheSize);
	let cachedAssignment: string | undefined;
	/** `sketchId|actorId|elementId` pairs already reported to the server. */
	const reported = new LruMap<string, true>(cacheSize);
	/** Decisions already written to the audit log, so repeated reads add no lines. */
	const audited = new LruMap<string, true>(cacheSize);
	const auditQueue = createKeyedWriteQueue();
	/** `sketchId|elementId` -> the pending eager screen. */
	const eager = new Map<string, { hash: string; timer: ReturnType<typeof setTimeout> }>();

	/** Clear the cache when the `injection-screen` assignment changed (section 8.4). */
	function syncCacheWithAssignment(): void {
		const key = assignmentKey();
		if (cachedAssignment !== undefined && cachedAssignment !== key) {
			verdicts.clear();
			logger.info('Injection screen reassigned: verdict cache cleared', LOG_CTX);
		}
		cachedAssignment = key;
	}

	/**
	 * Whether `source` may score text written at `at` for this room: a local
	 * source always; a cloud one only under the room's policy and H1.
	 */
	function allows(sketchId: string, at: number | undefined, source: InjectionSourceInfo): boolean {
		if (source.locality === 'local') return true;
		if (!cloudPolicy.isCloudScreeningAllowed(sketchId, source)) return false;
		const since = cloudPolicy.cloudScreeningSince(sketchId);
		return since !== null && at !== undefined && at >= since;
	}

	/** One score inside the gate's deadline. A timeout resolves `unavailable`. */
	async function scoreWithDeadline(
		request: Omit<InjectionScoreRequest, 'signal'>
	): Promise<InjectionScore> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<InjectionScore>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({ status: 'unavailable', reason: 'The screen took too long to answer.' });
			}, timeoutMs);
		});
		const scoring = score({ ...request, signal: controller.signal });
		// A throw after the deadline won is still a bug: report it rather than
		// leave it unhandled. Before the deadline the race rethrows it.
		scoring.catch((error: unknown) => {
			if (controller.signal.aborted) {
				void captureException(error, { context: 'sketch-guardrail late score' });
			}
		});
		try {
			return await Promise.race([scoring, deadline]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function writeAudit(entry: SketchAuditEntry): Promise<void> {
		const filePath = await auditPath(entry.sketchId);
		if (!filePath) {
			logger.warn('Audit line not written: unknown sketch', LOG_CTX, { sketchId: entry.sketchId });
			return;
		}
		await auditQueue.enqueue(filePath, () => appendAudit(filePath, `${JSON.stringify(entry)}\n`));
	}

	/** Record the decision, apply the report rule, and return it. */
	function decide(
		request: SketchScreenTextRequest,
		verdict: SketchScreenVerdict
	): SketchScreenVerdict {
		const { sketchId, subject, actor } = request;
		let result = verdict;
		if (
			subject.kind === 'canvas' &&
			verdict.status === 'flagged' &&
			subject.opSeq !== undefined &&
			actor
		) {
			const pair = `${sketchId}|${actor.id}|${subject.elementId}`;
			if (!reported.has(pair)) {
				const report: SketchCanvasReport = { sketchId, opSeq: subject.opSeq, reason: 'injection' };
				// Marked only when a room client took it, so an unshared sketch can
				// still report once a room is listening.
				if (sketchGuardrailEvents.emit('canvas-report', report)) {
					reported.set(pair, true);
					result = { ...verdict, reported: true };
				}
			}
		}

		const subjectKey =
			subject.kind === 'chat'
				? `chat:${subject.replyTo}`
				: `${subject.elementId}@${subject.version}`;
		const auditKey = `${sketchId}|${subjectKey}|${result.status}|${result.sourceLabel}|${result.reported ? 1 : 0}`;
		if (!audited.has(auditKey)) {
			audited.set(auditKey, true);
			const entry: SketchAuditEntry = {
				ts: now(),
				sketchId,
				subject: auditSubject(subject),
				actor: actor
					? { id: actor.id, kind: actor.kind, ...(actor.capId ? { capId: actor.capId } : {}) }
					: null,
				status: result.status,
				...(result.score !== undefined ? { score: result.score } : {}),
				source: result.sourceLabel,
				locality: result.locality,
				// Chat always ends in `guardrail_rejected` unless clean (rule 4).
				reported: subject.kind === 'chat' ? result.status !== 'clean' : result.reported === true,
			};
			writeAudit(entry).catch((error: unknown) => {
				logger.warn('Audit line not written', LOG_CTX, {
					sketchId,
					error: error instanceof Error ? error.message : String(error),
				});
				void captureException(error, { context: 'sketch-guardrail audit', sketchId });
			});
		}
		return result;
	}

	function unscreened(
		request: SketchScreenTextRequest,
		reason: string,
		sourceLabel: string,
		locality: SketchScreenLocality,
		extra: { off?: true } = {}
	): SketchScreenVerdict {
		return decide(request, { status: 'unscreened', reason, sourceLabel, locality, ...extra });
	}

	function fromScore(
		request: SketchScreenTextRequest,
		value: number,
		source: InjectionSourceInfo
	): SketchScreenVerdict {
		return decide(request, {
			status: value >= DEFAULT_INJECTION_THRESHOLD ? 'flagged' : 'clean',
			score: value,
			sourceLabel: source.label,
			locality: source.locality,
		});
	}

	async function screenOnce(request: SketchScreenTextRequest): Promise<SketchScreenVerdict> {
		const { sketchId, subject, text } = request;
		syncCacheWithAssignment();
		if (!text.trim()) {
			return decide(request, { status: 'clean', sourceLabel: LABEL_NO_TEXT, locality: 'local' });
		}

		const resolved = await resolveSource();
		if (!isSourceInfo(resolved)) {
			return resolved.status === 'off'
				? unscreened(
						request,
						'The prompt-injection screen is off. Assign it a model in Settings > Models.',
						LABEL_SCREEN_OFF,
						'local',
						{ off: true }
					)
				: unscreened(request, resolved.reason, LABEL_SCREEN_UNAVAILABLE, 'local');
		}

		const at = writtenAt(subject);
		let route: { source: InjectionSourceInfo; localModelId?: string } = { source: resolved };
		if (resolved.locality === 'cloud') {
			if (!cloudPolicy.isCloudScreeningAllowed(sketchId, resolved)) {
				return unscreened(
					request,
					`Screening on ${resolved.label} is not confirmed for this room.`,
					resolved.label,
					'cloud'
				);
			}
			const since = cloudPolicy.cloudScreeningSince(sketchId);
			if (since === null || at === undefined || at < since) {
				// H1: written under a local-screening promise. Never the cloud engine.
				const local = await resolveLocalClassifier();
				if (!local) {
					return unscreened(
						request,
						'Written before cloud screening started, and no local classifier is installed.',
						LABEL_NO_LOCAL_CLASSIFIER,
						'local'
					);
				}
				route = { source: local.source, localModelId: local.modelId };
			}
		}

		const hash = sketchScreenHash(text);
		const cached = verdicts.get(`${sourceKey(route.source)}|${hash}`);
		if (cached) return fromScore(request, cached.score, cached.source);

		let used: InjectionSourceInfo | undefined;
		const result = await scoreWithDeadline({
			text,
			purpose: 'sketch-book',
			label: `${sketchId}.${subject.kind === 'chat' ? subject.replyTo : subject.elementId}`,
			...(request.agentId ? { agentId: request.agentId } : {}),
			...(route.localModelId ? { localModelId: route.localModelId } : {}),
			allowSource: (source) => {
				used = source;
				return allows(sketchId, at, source);
			},
		});
		const source = used ?? route.source;
		switch (result.status) {
			case 'scored':
				verdicts.set(`${sourceKey(source)}|${hash}`, { score: result.score, source });
				return fromScore(request, result.score, source);
			case 'off':
				// Reassigned to off while the call was being set up.
				return unscreened(request, result.reason, LABEL_SCREEN_OFF, 'local', { off: true });
			case 'unavailable':
				return unscreened(request, result.reason, source.label, source.locality);
		}
	}

	async function screenText(request: SketchScreenTextRequest): Promise<SketchScreenVerdict> {
		if (!isThirdPartySubject(request.subject, request.actor)) {
			return {
				status: 'clean',
				sourceLabel: 'Not third-party',
				locality: 'local',
				skipped: true,
			};
		}
		try {
			return await screenOnce(request);
		} catch (error) {
			// A bug, never an expected failure: report it, and still fail closed.
			logger.error('Injection screen threw', LOG_CTX, {
				sketchId: request.sketchId,
				error: error instanceof Error ? error.message : String(error),
			});
			void captureException(error, { context: 'sketch-guardrail screenText' });
			return unscreened(
				request,
				'The screen failed unexpectedly.',
				LABEL_SCREEN_UNAVAILABLE,
				'local'
			);
		}
	}

	async function screenForAgent(
		request: AgentScreenRequest
	): Promise<Map<string, AgentScreenVerdict>> {
		const posture = request.posture ?? 'full';
		const results = new Map<string, AgentScreenVerdict>();
		const queue = [...request.subjects];
		const worker = async () => {
			for (let subject = queue.shift(); subject; subject = queue.shift()) {
				const verdict = await screenText({
					sketchId: request.sketchId,
					agentId: request.agentId,
					actor: subject.author,
					text: sketchScreenText(subject.fields),
					subject: {
						kind: 'canvas',
						elementId: subject.elementId,
						version: subject.version,
						...(subject.guestTouched !== undefined ? { guestTouched: subject.guestTouched } : {}),
						...(subject.guestTextAt !== undefined ? { guestTextAt: subject.guestTextAt } : {}),
						...(subject.opSeq !== undefined ? { opSeq: subject.opSeq } : {}),
					},
				});
				if (verdict.status === 'clean') {
					results.set(subject.elementId, { status: 'clear' });
				} else if (visibleWhenOff({ verdict, posture, kind: 'canvas' })) {
					results.set(subject.elementId, { status: 'clear', unscreened: true });
				} else {
					results.set(subject.elementId, { status: 'withheld', reason: verdict.status });
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(SCREEN_CONCURRENCY, queue.length) }, () => worker())
		);
		return results;
	}

	function noteCanvasText(request: SketchScreenTextRequest): void {
		if (request.subject.kind !== 'canvas') return;
		if (!isThirdPartySubject(request.subject, request.actor)) return;
		const key = `${request.sketchId}|${request.subject.elementId}`;
		const hash = sketchScreenHash(request.text);
		const pending = eager.get(key);
		// A move or restyle keeps the clock running; only a text change restarts it.
		if (pending?.hash === hash) return;
		if (pending) clearTimeout(pending.timer);
		const timer = setTimeout(() => {
			eager.delete(key);
			void screenText(request);
		}, eagerDelayMs);
		timer.unref?.();
		eager.set(key, { hash, timer });
	}

	function cancelEager(sketchId: string): void {
		for (const [key, pending] of eager) {
			if (key.startsWith(`${sketchId}|`)) {
				clearTimeout(pending.timer);
				eager.delete(key);
			}
		}
	}

	async function isB2Available({ agentId }: { agentId: string }): Promise<SketchB2Availability> {
		const postureBlocker = restrictedPostureBlocker(agentId);
		if (postureBlocker) return { ok: false, reason: postureBlocker };
		const resolved = await resolveSource();
		if (!isSourceInfo(resolved)) {
			return resolved.status === 'off'
				? {
						ok: false,
						reason:
							'The prompt-injection screen is off. Assign it a model in Settings > Models, or download Prompt Guard 2.',
					}
				: { ok: false, reason: resolved.reason };
		}
		if (resolved.locality === 'cloud' && !cloudPolicy.hasConsent(resolved)) {
			return {
				ok: false,
				reason: `Screening uses ${resolved.label}, a cloud service, and you have not allowed it for Sketch Book.`,
			};
		}
		return { ok: true };
	}

	return {
		screenText,
		screenForAgent,
		noteCanvasText,
		cancelEager,
		isB2Available,
		clearVerdictCache: () => verdicts.clear(),
		dispose: () => {
			for (const pending of eager.values()) clearTimeout(pending.timer);
			eager.clear();
		},
	};
}

let defaultGuardrail: SketchGuardrail | null = null;

/** The app's gate. */
export function getSketchGuardrail(): SketchGuardrail {
	defaultGuardrail ??= createSketchGuardrail();
	return defaultGuardrail;
}

/** Decide one value with the app's gate. */
export function screenText(request: SketchScreenTextRequest): Promise<SketchScreenVerdict> {
	return getSketchGuardrail().screenText(request);
}

/**
 * Decide every subject with the app's gate, keyed by element id. A subject
 * the result does not name must be treated as withheld by the caller (fail
 * closed).
 */
export function screenForAgent(
	request: AgentScreenRequest
): Promise<Map<string, AgentScreenVerdict>> {
	return getSketchGuardrail().screenForAgent(request);
}

/** B2 availability with the app's gate. */
export function isB2Available(input: { agentId: string }): Promise<SketchB2Availability> {
	return getSketchGuardrail().isB2Available(input);
}
