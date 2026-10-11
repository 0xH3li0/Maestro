/**
 * Local Models IPC handlers (`localModels:*`).
 *
 * The core transport in front of `src/main/local-models/service.ts`. NOT gated
 * on any Encore Feature: Local Models is a core service with several consumers
 * (voice is one), so its catalog, downloads, and disk have to be reachable no
 * matter which consumer is switched on. A consumer that wants a gate applies it
 * on its own channels (see `acappella-models.ts`), never here.
 *
 * Registering these channels opens no socket and reads no remote metadata. The
 * only calls that reach the network are `download`, `resume`, and
 * `runtimes:install`, each of which a user pressed a button to send, plus the
 * `endpoints:*` calls, which talk to a model server the user runs.
 * `endpoints:detect` probes loopback only and saves nothing. `runTask` reaches
 * a model only when the user assigned one to that task. `taskReadiness` reads
 * disk and settings, and reaches the network only to list the models of an
 * endpoint a task is assigned to. `draftPullRequest` reads a local repository
 * and reaches a model only when the user assigned one to Git drafts.
 *
 * Progress is BROADCAST, matching the multi-window invariant in
 * `src/main/utils/safe-send.ts`.
 */

import { ipcMain } from 'electron';

import type {
	DetectedEndpoint,
	EndpointModelsResult,
	EndpointTestResult,
} from '../../local-models/endpoint-client';
import {
	detectNewLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../local-models/endpoint-service';
import type { DownloadProgress, DownloadResult } from '../../local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../local-models/model-store';
import type { RuntimeInstallProgress } from '../../local-models/runtime/runtime-installer';
import { draftPullRequestRequest } from '../../local-models/git-drafts';
import { runLocalTaskRequest, type LocalTaskResult } from '../../local-models/task-router';
import { resolveTaskReadinessRequest } from '../../local-models/task-readiness';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';
import type { PullRequestDraftResult } from '../../../shared/gitDrafts';
import {
	cancelLocalModel,
	downloadLocalModel,
	installLocalRuntime,
	listLocalModels,
	listLocalRuntimes,
	localModelsFootprint,
	localRuntimesFootprint,
	onLocalModelProgress,
	onLocalRuntimeInstallProgress,
	pauseLocalModel,
	removeAllLocalModels,
	removeAllLocalRuntimes,
	removeLocalModel,
	resumeLocalModel,
	verifyLocalModel,
	type LocalModelListing,
	type LocalRuntimeListing,
} from '../../local-models/service';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';

const LOG_CONTEXT = '[LocalModels]';

/** The push channel model download progress goes out on. */
export const LOCAL_MODEL_PROGRESS_CHANNEL = 'localModels:progress';

/** The push channel native-runtime install progress goes out on. */
export const LOCAL_RUNTIME_PROGRESS_CHANNEL = 'localModels:runtimes:progress';

export interface LocalModelsHandlerDependencies {
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Unsubscribes from the previous registration, so re-registering never doubles broadcasts. */
let releaseProgressListeners: (() => void) | null = null;

/**
 * Register the core Local Models handlers.
 *
 * Wired from `setupIpcHandlers()` (src/main/ipc/bootstrap/index.ts), which is
 * what the running app calls. A handler registered only through
 * `registerAllHandlers()` in handlers/index.ts would be dead.
 */
export function registerLocalModelsHandlers(deps: LocalModelsHandlerDependencies): void {
	const { safeSend } = deps;

	releaseProgressListeners?.();
	const releaseModel = onLocalModelProgress((progress: DownloadProgress) => {
		safeSend(LOCAL_MODEL_PROGRESS_CHANNEL, progress);
	});
	const releaseRuntime = onLocalRuntimeInstallProgress((progress: RuntimeInstallProgress) => {
		safeSend(LOCAL_RUNTIME_PROGRESS_CHANNEL, progress);
	});
	releaseProgressListeners = () => {
		releaseModel();
		releaseRuntime();
	};

	ipcMain.handle(
		'localModels:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (): Promise<LocalModelListing[]> => listLocalModels()
		)
	);
	ipcMain.handle(
		'localModels:download',
		withIpcErrorLogging(
			handlerOpts('download'),
			async (id: unknown): Promise<DownloadResult> => downloadLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:pause',
		withIpcErrorLogging(
			handlerOpts('pause'),
			async (id: unknown): Promise<boolean> => pauseLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:resume',
		withIpcErrorLogging(
			handlerOpts('resume'),
			async (id: unknown): Promise<DownloadResult> => resumeLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:cancel',
		withIpcErrorLogging(
			handlerOpts('cancel'),
			async (id: unknown): Promise<boolean> => cancelLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:verify',
		withIpcErrorLogging(
			handlerOpts('verify'),
			async (id: unknown): Promise<VerifyResult> => verifyLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:remove',
		withIpcErrorLogging(
			handlerOpts('remove'),
			async (id: unknown): Promise<number> => removeLocalModel(id)
		)
	);
	ipcMain.handle(
		'localModels:remove-all',
		withIpcErrorLogging(
			handlerOpts('removeAll'),
			async (): Promise<number> => removeAllLocalModels()
		)
	);
	ipcMain.handle(
		'localModels:footprint',
		withIpcErrorLogging(
			handlerOpts('footprint'),
			async (): Promise<ModelFootprint> => localModelsFootprint()
		)
	);

	ipcMain.handle(
		'localModels:runtimes:list',
		withIpcErrorLogging(
			handlerOpts('runtimes:list'),
			async (): Promise<LocalRuntimeListing[]> => listLocalRuntimes()
		)
	);
	ipcMain.handle(
		'localModels:runtimes:install',
		withIpcErrorLogging(handlerOpts('runtimes:install'), async (id: unknown): Promise<boolean> => {
			await installLocalRuntime(id);
			return true;
		})
	);
	ipcMain.handle(
		'localModels:runtimes:footprint',
		withIpcErrorLogging(
			handlerOpts('runtimes:footprint'),
			async (): Promise<number> => localRuntimesFootprint()
		)
	);
	ipcMain.handle(
		'localModels:runtimes:remove-all',
		withIpcErrorLogging(
			handlerOpts('runtimes:remove-all'),
			async (): Promise<void> => removeAllLocalRuntimes()
		)
	);

	ipcMain.handle(
		'localModels:endpoints:detect',
		withIpcErrorLogging(
			handlerOpts('endpoints:detect'),
			async (): Promise<DetectedEndpoint[]> => detectNewLocalModelEndpoints()
		)
	);
	ipcMain.handle(
		'localModels:endpoints:listModels',
		withIpcErrorLogging(
			handlerOpts('endpoints:listModels'),
			async (ref: unknown): Promise<EndpointModelsResult> => listLocalModelEndpointModels(ref)
		)
	);
	ipcMain.handle(
		'localModels:endpoints:test',
		withIpcErrorLogging(
			handlerOpts('endpoints:test'),
			async (ref: unknown, model?: unknown): Promise<EndpointTestResult> =>
				testLocalModelEndpoint(ref, model)
		)
	);

	ipcMain.handle(
		'localModels:runTask',
		withIpcErrorLogging(
			handlerOpts('runTask'),
			async (taskId: unknown, input: unknown): Promise<LocalTaskResult> =>
				runLocalTaskRequest(taskId, input)
		)
	);

	ipcMain.handle(
		'localModels:taskReadiness',
		withIpcErrorLogging(
			handlerOpts('taskReadiness'),
			async (taskId?: unknown): Promise<LocalModelTaskReadiness[]> =>
				resolveTaskReadinessRequest(taskId)
		)
	);

	ipcMain.handle(
		'localModels:draftPullRequest',
		withIpcErrorLogging(
			handlerOpts('draftPullRequest'),
			async (request: unknown): Promise<PullRequestDraftResult> => draftPullRequestRequest(request)
		)
	);
}
