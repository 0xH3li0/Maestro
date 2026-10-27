/**
 * The window half of the B2 policy (src/renderer/services/sketchBotPolicy.ts):
 * `policy.set` goes out on the live room and is recorded with any demotion
 * notice, a room that is not there or not joined is refused, and the room's
 * own `welcome` and `policy` frames are reported to main.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const roomClient = vi.hoisted(() => ({ getSketchRoomClient: vi.fn() }));
vi.mock('../../../renderer/services/sketchRoomClient', () => roomClient);

import {
	applySketchBotPolicy,
	attachSketchBotPolicySync,
	detachSketchBotPolicySync,
	dismissSketchBotPolicyNotice,
} from '../../../renderer/services/sketchBotPolicy';
import {
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../renderer/stores/sketchSessionStore';
import type { ServerFrame } from '../../../shared/sketch/protocol';

const SKETCH_ID = 'sketch-1';

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
		...overrides,
	};
}

function room(): SketchRoomState | null | undefined {
	return useSketchSessionStore.getState().sessions[SKETCH_ID]?.room;
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

describe('applySketchBotPolicy', () => {
	it('sends policy.set on the room and records the policy', () => {
		const send = vi.fn(() => true);
		roomClient.getSketchRoomClient.mockReturnValue({ send });
		applySketchBotPolicy(SKETCH_ID, 'writers');
		expect(send).toHaveBeenCalledWith({ t: 'policy.set', botPolicy: 'writers' });
		expect(room()?.botPolicy).toBe('writers');
	});

	it('records the demotion notice, and turning writers on clears it', () => {
		roomClient.getSketchRoomClient.mockReturnValue({ send: vi.fn(() => true) });
		applySketchBotPolicy(SKETCH_ID, 'conductor', 'Collaborators can no longer ask the agent: off.');
		expect(room()).toMatchObject({
			botPolicy: 'conductor',
			botPolicyNotice: 'Collaborators can no longer ask the agent: off.',
		});
		applySketchBotPolicy(SKETCH_ID, 'writers');
		expect(room()?.botPolicyNotice).toBeNull();
	});

	it('refuses without a room client, or while the room is not joined', () => {
		roomClient.getSketchRoomClient.mockReturnValue(undefined);
		expect(() => applySketchBotPolicy(SKETCH_ID, 'writers')).toThrow(/no room for the sketch/);
		roomClient.getSketchRoomClient.mockReturnValue({ send: vi.fn(() => false) });
		expect(() => applySketchBotPolicy(SKETCH_ID, 'writers')).toThrow(/not connected yet/);
		expect(room()?.botPolicy).toBe('conductor');
	});

	it('dismisses the notice', () => {
		useSketchSessionStore
			.getState()
			.updateSketchRoom(SKETCH_ID, () => liveRoom({ botPolicyNotice: 'Why.' }));
		dismissSketchBotPolicyNotice(SKETCH_ID);
		expect(room()?.botPolicyNotice).toBeNull();
	});
});

describe('attachSketchBotPolicySync', () => {
	function fakeRoom() {
		let listener: ((frame: ServerFrame) => void) | null = null;
		const unsubscribe = vi.fn();
		return {
			unsubscribe,
			subscribe: vi.fn((next: (frame: ServerFrame) => void) => {
				listener = next;
				return unsubscribe;
			}),
			emit: (frame: unknown) => listener?.(frame as ServerFrame),
		};
	}

	it("reports the room's policy on welcome and policy frames only", () => {
		const fake = fakeRoom();
		const note = vi.fn(async () => undefined);
		attachSketchBotPolicySync(SKETCH_ID, fake, note);
		fake.emit({ t: 'welcome', botPolicy: 'writers' });
		fake.emit({ t: 'policy', botPolicy: 'conductor' });
		fake.emit({ t: 'presence.bot', online: true });
		expect(note.mock.calls).toEqual([
			[SKETCH_ID, 'writers'],
			[SKETCH_ID, 'conductor'],
		]);
	});

	it('replaces an older sync and stops on detach', () => {
		const first = fakeRoom();
		const second = fakeRoom();
		attachSketchBotPolicySync(
			SKETCH_ID,
			first,
			vi.fn(async () => undefined)
		);
		attachSketchBotPolicySync(
			SKETCH_ID,
			second,
			vi.fn(async () => undefined)
		);
		expect(first.unsubscribe).toHaveBeenCalled();
		detachSketchBotPolicySync(SKETCH_ID);
		expect(second.unsubscribe).toHaveBeenCalled();
	});

	it('logs a failed report instead of throwing', async () => {
		const fake = fakeRoom();
		const note = vi.fn(async () => {
			throw new Error('Sketch Book is off.');
		});
		attachSketchBotPolicySync(SKETCH_ID, fake, note);
		expect(() => fake.emit({ t: 'policy', botPolicy: 'writers' })).not.toThrow();
		await Promise.resolve();
		expect(note).toHaveBeenCalled();
	});
});
