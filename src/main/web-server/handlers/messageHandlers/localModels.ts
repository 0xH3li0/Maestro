/**
 * Local Models WebSocket message handlers.
 *
 * Handles: local_models_list, local_models_download, local_models_pause,
 * local_models_cancel, local_models_verify, local_models_remove,
 * local_models_endpoints_detect, local_models_endpoint_models,
 * local_models_endpoint_test, local_models_run_task, local_models_task_readiness, local_models_git_draft,
 * local_models_semantic_index_status, local_models_search,
 * local_models_tab_cleanup, local_models_transcribe, local_models_proxy_status,
 * local_models_proxy_block, local_models_runtimes_list,
 * local_models_runtime_install, notify_speak.
 * These are the CLI's route to the same service functions the `localModels:*`
 * IPC channels call, so
 * `maestro-cli models install` and Settings' Download button write the same
 * files through the same downloader, `maestro-cli models endpoints test` and
 * Settings' Test button use the same record, the same key lookup, and the same
 * budget, and `maestro-cli models run` goes through the same task router (and
 * the same assignment) as an in-app caller.
 *
 * Adding, editing and removing an endpoint, and assigning a task, do NOT come
 * through here: like SSH remotes, the CLI edits `localModelEndpoints` and
 * `localModelAssignments` in the settings file through the shared helpers, and
 * the settings watcher reloads every window. Only the verbs that need the model
 * store, the network, or Settings -> Environment run in the app.
 */

import {
	detectNewLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../local-models/endpoint-service';
import {
	cancelLocalModel,
	installLocalModel,
	installLocalRuntime,
	listLocalRuntimes,
	listLocalModels,
	localModelsFootprint,
	pauseLocalModel,
	removeLocalModel,
	verifyLocalModel,
} from '../../../local-models/service';
import { transcribeAudioFileRequest } from '../../../local-models/dictation';
import { speakNoticeRequest } from '../../../local-models/spoken-notices';
import { draftPullRequestRequest } from '../../../local-models/git-drafts';
import { runLocalTaskRequest } from '../../../local-models/task-router';
import { resolveTaskReadinessRequest } from '../../../local-models/task-readiness';
import { semanticIndexProgress } from '../../../local-models/semantic-indexer';
import { searchPastWorkRequest } from '../../../local-models/work-search';
import { suggestTabCleanup } from '../../../local-models/tab-cleanup';
import { getTokenProxyReport, readTokenProxyBlock } from '../../../local-models/proxy/service';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Run one service call and answer with its result under `key`, or with
 * `success: false` and the error message. Every handler here has the same
 * shape: a verdict the service RETURNS (a failed download, a corrupt verify)
 * is a successful round trip, and only a thrown error is a failed one.
 */
async function respond(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	type: string,
	work: () => Promise<Record<string, unknown>>
): Promise<void> {
	try {
		const payload = await work();
		ctx.send(client, { type, success: true, ...payload, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}

/**
 * Handle local_models_list - every catalog model joined to its install state,
 * plus the disk footprint (`maestro-cli models list`). A disk read; no network.
 */
export function handleLocalModelsList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_list_result', async () => {
		const [listings, footprint] = await Promise.all([listLocalModels(), localModelsFootprint()]);
		return { listings, footprint };
	});
}

/**
 * Handle local_models_download - download (or resume) one model and answer when
 * the job settles (`maestro-cli models install`). The same downloader as the
 * Settings button, so a download already running from the app is joined, not
 * duplicated, and its progress shows in every window.
 */
export function handleLocalModelsDownload(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_download_result', async () => ({
		// The model and the runtime that reads it, exactly as the Settings button.
		result: await installLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_runtimes_list - every native runtime joined to what is on
 * disk (`maestro-cli models runtimes list`). A disk read; no network.
 */
export function handleLocalModelsRuntimesList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_runtimes_list_result', async () => ({
		runtimes: await listLocalRuntimes(),
	}));
}

