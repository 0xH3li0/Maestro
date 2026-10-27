/**
 * Sketch Book WebSocket handler: `sketch_command`, the CLI half of Sketch Book
 * (`maestro-cli sketch new|list|open|rename|delete|read|export|screening-consent|share|
 * unshare|revoke-link|link|reset-link|rotate|owner|requests|approve|deny|escalate|publish|
 * discard|bot-policy|stats|kick|unlock|unsuspend|audit|chat`, spec section 9).
 *
 * The sharing verbs, the `@bot` decisions, `bot-policy` and the Collaborate panel
 * verbs pass the asking agent's name when an agent called (A1): the service
 * raises the desktop confirmation (sharing, approve, escalate, publish,
 * `bot-policy writers`, unlock, unsuspend) and runs only on Allow.
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
import { getSketchBotPolicy } from '../../../sketch/sketch-bot-policy';
import { getSketchRoomAdmin } from '../../../sketch/sketch-room-admin';
import {
	isSketchCommandAction,
	isSketchOwnerOp,
	isSketchScreeningConsentOp,
	type SketchCommandAction,
	type SketchOwnerCommandResult,
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
		case 'rename':
			return service.renameSketch(sketchId, message.name as string);
		case 'delete':
			return service.deleteSketch(sketchId, callerOf(message));
		case 'read':
			return service.readSketch(sketchId, (message.format as 'summary' | undefined) ?? 'summary');
		case 'export':
			return service.exportSketch(sketchId, message.format as 'json');
		case 'screening-consent':
			return screeningConsent(message);
		case 'share':
			return service.shareSketch(
				sketchId,
				{
					role: message.role as 'rw' | 'ro' | undefined,
					expiresInDays: message.expiresInDays as number | undefined,
					label: message.label as string | undefined,
				},
				callerOf(message)
			);
		case 'unshare':
			return service.unshareSketch(sketchId, callerOf(message));
		case 'revoke-link':
			return service.revokeSketchLink(sketchId, message.capId as string, callerOf(message));
		case 'link':
			return service.sketchLink(sketchId, message.capId as string, callerOf(message));
		case 'reset-link':
			return service.resetSketchLink(sketchId, message.capId as string, callerOf(message));
		case 'rotate':
			return service.rotateSketch(sketchId, callerOf(message));
		case 'owner':
			return owner(message);
		case 'requests':
			return service.listBotRequests();
		case 'approve':
		case 'deny':
		case 'escalate':
		case 'publish':
		case 'discard':
			return service.decideBotRequest(action, message.replyTo as string, callerOf(message));
		case 'bot-policy':
			return botPolicy(message);
		case 'stats':
			return getSketchRoomAdmin().stats(sketchId);
		case 'kick':
		case 'unlock':
		case 'unsuspend':
			return getSketchRoomAdmin().act(
				sketchId,
				action,
				{ actorId: message.actorId, capId: message.capId, minutes: message.minutes },
				callerOf(message)
			);
		case 'audit':
			return getSketchRoomAdmin().audit(sketchId);
		case 'chat':
			return service.sketchChat(sketchId, message.text as string | undefined, callerOf(message));
	}
}

/**
 * `maestro-cli sketch bot-policy <sketchId> [conductor|writers]` (spec section
 * 5, B2): the status without a policy, else `policy.set` on the room. The
 * service checks the policy, refuses `writers` while B2 is unavailable, and
 * raises the desktop confirmation for an agent's `writers` (A1).
 */
function botPolicy(message: WebClientMessage): Promise<unknown> {
	const service = getSketchBotPolicy();
	const sketchId = message.sketchId as string;
	if (message.policy === undefined || message.policy === null) return service.status(sketchId);
	return service.setPolicy(sketchId, message.policy as 'conductor' | 'writers', callerOf(message));
}

/** The asking agent's name (or id), when an agent called through the CLI (A1). */
function requestedBy(message: WebClientMessage): string | undefined {
	const caller = readCallerMessageFields(message);
	if (!caller) return undefined;
	return getLiveSessions().find((s) => s.id === caller.fromSessionId)?.name ?? caller.fromSessionId;
}

function callerOf(message: WebClientMessage): { requestedBy?: string } {
	const name = requestedBy(message);
	return name ? { requestedBy: name } : {};
}

/** `maestro-cli sketch owner status|register|sign-out` (spec section 6, M1). */
async function owner(message: WebClientMessage): Promise<SketchOwnerCommandResult> {
	const service = getSketchService();
	const op = message.op;
	if (!isSketchOwnerOp(op)) {
		throw new Error(`owner expects status, register or sign-out, not ${String(op ?? '(none)')}.`);
	}
	if (op === 'status') return { status: await service.ownerStatus() };
	if (op === 'sign-out') return { status: await service.signOutOwner() };
	const registration = await service.registerOwner(message.email as string);
	const status =
		message.wait === true && registration.status.state === 'pending'
			? await service.waitForOwner()
			: registration.status;
	return { status, email: registration.email };
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
	const fromAgent = requestedBy(message);
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
