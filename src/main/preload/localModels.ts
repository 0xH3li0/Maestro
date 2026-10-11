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
 * `runtimes.install`, and the `endpoints.*` calls, which talk to model servers
 * the user runs. `list()` is a disk read against a frozen local catalog.
 * `taskReadiness()` lists an endpoint's models only when a task is assigned to
 * one. `draftPullRequest()` reaches a model only when Git drafts is assigned
 * one, and `suggestTabCleanup()` only when Tab cleanup suggestions is.
 * `semanticIndex.*` reads the indexer's in-memory progress. `dictation.start()`
 * is the one call that opens a device: the microphone, for this window only.
 */

import { ipcRenderer } from 'electron';
import type { LocalModelListing, LocalRuntimeListing } from '../local-models/service';
import type {
	DetectedEndpoint,
	EndpointModelsResult,
	EndpointTestResult,
} from '../local-models/endpoint-client';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import type { DownloadProgress, DownloadResult } from '../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../local-models/model-store';
import type { RuntimeInstallProgress } from '../local-models/runtime/runtime-installer';
import type { LocalTaskInput, LocalTaskResult } from '../local-models/task-router';
import type { LocalModelTaskId } from '../../shared/local-models/tasks';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';
import type { PullRequestDraftRequest, PullRequestDraftResult } from '../../shared/gitDrafts';
import type {
	DictationInterruption,
	DictationResult,
	DictationStartResult,
} from '../../shared/local-models/dictation';
import type { SemanticIndexProgress } from '../../shared/local-models/embedding-index';
import type { WorkSearchRequest, WorkSearchResult } from '../../shared/local-models/work-search';
import type { TabCleanupResult } from '../../shared/tabCleanup';

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
 * `window.maestro.localModels.endpoints.*` - model servers the user runs
 * (Ollama, LM Studio, OpenAI-compatible). The configured list itself is the
 * `localModelEndpoints` setting. An endpoint is named by saved id or passed as
 * a whole record, so a form can test before it saves. Failures come back as
 * `{ ok: false, error }` rather than a rejection, keeping the error `kind`.
 */
function createLocalModelEndpointsApi() {
	return {
		/**
		 * Probe the default Ollama and LM Studio ports on loopback and return the
		 * running servers that are not configured. Adds nothing.
		 */
		detect: (): Promise<DetectedEndpoint[]> => ipcRenderer.invoke('localModels:endpoints:detect'),

		/** The models one endpoint serves right now. */
		listModels: (endpoint: string | LocalModelEndpoint): Promise<EndpointModelsResult> =>
			ipcRenderer.invoke('localModels:endpoints:listModels', endpoint),

		/** A one-token chat, reporting latency. `model` defaults to the first listed. */
		test: (endpoint: string | LocalModelEndpoint, model?: string): Promise<EndpointTestResult> =>
			ipcRenderer.invoke('localModels:endpoints:test', endpoint, model),
	};
}

/**
 * `window.maestro.localModels.semanticIndex.*` - the background indexer behind
 * semantic search. Read-only: the indexer is driven by the Semantic search
 * assignment and the `semanticIndexCue` setting, not by a call from here.
 */
function createSemanticIndexApi() {
	return {
		/** What the indexer is doing and how far along it is. Reads memory only. */
		status: (): Promise<SemanticIndexProgress> =>
			ipcRenderer.invoke('localModels:semanticIndex:status'),

		/** Progress pushes, throttled at the source. Broadcast to every window. */
		onProgress: (handler: (progress: SemanticIndexProgress) => void): (() => void) =>
			subscribe('localModels:semanticIndex:progress', handler),
	};
}

/**
 * `window.maestro.localModels.dictation.*` - record one clip of speech and get
 * its transcript, through the Dictation task's assignment. No voice session is
 * started and the voice floor is never opened.
 *
 * The recording is made in the main process (the app window has no microphone)
 * and belongs to the window that started it. Every outcome is an answer, never
 * a rejection: a refusal carries a `code` and a `message` written for a person.
 */
function createDictationApi() {
	return {
		/**
		 * Open the microphone and start recording. Resolves `{ started: true }`
		 * once audio is really being captured, or with why it is not (task off or
		 * unavailable, microphone denied, a voice session is live, ...).
		 */
		start: (): Promise<DictationStartResult> => ipcRenderer.invoke('localModels:dictation:start'),

		/** Close the microphone and transcribe what was recorded. */
		stop: (): Promise<DictationResult> => ipcRenderer.invoke('localModels:dictation:stop'),

		/** Close the microphone and discard the recording and any pending transcript. */
		cancel: (): Promise<void> => ipcRenderer.invoke('localModels:dictation:cancel'),

		/**
		 * This window's recording ended on its own (the microphone was lost, or
		 * the length cap was reached). Call `stop()` for what was captured.
		 */
		onInterrupted: (handler: (interruption: DictationInterruption) => void): (() => void) =>
			subscribe('localModels:dictation:interrupted', handler),
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

		/**
		 * Run a text-generation task through the user's assignment for it. Answers
		 * `off` or `use-utility-agent` without touching a model; the caller keeps
		 * its existing path for the latter. Never falls back to another source.
		 */
		runTask: (
			taskId: LocalModelTaskId,
			input: Omit<LocalTaskInput, 'signal'>
		): Promise<LocalTaskResult> => ipcRenderer.invoke('localModels:runTask', taskId, input),

		/**
		 * Whether a task's assigned source would answer now, and if not why and
		 * what to do. Omit the task id for every task (registry order); a named
		 * task answers a one-entry list.
		 */
		taskReadiness: (taskId?: LocalModelTaskId): Promise<LocalModelTaskReadiness[]> =>
			ipcRenderer.invoke('localModels:taskReadiness', taskId),

		/**
		 * Draft a pull request title and body for a local branch with the Git
		 * drafts assignment. Returns text only: nothing is pushed or created. A
		 * task that is off or unavailable answers `success: false` with the reason.
		 */
		draftPullRequest: (request: PullRequestDraftRequest): Promise<PullRequestDraftResult> =>
			ipcRenderer.invoke('localModels:draftPullRequest', request),

		/**
		 * Search past work (History entries, Director's Notes, tab transcripts) by
		 * meaning on the Semantic search assignment, or by exact text. Answers `off`
		 * or `unavailable` with the reason when a semantic search cannot run; it
		 * never falls back to text matches.
		 */
		search: (request: WorkSearchRequest): Promise<WorkSearchResult> =>
			ipcRenderer.invoke('localModels:search', request),

		/**
		 * Ask the Tab cleanup assignment which tabs could be closed, snoozed, or
		 * brought back from snooze, across every agent. Read-only: it returns a
		 * list and changes no tab. A task that is off or unavailable answers
		 * `success: false` with the reason.
		 */
		suggestTabCleanup: (): Promise<TabCleanupResult> =>
			ipcRenderer.invoke('localModels:suggestTabCleanup'),

		dictation: createDictationApi(),

		semanticIndex: createSemanticIndexApi(),

		runtimes: createLocalRuntimesApi(),

		endpoints: createLocalModelEndpointsApi(),
	};
}

export type LocalModelsApi = ReturnType<typeof createLocalModelsApi>;
