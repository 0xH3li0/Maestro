/**
 * Sketch Book tool service: the main-process implementations of the
 * `maestro-sketch` MCP tools (spec section 4) that the bridge routes to.
 * This phase serves the read tools (T1 `sketch_list`, T3 `sketch_read_scene`,
 * T4 `sketch_changes`) and the write tools (T2 `sketch_create`, T5
 * `sketch_add_elements`, T6 `sketch_update_elements`, T7
 * `sketch_delete_elements`, T8 `sketch_from_mermaid`, T11 `sketch_focus`,
 * T12 `sketch_chat_post`).
 *
 * The bridge has already bound the caller to its agent at the handshake and
 * checked that the sketch a call names belongs to that agent, so every
 * handler here acts for `call.agent` on `call.sketch` and nothing else. There
 * is no active-session fallback anywhere.
 *
 * Where the scene comes from. The live drawing, with any unsaved edit and the
 * author map (spec section 7), exists only in the renderer's `SketchSession`.
 * The tools read it through a request/response round trip to the window that
 * owns the agent, the way coworking-tools.ts reads terminal scrollback: an
 * injected reader (`SketchSessionReader`), so this module stays testable
 * without Electron. The default reader rides the Sketch Book renderer bridge
 * (`requestSketchRenderer`, over the canonical `requestFromRenderer`), whose
 * window resolver is set once at startup.
 *
 * The gate. Every third-party element a view needs goes through
 * `screenForAgent()` (sketch-guardrail.ts) in one batched call before the view
 * is built; a subject the gate does not clear is withheld (fail closed).
 *
 * Writes. Main checks the arguments and the caps, runs the per-sketch write
 * rate guard, and passes every outbound text through `screenOutbound()`
 * (sketch-outbound.ts, spec section 8.5) in one batch per write; a refusal
 * refuses the whole write. The change itself is made by the window
 * (`SketchSessionWriter`, the `agentWrite` hop): Excalidraw converts skeletons
 * and Mermaid in a DOM, and the session there stamps the change as the agent
 * (`kind: 'bot'`, `id: 'agent:<agentId>'`). A sketch an agent creates opens
 * in a background tab and is never shared (Q5). A chat post is allowed only
 * on an unshared sketch until bot turns exist (phase 06).
 *
 * Caps: a response is cut to 1 MB (`truncated: true` plus `omittedCount`), and
 * every response carries `sceneVersion`.
 */

import { serializedJsonByteLength } from '../../shared/jsonUtils';
import {
	buildSketchAgentElements,
	buildSketchAgentSummary,
	buildSketchChangeEntries,
	currentAuthorship,
	diffSketchElements,
	selectSketchElements,
	sketchElementsToScreen,
	sketchSceneVersion,
	sketchVersionMap,
	type SketchBox,
	type SketchChangeSet,
	type SketchReadScope,
	type SketchWithheldMap,
} from '../../shared/sketch/agent-view';
import {
	collectSketchOutboundTexts,
	forbiddenSketchPatchKeys,
	replaceSketchOutboundTexts,
} from '../../shared/sketch/agent-writes';
import { sketchTextFields, type ElementAuthorship } from '../../shared/sketch/attribution';
import {
	isSketchReadFormat,
	type OpenedSketch,
	type SketchAgentWrite,
	type SketchAgentWriteResult,
	type SketchElementPatch,
	type SketchElementSkeleton,
	type SketchSessionSnapshot,
} from '../../shared/sketch/commands';
import type { SketchWireElement } from '../../shared/sketch/payloads';
import type { SketchRecord, SketchScene, WithheldReason } from '../../shared/sketch/types';
import { logger } from '../utils/logger';
import {
	createSlidingWindowGuard,
	type SlidingWindowGuard,
	type SlidingWindowLimits,
} from '../utils/sliding-window-guard';
import {
	screenForAgent,
	type AgentScreenRequest,
	type AgentScreenVerdict,
} from './sketch-guardrail';
import type { SketchToolCall, SketchToolService } from './sketch-mcp-bridge';
import {
	SKETCH_MAX_CHAT_POST_BYTES,
	SKETCH_MAX_ELEMENTS_PER_CALL,
} from './sketch-mcp-server-script';
import {
	screenOutbound,
	type OutboundPurpose,
	type OutboundScreenRequest,
	type OutboundScreenResult,
} from './sketch-outbound';
import { requestSketchRenderer } from './sketch-renderer-bridge';
import { getSketchService, type SketchOwnerAgent } from './sketch-service';

