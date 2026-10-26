/**
 * Preload API for Sketch Book (`window.maestro.sketch`).
 *
 * Mirrors the `sketch:*` channels in `src/main/ipc/handlers/sketch.ts`. Every
 * call rejects with `encoreDisabledMessage('sketchBook')` while the Sketch Book
 * Encore Feature is off. Desktop only: the web bridge refuses these channels.
 */

import { ipcRenderer } from 'electron';
import type { SaveToProjectOptions } from '../sketch/sketch-store';
import type { SketchRecord, SketchScene } from '../../shared/sketch/types';

/** Creates the Sketch Book API object for contextBridge exposure. */
export function createSketchApi() {
	return {
		/** A new sketch owned by a live local agent, with an empty scene. */
		create: (input: { ownerAgentId: string; name?: string }): Promise<SketchRecord> =>
			ipcRenderer.invoke('sketch:create', input),
		/** Every sketch, or only those one agent owns, oldest first. */
		list: (filter?: { ownerAgentId?: string }): Promise<SketchRecord[]> =>
			ipcRenderer.invoke('sketch:list', filter ?? {}),
		get: (sketchId: string): Promise<SketchRecord | null> =>
			ipcRenderer.invoke('sketch:get', sketchId),
		readScene: (sketchId: string): Promise<SketchScene> =>
			ipcRenderer.invoke('sketch:readScene', sketchId),
		writeScene: (sketchId: string, scene: SketchScene): Promise<void> =>
			ipcRenderer.invoke('sketch:writeScene', sketchId, scene),
		rename: (sketchId: string, name: string): Promise<SketchRecord> =>
			ipcRenderer.invoke('sketch:rename', sketchId, name),
		delete: (sketchId: string): Promise<void> => ipcRenderer.invoke('sketch:delete', sketchId),
		/** Copy the scene into a project folder. Resolves with the path written. */
		saveToProject: (
			sketchId: string,
			destDir: string,
			options?: SaveToProjectOptions
		): Promise<string> =>
			ipcRenderer.invoke('sketch:saveToProject', sketchId, destDir, options ?? {}),
	};
}

export type SketchApi = ReturnType<typeof createSketchApi>;
