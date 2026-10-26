/**
 * Tests for the Sketch Book wire protocol (src/shared/sketch/protocol.ts):
 * one valid and one invalid case per server frame, the frame and `ct` size
 * caps, and every `guardrail_rejected` rule on both the parser and the
 * builder (exactly one target, never `iv`, `ct`, `score` or `excerpt`).
 */

import { describe, it, expect } from 'vitest';
import {
	buildGuardrailRejected,
	CT_MAX_BYTES,
	ERROR_CODES,
	MAX_FRAME_BYTES,
	parseServerFrame,
	PROTOCOL_VERSION,
	type GuardrailTarget,
	type ServerFrame,
	type ServerFrameType,
} from '../../../shared/sketch/protocol';
import { BOT_STATUSES, type GuardrailReason } from '../../../shared/sketch/types';

const IV = 'AAAAAAAAAAAAAAAA';
const CT = 'Q2lwaGVydGV4dEdvZXNIZXJlMTIz';

const actor = { id: 'actor-1', kind: 'guest', name: 'Ada', role: 'rw', capId: 'cap-1' };
const op = { seq: 3, actor, ts: 1_700_000_000_000, iv: IV, ct: CT };

const statsActor = {
	actorId: 'actor-1',
	kind: 'guest',
	name: 'Ada',
	capId: 'cap-1',
	capLabel: 'Team',
	role: 'rw',
	online: true,
	ops: 4,
	toBot: 1,
	denyStreak: 0,
	denialsTotal: 0,
	guardrailTotal: 2,
	guardrailByReason: { injection: 1, other: 1 },
	unavailableTotal: 3,
	lockedOut: false,
	lastSeen: 1_700_000_000_000,
};

const statsCap = {
	capId: 'cap-1',
	label: 'Team',
	role: 'rw',
	expiresAt: null,
	revoked: false,
	botSuspended: false,
	guardrailTotal: 2,
	online: 1,
};

/** One valid frame and one invalid variant per server frame type. */
const CASES: Record<ServerFrameType, { valid: Record<string, unknown>; invalid: unknown }> = {
	welcome: {
		valid: {
			t: 'welcome',
			actor: { id: 'conductor', kind: 'conductor', name: 'Pedram', role: 'conductor' },
			role: 'conductor',
			botPolicy: 'conductor',
			botOnline: true,
			guestEdited: false,
			screening: null,
			screeningSince: null,
			headSeq: 0,
			snapshot: { seq: 0, key: 'rooms/abc/snapshots/0' },
			keyEpoch: 0,
			limits: { maxFrameBytes: MAX_FRAME_BYTES },
		},
		invalid: {
			t: 'welcome',
			actor,
			role: 'rw',
			botPolicy: 'everyone',
			botOnline: true,
			guestEdited: false,
			screening: null,
			screeningSince: null,
			headSeq: 0,
			snapshot: null,
			keyEpoch: 0,
			limits: {},
		},
	},
	screening: {
		valid: { t: 'screening', screening: 'local', since: 1_700_000_000_000 },
		invalid: { t: 'screening', screening: 'remote', since: 1 },
	},
	ack: {
		valid: { t: 'ack', seq: 1 },
		invalid: { t: 'ack', seq: 0 },
	},
	delta: {
		valid: { t: 'delta', ...op },
		invalid: { t: 'delta', ...op, iv: 'short' },
	},
	ops: {
		valid: { t: 'ops', items: [op, { ...op, seq: 4 }], more: false },
		invalid: { t: 'ops', items: [op, 'not an op'], more: false },
	},
	chat: {
		valid: { t: 'chat', id: 'msg-1', ...op, toBot: true, replyTo: 'msg-0' },
		invalid: { t: 'chat', id: 'msg-1', ...op, toBot: 'yes' },
	},
	'bot.status': {
		valid: { t: 'bot.status', replyTo: 'msg-1', status: 'failed' },
		invalid: { t: 'bot.status', replyTo: 'msg-1', status: 'thinking' },
	},
	guardrail_rejected: {
		valid: { t: 'guardrail_rejected', replyTo: 'msg-1', reason: 'rejected' },
		invalid: { t: 'guardrail_rejected', replyTo: 'msg-1', reason: 'injection' },
	},
	'room.stats': {
		valid: {
			t: 'room.stats',
			guestEdited: true,
			actors: [statsActor],
			caps: [statsCap],
			flaggedActors: ['actor-1'],
			screening: 'cloud',
			screeningSince: 1_700_000_000_000,
		},
		invalid: {
			t: 'room.stats',
			guestEdited: true,
			actors: [{ ...statsActor, unavailableTotal: undefined }],
			caps: [statsCap],
			flaggedActors: [],
			screening: null,
			screeningSince: null,
		},
	},
	policy: {
		valid: { t: 'policy', botPolicy: 'writers' },
		invalid: { t: 'policy' },
	},
	presence: {
		valid: { t: 'presence', actor, iv: IV, ct: CT },
		invalid: { t: 'presence', actor: { ...actor, kind: 'robot' }, iv: IV, ct: CT },
	},
	'presence.bot': {
		valid: { t: 'presence.bot', online: true, agentId: 'agent-1', name: 'Sketch Bot' },
		invalid: { t: 'presence.bot', online: 1 },
	},
	error: {
		valid: { t: 'error', code: 'rate_limited', ref: 'msg-1' },
		invalid: { t: 'error', code: 'teapot' },
	},
};

