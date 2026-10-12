/**
 * Tests for the System One decision ledger's shared vocabulary: the query
 * validator, the text a record keeps of a request, and the words a row is
 * shown in.
 */

import { describe, it, expect } from 'vitest';

import { choice, noul, score } from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_DECISION_OUTCOMES,
	SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS,
	SYSTEM_ONE_LEDGER_MAX_LIMIT,
	SYSTEM_ONE_LEDGER_OUTCOME_FILTERS,
	SYSTEM_ONE_LEDGER_OUTCOME_LABELS,
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	describeSystemOneAnswer,
	formatSystemOneLedgerInput,
	isSystemOneDecisionOutcome,
	isSystemOneLedgerOutcomeFilter,
	parseSystemOneLedgerQuery,
	summarizeSystemOneDecision,
} from '../../../shared/local-models/system-one-ledger';

// Built at run time so no secret-shaped literal sits in the source.
const SECRET = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;

describe('the retention window', () => {
	it('is thirty days', () => {
		expect(SYSTEM_ONE_LEDGER_RETENTION_DAYS).toBe(30);
		expect(SYSTEM_ONE_LEDGER_RETENTION_MS).toBe(30 * 86_400_000);
	});
});

describe('outcomes', () => {
	it('has no timeout outcome: a timeout is a code on a failed-open or failed-closed run', () => {
		expect(SYSTEM_ONE_DECISION_OUTCOMES).toEqual([
			'ok',
			'failed-open',
			'failed-closed',
			'unavailable',
			'cancelled',
		]);
		expect(isSystemOneDecisionOutcome('timeout')).toBe(false);
	});

	it('offers timeout as a filter beside every outcome, each with a label', () => {
		expect(SYSTEM_ONE_LEDGER_OUTCOME_FILTERS).toEqual([...SYSTEM_ONE_DECISION_OUTCOMES, 'timeout']);
		expect(isSystemOneLedgerOutcomeFilter('timeout')).toBe(true);
		expect(isSystemOneLedgerOutcomeFilter('sideways')).toBe(false);
		for (const filter of SYSTEM_ONE_LEDGER_OUTCOME_FILTERS) {
			expect(SYSTEM_ONE_LEDGER_OUTCOME_LABELS[filter]).toBeTruthy();
		}
	});
});

describe('parseSystemOneLedgerQuery', () => {
	it('reads an absent query as every task, newest first', () => {
		expect(parseSystemOneLedgerQuery(undefined)).toEqual({ ok: true, query: {} });
		expect(parseSystemOneLedgerQuery(null)).toEqual({ ok: true, query: {} });
		expect(parseSystemOneLedgerQuery({})).toEqual({ ok: true, query: {} });
	});

	it('keeps a task, an outcome, a start and a limit', () => {
		expect(
			parseSystemOneLedgerQuery({ taskId: 'cue-gate', outcome: 'timeout', since: 1000, limit: 5 })
		).toEqual({
			ok: true,
			query: { taskId: 'cue-gate', outcome: 'timeout', since: 1000, limit: 5 },
		});
	});

	it('drops a field it does not know, so a newer caller cannot smuggle one in', () => {
		expect(parseSystemOneLedgerQuery({ limit: 5, orderBy: 'input' })).toEqual({
			ok: true,
			query: { limit: 5 },
		});
	});

	it.each([
		['a string', 'cue-gate', /must be an object/],
		['an array', [], /must be an object/],
		['an unknown task', { taskId: 'no-such-task' }, /is not a task/],
		['an unknown outcome', { outcome: 'sideways' }, /is not an outcome/],
		['a start that is not a number', { since: '1d' }, /epoch milliseconds/],
		['a negative start', { since: -1 }, /epoch milliseconds/],
		['a limit of zero', { limit: 0 }, /whole number from 1/],
		['a fractional limit', { limit: 1.5 }, /whole number from 1/],
		['a limit past the cap', { limit: SYSTEM_ONE_LEDGER_MAX_LIMIT + 1 }, /whole number from 1/],
	])('refuses %s', (_name, raw, message) => {
		const result = parseSystemOneLedgerQuery(raw);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(message);
	});
});

