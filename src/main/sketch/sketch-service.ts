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
 */

import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import type { SketchRecord, SketchScene } from '../../shared/sketch/types';
import { getLiveSessions, getSettingsStore } from '../stores/getters';
import { getSketchStore, type SaveToProjectOptions, type SketchStore } from './sketch-store';

/** The live agent a sketch may belong to, as the service sees it. */
export interface SketchOwnerAgent {
	id: string;
	name: string;
	/** True when the agent runs over SSH, which Sketch Book does not support (Q12). */
	sshRemote: boolean;
}

export interface SketchServiceDeps {
	store?: () => SketchStore;
	isEnabled?: () => boolean;
	/** The live agent with this id, or `null`. */
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
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
}

function defaultFindAgent(agentId: string): SketchOwnerAgent | null {
	const session = getLiveSessions().find((candidate) => candidate.id === agentId);
	if (!session) return null;
	return {
		id: session.id,
		name: session.name,
		sshRemote: session.sessionSshRemoteConfig?.enabled === true,
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
	const findAgent = deps.findAgent ?? defaultFindAgent;

	/** The store, once the gate has passed. */
	function open(): SketchStore {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
		return store();
	}

	return {
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
	};
}

let defaultService: SketchService | null = null;

/** The app's service, over the app's store and settings. */
export function getSketchService(): SketchService {
	defaultService ??= createSketchService();
	return defaultService;
}