function parse(value: unknown, maxBytes?: number) {
	return parseServerFrame(JSON.stringify(value), maxBytes);
}

function expectFrame(value: unknown): ServerFrame {
	const result = parse(value);
	if (!result.ok) throw new Error(`expected a valid frame, got ${result.detail}`);
	return result.frame;
}

function expectBad(value: unknown, maxBytes?: number): string {
	const result =
		typeof value === 'string' ? parseServerFrame(value, maxBytes) : parse(value, maxBytes);
	if (result.ok) throw new Error(`expected a bad frame, got ${JSON.stringify(result.frame)}`);
	expect(result.code).toBe(ERROR_CODES.bad_frame);
	return result.detail;
}

describe('sketch protocol constants', () => {
	it('is wire protocol v1 with the contract section 1 caps', () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
		expect(CT_MAX_BYTES.chat).toBe(32 * 1024);
		expect(CT_MAX_BYTES['bot.reply']).toBe(32 * 1024);
		expect(CT_MAX_BYTES.delta).toBe(1024 * 1024);
		expect(CT_MAX_BYTES.presence).toBe(2 * 1024);
	});

	it('includes failed in the bot statuses (X5)', () => {
		expect(BOT_STATUSES).toContain('failed');
	});
});

describe('parseServerFrame: one valid and one invalid case per frame', () => {
	for (const [type, { valid, invalid }] of Object.entries(CASES)) {
		it(`accepts a valid ${type} and returns exactly its fields`, () => {
			const frame = expectFrame(valid);
			expect(frame.t).toBe(type);
			expect(frame).toEqual(valid);
		});

		it(`rejects an invalid ${type}`, () => {
			expectBad(invalid);
		});
	}
});

