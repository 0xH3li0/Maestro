/**
 * The window half of the Sketch Book B2 policy (spec section 5): who may ask
 * the bot. Main decides (`sketch-bot-policy.ts`: availability, the trust
 * warning for an agent caller, the demotion when the screen goes); this
 * window owns the room socket, so:
 *
 * - {@link applySketchBotPolicy} sends `policy.set` for main's `botPolicy`
 *   hop, which the Share panel's toggle and `maestro-cli sketch bot-policy`
 *   both reach. A demotion carries a notice the Sketch tab shows.
 * - {@link attachSketchBotPolicySync} reports what the room says (`welcome`,
 *   `policy`) to main, which mirrors it and puts a room on `writers` back on
 *   `conductor` when B2 is no longer available (a room that came back after
 *   the screen changed while it was away).
 */

import type { ServerFrame } from '../../shared/sketch/protocol';
import type { BotPolicy } from '../../shared/sketch/types';
import { useSketchSessionStore } from '../stores/sketchSessionStore';
import { logger } from '../utils/logger';
import { getSketchRoomClient } from './sketchRoomClient';

const LOG_CTX = '[SketchBook][BotPolicy]';

/** The room client calls the sync needs. */
export interface SketchBotPolicyRoom {
	subscribe(listener: (frame: ServerFrame) => void): () => void;
}

/** The main call the sync reports to. */
export type NoteRoomBotPolicy = (sketchId: string, policy: BotPolicy) => Promise<unknown>;

const syncs = new Map<string, () => void>();

/**
 * Send `policy.set` on the sketch's live room and record it. Throws when this
 * window has no live room for the sketch. `notice` (a demotion) is shown in
 * the Sketch tab; turning `writers` on clears an old one.
 */
export function applySketchBotPolicy(sketchId: string, policy: BotPolicy, notice?: string): void {
	const client = getSketchRoomClient(sketchId);
	if (!client) {
		throw new Error('Sketch Book: this window has no room for the sketch. Open the sketch first.');
	}
	if (!client.send({ t: 'policy.set', botPolicy: policy })) {
		throw new Error('Sketch Book: the room is not connected yet. Try again once it is.');
	}
	// The server answers with `policy` to every socket; record it now so the
	// toggle does not flick back while that frame is on its way.
	useSketchSessionStore.getState().updateSketchRoom(sketchId, (room) =>
		room
			? {
					...room,
					botPolicy: policy,
					botPolicyNotice: notice ?? (policy === 'writers' ? null : room.botPolicyNotice),
				}
			: room
	);
}

/** The Sketch tab's dismiss on the demotion notice. */
export function dismissSketchBotPolicyNotice(sketchId: string): void {
	useSketchSessionStore
		.getState()
		.updateSketchRoom(sketchId, (room) => (room ? { ...room, botPolicyNotice: null } : room));
}

/** Report the room's policy to main on `welcome` and `policy`. Replaces an older sync. */
export function attachSketchBotPolicySync(
	sketchId: string,
	room: SketchBotPolicyRoom,
	note: NoteRoomBotPolicy = (id, policy) => window.maestro.sketch.noteRoomBotPolicy(id, policy)
): void {
	detachSketchBotPolicySync(sketchId);
	const unsubscribe = room.subscribe((frame) => {
		if (frame.t !== 'welcome' && frame.t !== 'policy') return;
		note(sketchId, frame.botPolicy).catch((error) => {
			logger.warn('Could not report the room bot policy', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
	syncs.set(sketchId, unsubscribe);
}

export function detachSketchBotPolicySync(sketchId: string): void {
	syncs.get(sketchId)?.();
	syncs.delete(sketchId);
}
