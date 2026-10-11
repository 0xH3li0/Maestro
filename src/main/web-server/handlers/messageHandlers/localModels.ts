/**
 * Local Models WebSocket message handlers.
 *
 * Handles: local_models_endpoints_detect, local_models_endpoint_test,
 * local_models_run_task. These are the CLI's route to the same service functions
 * the `localModels:*` IPC channels call, so `maestro-cli models endpoints test`
 * and Settings' Test button use the same record, the same key lookup, and the
 * same budget, and `maestro-cli models run` goes through the same task router
 * (and the same assignment) as an in-app caller.
 *
 * Adding and removing an endpoint does NOT come through here: like SSH remotes,
 * the CLI edits `localModelEndpoints` in the settings file through the shared
 * list helpers, and the settings watcher reloads every window. Only the verbs
 * that need the network and Settings -> Environment run in the app.
 */

import {
	detectNewLocalModelEndpoints,
	testLocalModelEndpoint,
} from '../../../local-models/endpoint-service';
import { runLocalTaskRequest } from '../../../local-models/task-router';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Handle local_models_endpoints_detect - running loopback servers not configured yet. */
export async function handleLocalModelsEndpointsDetect(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'local_models_endpoints_detect_result';
	try {
		const detected = await detectNewLocalModelEndpoints();
		ctx.send(client, { type, success: true, detected, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}

/**
 * Handle local_models_endpoint_test - a one-token chat against a saved
 * endpoint, named by id, id prefix, or name. An endpoint that answers badly is
 * still a successful round trip: the verdict rides in `result`, whose `error`
 * keeps its `kind` so the CLI can tell a missing key from a dead server.
 */
export async function handleLocalModelsEndpointTest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'local_models_endpoint_test_result';
	const ref = typeof message.endpoint === 'string' ? message.endpoint : '';
	const model = typeof message.model === 'string' ? message.model : undefined;
	try {
		const result = await testLocalModelEndpoint(ref, model);
		ctx.send(client, { type, success: true, result, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}

/**
 * Handle local_models_run_task - one text-generation task through the task
 * router. Every router verdict (`off`, `use-utility-agent`, `unavailable`, ...)
 * is a successful round trip and rides in `result`; only a bad request (an
 * unknown task, a non-text task, a malformed input) comes back as an error.
 */
export async function handleLocalModelsRunTask(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'local_models_run_task_result';
	try {
		const result = await runLocalTaskRequest(message.taskId, message.input);
		ctx.send(client, { type, success: true, result, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}