/**
 * Handle local_models_runtime_install - download, verify and install one
 * runtime, answering with its listing afterwards (`maestro-cli models runtimes
 * install`). Joins an install already running from the app.
 */
export function handleLocalModelsRuntimeInstall(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_runtime_install_result', async () => {
		await installLocalRuntime(message.runtimeId);
		const runtimes = await listLocalRuntimes();
		return { runtime: runtimes.find((runtime) => runtime.id === message.runtimeId) };
	});
}

/**
 * Handle local_models_pause - abort one running download and keep its partial
 * file (`maestro-cli models pause`). `paused` is false when nothing was running,
 * which is an answer, not an error. Resume is `local_models_download` again.
 */
export function handleLocalModelsPause(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_pause_result', async () => ({
		paused: pauseLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_cancel - abort one download and delete what it wrote
 * (`maestro-cli models cancel`). `cancelled` is false when no job was running;
 * a partial file left by an earlier run is cleared either way.
 */
export function handleLocalModelsCancel(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_cancel_result', async () => ({
		cancelled: await cancelLocalModel(message.modelId),
	}));
}

/** Handle local_models_verify - re-hash one model against the catalog. */
export function handleLocalModelsVerify(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_verify_result', async () => ({
		result: await verifyLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_remove - delete one model, answering with the bytes
 * reclaimed. The in-use warning is the CLI's job before it sends this, exactly
 * as the Settings row warns before it calls `localModels:remove`.
 */
export function handleLocalModelsRemove(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_remove_result', async () => ({
		bytes: await removeLocalModel(message.modelId),
	}));
}

/** Handle local_models_endpoints_detect - running loopback servers not configured yet. */
export function handleLocalModelsEndpointsDetect(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_endpoints_detect_result', async () => ({
		detected: await detectNewLocalModelEndpoints(),
	}));
}

/**
 * Handle local_models_endpoint_models - the models one saved endpoint serves
 * now, named by id, id prefix, or name (`maestro-cli models endpoints models`).
 * A server that cannot be listed is still a successful round trip: the verdict
 * rides in `result`, with the same error kinds as the test.
 */
export function handleLocalModelsEndpointModels(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const ref = typeof message.endpoint === 'string' ? message.endpoint : '';
	return respond(ctx, client, message, 'local_models_endpoint_models_result', async () => ({
		result: await listLocalModelEndpointModels(ref),
	}));
}

/**
 * Handle local_models_endpoint_test - a one-token chat against a saved
 * endpoint, named by id, id prefix, or name. An endpoint that answers badly is
 * still a successful round trip: the verdict rides in `result`, whose `error`
 * keeps its `kind` so the CLI can tell a missing key from a dead server.
 */
export function handleLocalModelsEndpointTest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const ref = typeof message.endpoint === 'string' ? message.endpoint : '';
	const model = typeof message.model === 'string' ? message.model : undefined;
	return respond(ctx, client, message, 'local_models_endpoint_test_result', async () => ({
		result: await testLocalModelEndpoint(ref, model),
	}));
}

/**
 * Handle local_models_run_task - one text-generation task through the task
 * router. Every router verdict (`off`, `use-utility-agent`, `unavailable`, ...)
 * is a successful round trip and rides in `result`; only a bad request (an
 * unknown task, a non-text task, a malformed input) comes back as an error.
 */
export function handleLocalModelsRunTask(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_run_task_result', async () => ({
		result: await runLocalTaskRequest(message.taskId, message.input),
	}));
}

/**
 * Handle local_models_task_readiness - whether each task's assigned source
 * would answer now (`maestro-cli models status`). An unavailable task is a
 * successful round trip with the verdict in `readiness`; only an unknown task
 * id comes back as an error.
 */
export function handleLocalModelsTaskReadiness(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_task_readiness_result', async () => ({
		readiness: await resolveTaskReadinessRequest(message.taskId),
	}));
}

