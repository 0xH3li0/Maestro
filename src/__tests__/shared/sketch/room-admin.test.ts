/**
 * The Room panel's rules (src/shared/sketch/room-admin.ts): the conductor
 * frames, which ops wait on the conductor for an agent caller (A1), the
 * member and link words, and the audit log reader (spec section 8.8).
 */

import { describe, expect, it } from 'vitest';
import {
	canKickRoomActor,
	canUnlockRoomActor,
	describeRoomStatsActor,
	describeRoomStatsCap,
	describeSketchAuditDecision,
	flaggedSketchElements,
	isSketchRoomActionOp,
	isSketchRoomAdminOp,
	parseSketchAuditLine,
	parseSketchAuditLog,
	sketchKickMinutesProblem,
	sketchRoomActionTarget,
	sketchRoomAdminFrame,
	sketchRoomAdminNeedsConfirmation,
	SKETCH_KICK_MAX_MINUTES,
	SKETCH_KICK_NOTE,
	type SketchAuditEntry,
} from '../../../shared/sketch/room-admin';
import type { RoomStatsActor } from '../../../shared/sketch/protocol';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';

function actor(fields: Partial<RoomStatsActor> = {}): RoomStatsActor {
	return {
		actorId: 'guest-1',
		kind: 'guest',
		name: 'Sam',
		capId: 'Cap000000001',
		capLabel: '#3',
		role: 'rw',
		online: true,
		ops: 0,
		toBot: 0,
		denyStreak: 0,
		denialsTotal: 0,
		guardrailTotal: 0,
		guardrailByReason: { injection: 0, other: 0 },
		unavailableTotal: 0,
		lockedOut: false,
		lastSeen: 1,
		...fields,
	};
}

function entry(fields: Partial<SketchAuditEntry> = {}): SketchAuditEntry {
	return {
		ts: 10,
		sketchId: SKETCH_ID,
		subject: { elementId: 'el-1', version: 1 },
		actor: { id: 'guest-1', kind: 'guest' },
		status: 'flagged',
		score: 0.97,
		source: 'Prompt Guard 2 22M',
		locality: 'local',
		reported: false,
		...fields,
	};
}

describe('room admin ops', () => {
	it('knows its ops', () => {
		expect(isSketchRoomAdminOp('stats')).toBe(true);
		expect(isSketchRoomActionOp('stats')).toBe(false);
		expect(isSketchRoomActionOp('kick')).toBe(true);
		expect(isSketchRoomActionOp('revoke')).toBe(false);
	});

	it('asks the conductor for unlock and unsuspend from an agent, never for kick', () => {
		expect(sketchRoomAdminNeedsConfirmation('unlock')).toBe(true);
		expect(sketchRoomAdminNeedsConfirmation('unsuspend')).toBe(true);
		expect(sketchRoomAdminNeedsConfirmation('kick')).toBe(false);
	});

	it('builds the contract frames', () => {
		expect(sketchRoomAdminFrame({ op: 'kick', actorId: 'a1' })).toEqual({
			t: 'kick',
			actorId: 'a1',
		});
		expect(sketchRoomAdminFrame({ op: 'kick', actorId: 'a1', minutes: 30 })).toEqual({
			t: 'kick',
			actorId: 'a1',
			minutes: 30,
		});
		expect(sketchRoomAdminFrame({ op: 'unlock', actorId: 'a1' })).toEqual({
			t: 'actor.unlock',
			actorId: 'a1',
		});
		expect(sketchRoomAdminFrame({ op: 'unsuspend', capId: 'c1' })).toEqual({
			t: 'cap.unsuspend',
			capId: 'c1',
		});
		expect(sketchRoomActionTarget({ op: 'unsuspend', capId: 'c1' })).toBe('c1');
		expect(sketchRoomActionTarget({ op: 'unlock', actorId: 'a1' })).toBe('a1');
	});

	it('refuses a kick length that is not a whole number of minutes in range', () => {
		expect(sketchKickMinutesProblem(undefined)).toBeNull();
		expect(sketchKickMinutesProblem(1)).toBeNull();
		expect(sketchKickMinutesProblem(SKETCH_KICK_MAX_MINUTES)).toBeNull();
		for (const bad of [0, -5, 1.5, SKETCH_KICK_MAX_MINUTES + 1, '30']) {
			expect(sketchKickMinutesProblem(bad)).toMatch(/whole number of minutes/);
		}
		expect(() => sketchRoomAdminFrame({ op: 'kick', actorId: 'a1', minutes: 0 })).toThrow();
	});

	it('says that kick is temporary and revoke is the real fix', () => {
		expect(SKETCH_KICK_NOTE).toMatch(/temporary/);
		expect(SKETCH_KICK_NOTE).toMatch(/Revoke the link/);
	});
});

