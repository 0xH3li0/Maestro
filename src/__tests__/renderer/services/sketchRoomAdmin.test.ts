/**
 * The window half of the Room panel (src/renderer/services/sketchRoomAdmin.ts):
 * `stats.get` and the wait for the server's `room.stats`, Kick, Unlock and
 * Unsuspend sent on the live room after the target is checked against the
 * newest stats, `unknown_ref` thrown, and main's `roomAdmin` hop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	readSketchRoomStats,
	runRemoteSketchRoomAdmin,
	runSketchRoomAction,
	type SketchRoomAdminClient,
} from '../../../renderer/services/sketchRoomAdmin';
import {
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../renderer/stores/sketchSessionStore';
import type { ClientFrame, ServerFrame } from '../../../shared/sketch/protocol';
import type { SketchRoomStats } from '../../../shared/sketch/room-stats';

const SKETCH_ID = 'sketch-1';

const stats: SketchRoomStats = {
	guestEdited: false,
	actors: [
		{
			actorId: 'guest-1',
			kind: 'guest',
			name: 'Sam',
			role: 'rw',
			online: true,
			ops: 1,
			toBot: 0,
			denyStreak: 0,
			denialsTotal: 0,
			guardrailTotal: 0,
			guardrailByReason: { injection: 0, other: 0 },
			unavailableTotal: 0,
			lockedOut: false,
			lastSeen: 1,
		},
		{
			actorId: 'owner',
			kind: 'conductor',
			name: 'Pedram',
			role: 'conductor',
			online: true,
			ops: 1,
			toBot: 0,
			denyStreak: 0,
			denialsTotal: 0,
			guardrailTotal: 0,
			guardrailByReason: { injection: 0, other: 0 },
			unavailableTotal: 0,
			lockedOut: false,
			lastSeen: 1,
		},
	],
	caps: [
		{
			capId: 'Cap000000001',
			label: 'Review',
			role: 'rw',
			expiresAt: null,
			revoked: false,
			botSuspended: true,
			guardrailTotal: 5,
			online: 1,
		},
		{
			capId: 'Cap000000002',
			label: '',
			role: 'ro',
			expiresAt: null,
			revoked: true,
			botSuspended: false,
			guardrailTotal: 0,
			online: 0,
		},
	],
	flaggedActors: [],
	screening: 'local',
	screeningSince: 1,
};

function liveRoom(overrides: Partial<SketchRoomState> = {}): SketchRoomState {
	return {
		roomId: 'r1',
		connection: 'live',
		notice: null,
		actor: null,
		role: 'conductor',
		botPolicy: 'conductor',
		botOnline: true,
		guestEdited: false,
		headSeq: 0,
		keyEpoch: 1,
		syncedSeq: 0,
		screening: { reported: 'local', server: 'local', since: 1 },
		botPolicyNotice: null,
		stats,
		...overrides,
	};
}

/**
 * A room client whose server answers `stats.get` with a fresh `room.stats`
 * (stored in the session, as the real client does) unless told otherwise.
 */
