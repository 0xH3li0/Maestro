/**
 * Preload API for the core Local Models service.
 *
 * Provides the `window.maestro.localModels` namespace. Unlike
 * `window.maestro.voice.models`, nothing here is gated on an Encore Feature:
 * Local Models is a core service, and voice is one consumer of it. Both
 * namespaces reach the same main-process service, so a download started from
 * one is the same transfer the other sees.
 *
 * Nothing in here touches the network except {@link download}, {@link resume},
 * and `runtimes.install`. `list()` is a disk read against a frozen local catalog.
 */

import { ipcRenderer } from 'electron';
import type { LocalModelListing, LocalRuntimeListing } from '../local-models/service';
import type { DownloadProgress, DownloadResult } from '../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../local-models/model-store';
import type { RuntimeInstallProgress } from '../local-models/runtime/runtime-installer';

/** Subscribe to one broadcast channel; returns the unsubscribe. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
	const wrappedHandler = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
	ipcRenderer.on(channel, wrappedHandler);
	return () => ipcRenderer.removeListener(channel, wrappedHandler);
}

/**
 * `window.maestro.localModels.runtimes.*` - the native engines local models run
 * on. `install()` is the only call here that opens a connection, and a second
 * call for a runtime already installing joins the first.
 */
function createLocalRuntimesApi() {
	return {
		/** Every native runtime joined to its on-disk state and download size. */
		list: (): Promise<LocalRuntimeListing[]> => ipcRenderer.invoke('localModels:runtimes:list'),

		/** Download, verify, and install one runtime. Resolves when it is usable. */
		install: (runtimeId: string): Promise<boolean> =>
			ipcRenderer.invoke('localModels:runtimes:install', runtimeId),

		/** Disk used by downloaded runtimes. */
		footprint: (): Promise<number> => ipcRenderer.invoke('localModels:runtimes:footprint'),

		/** Delete every downloaded runtime. */
		removeAll: (): Promise<void> => ipcRenderer.invoke('localModels:runtimes:remove-all'),

		/** Install progress. Broadcast, so every window sees the same transfer. */
		onProgress: (handler: (progress: RuntimeInstallProgress) => void): (() => void) =>
			subscribe('localModels:runtimes:progress', handler),
	};
}

/**
 * Creates the Local Models API object for contextBridge exposure.
 */
export function createLocalModelsApi() {
	return {
		/** Every catalog model joined to its on-disk status and install paths. */
		list: (): Promise<LocalModelListing[]> => ipcRenderer.invoke('localModels:list'),

		/**
		 * Start or resume a download. Resolves when the model is installed, paused,
		 * cancelled, or has failed; watch {@link onProgress} for the detail.
		 */
		download: (modelId: string): Promise<DownloadResult> =>
			ipcRenderer.invoke('localModels:download', modelId),

		/** Abort the transfer, keep the partial file. */
		pause: (modelId: string): Promise<boolean> => ipcRenderer.invoke('localModels:pause', modelId),

		/** Continue from the partial file rather than starting over. */
		resume: (modelId: string): Promise<DownloadResult> =>
			ipcRenderer.invoke('localModels:resume', modelId),

		/** Abort and delete everything the download wrote. */
		cancel: (modelId: string): Promise<boolean> =>
			ipcRenderer.invoke('localModels:cancel', modelId),

		/** Re-hash an installed model. A mismatch is reported, never repaired. */
		verify: (modelId: string): Promise<VerifyResult> =>
			ipcRenderer.invoke('localModels:verify', modelId),

		/** Delete one model. Resolves to the bytes reclaimed. */
		remove: (modelId: string): Promise<number> => ipcRenderer.invoke('localModels:remove', modelId),

		/** Delete every installed model. Resolves to the bytes reclaimed. */
		removeAll: (): Promise<number> => ipcRenderer.invoke('localModels:remove-all'),

		/** Disk used by local models, including directories no longer in the catalog. */
		footprint: (): Promise<ModelFootprint> => ipcRenderer.invoke('localModels:footprint'),

		/** Download progress, throttled at the source. Broadcast to every window. */
		onProgress: (handler: (progress: DownloadProgress) => void): (() => void) =>
			subscribe('localModels:progress', handler),

		runtimes: createLocalRuntimesApi(),
	};
}

export type LocalModelsApi = ReturnType<typeof createLocalModelsApi>;
