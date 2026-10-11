/**
 * The Local Models service: the one implementation behind every surface that
 * lists, downloads, verifies, removes, or installs local models and the native
 * runtimes they run on.
 *
 * Two IPC transports sit in front of it and neither carries logic of its own:
 * the core `localModels:*` channels (`src/main/ipc/handlers/local-models.ts`,
 * ungated, because Local Models is a core feature) and A Cappella's older
 * `models:*` / `runtimes:*` channels (`acappella-models.ts`, gated on the voice
 * Encore flag). A second copy of any of this would drift first on the parts
 * that are easy to get subtly wrong: id validation before a path join, cancel
 * before delete, and one shared install per runtime.
 *
 * Nothing here touches the network except `downloadLocalModel`,
 * `resumeLocalModel`, and `installLocalRuntime`. Listing is a disk read against
 * frozen tables that already know every size and hash.
 */

import {
	LOCAL_MODEL_CATALOG,
	getLocalModel,
	localModelsForRuntime,
} from '../../shared/local-models/model-catalog';
import { NATIVE_RUNTIMES, type NativeRuntimeId } from '../../shared/local-models/native-runtimes';
import { nativeRuntimeArtifactBytes } from '../../shared/local-models/runtime-artifacts';
import type { LocalModelEntry } from '../../shared/local-models/types';
import { getModelDownloader, type DownloadProgress, type DownloadResult } from './model-downloader';
import {
	installPathFor,
	listStatuses,
	remove,
	removeAll,
	totalFootprint,
	verify,
	type ModelFootprint,
	type ModelStatus,
	type VerifyResult,
} from './model-store';
import { installNativeRuntime, type RuntimeInstallProgress } from './runtime/runtime-installer';
import {
	artifactForThisPlatform,
	isRuntimeInstalled,
	isRuntimeStale,
	removeAllRuntimes,
	runtimesFootprint,
} from './runtime/runtime-store';
import { resetNativeRuntimes } from './runtime/native-loader';

/**
 * One catalog entry joined to what is on disk: the bill of materials and its
 * install state in one object, so a UI never has to correlate two lists.
 */
export interface LocalModelListing {
	entry: LocalModelEntry;
	status: ModelStatus;
	/** Absolute install paths, one per catalog file, for the "where does this go" line. */
	installPaths: string[];
}

/**
 * One native runtime joined to what is on disk. `downloadable` is false on a
 * platform with no published payload, which is a different answer from "not
 * installed yet" and needs different words in front of the user.
 */
export interface LocalRuntimeListing {
	id: NativeRuntimeId;
	label: string;
	/** Catalog model ids that cannot load without this runtime. */
	models: string[];
	installed: boolean;
	/** Installed, but not the payload this build expects. */
	stale: boolean;
	downloadable: boolean;
	/** Compressed download size for this platform. Zero when not downloadable. */
	bytes: number;
}

/** Reject anything that is not a catalog id before it can reach a path join. */
export function requireLocalModelId(raw: unknown): string {
	if (typeof raw !== 'string' || !getLocalModel(raw)) throw new Error('UnknownLocalModel');
	return raw;
}

/** Reject anything that is not a known runtime id before it reaches a path join. */
export function requireLocalRuntimeId(raw: unknown): NativeRuntimeId {
	const known = NATIVE_RUNTIMES.some((runtime) => runtime.id === raw);
	if (typeof raw !== 'string' || !known) throw new Error('UnknownLocalRuntime');
	return raw as NativeRuntimeId;
}

// -- Models -------------------------------------------------------------------

/** Every catalog model joined to its on-disk status and install paths. */
export async function listLocalModels(): Promise<LocalModelListing[]> {
	const statuses = await listStatuses();
	return LOCAL_MODEL_CATALOG.map((entry, index) => ({
		entry,
		status: statuses[index],
		installPaths: entry.files.map((file) => installPathFor(entry, file)),
	}));
}

export function downloadLocalModel(rawId: unknown): Promise<DownloadResult> {
	return getModelDownloader().download(requireLocalModelId(rawId));
}

/** Abort the transfer, keep the partial file. */
export function pauseLocalModel(rawId: unknown): boolean {
	return getModelDownloader().pause(requireLocalModelId(rawId));
}

export function resumeLocalModel(rawId: unknown): Promise<DownloadResult> {
	return getModelDownloader().resume(requireLocalModelId(rawId));
}

