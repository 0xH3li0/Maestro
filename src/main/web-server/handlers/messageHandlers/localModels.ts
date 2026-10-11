/**
 * Local Models WebSocket message handlers.
 *
 * Handles: local_models_list, local_models_download, local_models_verify,
 * local_models_remove, local_models_endpoints_detect, local_models_endpoint_test,
 * local_models_run_task, local_models_task_readiness, local_models_git_draft.
 * These are the CLI's route to the same service functions the `localModels:*`
 * IPC channels call, so
 * `maestro-cli models install` and Settings' Download button write the same
 * files through the same downloader, `maestro-cli models endpoints test` and
 * Settings' Test button use the same record, the same key lookup, and the same
 * budget, and `maestro-cli models run` goes through the same task router (and
 * the same assignment) as an in-app caller.
 *
 * Adding and removing an endpoint, and assigning a task, do NOT come through
 * here: like SSH remotes, the CLI edits `localModelEndpoints` and
 * `localModelAssignments` in the settings file through the shared helpers, and
 * the settings watcher reloads every window. Only the verbs that need the model
 * store, the network, or Settings -> Environment run in the app.
 */

import {
	detectNewLocalModelEndpoints,
	testLocalModelEndpoint,
} from '../../../local-models/endpoint-service';
import {
	downloadLocalModel,
	listLocalModels,
	localModelsFootprint,
	removeLocalModel,
	verifyLocalModel,
} from '../../../local-models/service';
import { draftPullRequestRequest } from '../../../local-models/git-drafts';
import { runLocalTaskRequest } from '../../../local-models/task-router';
import { resolveTaskReadinessRequest } from '../../../local-models/task-readiness';
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
		result: await downloadLocalModel(message.modelId),
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
