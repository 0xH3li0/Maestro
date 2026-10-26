/**
 * The Sketch Book service: the one implementation behind every surface that
 * reads or edits a sketch. The `sketch:*` IPC handlers call it, and the CLI's
 * WS verbs call the same methods (CLAUDE.md, "If the User Can Do It,
 * `maestro-cli` Can Do It"), so the UI and the CLI cannot drift.
 *
 * It owns what the store does not: the Encore gate, and who may own a sketch.
 *
 * - Gate (spec section 3): while the `sketchBook` Encore Feature is off, every
 *   method throws `encoreDisabledMessage('sketchBook')` before touching the
 *   store, so nothing is read or written and the CLI prints the same text.
 * - Owner (Q12): a new sketch belongs to a live LOCAL agent. An agent that runs
 *   over SSH cannot own one, because the MCP bridge is a local socket.
 *   Listing by owner does not check the agent: a sketch outlives the agent that
 *   made it (spec section 3), so its records stay readable.
 *
 * Arguments arrive from IPC and the WS bridge, so each one is checked here by
 * type before the store sees it. The secrets (room key, owner token) are not
 * part of this surface: they never leave the main process.
 *
 * The CLI verbs (`maestro-cli sketch new|open|read|export`) also land here.
 * Opening a tab and drawing PNG or SVG need a window, so those go through the
 * renderer bridge (`sketch-renderer-bridge.ts`) to the window that owns the
 * agent; the window opens the tab with the same `openSketchTab()` the UI uses.
 * `read` and `export` read the SAVED scene, which the tab autosaves within a
 * second of an edit.
 */

import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import {
	isSketchExportFormat,
	isSketchReadFormat,
	sketchSceneJsonFile,
	summarizeSketchScene,
	type ExportedSketch,
	type OpenedSketch,
	type SketchExportFormat,
	type SketchReadFormat,
	type SketchReading,
} from '../../shared/sketch/commands';
import type { SketchRecord, SketchScene } from '../../shared/sketch/types';
import { getLiveSessions, getSettingsStore } from '../stores/getters';
import { requestSketchRenderer, type SketchRendererBridge } from './sketch-renderer-bridge';
import { getSketchStore, type SaveToProjectOptions, type SketchStore } from './sketch-store';

/** The live agent a sketch may belong to, as the service sees it. */
export interface SketchOwnerAgent {
	id: string;
	name: string;
	/** True when the agent runs over SSH, which Sketch Book does not support (Q12). */
	sshRemote: boolean;
	/** The agent's working directory: the only place `sketch_export` may write (T10). */
	cwd: string;
}

export interface SketchServiceDeps {
	store?: () => SketchStore;
	isEnabled?: () => boolean;
	/** The live agent with this id, or `null`. */
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	/** Reaches the window that owns an agent (open a tab, draw an image). */
	renderer?: SketchRendererBridge;
}

export interface SketchService {
	createSketch(input: { ownerAgentId: string; name?: string }): Promise<SketchRecord>;
	listSketches(filter?: { ownerAgentId?: string }): Promise<SketchRecord[]>;
	getSketch(sketchId: string): Promise<SketchRecord | null>;
	readScene(sketchId: string): Promise<SketchScene>;
	writeScene(sketchId: string, scene: SketchScene): Promise<void>;
	renameSketch(sketchId: string, name: string): Promise<SketchRecord>;
	deleteSketch(sketchId: string): Promise<void>;
	saveSketchToProject(
		sketchId: string,
		destDir: string,
		options?: SaveToProjectOptions
	): Promise<string>;
	/** Create a sketch and open it in a tab on its agent (`maestro-cli sketch new`). */
	newSketch(input: {
		ownerAgentId: string;
		name?: string;
		background?: boolean;
	}): Promise<OpenedSketch>;
	/** Open a sketch in a tab on the agent that owns it (`maestro-cli sketch open`). */
	openSketch(sketchId: string, options?: { background?: boolean }): Promise<OpenedSketch>;
	/** The saved scene as a summary or as its live elements (`maestro-cli sketch read`). */
	readSketch(sketchId: string, format?: SketchReadFormat): Promise<SketchReading>;
	/** The saved scene as PNG, SVG or Excalidraw JSON (`maestro-cli sketch export`). */
	exportSketch(sketchId: string, format: SketchExportFormat): Promise<ExportedSketch>;
}