describe('formatSystemOneLedgerInput', () => {
	it('keeps the state and the questions as JSON', () => {
		const questions = { proceed: noul('Should this run proceed?') };

		const kept = JSON.parse(formatSystemOneLedgerInput({ state: 'A comment.', questions }));

		expect(kept).toEqual({ state: 'A comment.', questions });
	});

	it('removes a secret from the state and from a question before it is kept', () => {
		const text = formatSystemOneLedgerInput({
			state: { comment: `my key is ${SECRET}` },
			questions: { leak: noul(`Does the text hold ${SECRET}?`) },
		});

		expect(text).not.toContain(SECRET);
		expect(JSON.parse(text).state.comment).toContain('my key is');
	});

	it('cuts a state too long to keep whole, marks it, and keeps the questions', () => {
		const questions = { proceed: noul('Should this run proceed?') };

		const kept = JSON.parse(
			formatSystemOneLedgerInput({
				state: 'x'.repeat(SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS * 2),
				questions,
			})
		);

		expect(kept.truncated).toBe(true);
		expect(kept.state).toHaveLength(SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS);
		expect(kept.questions).toEqual(questions);
	});

	it('cuts a long JSON state as text', () => {
		const kept = JSON.parse(
			formatSystemOneLedgerInput({
				state: { items: Array.from({ length: 5000 }, (_, i) => `item ${i}`) },
				questions: { proceed: noul('Proceed?') },
			})
		);

		expect(kept.truncated).toBe(true);
		expect(typeof kept.state).toBe('string');
		expect(kept.state.startsWith('{"items":["item 0"')).toBe(true);
	});
});

describe('describeSystemOneAnswer', () => {
	it('says yes or no with P(yes)', () => {
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.93 })).toBe('yes (0.93)');
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.08 })).toBe('no (0.08)');
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.5 })).toBe('yes (0.50)');
	});

	it('names the option, with the confidence when the engine reports one', () => {
		expect(describeSystemOneAnswer({ type: 'choice', choice: 'bug', confidence: 0.81 })).toBe(
			'bug (0.81)'
		);
		// The local judge names one option and no distribution.
		expect(describeSystemOneAnswer({ type: 'choice', choice: 'bug' })).toBe('bug');
	});

	it('gives a score as a level, whole or between two', () => {
		expect(describeSystemOneAnswer({ type: 'score', score: 2 })).toBe('level 2');
		expect(describeSystemOneAnswer({ type: 'score', score: 2.4 })).toBe('level 2.40');
	});
});

describe('summarizeSystemOneDecision', () => {
	it('leaves out the id of a single question', () => {
		expect(
			summarizeSystemOneDecision({
				outcome: 'ok',
				answers: { proceed: { type: 'noul', probability: 0.93 } },
			})
		).toBe('yes (0.93)');
	});

	it('keys several answers by question id', () => {
		expect(
			summarizeSystemOneDecision({
				outcome: 'ok',
				answers: {
					kind: { type: 'choice', choice: 'bug', confidence: 0.81 },
					severity: { type: 'score', score: 3 },
				},
			})
		).toBe('kind: bug (0.81), severity: level 3');
	});

	it('says why there was no answer, or the outcome when no code was kept', () => {
		expect(summarizeSystemOneDecision({ outcome: 'failed-open', code: 'timeout' })).toBe('timeout');
		expect(summarizeSystemOneDecision({ outcome: 'failed-closed', code: 'off' })).toBe('off');
		expect(summarizeSystemOneDecision({ outcome: 'unavailable' })).toBe('unavailable');
	});
});

// The builders are the vocabulary a kept input is written in; a sanity check
// that the three types survive the round trip the ledger makes.
describe('a kept input and the three question types', () => {
	it('round-trips noul, choice and score', () => {
		const questions = {
			proceed: noul('Proceed?'),
			kind: choice('Which kind?', { bug: 'A defect', feature: 'A request' }),
			severity: score('How severe?', ['Cosmetic', 'Annoying', 'Blocking']),
		};

		expect(JSON.parse(formatSystemOneLedgerInput({ state: 'text', questions })).questions).toEqual(
			questions
		);
	});
});
