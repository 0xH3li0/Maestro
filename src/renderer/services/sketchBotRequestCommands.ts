/**
 * The window half of `maestro-cli sketch requests|approve|deny|escalate|
 * publish|discard` (spec sections 5 and 9): the bot relay's `@bot` requests
 * live in the window that owns the sketch, so main asks it (`botRequest`).
 *
 * Every op calls the function the Sketch tab's button calls (the approval
 * chip, "Run with full access", the held reply chip), so the CLI and the UI
 * cannot drift. Main has already raised the desktop confirmation an agent
 * caller needs (A1) before it asks.
 */

import {
	visibleSketchApprovals,
	type SketchBotDecisionOp,
	type SketchBotRequestInfo,
} from '../../shared/sketch/bot-requests';
import {
	canEscalateSketchMessage,
	useSketchSessionStore,
	type SketchSession,
} from '../stores/sketchSessionStore';
import {
	approveSketchBotRequest,
	denySketchBotRequest,
	escalateSketchBotRequest,
} from './sketchBotRelay';
import { discardHeldSketchReply, publishHeldSketchReply } from './sketchBotTurns';

/** One session's open requests, and its conductor messages offered "Run with full access". */
function sessionRequests(session: SketchSession): SketchBotRequestInfo[] {
	const waiting = new Set(
		visibleSketchApprovals(session.botRequests).waiting.map((request) => request.replyTo)
	);
	const open = new Set(session.botRequests.map((request) => request.replyTo));
	const requests: SketchBotRequestInfo[] = session.botRequests.map((request) => ({
		sketchId: session.sketchId,
		replyTo: request.replyTo,
		actor: request.actor,
		text: request.text,
		ts: request.ts,
		status: request.status,
		verdict: request.verdict,
		posture: request.posture,
		canEscalate: false,
		...(waiting.has(request.replyTo) ? { waiting: true as const } : {}),
	}));
	for (const message of session.chat) {
		const mark = message.request;
		if (!mark || open.has(mark.replyTo) || !canEscalateSketchMessage(session, message)) continue;
		requests.push({
			sketchId: session.sketchId,
			replyTo: mark.replyTo,
			actor: message.actor,
			text: message.text,
			ts: message.ts,
			status: 'ended',
			verdict: null,
			posture: mark.posture,
			canEscalate: true,
		});
	}
	return requests.sort((a, b) => a.ts - b.ts);
}

/** The open requests of these sketches (every open session without `sketchIds`). */
export function listSketchBotRequests(sketchIds?: readonly string[]): SketchBotRequestInfo[] {
	const sessions = useSketchSessionStore.getState().sessions;
	const ids = sketchIds ?? Object.keys(sessions);
	return ids.flatMap((id) => (sessions[id] ? sessionRequests(sessions[id]) : []));
}

function findRequest(sketchId: string, replyTo: string): SketchBotRequestInfo | undefined {
	return listSketchBotRequests([sketchId]).find((request) => request.replyTo === replyTo);
}

/** Why an op cannot run on a request as it stands. */
function refusal(op: SketchBotDecisionOp, request: SketchBotRequestInfo): string {
	switch (op) {
		case 'approve':
		case 'deny':
			return `Sketch Book: request ${request.replyTo} is ${request.status}, not waiting on approval.`;
		case 'escalate':
			return `Sketch Book: "Run with full access" is not offered on ${request.replyTo}. It is offered on your own message once its restricted turn is over, while a guest has edited the board.`;
		case 'publish':
		case 'discard':
			return `Sketch Book: request ${request.replyTo} has no held reply.`;
	}
}

function act(op: SketchBotDecisionOp, sketchId: string, replyTo: string): boolean {
	switch (op) {
		case 'approve':
			return approveSketchBotRequest(sketchId, replyTo);
		case 'deny':
			return denySketchBotRequest(sketchId, replyTo);
		case 'escalate':
			return escalateSketchBotRequest(sketchId, replyTo);
		case 'publish':
			return publishHeldSketchReply(sketchId, replyTo);
		case 'discard':
			return discardHeldSketchReply(sketchId, replyTo);
	}
}

/**
 * Run one decision on a request, as its button does. Resolves with the
 * request as it stands after (`ended` once it is gone). Throws when the
 * request is not open here, or the op does not apply to it.
 */
export function runSketchBotRequestOp(
	op: SketchBotDecisionOp,
	sketchId: string,
	replyTo: string
): SketchBotRequestInfo {
	const before = findRequest(sketchId, replyTo);
	if (!before) {
		throw new Error(`Sketch Book: no open @bot request ${replyTo} on this sketch.`);
	}
	if (!act(op, sketchId, replyTo)) throw new Error(refusal(op, before));
	return (
		findRequest(sketchId, replyTo) ?? {
			...before,
			status: 'ended',
			canEscalate: false,
		}
	);
}
