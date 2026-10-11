/**
 * Tests for the shared Cue gate contract: the reply parser, the caps that keep
 * an event inside a small model context, the failure policy, and the record
 * stamped on a gated event.
 *
 * The policy is the part with consequences: a gate whose model cannot answer
 * must run (and warn) unless the subscription asked to skip, and a reply that
 * is not a verdict must never be read as a pass or a fail.
 */

import { describe, it, expect } from 'vitest';

import {
	CUE_GATE_EVENT_CAPS,
	CUE_GATE_MAX_REASON_LENGTH,
	CUE_GATE_PAYLOAD_KEY,
	CUE_GATE_REPLY_SCHEMA,
	clampCueGateReason,
	compactCueGateEvent,
	formatCueGateInput,
	parseCueGateReply,
	readCueGateRecord,
	resolveCueGateDecision,
	withCueGateRecord,
} from '../../../shared/cue/gate';
import { isCueRunSkipped, type CueEvent } from '../../../shared/cue';

function event(payload: Record<string, unknown> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'github.issue',
		timestamp: '2026-10-11T12:00:00.000Z',
		triggerName: 'triage',
		payload,
	};
}

describe('CUE_GATE_REPLY_SCHEMA', () => {
	it('asks for a boolean verdict and a reason, and nothing else', () => {
		expect(CUE_GATE_REPLY_SCHEMA).toMatchObject({
			type: 'object',
			required: ['reason', 'pass'],
			additionalProperties: false,
			properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
		});
	});
});

describe('parseCueGateReply', () => {
	it('reads a verdict', () => {
		expect(parseCueGateReply({ pass: true, reason: 'Reports a crash.' })).toEqual({
			pass: true,
			reason: 'Reports a crash.',
		});
		expect(parseCueGateReply({ pass: false, reason: 'Praise only.' })).toEqual({
			pass: false,
			reason: 'Praise only.',
		});
	});

	it('keeps a verdict that came without a reason', () => {
		expect(parseCueGateReply({ pass: false })).toEqual({ pass: false, reason: '' });
	});

	it('returns null for anything that is not a verdict', () => {
		expect(parseCueGateReply(undefined)).toBeNull();
		expect(parseCueGateReply(null)).toBeNull();
		expect(parseCueGateReply('yes')).toBeNull();
		expect(parseCueGateReply([true])).toBeNull();
		expect(parseCueGateReply({ reason: 'no verdict here' })).toBeNull();
		// A string is not a boolean: "false" must not be read as truthy.
		expect(parseCueGateReply({ pass: 'false', reason: 'x' })).toBeNull();
		expect(parseCueGateReply({ pass: 1, reason: 'x' })).toBeNull();
	});

	it('flattens and bounds the reason', () => {
		const reply = parseCueGateReply({
			pass: true,
			reason: `line one\n\n  line two ${'x'.repeat(400)}`,
		});
		expect(reply?.reason.startsWith('line one line two')).toBe(true);
		expect(reply?.reason.length).toBe(CUE_GATE_MAX_REASON_LENGTH);
		expect(reply?.reason.endsWith('...')).toBe(true);
	});
});

describe('clampCueGateReason', () => {
	it('leaves a short reason alone', () => {
		expect(clampCueGateReason('  Asks for a fix.  ')).toBe('Asks for a fix.');
	});
});

describe('compactCueGateEvent', () => {
	it('is compact JSON of the payload', () => {
		expect(compactCueGateEvent({ number: 12, title: 'Login fails' })).toBe(
			'{"number":12,"title":"Login fails"}'
		);
	});

	it('cuts a long string and says how much was dropped', () => {
		const body = 'a'.repeat(CUE_GATE_EVENT_CAPS.maxStringChars + 250);
		const out = JSON.parse(compactCueGateEvent({ body, title: 'kept' }));
		expect(out.body).toContain('...[250 more characters not shown]');
		expect(out.body.startsWith('a'.repeat(CUE_GATE_EVENT_CAPS.maxStringChars))).toBe(true);
		// A long field must not push the fields after it out.
		expect(out.title).toBe('kept');
	});

	it('caps list length and nesting depth', () => {
		const items = Array.from({ length: CUE_GATE_EVENT_CAPS.maxArrayItems + 5 }, (_, i) => i);
		const out = JSON.parse(
			compactCueGateEvent({ items, deep: { a: { b: { c: { d: { e: 'too deep' } } } } } })
		);
		expect(out.items).toHaveLength(CUE_GATE_EVENT_CAPS.maxArrayItems + 1);
		expect(out.items.at(-1)).toBe('...[5 more items not shown]');
		expect(JSON.stringify(out.deep)).toContain('[object not shown]');
		expect(JSON.stringify(out.deep)).not.toContain('too deep');
	});

	it('cuts the whole document to the total cap', () => {
		const payload: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) payload[`field${i}`] = 'b'.repeat(1000);
		const out = compactCueGateEvent(payload);
		expect(out.length).toBeLessThan(CUE_GATE_EVENT_CAPS.maxTotalChars + 60);
		expect(out).toMatch(/more characters not shown\]$/);
	});

	it("leaves the gate's own record out of what the model reads", () => {
		const out = compactCueGateEvent({
			title: 'x',
			[CUE_GATE_PAYLOAD_KEY]: { outcome: 'passed', reason: 'earlier verdict' },
		});
		expect(out).toBe('{"title":"x"}');
	});

	it('falls back to an empty object for a payload that cannot be serialized', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		// Depth capping breaks the cycle before JSON.stringify can throw.
		expect(() => compactCueGateEvent(cyclic)).not.toThrow();
		expect(compactCueGateEvent({ big: BigInt(1) } as unknown as Record<string, unknown>)).toBe(
			'{}'
		);
	});
});