function fakeClient(
	options: { connected?: boolean; answer?: (frame: ClientFrame) => ServerFrame | null } = {}
) {
	const listeners = new Set<(frame: ServerFrame) => void>();
	const sent: ClientFrame[] = [];
	const answer =
		options.answer ??
		((frame: ClientFrame): ServerFrame | null =>
			frame.t === 'stats.get' ? { t: 'room.stats', ...stats, guestEdited: true } : null);
	const client: SketchRoomAdminClient = {
		send: vi.fn((frame: ClientFrame) => {
			if (options.connected === false) return false;
			sent.push(frame);
			const reply = answer(frame);
			if (reply) {
				queueMicrotask(() => {
					if (reply.t === 'room.stats') {
						const { t: _t, ...next } = reply;
						useSketchSessionStore
							.getState()
							.updateSketchRoom(SKETCH_ID, (room) => (room ? { ...room, stats: next } : room));
					}
					for (const listener of listeners) listener(reply);
				});
			}
			return true;
		}),
		subscribe: vi.fn((listener: (frame: ServerFrame) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
	return { client, sent, listeners };
}

beforeEach(async () => {
	vi.clearAllMocks();
	useSketchSessionStore.setState({ sessions: {} });
	vi.mocked(window.maestro.sketch.readScene).mockResolvedValue({
		type: 'excalidraw',
		version: 2,
		elements: [],
		appState: {},
		files: {},
	});
	await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
	useSketchSessionStore.getState().updateSketchRoom(SKETCH_ID, () => liveRoom());
});

describe('readSketchRoomStats', () => {
	it('answers with what the session holds when not asked to refresh', async () => {
		const { client } = fakeClient();
		await expect(readSketchRoomStats(SKETCH_ID, {}, { client: () => client })).resolves.toEqual({
			sketchId: SKETCH_ID,
			connection: 'live',
			stats,
		});
		expect(client.send).not.toHaveBeenCalled();
	});

	it("asks the server with stats.get and answers with the server's push", async () => {
		const { client, sent, listeners } = fakeClient();
		const reading = await readSketchRoomStats(
			SKETCH_ID,
			{ refresh: true },
			{ client: () => client }
		);
		expect(sent).toEqual([{ t: 'stats.get' }]);
		expect(reading.stats?.guestEdited).toBe(true);
		expect(listeners.size).toBe(0);
	});

	it('answers with the held stats when the server is slow', async () => {
		const { client, listeners } = fakeClient({ answer: () => null });
		const reading = await readSketchRoomStats(
			SKETCH_ID,
			{ refresh: true },
			{ client: () => client, waitMs: 5 }
		);
		expect(reading.stats).toBe(stats);
		expect(listeners.size).toBe(0);
	});

	it('answers at once with no room client, or a socket that is not joined', async () => {
		await expect(
			readSketchRoomStats('other', { refresh: true }, { client: () => undefined })
		).resolves.toEqual({ sketchId: 'other', connection: null, stats: null });
		const { client } = fakeClient({ connected: false });
		const reading = await readSketchRoomStats(
			SKETCH_ID,
			{ refresh: true },
			{ client: () => client, waitMs: 10_000 }
		);
		expect(reading.stats).toBe(stats);
	});
});

describe('runSketchRoomAction', () => {
	it('kicks a guest, then asks for the stats again', async () => {
		const { client, sent } = fakeClient();
		const reading = await runSketchRoomAction(
			SKETCH_ID,
			{ op: 'kick', actorId: 'guest-1', minutes: 15 },
			{ client: () => client }
		);
		expect(sent).toEqual([{ t: 'kick', actorId: 'guest-1', minutes: 15 }, { t: 'stats.get' }]);
		expect(reading.stats?.guestEdited).toBe(true);
	});

	it('sends actor.unlock and cap.unsuspend', async () => {
		const { client, sent } = fakeClient();
		await runSketchRoomAction(
			SKETCH_ID,
			{ op: 'unlock', actorId: 'guest-1' },
			{ client: () => client }
		);
		await runSketchRoomAction(
			SKETCH_ID,
			{ op: 'unsuspend', capId: 'Cap000000001' },
			{ client: () => client }
		);
		expect(sent.filter((frame) => frame.t !== 'stats.get')).toEqual([
			{ t: 'actor.unlock', actorId: 'guest-1' },
			{ t: 'cap.unsuspend', capId: 'Cap000000001' },
		]);
	});

	it('refuses a target the newest stats do not hold, before anything is sent', async () => {
		const { client } = fakeClient();
		const deps = { client: () => client };
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'kick', actorId: 'ghost' }, deps)
		).rejects.toThrow('no one in the room has the id "ghost"');
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'kick', actorId: 'owner' }, deps)
		).rejects.toThrow('only a guest can be kicked');
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'unsuspend', capId: 'CapNope00000' }, deps)
		).rejects.toThrow('no link "CapNope00000"');
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'unsuspend', capId: 'Cap000000002' }, deps)
		).rejects.toThrow('revoked');
		expect(client.send).not.toHaveBeenCalled();
	});

	it('leaves the check to the server before any stats arrived', async () => {
		useSketchSessionStore
			.getState()
			.updateSketchRoom(SKETCH_ID, (room) => (room ? { ...room, stats: null } : room));
		const { client, sent } = fakeClient();
		await runSketchRoomAction(
			SKETCH_ID,
			{ op: 'kick', actorId: 'anyone' },
			{ client: () => client }
		);
		expect(sent[0]).toEqual({ t: 'kick', actorId: 'anyone' });
	});

	it("throws the server's unknown_ref for the target", async () => {
		const { client } = fakeClient({
			answer: (frame) =>
				frame.t === 'kick' ? { t: 'error', code: 'unknown_ref', ref: 'guest-1' } : null,
		});
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'kick', actorId: 'guest-1' }, { client: () => client })
		).rejects.toThrow('the room does not know "guest-1"');
	});

	it('refuses with no room client, and with a socket that is not joined', async () => {
		await expect(
			runSketchRoomAction(
				SKETCH_ID,
				{ op: 'kick', actorId: 'guest-1' },
				{ client: () => undefined }
			)
		).rejects.toThrow('no room for the sketch');
		const { client } = fakeClient({ connected: false });
		await expect(
			runSketchRoomAction(SKETCH_ID, { op: 'kick', actorId: 'guest-1' }, { client: () => client })
		).rejects.toThrow('not connected');
	});
});

describe('runRemoteSketchRoomAdmin', () => {
	it('routes each op of main hop', async () => {
		const { client, sent } = fakeClient();
		const deps = { client: () => client };
		await runRemoteSketchRoomAdmin({ action: 'roomAdmin', sketchId: SKETCH_ID, op: 'stats' }, deps);
		await runRemoteSketchRoomAdmin(
			{ action: 'roomAdmin', sketchId: SKETCH_ID, op: 'kick', actorId: 'guest-1' },
			deps
		);
		await runRemoteSketchRoomAdmin(
			{ action: 'roomAdmin', sketchId: SKETCH_ID, op: 'unsuspend', capId: 'Cap000000001' },
			deps
		);
		expect(sent.filter((frame) => frame.t !== 'stats.get')).toEqual([
			{ t: 'kick', actorId: 'guest-1' },
			{ t: 'cap.unsuspend', capId: 'Cap000000001' },
		]);
	});

	it('refuses an op without its id', async () => {
		await expect(
			runRemoteSketchRoomAdmin({ action: 'roomAdmin', sketchId: SKETCH_ID, op: 'unlock' })
		).rejects.toThrow('an actor id is required');
		await expect(
			runRemoteSketchRoomAdmin({ action: 'roomAdmin', sketchId: SKETCH_ID, op: 'unsuspend' })
		).rejects.toThrow('a link id is required');
	});
});