const LOG_CTX = '[SketchBook][Tools]';

/** Largest tool response, in UTF-8 bytes of its JSON (spec section 4 caps). */
export const SKETCH_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Scene versions per sketch that `sketch_changes` can diff against. Older reads are forgotten. */
export const SKETCH_CHANGE_BASELINES_PER_SKETCH = 16;

/** Largest `sketch_from_mermaid` source, in UTF-8 bytes. */
export const SKETCH_MAX_MERMAID_BYTES = 64 * 1024;

/** The per-sketch write rate guard (spec section 4 caps): T5-T8, T11, T12. */
export const SKETCH_WRITE_LIMITS: SlidingWindowLimits = {
	windowMs: 10_000,
	maxPerWindow: 30,
	maxConcurrent: 2,
};

/** New sketches per agent (T2). */
export const SKETCH_CREATE_LIMITS: SlidingWindowLimits = {
	windowMs: 60_000,
	maxPerWindow: 5,
	maxConcurrent: 1,
};

/**
 * Reads a sketch's live session from the window that owns the agent. With
 * `open: false` it resolves null when the window has no session for it.
 */
export type SketchSessionReader = (
	agentId: string,
	sketchId: string,
	options: { open: boolean }
) => Promise<SketchSessionSnapshot | null>;

/** The default reader: the Sketch Book renderer bridge. */
export const readLiveSketchSession: SketchSessionReader = async (agentId, sketchId, { open }) => {
	const result = await requestSketchRenderer(agentId, { action: 'readSession', sketchId, open });
	if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
	if (result.session === undefined) {
		throw new Error('Sketch Book: the Maestro window did not return the sketch.');
	}
	return result.session;
};

/** Makes one agent write on a sketch's live session, in the window that owns the agent. */
export type SketchSessionWriter = (
	agent: SketchOwnerAgent,
	sketchId: string,
	write: SketchAgentWrite
) => Promise<SketchAgentWriteResult>;

/** The default writer: the Sketch Book renderer bridge. */
export const writeLiveSketchSession: SketchSessionWriter = async (agent, sketchId, write) => {
	const result = await requestSketchRenderer(agent.id, {
		action: 'agentWrite',
		sketchId,
		agent: { id: agent.id, name: agent.name },
		write,
	});
	if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
	if (!result.write) throw new Error('Sketch Book: the Maestro window did not report the write.');
	return result.write;
};

/** Mermaid source to element skeletons, in the window that owns the agent (T8). */
export type SketchMermaidConverter = (
	agentId: string,
	mermaid: string
) => Promise<SketchElementSkeleton[]>;

/** The default converter: the Sketch Book renderer bridge. */
export const convertMermaidInWindow: SketchMermaidConverter = async (agentId, mermaid) => {
	const result = await requestSketchRenderer(agentId, { action: 'convertMermaid', mermaid });
	if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
	if (!result.skeletons) {
		throw new Error('Sketch Book: the Maestro window did not convert the diagram.');
	}
	return result.skeletons;
};

export interface SketchToolDeps {
	readSession?: SketchSessionReader;
	writeSession?: SketchSessionWriter;
	convertMermaid?: SketchMermaidConverter;
	/** Create a sketch owned by the agent and open it in a background tab (T2). */
	createSketch?: (ownerAgentId: string, name: string | undefined) => Promise<OpenedSketch>;
	outbound?: (request: OutboundScreenRequest) => Promise<OutboundScreenResult>;
	/** The write rate guard; one per service by default. */
	writeGuard?: SlidingWindowGuard;
	/** The sketches an agent owns. */
	listSketches?: (ownerAgentId: string) => Promise<SketchRecord[]>;
	/** The saved scene, for a sketch no window has open (T1 only). */
	readSavedScene?: (sketchId: string) => Promise<SketchScene>;
	screen?: (request: AgentScreenRequest) => Promise<Map<string, AgentScreenVerdict>>;
	maxResponseBytes?: number;
}