describe('members and links', () => {
	it('names a member with the server-stamped actor line', () => {
		expect(describeRoomStatsActor(actor())).toBe('"Sam" · guest, read-write link #3, not verified');
		expect(describeRoomStatsActor(actor({ kind: 'conductor', role: 'conductor' }))).toBe(
			'"Sam" · conductor'
		);
	});

	it('offers kick for guests only, and unlock only while a guest is locked or on a streak', () => {
		expect(canKickRoomActor(actor())).toBe(true);
		expect(canKickRoomActor(actor({ kind: 'bot' }))).toBe(false);
		expect(canUnlockRoomActor(actor())).toBe(false);
		expect(canUnlockRoomActor(actor({ lockedOut: true }))).toBe(true);
		expect(canUnlockRoomActor(actor({ denyStreak: 2 }))).toBe(true);
		expect(canUnlockRoomActor(actor({ kind: 'conductor', lockedOut: true }))).toBe(false);
	});

	it('describes a link by revocation, expiry and suspension', () => {
		const base = { revoked: false, expiresAt: 2_000, botSuspended: false };
		expect(describeRoomStatsCap({ ...base, revoked: true }, 1_000)).toBe('revoked');
		expect(describeRoomStatsCap(base, 3_000)).toBe('expired');
		expect(describeRoomStatsCap(base, 1_000)).toBe('@bot allowed');
		expect(describeRoomStatsCap({ ...base, botSuspended: true }, 1_000)).toBe('@bot suspended');
		expect(describeRoomStatsCap({ ...base, expiresAt: null }, 1_000)).toBe(
			'never expires, @bot allowed'
		);
	});
});

describe('audit log', () => {
	it('parses a line and copies only the known fields', () => {
		const line = JSON.stringify({ ...entry({ reported: true }), text: 'secret', excerpt: 'x' });
		const parsed = parseSketchAuditLine(line);
		expect(parsed).toEqual(entry({ reported: true }));
		expect(parsed).not.toHaveProperty('text');
		expect(parsed).not.toHaveProperty('excerpt');
	});

	it('refuses lines that are not an audit entry', () => {
		expect(parseSketchAuditLine('nope')).toBeNull();
		expect(parseSketchAuditLine('[]')).toBeNull();
		expect(parseSketchAuditLine(JSON.stringify({ ...entry(), status: 'maybe' }))).toBeNull();
		expect(parseSketchAuditLine(JSON.stringify({ ...entry(), subject: {} }))).toBeNull();
		expect(
			parseSketchAuditLine(JSON.stringify({ ...entry(), actor: { id: 'x', kind: 'alien' } }))
		).toBeNull();
		expect(parseSketchAuditLine(JSON.stringify({ ...entry(), locality: 'moon' }))).toBeNull();
	});

	it('keeps a null actor (a snapshot delivered the element) and a chat subject', () => {
		const parsed = parseSketchAuditLine(
			JSON.stringify(entry({ actor: null, subject: { replyTo: 'r1' } }))
		);
		expect(parsed?.actor).toBeNull();
		expect(parsed?.subject).toEqual({ replyTo: 'r1' });
	});

	it('reads a whole log, skipping blank and broken lines', () => {
		const text = [JSON.stringify(entry()), '', '{', JSON.stringify(entry({ ts: 11 }))].join('\n');
		expect(parseSketchAuditLog(text).map((e) => e.ts)).toEqual([10, 11]);
	});

	it("lists an element only while its newest version's decision is flagged", () => {
		const flagged = flaggedSketchElements([
			entry({ subject: { elementId: 'a', version: 1 }, ts: 1 }),
			entry({ subject: { elementId: 'a', version: 2 }, status: 'clean', ts: 2 }),
			entry({ subject: { elementId: 'b', version: 3 }, status: 'clean', ts: 3 }),
			entry({ subject: { elementId: 'b', version: 3 }, status: 'flagged', ts: 4 }),
			entry({ subject: { elementId: 'c', version: 1 }, ts: 5 }),
			entry({ subject: { replyTo: 'r1' }, ts: 6 }),
		]);
		expect(flagged.map((element) => element.elementId)).toEqual(['c', 'b']);
		expect(flagged[1]).toEqual(
			expect.objectContaining({ version: 3, score: 0.97, source: 'Prompt Guard 2 22M' })
		);
	});

	it('words a decision with its source, score and locality', () => {
		expect(describeSketchAuditDecision(entry())).toBe(
			'Flagged by Prompt Guard 2 22M, 0.97 (on this computer)'
		);
		expect(
			describeSketchAuditDecision(
				entry({ status: 'unscreened', score: undefined, source: 'Screen off', locality: 'local' })
			)
		).toBe('Not screened: Screen off (on this computer)');
		expect(describeSketchAuditDecision(entry({ status: 'clean', locality: 'cloud' }))).toBe(
			'Clean by Prompt Guard 2 22M, 0.97 (by a cloud service)'
		);
	});
});