/**
 * Handle local_models_git_draft - a pull request title and body for a local
 * branch (`maestro-cli models run git-drafts --cwd`), through the same service
 * function as the Create Pull Request form's draft button. A task that is off,
 * unavailable, or has nothing to draft from is a successful round trip with the
 * reason in `result`; only a bad request (no path, a bad branch name) comes
 * back as an error.
 */
export function handleLocalModelsGitDraft(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_git_draft_result', async () => ({
		result: await draftPullRequestRequest({ cwd: message.cwd, baseBranch: message.baseBranch }),
	}));
}

/**
 * Handle local_models_semantic_index_status - what the background indexer is
 * doing and how far along it is (`maestro-cli models index`). The same record
 * the `localModels:semanticIndex:status` IPC channel answers with; reads memory
 * only, and answers `off` before the indexer has started.
 */
export function handleLocalModelsSemanticIndexStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_semantic_index_status_result', async () => ({
		progress: semanticIndexProgress(),
	}));
}

/**
 * Handle local_models_proxy_status - what the Maestro token proxy is doing, the
 * agents on it with their mode, what it carried and what it last shortened
 * (`maestro-cli models proxy status`). The same report the
 * `localModels:proxy:report` IPC channel answers with; it never chooses a port.
 */
export function handleLocalModelsProxyStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_proxy_status_result', async () => ({
		report: await getTokenProxyReport(),
	}));
}

/**
 * Handle local_models_proxy_block - both sides of one compressed block from the
 * content-addressed cache (`maestro-cli models proxy block <hash>`). A hash the
 * cache has no compressed verdict for answers `block: null`; a value that is
 * not a hash is an error.
 */
export function handleLocalModelsProxyBlock(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_proxy_block_result', async () => ({
		block: await readTokenProxyBlock(message.hash),
	}));
}

/**
 * Handle local_models_search - search past work by meaning or by text
 * (`maestro-cli search`), through the same function the `localModels:search`
 * IPC channel calls. A search that is off or unavailable is a successful round
 * trip with the verdict in `result`; only a bad request (no query, an unknown
 * source) comes back as an error.
 */
export function handleLocalModelsSearch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_search_result', async () => ({
		result: await searchPastWorkRequest(message.request),
	}));
}

/**
 * Handle local_models_tab_cleanup - which tabs could be closed, snoozed, or
 * woken (`maestro-cli tab suggest-cleanup`), through the same function the
 * Tab Cleanup Suggestions modal calls. Read-only: it answers with a list and
 * changes no tab. A task that is off or unavailable is a successful round trip
 * with the reason in `result`.
 */
export function handleLocalModelsTabCleanup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_tab_cleanup_result', async () => ({
		result: await suggestTabCleanup(),
	}));
}

/**
 * Handle local_models_transcribe - transcribe a WAV file with the Dictation
 * assignment (`maestro-cli models run dictation --audio <file>`), through the
 * same `transcribeClip()` a dictation recorded in a text box ends in. A task
 * that is off or unavailable is a successful round trip with the verdict in
 * `result`; only a bad request (no path, not a WAV) comes back as an error.
 */
export function handleLocalModelsTranscribe(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_transcribe_result', async () => ({
		result: await transcribeAudioFileRequest(message.path),
	}));
}

/**
 * Handle notify_speak - say one line aloud through the spoken notices queue
 * (`maestro-cli notify speak "<text>"`), the same `speakNotice()` the Test
 * button in Settings > Notifications calls. Answers once the line was spoken
 * or refused. A refusal (a voice session is live, the voice could not speak)
 * is a successful round trip with the verdict in `result`; only a bad request
 * (no text, too long) comes back as an error.
 */
export function handleNotifySpeak(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'notify_speak_result', async () => ({
		result: await speakNoticeRequest(message.text),
	}));
}
