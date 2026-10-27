/**
 * Sketch Book `@bot` decisions (spec section 5, B2 approval chip, and
 * section 9): the verdict line the chip shows, the per-link chip limit, and
 * which ops an agent caller must have the conductor confirm (A1).
 */

import { describe, expect, it } from 'vitest';
import {
	SKETCH_APPROVALS_PER_CAP,
	describeSketchVerdict,
	isSketchBotDecisionOp,
	isSketchBotRequestOp,
	sketchBotOpNeedsConfirmation,
	sketchRequestCapKey,
	visibleSketchApprovals,
} from '../../../shared/sketch/bot-requests';
import type { SketchActor } from '../../../shared/sketch/types';

const sam: SketchActor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw', capId: 'cap-3' };
const kim: SketchActor = { id: 'g2', kind: 'guest', name: 'Kim', role: 'rw', capId: 'cap-4' };

function request(replyTo: string, actor: SketchActor, ts: number, status = 'awaiting_approval') {
	return { replyTo, actor, ts, status };
}

describe('describeSketchVerdict', () => {
	it('names the status, the source and the score', () => {
		expect(
			describeSketchVerdict({
				status: 'clean',
				score: 0.0412,
				sourceLabel: 'Prompt Guard 2',
				locality: 'local',
			})
		).toBe('Screened: clean, Prompt Guard 2, 0.04');
	});

	it('leaves the score out when the source gave none', () => {
		expect(describeSketchVerdict({ status: 'clean', sourceLabel: 'Jev', locality: 'cloud' })).toBe(
			'Screened: clean, Jev'
		);
	});

	it('says the conductor wrote a request with no verdict', () => {
		expect(describeSketchVerdict(null)).toBe('Not screened: the conductor wrote it.');
	});
});

describe('visibleSketchApprovals', () => {
	it('shows the oldest three per link and keeps the rest waiting', () => {
		const requests = [
			request('m5', sam, 5),
			request('m1', sam, 1),
			request('m2', sam, 2),
			request('k1', kim, 3),
			request('m3', sam, 4),
		];
		const { visible, waiting } = visibleSketchApprovals(requests);
		expect(SKETCH_APPROVALS_PER_CAP).toBe(3);
		expect(visible.map((r) => r.replyTo)).toEqual(['m1', 'm2', 'k1', 'm3']);
		expect(waiting.map((r) => r.replyTo)).toEqual(['m5']);
	});

	it('counts only requests waiting on approval', () => {
		const requests = [
			request('r1', sam, 1, 'running'),
			request('h1', sam, 2, 'held'),
			request('m1', sam, 3),
		];
		const { visible, waiting } = visibleSketchApprovals(requests, 1);
		expect(visible.map((r) => r.replyTo)).toEqual(['m1']);
		expect(waiting).toEqual([]);
	});

	it('groups an actor with no link by the actor', () => {
		expect(sketchRequestCapKey({ id: 'g9', kind: 'guest', name: 'X', role: 'rw' })).toBe(
			'actor:g9'
		);
		expect(sketchRequestCapKey(sam)).toBe('cap:cap-3');
	});
});

describe('ops', () => {
	it('knows the request ops and the decisions', () => {
		expect(isSketchBotRequestOp('list')).toBe(true);
		expect(isSketchBotDecisionOp('list')).toBe(false);
		expect(isSketchBotDecisionOp('approve')).toBe(true);
		expect(isSketchBotRequestOp('run')).toBe(false);
	});

	it('confirms approve, escalate and publish for an agent; deny and discard run', () => {
		expect(sketchBotOpNeedsConfirmation('approve')).toBe(true);
		expect(sketchBotOpNeedsConfirmation('escalate')).toBe(true);
		expect(sketchBotOpNeedsConfirmation('publish')).toBe(true);
		expect(sketchBotOpNeedsConfirmation('deny')).toBe(false);
		expect(sketchBotOpNeedsConfirmation('discard')).toBe(false);
	});
});