export function cancelLocalModel(rawId: unknown): Promise<boolean> {
	return getModelDownloader().cancel(requireLocalModelId(rawId));
}

export function verifyLocalModel(rawId: unknown): Promise<VerifyResult> {
	return verify(requireLocalModelId(rawId));
}

/** Delete one model. Resolves to the bytes reclaimed. */
export async function removeLocalModel(rawId: unknown): Promise<number> {
	const id = requireLocalModelId(rawId);
	// Cancel first: deleting the directory under a live writer would let the
	// writer recreate the file it was told to stop writing.
	await getModelDownloader().cancel(id);
	return remove(id);
}

/** Delete every installed model. Resolves to the bytes reclaimed. */
export async function removeAllLocalModels(): Promise<number> {
	await getModelDownloader().cancelAll();
	return removeAll();
}

export function localModelsFootprint(): Promise<ModelFootprint> {
	return totalFootprint();
}

/**
 * Subscribe to download progress (throttled at the source). Returns the
 * unsubscribe, so a transport that registers twice can drop its old listener.
 */
export function onLocalModelProgress(listener: (progress: DownloadProgress) => void): () => void {
	return getModelDownloader().onProgress(listener);
}

// -- Runtimes -----------------------------------------------------------------

/** Every native runtime joined to its on-disk state and download size. */
export async function listLocalRuntimes(): Promise<LocalRuntimeListing[]> {
	return Promise.all(
		NATIVE_RUNTIMES.map(async (runtime) => {
			// `artifactForThisPlatform` resolves the platform key itself, so this
			// cannot disagree with what the installer will actually fetch.
			const artifact = artifactForThisPlatform(runtime.id);
			return {
				id: runtime.id,
				label: runtime.label,
				models: localModelsForRuntime(runtime.id).map((entry) => entry.id),
				installed: await isRuntimeInstalled(runtime.id),
				stale: await isRuntimeStale(runtime.id),
				downloadable: artifact !== null,
				// Payload plus dependencies: for llama the dependencies are most of it.
				bytes: artifact ? nativeRuntimeArtifactBytes(artifact) : 0,
			};
		})
	);
}

const runtimeProgressListeners = new Set<(progress: RuntimeInstallProgress) => void>();

/**
 * Subscribe to runtime install progress. Fanned out here rather than passed per
 * call, because an install started from one transport must be visible on every
 * other: a runtime requested by voice is the same bytes the core panel shows.
 */
export function onLocalRuntimeInstallProgress(
	listener: (progress: RuntimeInstallProgress) => void
): () => void {
	runtimeProgressListeners.add(listener);
	return () => {
		runtimeProgressListeners.delete(listener);
	};
}

/**
 * Installs in flight, keyed by runtime.
 *
 * `installNativeRuntime` clears its staging directory on entry, so two
 * concurrent installs of the same runtime would delete each other's partial
 * download and race to rename onto the same target. Sharing the promise makes a
 * second request join the first, from either transport - which is also what the
 * user means when an impatient second click lands on a download already running.
 */
const runtimeInstalls = new Map<NativeRuntimeId, Promise<void>>();

/** Download, verify, and install one runtime. Resolves when it is usable. */
export async function installLocalRuntime(rawId: unknown): Promise<void> {
	const id = requireLocalRuntimeId(rawId);

	const existing = runtimeInstalls.get(id);
	if (existing) return existing;

	const install = installNativeRuntime(id, {
		onProgress: (progress) => {
			for (const listener of runtimeProgressListeners) listener(progress);
		},
	})
		.then(() => {
			// The loader remembers failures so it does not retry a dlopen on every
			// call. That memory is now stale in the good direction: the thing it
			// could not find is on disk. Without this the user downloads a runtime
			// and every consumer keeps refusing until the app restarts.
			resetNativeRuntimes();
		})
		.finally(() => {
			runtimeInstalls.delete(id);
		});

	runtimeInstalls.set(id, install);
	return install;
}

export function localRuntimesFootprint(): Promise<number> {
	return runtimesFootprint();
}

/** Delete every downloaded runtime. */
export async function removeAllLocalRuntimes(): Promise<void> {
	await removeAllRuntimes();
	// Whatever is currently dlopened points at files that no longer exist.
	resetNativeRuntimes();
}
