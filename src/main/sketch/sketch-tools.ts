/**
 * Sketch Book tool service: the main-process implementations of the
 * `maestro-sketch` MCP tools (spec section 4) that the bridge routes to.
 * This phase serves the read tools: T1 `sketch_list`, T3 `sketch_read_scene`
 * and T4 `sketch_changes`.
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
import { sketchTextFields, type ElementAuthorship } from '../../shared/sketch/attribution';
import { isSketchReadFormat, type SketchSessionSnapshot } from '../../shared/sketch/commands';
import type { SketchWireElement } from '../../shared/sketch/payloads';
import type { SketchRecord, SketchScene, WithheldReason } from '../../shared/sketch/types';
import { logger } from '../utils/logger';
import {
	screenForAgent,
	type AgentScreenRequest,
	type AgentScreenVerdict,
} from './sketch-guardrail';
import type { SketchToolCall, SketchToolService } from './sketch-mcp-bridge';
import { requestSketchRenderer } from './sketch-renderer-bridge';
import { getSketchService } from './sketch-service';

const LOG_CTX = '[SketchBook][Tools]';

/** Largest tool response, in UTF-8 bytes of its JSON (spec section 4 caps). */
export const SKETCH_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Scene versions per sketch that `sketch_changes` can diff against. Older reads are forgotten. */
export const SKETCH_CHANGE_BASELINES_PER_SKETCH = 16;

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

export interface SketchToolDeps {
	readSession?: SketchSessionReader;
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
	};
}

let defaultToolService: SketchToolService | null = null;

/** The app's tool service. One instance, so `sketch_changes` baselines survive a flag toggle. */
export function getSketchToolService(): SketchToolService {
	defaultToolService ??= createSketchToolService();
	return defaultToolService;
}