describe('formatCueGateInput', () => {
	it('names the condition, the event type, and the event', () => {
		const text = formatCueGateInput({
			condition: '  the comment reports a bug  ',
			event: event({ title: 'Crash on save' }),
		});
		expect(text).toBe(
			[
				'Condition: the comment reports a bug',
				'',
				'Event type: github.issue',
				'Event:',
				'{"title":"Crash on save"}',
			].join('\n')
		);
	});
});

describe('resolveCueGateDecision', () => {
	it('runs on a pass, without a warning', () => {
		expect(resolveCueGateDecision({ status: 'pass', reason: 'Reports a bug.' })).toEqual({
			run: true,
			warn: false,
			record: { outcome: 'passed', reason: 'Reports a bug.' },
		});
	});

	it('skips on a fail, without a warning', () => {
		expect(resolveCueGateDecision({ status: 'fail', reason: 'Praise only.' })).toEqual({
			run: false,
			warn: false,
			record: { outcome: 'gated', reason: 'Praise only.' },
		});
	});

	it('gives a fail with no reason a reason', () => {
		const decision = resolveCueGateDecision({ status: 'fail', reason: '' });
		expect(decision.run).toBe(false);
		expect(decision.record.reason).toMatch(/does not meet the gate condition/);
	});

	it('fails OPEN with a warning when the gate is unavailable (the default)', () => {
		const check = { status: 'unavailable', reason: 'Cue gate is off.' } as const;
		for (const decision of [
			resolveCueGateDecision(check),
			resolveCueGateDecision(check, 'run'),
			resolveCueGateDecision(check, undefined),
		]) {
			expect(decision.run).toBe(true);
			expect(decision.warn).toBe(true);
			expect(decision.record.outcome).toBe('ran-unchecked');
			expect(decision.record.reason).toContain('Cue gate is off.');
		}
	});

	it('fails closed, still with a warning, when the subscription asked to skip', () => {
		const decision = resolveCueGateDecision(
			{ status: 'unavailable', reason: 'Model not installed.' },
			'skip'
		);
		expect(decision.run).toBe(false);
		expect(decision.warn).toBe(true);
		expect(decision.record.outcome).toBe('gated');
		expect(decision.record.reason).toContain('gate_on_unavailable is "skip"');
		expect(decision.record.reason).toContain('Model not installed.');
	});

	it('never lets gate_on_unavailable override a real verdict', () => {
		expect(resolveCueGateDecision({ status: 'pass', reason: 'ok' }, 'skip').run).toBe(true);
		expect(resolveCueGateDecision({ status: 'fail', reason: 'no' }, 'run').run).toBe(false);
	});
});

describe('gate record on an event', () => {
	it('stamps a copy and reads it back', () => {
		const original = event({ title: 'x' });
		const stamped = withCueGateRecord(original, { outcome: 'gated', reason: 'Praise only.' });

		expect(original.payload).toEqual({ title: 'x' });
		expect(stamped.id).toBe(original.id);
		expect(stamped.payload.title).toBe('x');
		expect(readCueGateRecord(stamped.payload)).toEqual({
			outcome: 'gated',
			reason: 'Praise only.',
		});
	});

	it('survives a JSON round trip, which is how cue_events stores it', () => {
		const stamped = withCueGateRecord(event(), { outcome: 'ran-unchecked', reason: 'Off.' });
		const restored = JSON.parse(JSON.stringify(stamped.payload));
		expect(readCueGateRecord(restored)).toEqual({ outcome: 'ran-unchecked', reason: 'Off.' });
	});

	it('reads nothing from an event no gate touched, or from a malformed record', () => {
		expect(readCueGateRecord(undefined)).toBeNull();
		expect(readCueGateRecord({})).toBeNull();
		expect(readCueGateRecord({ gate: 'yes' })).toBeNull();
		expect(readCueGateRecord({ gate: { outcome: 'maybe', reason: 'x' } })).toBeNull();
		expect(readCueGateRecord({ gate: { outcome: 'passed' } })).toEqual({
			outcome: 'passed',
			reason: '',
		});
	});
});

describe('isCueRunSkipped', () => {
	it('is true only for the status that records a skipped event', () => {
		expect(isCueRunSkipped('gated')).toBe(true);
		for (const status of ['running', 'completed', 'failed', 'timeout', 'stopped']) {
			expect(isCueRunSkipped(status)).toBe(false);
		}
	});
});