/** A response cut to the byte cap. */
export type CappedSketchResponse<T> = T & { truncated: boolean; omittedCount?: number };

/**
 * Keep as many list items as fit in `maxBytes`, filling the lists in order;
 * once one item does not fit, every later item is dropped too, so the agent
 * reads a prefix of the scene rather than a scattered sample. `build` puts the
 * kept lists back into the response.
 */
export function capSketchResponse<T extends object>(
	lists: readonly (readonly unknown[])[],
	build: (lists: unknown[][]) => T,
	maxBytes: number = SKETCH_MAX_RESPONSE_BYTES
): CappedSketchResponse<T> {
	const full = { ...build(lists.map((list) => [...list])), truncated: false };
	const fullBytes = serializedJsonByteLength(full);
	if (fullBytes !== null && fullBytes <= maxBytes) return full;

	// The empty response, with the widest `omittedCount` it could carry.
	const total = lists.reduce((sum, list) => sum + list.length, 0);
	const empty = { ...build(lists.map(() => [])), truncated: true, omittedCount: total };
	let budget = maxBytes - (serializedJsonByteLength(empty) ?? maxBytes);
	const kept: unknown[][] = lists.map(() => []);
	let keptCount = 0;
	fill: for (let listIndex = 0; listIndex < lists.length; listIndex += 1) {
		for (const item of lists[listIndex]) {
			// +1 for the comma that joins it to the previous item.
			const bytes = (serializedJsonByteLength(item) ?? Infinity) + 1;
			if (bytes > budget) break fill;
			budget -= bytes;
			kept[listIndex].push(item);
			keptCount += 1;
		}
	}
	return { ...build(kept), truncated: true, omittedCount: total - keptCount };
}

function requireSketch(call: SketchToolCall): SketchRecord {
	// The bridge resolves and checks the sketch for every tool that names one.
	if (!call.sketch) throw new Error('Sketch Book: this tool needs a sketch.');
	return call.sketch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty array of at most `SKETCH_MAX_ELEMENTS_PER_CALL` items, or an error naming the field. */
function boundedArray(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`Sketch Book: \`${field}\` must be a non-empty array.`);
	}
	if (value.length > SKETCH_MAX_ELEMENTS_PER_CALL) {
		throw new Error(
			`Sketch Book: \`${field}\` has ${value.length} items; at most ${SKETCH_MAX_ELEMENTS_PER_CALL} per call.`
		);
	}
	return value;
}

/** A non-empty, bounded list of element ids. */
function elementIdList(value: unknown, field: string): string[] {
	const ids = boundedArray(value, field);
	if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) {
		throw new Error(`Sketch Book: \`${field}\` must be an array of element ids.`);
	}
	return [...new Set(ids)];
}

/** `sketch_add_elements` skeletons, checked for shape. Excalidraw checks the rest. */
function elementSkeletons(value: unknown): SketchElementSkeleton[] {
	return boundedArray(value, 'elements').map((item, index) => {
		if (!isPlainObject(item) || typeof item.type !== 'string' || !item.type) {
			throw new Error(`Sketch Book: \`elements[${index}]\` must be an object with a \`type\`.`);
		}
		if (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) {
			throw new Error(`Sketch Book: \`elements[${index}].id\` must be a non-empty string.`);
		}
		// The stamp is the session's to write (spec section 7), never the agent's.
		const { customData: _stamp, ...skeleton } = item;
		return skeleton;
	});
}

/** `sketch_update_elements` patches, checked. */
function elementPatches(value: unknown): SketchElementPatch[] {
	return boundedArray(value, 'patches').map((item, index) => {
		if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) {
			throw new Error(`Sketch Book: \`patches[${index}]\` must be an object with an \`id\`.`);
		}
		const { id, baseVersion, ...props } = item;
		if (
			baseVersion !== undefined &&
			(typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0)
		) {
			throw new Error(
				`Sketch Book: \`patches[${index}].baseVersion\` must be a non-negative integer.`
			);
		}
		const forbidden = forbiddenSketchPatchKeys(props);
		if (forbidden.length > 0) {
			throw new Error(
				`Sketch Book: a patch may not set ${forbidden.map((key) => `\`${key}\``).join(', ')} (element "${id}"). Use sketch_delete_elements to delete.`
			);
		}
		if (Object.keys(props).length === 0) {
			throw new Error(`Sketch Book: the patch for element "${id}" sets nothing.`);
		}
		return { id, ...(baseVersion !== undefined ? { baseVersion } : {}), props };
	});
}

/** A required string no longer than `maxBytes` in UTF-8. */
function boundedText(value: unknown, field: string, maxBytes: number): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Sketch Book: \`${field}\` must be a non-empty string.`);
	}
	const bytes = Buffer.byteLength(value, 'utf8');
	if (bytes > maxBytes) {
		throw new Error(
			`Sketch Book: \`${field}\` is ${bytes} bytes; at most ${maxBytes} bytes are allowed.`
		);
	}
	return value;
}

