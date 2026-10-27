/**
 * The window half of `maestro-cli sketch requests|approve|deny|escalate|
 * publish|discard`: `list` reports the bot relay's open requests (with the
 * per-link waiting flag) and the conductor messages offered "Run with full
 * access", and each op presses the same function the Sketch tab's button
 * does, refusing a request it does not apply to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
	const decision = () => vi.fn((_sketchId: string, _replyTo: string): boolean => true);
	return {
		approve: decision(),
		deny: decision(),
		escalate: decision(),
		publish: decision(),
		discard: decision(),
	};
});

vi.mock('../../../renderer/services/sketchBotRelay', () => ({
	approveSketchBotRequest: h.approve,
	denySketchBotRequest: h.deny,
	escalateSketchBotRequest: h.escalate,
}));
vi.mock('../../../renderer/services/sketchBotTurns', () => ({
	publishHeldSketchReply: h.publish,
	discardHeldSketchReply: h.discard,
}));

import {
	listSketchBotRequests,
	runSketchBotRequestOp,
} from '../../../renderer/services/sketchBotRequestCommands';
import {
	useSketchSessionStore,
	type SketchBotRequest,
	type SketchSession,
} from '../../../renderer/stores/sketchSessionStore';
import type { SketchActor } from '../../../shared/sketch/types';

const SKETCH_ID = 'sketch-1';
const guest: SketchActor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw', capId: 'cap-3' };
const conductor: SketchActor = { id: 'c1', kind: 'conductor', name: 'Pedram', role: 'conductor' };

function awaiting(replyTo: string, ts: number): SketchBotRequest {
	return {
		replyTo,
		actor: guest,
		text: `request ${replyTo}`,
		ts,
		status: 'awaiting_approval',
		verdict: { status: 'clean', score: 0.01, sourceLabel: 'Prompt Guard 2', locality: 'local' },
		posture: 'restricted',
	};
}

function seed(overrides: Partial<SketchSession> = {}): void {
	const session: SketchSession = {
		sketchId: SKETCH_ID,
		status: 'ready',
		loadError: null,
		scene: null,
		authors: { el1: { version: 1, actor: guest, textHash: 'h', guestTouched: true } },
		dirty: false,
		revision: 0,
		saveError: null,
		externalRevision: 0,
		focusRequest: null,
		chat: [],
		botRequests: [],
		approvedImages: {},
		room: null,
		...overrides,
	};
	useSketchSessionStore.setState({ sessions: { [SKETCH_ID]: session } });
}

beforeEach(() => {
	vi.clearAllMocks();
	seed();
});

describe('listSketchBotRequests', () => {
	it('lists open requests oldest first, with the ones waiting behind the limit flagged', () => {
		seed({
			botRequests: [awaiting('m4', 4), awaiting('m1', 1), awaiting('m2', 2), awaiting('m3', 3)],
		});
		const listed = listSketchBotRequests();
		expect(listed.map((request) => request.replyTo)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(listed.map((request) => request.waiting ?? false)).toEqual([false, false, false, true]);
		expect(listed[0]).toMatchObject({
			sketchId: SKETCH_ID,
			status: 'awaiting_approval',
			canEscalate: false,
		});
	});

	it('lists a conductor message offered "Run with full access" as ended', () => {
		seed({
			chat: [
				{
					id: 'chat-1',
					actor: conductor,
					text: 'tidy',
					ts: 9,
					request: { replyTo: 'local-1', posture: 'restricted', shared: false },
				},
				{
					id: 'chat-2',
					actor: conductor,
					text: 'again',
					ts: 10,
					request: { replyTo: 'local-2', posture: 'restricted', shared: false, escalated: true },
				},
			],
		});
		expect(listSketchBotRequests()).toEqual([
			{
				sketchId: SKETCH_ID,
				replyTo: 'local-1',
				actor: conductor,
				text: 'tidy',
				ts: 9,
				status: 'ended',
				verdict: null,
				posture: 'restricted',
				canEscalate: true,
			},
		]);
	});

	it('lists only the sketches named', () => {
		seed({ botRequests: [awaiting('m1', 1)] });
		expect(listSketchBotRequests(['other'])).toEqual([]);
		expect(listSketchBotRequests([SKETCH_ID])).toHaveLength(1);
	});
});

describe('runSketchBotRequestOp', () => {
	it.each([
		['approve', h.approve],
		['deny', h.deny],
		['escalate', h.escalate],
		['publish', h.publish],
		['discard', h.discard],
	] as const)('%s presses the button the Sketch tab shows', (op, fn) => {
		seed({ botRequests: [awaiting('m1', 1)] });
		const after = runSketchBotRequestOp(op, SKETCH_ID, 'm1');
		expect(fn).toHaveBeenCalledWith(SKETCH_ID, 'm1');
		// The mocked relay changed nothing, so the request is still listed.
		expect(after).toMatchObject({ replyTo: 'm1', status: 'awaiting_approval' });
	});

	it('reports a request that is gone after the op as ended', () => {
		seed({ botRequests: [awaiting('m1', 1)] });
		h.deny.mockImplementationOnce(() => {
			useSketchSessionStore.getState().removeSketchBotRequest(SKETCH_ID, 'm1');
			return true;
		});
		expect(runSketchBotRequestOp('deny', SKETCH_ID, 'm1')).toMatchObject({
			replyTo: 'm1',
			status: 'ended',
			canEscalate: false,
		});
	});

	it('refuses a request that is not open here', () => {
		expect(() => runSketchBotRequestOp('approve', SKETCH_ID, 'nope')).toThrow(
			'no open @bot request nope'
		);
		expect(h.approve).not.toHaveBeenCalled();
	});

	it('says why when the op does not apply', () => {
		seed({ botRequests: [{ ...awaiting('m1', 1), status: 'running' }] });
		h.approve.mockReturnValueOnce(false);
		expect(() => runSketchBotRequestOp('approve', SKETCH_ID, 'm1')).toThrow(
			'request m1 is running, not waiting on approval'
		);
		h.publish.mockReturnValueOnce(false);
		expect(() => runSketchBotRequestOp('publish', SKETCH_ID, 'm1')).toThrow('has no held reply');
	});
});
