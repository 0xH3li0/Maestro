/**
 * Local Models WebSocket message handlers.
 *
 * Handles: local_models_endpoints_detect, local_models_endpoint_test. These are
 * the CLI's route to the same endpoint-service functions the
 * `localModels:endpoints:*` IPC channels call, so `maestro-cli models endpoints
 * test` and Settings' Test button use the same record, the same key lookup, and
 * the same budget.
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
