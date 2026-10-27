/**
 * Sketch Book `@bot` requests as the conductor decides them (spec section 5,
 * B2 approval chip, and section 9): the approval chip, the "Run with full
 * access" control, the held reply chip, and the `maestro-cli sketch
 * requests|approve|deny|escalate|publish|discard` verbs all read them here.
 *
 * - An approval chip shows the server-stamped actor (A2), the request, and
 *   the gate's verdict ({@link describeSketchVerdict}). At most
 *   {@link SKETCH_APPROVALS_PER_CAP} chips show per link; newer requests on
 *   that link wait behind them ({@link visibleSketchApprovals}).
 * - Escalation (Q2) runs one conductor message again with full access. It is
 *   offered only while a guest has edited the board, on a message that ran
 *   restricted and is not running now. It never carries over.
 * - From an agent caller, every op that lets the agent act on text the
 *   conductor did not write, or with more access, needs the desktop
 *   confirmation (A1): {@link sketchBotOpNeedsConfirmation}.
 *
 * Pure. Bundled into the renderer and the CLI: no Electron or Node imports.
 */

import type { SketchActor, SketchScreenVerdict, SketchTurnPosture } from './types';

/** Where one `@bot` request stands in the bot relay. */
/** `held`: the turn answered, and the outbound screen's model pass holds the reply for "Publish anyway". */
export type SketchBotRequestStatus = 'awaiting_approval' | 'running' | 'held';

/** What the conductor can do to a request, and `list` to read them. */
export const SKETCH_BOT_REQUEST_OPS = [
	'list',
	'approve',
	'deny',
	'escalate',
	'publish',
	'discard',
] as const;
export type SketchBotRequestOp = (typeof SKETCH_BOT_REQUEST_OPS)[number];
/** Every op that changes a request. */
export type SketchBotDecisionOp = Exclude<SketchBotRequestOp, 'list'>;

export function isSketchBotRequestOp(value: unknown): value is SketchBotRequestOp {
	return typeof value === 'string' && (SKETCH_BOT_REQUEST_OPS as readonly string[]).includes(value);
}

export function isSketchBotDecisionOp(value: unknown): value is SketchBotDecisionOp {
	return isSketchBotRequestOp(value) && value !== 'list';
}

/**
 * A1: approve runs a guest's text, escalate gives a turn full access, and
 * publish posts a reply the screen held. From an agent caller each waits on
 * the conductor. Deny and discard only ever end a request, so they run.
 */
export function sketchBotOpNeedsConfirmation(op: SketchBotDecisionOp): boolean {
	return op === 'approve' || op === 'escalate' || op === 'publish';
}

/** Approval chips shown per link (or per actor without one); newer requests wait behind them. */
export const SKETCH_APPROVALS_PER_CAP = 3;

/** A request as the CLI and the window report it. */
export interface SketchBotRequestInfo {
	sketchId: string;
	replyTo: string;
	/** The server-stamped actor (A2), or the local conductor. */
	actor: SketchActor;
	text: string;
	ts: number;
	/** `ended`: a conductor message whose turn is over, listed only while it can be escalated. */
	status: SketchBotRequestStatus | 'ended';
	/** The gate's decision on a guest request; null for the conductor's own message. */
	verdict: SketchScreenVerdict | null;
	posture: SketchTurnPosture;
	/** "Run with full access" is offered for it now (Q2). */
	canEscalate: boolean;
	/** An approval waiting behind {@link SKETCH_APPROVALS_PER_CAP} older chips on the same link. */
	waiting?: true;
}

/** The chip's verdict line: "Screened: clean, Prompt Guard 2, 0.04". */
export function describeSketchVerdict(verdict: SketchScreenVerdict | null): string {
	if (!verdict) return 'Not screened: the conductor wrote it.';
	const score = typeof verdict.score === 'number' ? `, ${verdict.score.toFixed(2)}` : '';
	return `Screened: ${verdict.status}, ${verdict.sourceLabel}${score}`;
}

/** What the per-link chip limit groups by: the link, or the actor when it has none. */
export function sketchRequestCapKey(actor: SketchActor): string {
	return actor.capId ? `cap:${actor.capId}` : `actor:${actor.id}`;
}

/**
 * The approval chips to show: the oldest {@link SKETCH_APPROVALS_PER_CAP}
 * awaiting requests per link, in order. `waiting` counts the rest.
 */
export function visibleSketchApprovals<
	T extends { actor: SketchActor; status: string; ts: number },
>(
	requests: readonly T[],
	perCap: number = SKETCH_APPROVALS_PER_CAP
): { visible: T[]; waiting: T[] } {
	const awaiting = requests
		.filter((request) => request.status === 'awaiting_approval')
		.sort((a, b) => a.ts - b.ts);
	const shown = new Map<string, number>();
	const visible: T[] = [];
	const waiting: T[] = [];
	for (const request of awaiting) {
		const key = sketchRequestCapKey(request.actor);
		const count = shown.get(key) ?? 0;
		if (count < perCap) {
			shown.set(key, count + 1);
			visible.push(request);
		} else {
			waiting.push(request);
		}
	}
	return { visible, waiting };
}
