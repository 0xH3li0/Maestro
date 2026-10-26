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
import type {
	SketchCloudEngine,
	SketchScreeningChange,
	SketchScreeningConsentStatus,
} from '../../shared/sketch/cloud-consent';
import type { Screening } from '../../shared/sketch/protocol';
import type { SketchRecord, SketchScene } from '../../shared/sketch/types';

/** Matches `SKETCH_REMOTE_COMMAND_CHANNEL` in `src/main/sketch/sketch-renderer-bridge.ts`. */
const REMOTE_COMMAND_CHANNEL = 'remote:sketchCommand';

/** Matches `SKETCH_SCREENING_CHANGED_CHANNEL` in `src/main/sketch/sketch-cloud-consent.ts`. */
const SCREENING_CHANGED_CHANNEL = 'sketch:screeningChanged';

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
		/** Cloud screening consent, the engine in force, and each live room (spec section 8.10). */
		screeningConsentStatus: (): Promise<SketchScreeningConsentStatus> =>
			ipcRenderer.invoke('sketch:screeningConsentStatus'),
		/** Store a consent for one engine (OpenJev: the host in force). */
		grantScreeningConsent: (engine: SketchCloudEngine): Promise<SketchScreeningConsentStatus> =>
			ipcRenderer.invoke('sketch:grantScreeningConsent', engine),
		revokeScreeningConsent: (engine: SketchCloudEngine): Promise<SketchScreeningConsentStatus> =>
			ipcRenderer.invoke('sketch:revokeScreeningConsent', engine),
		/** Raise the desktop confirmation for the cloud engine in force (G2, G3). True on Allow. */
		confirmCloudScreening: (): Promise<boolean> =>
			ipcRenderer.invoke('sketch:confirmCloudScreening'),
		/** The value to send as `screening.set` for a room. */
		roomScreening: (sketchId: string): Promise<Screening> =>
			ipcRenderer.invoke('sketch:roomScreening', sketchId),
		/** The room's socket joined (`welcome`) or left. Resolves with the room's value. */
		setRoomLive: (sketchId: string, live: boolean): Promise<Screening> =>
			ipcRenderer.invoke('sketch:setRoomLive', sketchId, live),
		/** The server's `welcome.screening` / `screeningSince` or a `screening` frame (G4, H1). */
		reportServerScreening: (
			sketchId: string,
			screening: Screening,
			since: number | null
		): Promise<void> =>
			ipcRenderer.invoke('sketch:reportServerScreening', sketchId, screening, since),
		/** Every change to a room's screening value or the consent. Returns the unsubscribe. */
		onScreeningChanged: (callback: (change: SketchScreeningChange) => void): (() => void) => {
			const handler = (_: unknown, change: SketchScreeningChange) => callback(change);
			ipcRenderer.on(SCREENING_CHANGED_CHANNEL, handler);
			return () => ipcRenderer.removeListener(SCREENING_CHANGED_CHANNEL, handler);
		},
	};
}

export type SketchApi = ReturnType<typeof createSketchApi>;