/** The live agent with this id, as Sketch Book sees it, or `null`. */
export function findSketchOwnerAgent(agentId: string): SketchOwnerAgent | null {
	const session = getLiveSessions().find((candidate) => candidate.id === agentId);
	if (!session) return null;
	return {
		id: session.id,
		name: session.name,
		sshRemote: session.sessionSshRemoteConfig?.enabled === true,
		cwd: session.cwd,
	};
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`Sketch Book: ${field} must be a non-empty string.`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error(`Sketch Book: ${field} must be a string.`);
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSketchService(deps: SketchServiceDeps = {}): SketchService {
	const store = deps.store ?? getSketchStore;
	const isEnabled =
		deps.isEnabled ?? (() => isEncoreFeatureEnabled(getSettingsStore(), 'sketchBook'));
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const renderer = deps.renderer ?? requestSketchRenderer;

	/** The store, once the gate has passed. */
	function open(): SketchStore {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
		return store();
	}

	async function requireSketch(sketches: SketchStore, sketchId: unknown): Promise<SketchRecord> {
		const id = requireString(sketchId, 'sketchId');
		const record = await sketches.getSketch(id);
		if (!record) throw new Error(`Sketch Book: no sketch has the id "${id}".`);
		return record;
	}

	/** Open a record's tab on its owner, which must still be a live local agent. */
	async function openRecord(record: SketchRecord, background: boolean): Promise<OpenedSketch> {
		const agent = findAgent(record.ownerAgentId);
		if (!agent) {
			throw new Error(
				`Sketch Book: the agent that owns "${record.name}" is gone, so it has no tab to open in.`
			);
		}
		if (agent.sshRemote) {
			throw new Error(
				`Sketch Book runs on local agents only. "${agent.name}" runs over SSH, so it cannot show a sketch.`
			);
		}
		const result = await renderer(agent.id, {
			action: 'open',
			sessionId: agent.id,
			sketchId: record.sketchId,
			name: record.name,
			background,
		});
		if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
		return { record, tabId: result.tabId ?? null };
	}

	const service: SketchService = {
		async createSketch(input) {
			const sketches = open();
			const request: Record<string, unknown> = isObject(input) ? input : {};
			const ownerAgentId = requireString(request.ownerAgentId, 'ownerAgentId');
			const name = optionalString(request.name, 'name');
			const agent = findAgent(ownerAgentId);
			if (!agent) throw new Error(`Sketch Book: no agent has the id "${ownerAgentId}".`);
			if (agent.sshRemote) {
				throw new Error(
					`Sketch Book runs on local agents only. "${agent.name}" runs over SSH, so it cannot own a sketch.`
				);
			}
			return sketches.createSketch({ ownerAgentId, name });
		},

		async listSketches(filter) {
			const sketches = open();
			const ownerAgentId = optionalString(
				isObject(filter) ? filter.ownerAgentId : undefined,
				'ownerAgentId'
			);
			return sketches.listSketches(ownerAgentId ? { ownerAgentId } : undefined);
		},

		async getSketch(sketchId) {
			return open().getSketch(requireString(sketchId, 'sketchId'));
		},

		async readScene(sketchId) {
			return open().readScene(requireString(sketchId, 'sketchId'));
		},

		async writeScene(sketchId, scene) {
			// The store checks the scene's shape before anything is written.
			return open().writeScene(requireString(sketchId, 'sketchId'), scene);
		},

		async renameSketch(sketchId, name) {
			const sketches = open();
			if (typeof name !== 'string') throw new Error('Sketch Book: name must be a string.');
			return sketches.renameSketch(requireString(sketchId, 'sketchId'), name);
		},

		async deleteSketch(sketchId) {
			return open().deleteSketch(requireString(sketchId, 'sketchId'));
		},

		async saveSketchToProject(sketchId, destDir, options) {
			const sketches = open();
			const raw: Record<string, unknown> = isObject(options) ? options : {};
			const fileName = optionalString(raw.fileName, 'fileName');
			return sketches.saveSketchToProject(
				requireString(sketchId, 'sketchId'),
				requireString(destDir, 'destDir'),
				{
					...(fileName !== undefined ? { fileName } : {}),
					overwrite: raw.overwrite === true,
				}
			);
		},

		async newSketch(input) {
			const request: Record<string, unknown> = isObject(input) ? input : {};
			const record = await service.createSketch({
				ownerAgentId: request.ownerAgentId as string,
				name: request.name as string | undefined,
			});
			try {
				return await openRecord(record, request.background === true);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Sketch "${record.name}" (${record.sketchId}) was created, but its tab did not open. ${reason}`
				);
			}
		},

		async openSketch(sketchId, options) {
			const record = await requireSketch(open(), sketchId);
			return openRecord(record, isObject(options) && options.background === true);
		},

		async readSketch(sketchId, format = 'summary') {
			const sketches = open();
			if (!isSketchReadFormat(format)) {
				throw new Error('Sketch Book: format must be "summary" or "elements".');
			}
			const record = await requireSketch(sketches, sketchId);
			const scene = await sketches.readScene(record.sketchId);
			if (format === 'elements') {
				return {
					record,
					format,
					elements: scene.elements.filter((element) => element.isDeleted !== true),
				};
			}
			return { record, format, summary: summarizeSketchScene(scene) };
		},

		async exportSketch(sketchId, format) {
			const sketches = open();
			if (!isSketchExportFormat(format)) {
				throw new Error('Sketch Book: format must be "png", "svg" or "json".');
			}
			const record = await requireSketch(sketches, sketchId);
			const scene = await sketches.readScene(record.sketchId);
			if (format === 'json') {
				// The `.excalidraw` file as saved.
				return { record, file: sketchSceneJsonFile(scene) };
			}
			// Any window can draw it; prefer the one that owns the agent.
			const owner = findAgent(record.ownerAgentId);
			const result = await renderer(owner?.id ?? null, { action: 'export', format, scene });
			if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
			if (!result.file || result.file.format !== format) {
				throw new Error(`Sketch Book: the Maestro window did not return a ${format} file.`);
			}
			return { record, file: result.file };
		},
	};
	return service;
}

let defaultService: SketchService | null = null;

/** The app's service, over the app's store and settings. */
export function getSketchService(): SketchService {
	defaultService ??= createSketchService();
	return defaultService;
}