/** `sketch_read_scene` scope arguments, checked. */
function readScope(params: Record<string, unknown>): SketchReadScope {
	const scope: SketchReadScope = {};
	if (params.elementIds !== undefined) {
		if (
			!Array.isArray(params.elementIds) ||
			!params.elementIds.every((id): id is string => typeof id === 'string')
		) {
			throw new Error('Sketch Book: `elementIds` must be an array of strings.');
		}
		scope.elementIds = params.elementIds;
	}
	if (params.bbox !== undefined) {
		const raw = params.bbox as Record<string, unknown> | null;
		const box = raw && typeof raw === 'object' ? raw : {};
		const field = (key: keyof SketchBox) => {
			const value = box[key];
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new Error(`Sketch Book: \`bbox.${key}\` must be a number.`);
			}
			return value;
		};
		const bbox: SketchBox = {
			x: field('x'),
			y: field('y'),
			width: field('width'),
			height: field('height'),
		};
		if (bbox.width < 0 || bbox.height < 0) {
			throw new Error('Sketch Book: `bbox.width` and `bbox.height` must not be negative.');
		}
		scope.bbox = bbox;
	}
	return scope;
}

export function createSketchToolService(deps: SketchToolDeps = {}): SketchToolService {
	const readSession = deps.readSession ?? readLiveSketchSession;
	const listSketches =
		deps.listSketches ?? ((ownerAgentId) => getSketchService().listSketches({ ownerAgentId }));
	const readSavedScene =
		deps.readSavedScene ?? ((sketchId) => getSketchService().readScene(sketchId));
	const screen = deps.screen ?? screenForAgent;
	const maxBytes = deps.maxResponseBytes ?? SKETCH_MAX_RESPONSE_BYTES;
	const writeSession = deps.writeSession ?? writeLiveSketchSession;
	const convertMermaid = deps.convertMermaid ?? convertMermaidInWindow;
	const createSketch =
		deps.createSketch ??
		((ownerAgentId, name) =>
			getSketchService().newSketch({ ownerAgentId, name, background: true }));
	const outbound = deps.outbound ?? screenOutbound;
	const writeGuard = deps.writeGuard ?? createSlidingWindowGuard();

	/** sketchId -> sceneVersion -> element versions, the reads `sketch_changes` can diff against. */
	const baselines = new Map<string, Map<number, Record<string, number>>>();

	function rememberRead(sketchId: string, elements: readonly SketchWireElement[]): number {
		const sceneVersion = sketchSceneVersion(elements);
		const reads = baselines.get(sketchId) ?? new Map<number, Record<string, number>>();
		reads.delete(sceneVersion);
		reads.set(sceneVersion, sketchVersionMap(elements));
		while (reads.size > SKETCH_CHANGE_BASELINES_PER_SKETCH) {
			reads.delete(reads.keys().next().value as number);
		}
		baselines.set(sketchId, reads);
		return sceneVersion;
	}

	async function liveSession(agentId: string, sketchId: string): Promise<SketchSessionSnapshot> {
		const session = await readSession(agentId, sketchId, { open: true });
		if (!session) throw new Error('Sketch Book: the Maestro window could not open the sketch.');
		return session;
	}

	/** Screen the third-party elements in one call; everything not cleared is withheld. */
	async function gate(
		agentId: string,
		sketchId: string,
		subjects: readonly SketchWireElement[],
		authors: Readonly<Record<string, ElementAuthorship>>
	): Promise<SketchWithheldMap> {
		const withheld = new Map<string, WithheldReason>();
		if (subjects.length === 0) return withheld;
		const verdicts = await screen({
			sketchId,
			agentId,
			subjects: subjects.map((element) => {
				const authorship = currentAuthorship(element, authors);
				return {
					elementId: element.id,
					version: element.version,
					type: String(element.type ?? 'unknown'),
					author: authorship?.actor ?? null,
					...(authorship ? { textHash: authorship.textHash } : {}),
					fields: sketchTextFields(element),
				};
			}),
		});
		for (const element of subjects) {
			const verdict = verdicts.get(element.id);
			if (verdict?.status === 'clear') continue;
			withheld.set(element.id, verdict?.status === 'withheld' ? verdict.reason : 'unscreened');
		}
		return withheld;
	}

	/** Run `fn` inside the rate guard for `key`; a refused call does nothing. */
	async function guarded<T>(
		key: string,
		limits: SlidingWindowLimits,
		what: string,
		fn: () => Promise<T>
	): Promise<T> {
		const admitted = writeGuard.begin(key, limits);
		if (!admitted.ok) {
			throw new Error(
				admitted.limit === 'rate'
					? `Sketch Book: too many ${what} (at most ${limits.maxPerWindow} per ${limits.windowMs / 1000} s). Wait a moment and try again.`
					: `Sketch Book: ${admitted.count} ${what} are still running. Wait for them to finish.`
			);
		}
		try {
			return await fn();
		} finally {
			admitted.release();
		}
	}

	/** One sketch write: the per-sketch guard around it. */
	function sketchWrite<T>(record: SketchRecord, fn: () => Promise<T>): Promise<T> {
		return guarded(`sketch:${record.sketchId}`, SKETCH_WRITE_LIMITS, 'writes to this sketch', fn);
	}

	/**
	 * `value` with its outbound texts screened (spec section 8.5), in one batch.
	 * A refusal refuses the whole write.
	 */
	async function screenTexts<T>(
		call: SketchToolCall,
		record: SketchRecord,
		purpose: OutboundPurpose,
		value: T
	): Promise<{ value: T; redactedCount: number }> {
		const texts = collectSketchOutboundTexts(value);
		if (texts.length === 0) return { value, redactedCount: 0 };
		const screened = await outbound({
			sketchId: record.sketchId,
			agentId: call.agent.id,
			purpose,
			texts,
		});
		if (!screened.ok) throw new Error(`Sketch Book: ${screened.reason}`);
		return {
			value: replaceSketchOutboundTexts(value, screened.texts),
			redactedCount: screened.redactedCount,
		};
	}

	/** T5 and T8: screened skeletons onto the board. */
	async function addSkeletons(
		call: SketchToolCall,
		record: SketchRecord,
		skeletons: SketchElementSkeleton[],
		options: { regenerateIds: boolean; placeBelowScene: boolean }
	) {
		const screened = await screenTexts(call, record, 'element', skeletons);
		const result = await writeSession(call.agent, record.sketchId, {
			op: 'add',
			skeletons: screened.value,
			...options,
		});
		return {
			sketchId: record.sketchId,
			sceneVersion: result.sceneVersion,
			added: result.elements,
			redactedCount: screened.redactedCount,
		};
	}

	return {
		// T1: the agent's own sketches. A listing never opens a session: a sketch
		// no window has open reports the version of its saved scene.
		sketch_list: async (call) => {
			const records = await listSketches(call.agent.id);
			const sketches = await Promise.all(
				records.map(async (record) => {
					let elements: SketchWireElement[] | null = null;
					try {
						const live = await readSession(call.agent.id, record.sketchId, { open: false });
						elements = live?.elements ?? null;
					} catch (err) {
						logger.warn(
							`${LOG_CTX} Live read of ${record.sketchId} failed, using the saved scene: ${String(err)}`,
							'SketchBook'
						);
					}
					if (!elements) {
						try {
							elements = (await readSavedScene(record.sketchId)).elements;
						} catch (err) {
							logger.warn(
								`${LOG_CTX} No scene for ${record.sketchId}: ${String(err)}`,
								'SketchBook'
							);
						}
					}
					return {
						sketchId: record.sketchId,
						name: record.name,
						createdAt: record.createdAt,
						shared: record.share !== null,
						botPolicy: record.share?.botPolicy ?? null,
						// The room client (phase 05) knows who is online; an unshared sketch has nobody.
						collaboratorsOnline: record.share ? null : 0,
						sceneVersion: elements ? rememberRead(record.sketchId, elements) : null,
					};
				})
			);
			return capSketchResponse([sketches], ([kept]) => ({ sketches: kept }), maxBytes);
		},

		// T3: the scene, or part of it, as a summary or as elements.
		sketch_read_scene: async (call) => {
			const record = requireSketch(call);
			const format = call.params.format;
			if (!isSketchReadFormat(format)) {
				throw new Error('Sketch Book: `format` must be "summary" or "elements".');
			}
			const scope = readScope(call.params);
			const { elements, authors, fileCount } = await liveSession(call.agent.id, record.sketchId);
			const sceneVersion = rememberRead(record.sketchId, elements);
			const selected = selectSketchElements(elements, scope);
			const withheld = await gate(
				call.agent.id,
				record.sketchId,
				sketchElementsToScreen(elements, selected, authors),
				authors
			);
			const head = { sketchId: record.sketchId, name: record.name, sceneVersion, fileCount };

			if (format === 'elements') {
				return capSketchResponse(
					[buildSketchAgentElements(selected, authors, withheld)],
					([kept]) => ({ ...head, format, elements: kept }),
					maxBytes
				);
			}
			const summary = buildSketchAgentSummary(elements, selected, authors, withheld);
			return capSketchResponse(
				[summary.frames, summary.shapes, summary.connections, summary.groups],
				([frames, shapes, connections, groups]) => ({
					...head,
					format,
					summary: { ...summary, frames, shapes, connections, groups },
				}),
				maxBytes
			);
		},

		// T4: what changed since a scene version the agent read.
		sketch_changes: async (call) => {
			const record = requireSketch(call);
			const sinceVersion = call.params.sinceVersion;
			if (
				typeof sinceVersion !== 'number' ||
				!Number.isSafeInteger(sinceVersion) ||
				sinceVersion < 0
			) {
				throw new Error('Sketch Book: `sinceVersion` must be a non-negative integer.');
			}
			const { elements, authors } = await liveSession(call.agent.id, record.sketchId);
			const baseline = baselines.get(record.sketchId)?.get(sinceVersion) ?? null;
			const sceneVersion = rememberRead(record.sketchId, elements);
			// The scene version only grows, so a reader already at (or past) it has missed nothing.
			const diff =
				baseline || sinceVersion < sceneVersion
					? diffSketchElements(baseline, elements)
					: { added: [], updated: [], deleted: [] };
			const withheld = await gate(
				call.agent.id,
				record.sketchId,
				sketchElementsToScreen(elements, [...diff.added, ...diff.updated], authors),
				authors
			);
			const entries = buildSketchChangeEntries(elements, diff, authors, withheld);
			const head: Omit<SketchChangeSet, 'added' | 'updated' | 'deleted'> & { sketchId: string } = {
				sketchId: record.sketchId,
				sinceVersion,
				sceneVersion,
				baseline: baseline || sinceVersion >= sceneVersion ? 'known' : 'unknown',
			};
			return capSketchResponse(
				[entries.added, entries.updated, entries.deleted],
				([added, updated, deleted]) => ({ ...head, added, updated, deleted }),
				maxBytes
			);
		},

		// T2: a new sketch in a background tab, never shared (Q5).
		sketch_create: async (call) => {
			const name = call.params.name;
			if (name !== undefined && typeof name !== 'string') {
				throw new Error('Sketch Book: `name` must be a string.');
			}
			const opened = await guarded(
				`create:${call.agent.id}`,
				SKETCH_CREATE_LIMITS,
				'new sketches',
				() => createSketch(call.agent.id, name?.trim() || undefined)
			);
			return {
				sketchId: opened.record.sketchId,
				name: opened.record.name,
				tabId: opened.tabId,
				shared: false,
				sceneVersion: 0,
			};
		},

		// T5: elements from Excalidraw skeletons.
		sketch_add_elements: async (call) => {
			const record = requireSketch(call);
			const skeletons = elementSkeletons(call.params.elements);
			return sketchWrite(record, () =>
				addSkeletons(call, record, skeletons, { regenerateIds: false, placeBelowScene: false })
			);
		},

		// T6: patches; a stale `baseVersion` returns the element as it is now (gated).
		sketch_update_elements: async (call) => {
			const record = requireSketch(call);
			const patches = elementPatches(call.params.patches);
			return sketchWrite(record, async () => {
				const screened = await screenTexts(call, record, 'element', patches);
				const result = await writeSession(call.agent, record.sketchId, {
					op: 'update',
					patches: screened.value,
				});
				const { elements, authors } = result.conflicts;
				const withheld = await gate(
					call.agent.id,
					record.sketchId,
					sketchElementsToScreen(elements, elements, authors),
					authors
				);
				return capSketchResponse(
					[buildSketchAgentElements(elements, authors, withheld)],
					([conflicts]) => ({
						sketchId: record.sketchId,
						sceneVersion: result.sceneVersion,
						updated: result.elements,
						missing: result.missing,
						conflicts,
						redactedCount: screened.redactedCount,
					}),
					maxBytes
				);
			});
		},

		// T7: `isDeleted` tombstones, with the text bound to each element.
		sketch_delete_elements: async (call) => {
			const record = requireSketch(call);
			const ids = elementIdList(call.params.ids, 'ids');
			return sketchWrite(record, async () => {
				const result = await writeSession(call.agent, record.sketchId, { op: 'delete', ids });
				return {
					sketchId: record.sketchId,
					sceneVersion: result.sceneVersion,
					deleted: result.elements,
					missing: result.missing,
				};
			});
		},

		// T8: a Mermaid diagram, converted in the window, screened, then added like T5.
		sketch_from_mermaid: async (call) => {
			const record = requireSketch(call);
			const mermaid = boundedText(call.params.mermaid, 'mermaid', SKETCH_MAX_MERMAID_BYTES);
			return sketchWrite(record, async () => {
				const skeletons = await convertMermaid(call.agent.id, mermaid);
				if (skeletons.length === 0) {
					throw new Error('Sketch Book: the Mermaid diagram has nothing to draw.');
				}
				if (skeletons.length > SKETCH_MAX_ELEMENTS_PER_CALL) {
					throw new Error(
						`Sketch Book: the diagram makes ${skeletons.length} elements; at most ${SKETCH_MAX_ELEMENTS_PER_CALL} per call.`
					);
				}
				return addSkeletons(call, record, skeletons, {
					regenerateIds: true,
					placeBelowScene: true,
				});
			});
		},

		// T11: scroll and zoom the people's view to these elements.
		sketch_focus: async (call) => {
			const record = requireSketch(call);
			const elementIds = elementIdList(call.params.elementIds, 'elementIds');
			return sketchWrite(record, async () => {
				const result = await writeSession(call.agent, record.sketchId, {
					op: 'focus',
					elementIds,
				});
				return {
					sketchId: record.sketchId,
					sceneVersion: result.sceneVersion,
					focused: result.elements.map((element) => element.id),
					missing: result.missing,
				};
			});
		},

		// T12: a chat post as the agent, in the local chat pane.
		sketch_chat_post: async (call) => {
			const record = requireSketch(call);
			const text = boundedText(call.params.text, 'text', SKETCH_MAX_CHAT_POST_BYTES);
			// Bot turns (phase 06) are the only other time a post is allowed.
			if (record.share !== null) {
				throw new Error(
					'Sketch Book: this sketch is shared, so the agent may post in its chat only during a turn the sketch started.'
				);
			}
			return sketchWrite(record, async () => {
				const screened = await screenTexts(call, record, 'chat', { text });
				const result = await writeSession(call.agent, record.sketchId, {
					op: 'chat',
					text: screened.value.text,
				});
				return {
					sketchId: record.sketchId,
					sceneVersion: result.sceneVersion,
					posted: true,
					redactedCount: screened.redactedCount,
				};
			});
		},
	};
}

let defaultToolService: SketchToolService | null = null;

/** The app's tool service. One instance, so `sketch_changes` baselines survive a flag toggle. */
export function getSketchToolService(): SketchToolService {
	defaultToolService ??= createSketchToolService();
	return defaultToolService;
}