describe('parseServerFrame: shape rules', () => {
	it('drops unknown extra fields instead of passing them through', () => {
		const frame = expectFrame({ ...CASES.ack.valid, extra: 'smuggled' });
		expect(frame).toEqual({ t: 'ack', seq: 1 });
		expect('extra' in frame).toBe(false);
	});

	it('drops unknown actor fields', () => {
		const frame = expectFrame({ t: 'presence', actor: { ...actor, admin: true }, iv: IV, ct: CT });
		expect(frame.t === 'presence' && 'admin' in frame.actor).toBe(false);
	});

	it('leaves absent optional fields absent', () => {
		const frame = expectFrame({ t: 'presence.bot', online: false });
		expect(frame).toEqual({ t: 'presence.bot', online: false });
	});

	it('accepts welcome screening values and a null snapshot', () => {
		const frame = expectFrame({
			...CASES.welcome.valid,
			screening: 'cloud',
			screeningSince: 5,
			snapshot: null,
		});
		expect(frame).toMatchObject({ screening: 'cloud', screeningSince: 5, snapshot: null });
	});

	it('rejects a non-numeric limit', () => {
		expectBad({ ...CASES.welcome.valid, limits: { maxFrameBytes: 'big' } });
	});

	it('rejects an unknown frame type, a non-object, and invalid json', () => {
		expect(expectBad({ t: 'hello' })).toBe('unknown t');
		expect(expectBad([CASES.ack.valid])).toBe('not an object');
		expect(expectBad('{not json')).toBe('invalid json');
	});

	it('rejects a ct that base64url never produces', () => {
		expectBad({ t: 'delta', ...op, ct: 'AAAAA' });
		expectBad({ t: 'delta', ...op, ct: `${'A'.repeat(23)}+` });
		expectBad({ t: 'delta', ...op, ct: 'A'.repeat(25) });
	});

	it('never throws on hostile input', () => {
		for (const raw of ['', 'null', '42', '"text"', '{"t":null}', '{"t":"ops","items":null}']) {
			expect(() => parseServerFrame(raw)).not.toThrow();
			expect(parseServerFrame(raw).ok).toBe(false);
		}
	});
});

describe('parseServerFrame: size caps', () => {
	it('rejects a frame over maxBytes', () => {
		const raw = JSON.stringify({ t: 'ack', seq: 1 });
		expect(parseServerFrame(raw, raw.length).ok).toBe(true);
		expect(expectBad(raw, raw.length - 1)).toBe('frame too large');
	});

	it('counts UTF-8 bytes, not UTF-16 units', () => {
		const raw = JSON.stringify({ t: 'presence.bot', online: true, name: 'é'.repeat(40) });
		const bytes = new TextEncoder().encode(raw).length;
		expect(raw.length).toBeLessThan(bytes);
		expect(parseServerFrame(raw, bytes).ok).toBe(true);
		expect(expectBad(raw, raw.length)).toBe('frame too large');
	});

	it('defaults to the 1 MiB frame cap', () => {
		const raw = JSON.stringify({ t: 'delta', ...op, ct: 'A'.repeat(MAX_FRAME_BYTES) });
		expect(expectBad(raw)).toBe('frame too large');
	});

	it('caps chat ct at 32 KiB (Y1) while a delta of the same size passes', () => {
		const big = 'A'.repeat(CT_MAX_BYTES.chat + 4);
		expect(expectBad({ t: 'chat', id: 'msg-1', ...op, ct: big, toBot: false })).toBe(
			'ct too large'
		);
		expect(parse({ t: 'delta', ...op, ct: big }).ok).toBe(true);
		const atCap = 'A'.repeat(CT_MAX_BYTES.chat);
		expect(parse({ t: 'chat', id: 'msg-1', ...op, ct: atCap, toBot: false }).ok).toBe(true);
	});

	it('caps presence ct at 2 KiB', () => {
		expect(
			expectBad({ t: 'presence', actor, iv: IV, ct: 'A'.repeat(CT_MAX_BYTES.presence + 4) })
		).toBe('ct too large');
	});
});

