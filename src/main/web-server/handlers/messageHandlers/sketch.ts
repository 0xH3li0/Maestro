/**
 * Sketch Book WebSocket handler: `sketch_command`, the CLI half of Sketch Book
 * (`maestro-cli sketch new|list|open|read|export`, spec section 9).
 *
 * One message carrying an `action`, answered by the SAME SketchService the
 * `sketch:*` IPC handlers call, so the CLI and the UI cannot drift. The service
 * refuses every action while the `sketchBook` Encore Feature is off, and checks
 * each field; this handler only routes and reports.
 *
 * CLI connections only. Sketch Book is desktop only and shares through
 * RunMaestro.ai, never through the web interface (Q13), so a browser client is
 * refused the way the `sketch:*` IPC channels are refused on the web bridge.
 */

import { logger } from '../../../utils/logger';
import { getSketchService } from '../../../sketch/sketch-service';
import { getSketchCloudConsent } from '../../../sketch/sketch-cloud-consent';
import {
	isSketchCommandAction,
	isSketchScreeningConsentOp,
	type SketchCommandAction,
} from '../../../../shared/sketch/commands';
import { isSketchCloudEngine } from '../../../../shared/sketch/cloud-consent';
import { readCallerMessageFields } from '../../../../shared/agentDelegation';
import { getLiveSessions } from '../../../stores/getters';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

function run(action: SketchCommandAction, message: WebClientMessage): Promise<unknown> {
	const service = getSketchService();
	const sketchId = message.sketchId as string;
	switch (action) {
		case 'new':
			return service.newSketch({
				ownerAgentId: message.agentId as string,
				name: message.name as string | undefined,
				background: message.background === true,
			});
		case 'list': {
			const agentId = message.agentId as string | undefined;
			return service.listSketches(agentId ? { ownerAgentId: agentId } : undefined);
		}
		case 'open':
			return service.openSketch(sketchId, { background: message.background === true });
		case 'read':
			return service.readSketch(sketchId, (message.format as 'summary' | undefined) ?? 'summary');
		case 'export':
			return service.exportSketch(sketchId, message.format as 'json');
		case 'screening-consent':
			return screeningConsent(message);
	}
}

/**
 * `maestro-cli sketch screening-consent grant|revoke|status` (spec section
 * 8.10). A grant from an agent caller raises the desktop confirmation (A1) and
 * stores nothing unless the conductor allows it; revoke and status run.
 */
function screeningConsent(message: WebClientMessage): Promise<unknown> {
	const consent = getSketchCloudConsent();
	const op = message.op;
	if (!isSketchScreeningConsentOp(op)) {
		throw new Error(
			`screening-consent expects grant, revoke or status, not ${String(op ?? '(none)')}.`
		);
	}
	if (op === 'status') return consent.status();
	const engine = message.engine;
	if (!isSketchCloudEngine(engine)) {
		throw new Error(`--engine expects jev or openjev, not ${String(engine ?? '(none)')}.`);
	}
	if (op === 'revoke') return consent.revokeConsent(engine);
	const caller = readCallerMessageFields(message);
	const fromAgent = caller
		? (getLiveSessions().find((s) => s.id === caller.fromSessionId)?.name ?? caller.fromSessionId)
		: undefined;
	return consent.requestGrant(engine, fromAgent ? { fromAgent } : {});
}

export async function handleSketchCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sketch_result', ...payload, requestId: message.requestId });
	};

	if (client.cli !== true) {
		logger.warn(`[Web] Refused sketch_command from non-CLI client ${client.id}`, LOG_CONTEXT);
		reply({ success: false, error: 'Sketch Book is not available over the web interface' });
		return;
	}

	const action = message.action;
	if (!isSketchCommandAction(action)) {
		reply({ success: false, error: `Unknown Sketch Book action: ${String(action ?? '(none)')}` });
		return;
	}
	logger.info(`[Web] Received sketch_command: action=${action}`, LOG_CONTEXT);

	try {
		reply({ success: true, response: await run(action, message) });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
