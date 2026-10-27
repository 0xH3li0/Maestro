/**
 * The window half of the Collaborate panel (spec section 6, hosted spec §8): the
 * room socket lives in this window, so main asks it (`roomAdmin`) to read
 * `room.stats` and to send the conductor frames Kick, Unlock and Unsuspend.
 * The Collaborate panel's buttons and `maestro-cli sketch stats|kick|unlock|
 * unsuspend` both reach these functions through main's
 * `sketch-room-admin.ts`, so the two cannot drift. Main has already raised
 * the desktop confirmation an agent caller needs (A1).
 *
 * - {@link readSketchRoomStats} answers with the newest `room.stats` the
 *   session holds. With `refresh`, it asks the server (`stats.get`) and waits
 *   a moment for the answer first; a slow or closed socket answers with what
 *   the session already holds.
 * - {@link runSketchRoomAction} checks the target against the newest stats,
 *   sends the frame, and answers with the room as it stands after. The server
 *   names an id it does not know with `error {unknown_ref}`, which is thrown.
 */

import type { ClientFrame, ServerFrame } from '../../shared/sketch/protocol';
import {
	canKickRoomActor,
	sketchRoomActionTarget,
	sketchRoomAdminFrame,
	type SketchRoomAction,
	type SketchRoomStatsReading,
} from '../../shared/sketch/room-admin';
import type { SketchRendererRequest } from '../../shared/sketch/commands';
import { useSketchSessionStore } from '../stores/sketchSessionStore';
import { getSketchRoomClient } from './sketchRoomClient';

/** How long a read waits for the server's `room.stats` before it answers with the held one. */
export const SKETCH_ROOM_STATS_WAIT_MS = 3_000;

/** The room client calls the Collaborate panel needs. */
export interface SketchRoomAdminClient {
	send(frame: ClientFrame): boolean;
	subscribe(listener: (frame: ServerFrame) => void): () => void;
}

export interface SketchRoomAdminDeps {
	client?: (sketchId: string) => SketchRoomAdminClient | undefined;
	waitMs?: number;
}

/** The room as the session holds it now. */
function heldReading(sketchId: string): SketchRoomStatsReading {
	const room = useSketchSessionStore.getState().sessions[sketchId]?.room ?? null;
	return { sketchId, connection: room?.connection ?? null, stats: room?.stats ?? null };
}

/**
 * Wait for the first frame `match` accepts, at most `waitMs`. Resolves null on
 * the timeout. The listener is added before `send` runs, so a fast answer is
 * not missed.
 */
function awaitFrame(
	client: SketchRoomAdminClient,
	match: (frame: ServerFrame) => boolean,
	waitMs: number,
	send: () => boolean
): Promise<ServerFrame | null> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (frame: ServerFrame | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(frame);
		};
		const unsubscribe = client.subscribe((frame) => {
			if (match(frame)) finish(frame);
		});
		const timer = setTimeout(() => finish(null), waitMs);
		if (!send()) finish(null);
	});
}

/** The newest `room.stats` of a sketch's room; with `refresh`, asked of the server first. */
export async function readSketchRoomStats(
	sketchId: string,
	options: { refresh?: boolean } = {},
	deps: SketchRoomAdminDeps = {}
): Promise<SketchRoomStatsReading> {
	const client = (deps.client ?? getSketchRoomClient)(sketchId);
	if (options.refresh && client) {
		await awaitFrame(
			client,
			(frame) => frame.t === 'room.stats',
			deps.waitMs ?? SKETCH_ROOM_STATS_WAIT_MS,
			() => client.send({ t: 'stats.get' })
		);
	}
	return heldReading(sketchId);
}

/** Why the newest stats refuse this action, or null (also when no stats arrived yet: the server decides). */
function targetProblem(sketchId: string, action: SketchRoomAction): string | null {
	const stats = heldReading(sketchId).stats;
	if (!stats) return null;
	if (action.op === 'unsuspend') {
		const cap = stats.caps.find((candidate) => candidate.capId === action.capId);
		if (!cap) return `Sketch Book: the room has no link "${action.capId}".`;
		if (cap.revoked) return 'Sketch Book: that link is revoked, so it has nothing to unsuspend.';
		return null;
	}
	const actor = stats.actors.find((candidate) => candidate.actorId === action.actorId);
	if (!actor) return `Sketch Book: no one in the room has the id "${action.actorId}".`;
	if (!canKickRoomActor(actor)) {
		return `Sketch Book: only a guest can be ${action.op === 'kick' ? 'kicked' : 'unlocked'}.`;
	}
	return null;
}

/**
 * Kick, Unlock or Unsuspend on the sketch's live room, then the room as it
 * stands after. Throws when this window has no live room for the sketch, when
 * the newest stats name no such member or link, or when the server answers
 * `unknown_ref` for it.
 */
export async function runSketchRoomAction(
	sketchId: string,
	action: SketchRoomAction,
	deps: SketchRoomAdminDeps = {}
): Promise<SketchRoomStatsReading> {
	const client = (deps.client ?? getSketchRoomClient)(sketchId);
	if (!client) {
		throw new Error('Sketch Book: this window has no room for the sketch. Open the sketch first.');
	}
	const problem = targetProblem(sketchId, action);
	if (problem) throw new Error(problem);
	const frame = sketchRoomAdminFrame(action);
	const target = sketchRoomActionTarget(action);
	let sent = false;
	const answer = await awaitFrame(
		client,
		(incoming) =>
			incoming.t === 'room.stats' ||
			(incoming.t === 'error' && incoming.code === 'unknown_ref' && incoming.ref === target),
		deps.waitMs ?? SKETCH_ROOM_STATS_WAIT_MS,
		() => {
			sent = client.send(frame);
			// The server marks `room.stats` dirty on a change; ask now so the answer is fresh.
			return sent && client.send({ t: 'stats.get' });
		}
	);
	if (!sent) {
		throw new Error('Sketch Book: the room is not connected yet. Try again once it is.');
	}
	if (answer?.t === 'error') {
		throw new Error(`Sketch Book: the room does not know "${target}". It may have left already.`);
	}
	return heldReading(sketchId);
}

/** Main's `roomAdmin` hop. */
export async function runRemoteSketchRoomAdmin(
	request: Extract<SketchRendererRequest, { action: 'roomAdmin' }>,
	deps: SketchRoomAdminDeps = {}
): Promise<SketchRoomStatsReading> {
	switch (request.op) {
		case 'stats':
			return readSketchRoomStats(request.sketchId, { refresh: true }, deps);
		case 'kick':
		case 'unlock':
			if (!request.actorId) throw new Error('Sketch Book: an actor id is required.');
			return runSketchRoomAction(
				request.sketchId,
				request.op === 'kick'
					? {
							op: 'kick',
							actorId: request.actorId,
							...(request.minutes !== undefined ? { minutes: request.minutes } : {}),
						}
					: { op: 'unlock', actorId: request.actorId },
				deps
			);
		case 'unsuspend':
			if (!request.capId) throw new Error('Sketch Book: a link id is required.');
			return runSketchRoomAction(request.sketchId, { op: 'unsuspend', capId: request.capId }, deps);
	}
}