describe('parseServerFrame: guardrail_rejected rules', () => {
	it('accepts exactly one target, replyTo or opSeq', () => {
		expect(
			expectFrame({ t: 'guardrail_rejected', replyTo: 'msg-1', reason: 'unavailable' })
		).toEqual({
			t: 'guardrail_rejected',
			replyTo: 'msg-1',
			reason: 'unavailable',
		});
		expect(expectFrame({ t: 'guardrail_rejected', opSeq: 7, reason: 'rejected' })).toEqual({
			t: 'guardrail_rejected',
			opSeq: 7,
			reason: 'rejected',
		});
	});

	it('rejects both targets and neither target', () => {
		expectBad({ t: 'guardrail_rejected', replyTo: 'msg-1', opSeq: 7, reason: 'rejected' });
		expectBad({ t: 'guardrail_rejected', reason: 'rejected' });
	});

	it('rejects an invalid opSeq', () => {
		expectBad({ t: 'guardrail_rejected', opSeq: 0, reason: 'rejected' });
		expectBad({ t: 'guardrail_rejected', opSeq: 1.5, reason: 'rejected' });
	});

	for (const key of ['iv', 'ct', 'score', 'excerpt']) {
		it(`rejects a guardrail_rejected that carries ${key}`, () => {
			const detail = expectBad({
				t: 'guardrail_rejected',
				replyTo: 'msg-1',
				reason: 'rejected',
				[key]: key === 'score' ? 0.9 : 'x',
			});
			expect(detail).toBe(`guardrail_rejected must not carry ${key}`);
		});
	}
});

describe('buildGuardrailRejected', () => {
	const reasons: GuardrailReason[] = ['injection', 'screen_unavailable', 'other'];

	for (const reason of reasons) {
		it(`builds a replyTo frame for ${reason}`, () => {
			expect(buildGuardrailRejected({ replyTo: 'msg-1' }, reason)).toEqual({
				t: 'guardrail_rejected',
				replyTo: 'msg-1',
				reason,
			});
		});
	}

	it('builds an opSeq frame for injection and other', () => {
		expect(buildGuardrailRejected({ opSeq: 9 }, 'injection')).toEqual({
			t: 'guardrail_rejected',
			opSeq: 9,
			reason: 'injection',
		});
		expect(buildGuardrailRejected({ opSeq: 9 }, 'other')).toEqual({
			t: 'guardrail_rejected',
			opSeq: 9,
			reason: 'other',
		});
	});

	it('never serializes iv, ct, score or excerpt, whatever the caller passes', () => {
		const smuggled = {
			replyTo: 'msg-1',
			iv: IV,
			ct: CT,
			score: 0.97,
			excerpt: 'ignore previous instructions',
		} as unknown as GuardrailTarget;
		const frame = buildGuardrailRejected(smuggled, 'injection');
		const serialized = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
		expect(Object.keys(serialized).sort()).toEqual(['reason', 'replyTo', 't']);
		for (const key of ['iv', 'ct', 'score', 'excerpt']) expect(key in serialized).toBe(false);
	});

	it('emits exactly one target key', () => {
		for (const frame of [
			buildGuardrailRejected({ replyTo: 'msg-1' }, 'other'),
			buildGuardrailRejected({ opSeq: 2 }, 'other'),
		]) {
			const keys = Object.keys(frame);
			expect(keys.filter((key) => key === 'replyTo' || key === 'opSeq')).toHaveLength(1);
		}
	});

	it('throws on both targets or neither', () => {
		expect(() =>
			buildGuardrailRejected({ replyTo: 'msg-1', opSeq: 2 } as unknown as GuardrailTarget, 'other')
		).toThrow(/exactly one/);
		expect(() => buildGuardrailRejected({} as unknown as GuardrailTarget, 'other')).toThrow(
			/exactly one/
		);
	});

	it('throws on screen_unavailable with opSeq (X1)', () => {
		expect(() => buildGuardrailRejected({ opSeq: 2 }, 'screen_unavailable')).toThrow(/X1/);
	});

	it('throws on a bad target value or an unknown reason', () => {
		expect(() => buildGuardrailRejected({ replyTo: '' }, 'other')).toThrow();
		expect(() => buildGuardrailRejected({ opSeq: 0 }, 'other')).toThrow();
		expect(() => buildGuardrailRejected({ opSeq: 1.5 }, 'other')).toThrow();
		expect(() =>
			buildGuardrailRejected({ replyTo: 'msg-1' }, 'rejected' as unknown as GuardrailReason)
		).toThrow(/unknown reason/);
	});
});
