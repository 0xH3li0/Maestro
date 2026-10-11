/**
 * Chat steering, renderer side: hand a queued message to the Claude turn already
 * running on its tab, and keep that message safe until the transcript says what
 * claude did with it.
 *
 * A steer is answered TWICE, on different clocks (see SteeringVerdict in
 * src/shared/chatSteering.ts). The socket reply says whether the text was typed
 * (`delivered` / `refused`); the transcript-observed outcome (`absorbed` /
 * `queued` / `dropped`) arrives later on maestro-p's stdout, forwarded as
 * `process:steering-verdict`. The card has to leave the queue on `delivered`, or
 * the same message sends again when the turn ends - so the item is parked in
 * `pendingSteers` until the second answer lands, and put back if claude never
 * took it.
 *
 * Module functions rather than hook members: the stdout listener and the exit
 * listener both run outside the click that started the steer. The registry is
 * per client - only the client that clicked holds the item, which is also the
 * only one that removed it.
 */

import type { QueuedItem } from '../types';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { resolveQueuedItemTarget } from '../utils/tabHelpers';
import { getSteerEligibility } from '../utils/executionQueue';

interface PendingSteer {
	processKey: string;
	sessionId: string;
	tabId: string;
	item: QueuedItem;
}

/** Delivered steers still waiting for their transcript verdict, keyed by steer id. */
const pendingSteers = new Map<string, PendingSteer>();

/** Test seam: the registry is module state. */
export function resetPendingSteersForTests(): void {
	pendingSteers.clear();
}

/** Test seam: how many delivered steers are still unsettled. */
export function pendingSteerCount(): number {
	return pendingSteers.size;
}

function removeFromQueue(sessionId: string, itemId: string): void {
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: s.executionQueue.filter((i) => i.id !== itemId),
	}));
}

/**
 * Put a steered message back at the HEAD of the queue. The head because the user
 * asked for it sooner than anything behind it, and a steer that was never taken
 * should not lose its place to messages queued after it.
 */
function restoreToQueue(sessionId: string, item: QueuedItem, paused: boolean): void {
	updateSessionWith(sessionId, (s) => {
		if (s.executionQueue.some((i) => i.id === item.id)) return s;
		const restored: QueuedItem = { ...item, paused: paused || undefined };
		return { ...s, executionQueue: [restored, ...s.executionQueue] };
	});
}

function notifyUnconfirmed(sessionId: string, tabId: string): void {
	notifyToast({
		color: 'orange',
		title: 'Steering result unconfirmed',
		message:
			'Claude may or may not have received the message, so it has been paused rather than sent twice. Resume it if the agent never answered it.',
		dismissible: true,
		sessionId,
		tabId,
	});
}

/**
 * Steer one queued message into the turn running on its tab. Never loses the
 * message: it leaves the queue only once claude has it, and comes back if the
 * transcript later shows claude never took it.
 */
export async function steerQueuedItem(sessionId: string, itemId: string): Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const item = session?.executionQueue?.find((i) => i.id === itemId);
	if (!session || !item) return;

	const target = resolveQueuedItemTarget(session, item);
	if (!target) return;
	const processKey = `${sessionId}-ai-${target.tabId}`;

	const steer = window.maestro?.process?.steer;
	if (!steer) {
		// Web renderer, or a build without the bridge. Say so rather than leaving
		// the click silent.
		notifyToast({
			color: 'yellow',
			title: 'Steering unavailable',
			message: 'This client cannot steer a running turn.',
		});
		return;
	}

	// Guarded by getSteerEligibility before the button renders; re-checked against
	// the LIVE item because the card can be stale by the click (a consult hold
	// landed, the turn ended), and this is reachable from surfaces that never
	// asked. Re-checking with the same predicate keeps the two from disagreeing.
	if (!getSteerEligibility(session, item).canSteer) return;
	const text = item.text?.trim();
	if (!text) return;

	const result = await steer(processKey, text);

	if (result.verdict === 'delivered') {
		// Claude has the text, so the queue lets go of it; the item is parked here
		// until the transcript says what claude did with it.
		pendingSteers.set(result.id, { processKey, sessionId, tabId: target.tabId, item });
		removeFromQueue(sessionId, itemId);
		notifyToast({
			color: 'green',
			title: 'Sent to the running turn',
			message: 'Claude has your message. If it never takes it, it goes back in the queue.',
			sessionId,
			tabId: target.tabId,
		});
		return;
	}

	if (result.verdict === 'absorbed' || result.verdict === 'queued') {
		// Already settled; nothing left to wait for.
		removeFromQueue(sessionId, itemId);
		return;
	}

	// Refused: nothing was typed, so the message is still ours and stays queued
	// exactly where it was. It will send normally when the turn ends.
	if (result.verdict === 'refused') {
		notifyToast({
			color: 'yellow',
			title: 'Could not steer this turn',
			message: `${result.detail ?? 'Claude could not take the message right now.'} It stays queued.`,
			sessionId,
			tabId: target.tabId,
		});
		return;
	}

	// Unknown (or a `dropped` on the socket, which cannot happen today): the text
	// MAY have been typed and we never got confirmation. Dropping the item can lose
	// a message the user wrote, and leaving it queued sends it a second time
	// without asking. So PAUSE it: kept, nothing sends behind the user's back, and
	// the card's own play button is the one-click resolution.
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: s.executionQueue.map((i) => (i.id === itemId ? { ...i, paused: true } : i)),
	}));
	notifyUnconfirmed(sessionId, target.tabId);
}

/**
 * Settle a delivered steer from its transcript verdict. A verdict for a steer
 * this client did not send (another window, a refusal it already handled) is
 * ignored: only the registry entry proves the item left THIS client's queue.
 */
export function applySteeringVerdict(processKey: string, verdict: SteeringResultFrame): void {
	const pending = pendingSteers.get(verdict.id);
	if (!pending || pending.processKey !== processKey) return;

	switch (verdict.verdict) {
		case 'absorbed':
			// The running turn changed course. The success toast already went out.
			pendingSteers.delete(verdict.id);
			return;
		case 'queued':
			pendingSteers.delete(verdict.id);
			notifyToast({
				color: 'theme',
				title: 'Steer runs after this turn',
				message: 'Claude could not fold it into the running turn, so it answers it as a follow-up.',
				sessionId: pending.sessionId,
				tabId: pending.tabId,
			});
			return;
		case 'dropped':
			// Claude never took it and the run is over. Put it back, live: the turn
			// has ended, so the queue sends it normally - which is the re-send the
			// verdict asks the caller for.
			pendingSteers.delete(verdict.id);
			restoreToQueue(pending.sessionId, pending.item, false);
			notifyToast({
				color: 'yellow',
				title: 'Steer returned to the queue',
				message: 'The turn ended before Claude took your message, so it will send next.',
				sessionId: pending.sessionId,
				tabId: pending.tabId,
			});
			return;
		default:
			// `delivered` repeated on stdout carries no new information; `refused` /
			// `unknown` never follow a delivery.
			return;
	}
}

/**
 * The process behind `processKey` exited. maestro-p reports every unsettled steer
 * as `dropped` before it exits, so anything still here means that report never
 * arrived (a crash, a kill). Nobody knows whether claude answered it, so it comes
 * back PAUSED - kept, never sent twice without asking.
 */
export function settlePendingSteersOnExit(processKey: string): void {
	for (const [id, pending] of pendingSteers) {
		if (pending.processKey !== processKey) continue;
		pendingSteers.delete(id);
		restoreToQueue(pending.sessionId, pending.item, true);
		notifyUnconfirmed(pending.sessionId, pending.tabId);
	}
}
