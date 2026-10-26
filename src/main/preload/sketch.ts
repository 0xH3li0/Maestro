/**
 * Preload API for Sketch Book (`window.maestro.sketch`).
 *
 * Mirrors the `sketch:*` channels in `src/main/ipc/handlers/sketch.ts`. Every
 * call rejects with `encoreDisabledMessage('sketchBook')` while the Sketch Book
 * Encore Feature is off. Desktop only: the web bridge refuses these channels.
 *
 * `onRemoteCommand` is the other direction: main asks this window to open a
 * sketch tab or draw an image for `maestro-cli sketch`, and the window answers
 * on the response channel with `sendRemoteCommandResponse`.
 */

import { ipcRenderer } from 'electron';
import type { SaveToProjectOptions } from '../sketch/sketch-store';
import type { SketchRendererRequest, SketchRendererResult } from '../../shared/sketch/commands';
import type { SketchRecord, SketchScene } from '../../shared/sketch/types';

/** Matches `SKETCH_REMOTE_COMMAND_CHANNEL` in `src/main/sketch/sketch-renderer-bridge.ts`. */
const REMOTE_COMMAND_CHANNEL = 'remote:sketchCommand';

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
		/** Main's requests for this window (`maestro-cli sketch`). Returns the unsubscribe. */
		onRemoteCommand: (
			callback: (request: SketchRendererRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, request: SketchRendererRequest, responseChannel: string) =>
				callback(request, responseChannel);
			ipcRenderer.on(REMOTE_COMMAND_CHANNEL, handler);
			return () => ipcRenderer.removeListener(REMOTE_COMMAND_CHANNEL, handler);
		},
		sendRemoteCommandResponse: (responseChannel: string, result: SketchRendererResult): void =>
			ipcRenderer.send(responseChannel, result),
	};
}

export type SketchApi = ReturnType<typeof createSketchApi>;
