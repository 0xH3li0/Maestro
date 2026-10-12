/**
 * Tests for the System One decision ledger in the main process: what
 * `recordSystemOneDecision` keeps and `readSystemOneLedger` returns.
 *
 * The stats singleton is replaced by the real `s1_decisions` functions over a
 * real in-memory SQLite, so the retention window, the prune and the filters
 * are checked against the schema, not a recorder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const state = vi.hoisted(() => ({
	db: null as unknown,
	ready: true,
	statsEnabled: true,
	pruneCalls: [] as number[],
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string) => (key === 'statsCollectionEnabled' ? state.statsEnabled : undefined),
	}),
}));
vi.mock('../../../../main/stats/singleton', async () => {
	const decisions = await import('../../../../main/stats/s1-decisions');
	return {
		getStatsDB: () => ({
			isReady: () => state.ready,
			recordSystemOneDecision: (decision: never) =>
				decisions.insertSystemOneDecision(state.db as Database.Database, decision),
			getSystemOneDecisions: (read: never) =>
				decisions.getSystemOneDecisions(state.db as Database.Database, read),
			getSystemOneAgentSpend: (since: number) =>
				decisions.getSystemOneAgentSpend(state.db as Database.Database, since),
			pruneSystemOneDecisions: (cutoffMs: number) => {
				state.pruneCalls.push(cutoffMs);
				return decisions.pruneSystemOneDecisions(state.db as Database.Database, cutoffMs);
			},
		}),
	};
});

import {
	SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE,
	SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE,
	keepSystemOneDecision,
	readSystemOneAgentSpend,
	readSystemOneLedger,
	recordSystemOneDecision,
	resetSystemOneLedgerForTests,
} from '../../../../main/local-models/system-one/decisions';
import { runMigrations } from '../../../../main/stats/migrations';
import { clearSystemOneDecisionsCache } from '../../../../main/stats/s1-decisions';
import { captureException } from '../../../../main/utils/sentry';
import { noul } from '../../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_LEDGER_DEFAULT_LIMIT,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	type SystemOneDecision,
} from '../../../../shared/local-models/system-one-ledger';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../../helpers/nodeSqlite';

const DAY_MS = 86_400_000;

function decision(overrides: Partial<SystemOneDecision> = {}): SystemOneDecision {
	return {
		taskId: 'cue-gate',
		engine: 'jev-cloud',
		model: 'jev-1.13.0',
		questionIds: ['proceed'],
		answers: { proceed: { type: 'noul', probability: 0.93 } },
		outcome: 'ok',
		startedAt: Date.now(),
		latencyMs: 240,
		usage: { inputTokens: 412, outputTokens: 3 },
		costUsd: 0.0000173,
		...overrides,
	};
}

function rowCount(): number {
	const row = (state.db as Database.Database)
		.prepare('SELECT COUNT(*) AS n FROM s1_decisions')
		.get() as { n: number };
	return Number(row.n);
}

describe.skipIf(!canLoadNodeSqlite())('the System One decision ledger', () => {
	beforeEach(() => {
		clearSystemOneDecisionsCache();
		resetSystemOneLedgerForTests();
		const Shim = nodeSqliteBetterSqlite3Mock().default;
		const db = new Shim(':memory:') as unknown as Database.Database;
		runMigrations(db);
		state.db = db;
		state.ready = true;
		state.statsEnabled = true;
		state.pruneCalls = [];
	});

	describe('recordSystemOneDecision', () => {
		it('keeps a decision that a read then returns', () => {
			recordSystemOneDecision(decision({ agentId: 'agent-1' }));

			const page = readSystemOneLedger(undefined);

			expect(page.total).toBe(1);
			expect(page.entries[0]).toMatchObject({
				taskId: 'cue-gate',
				engine: 'jev-cloud',
				outcome: 'ok',
				agentId: 'agent-1',
				answers: { proceed: { type: 'noul', probability: 0.93 } },
			});
			expect(page.notice).toBeNull();
			expect(page.retentionDays).toBe(30);
		});

		it('keeps nothing while usage statistics are off', () => {
			state.statsEnabled = false;

			recordSystemOneDecision(decision());

			expect(rowCount()).toBe(0);
		});

		it('keeps nothing, and does not throw, while the database is not open', () => {
			state.ready = false;

			expect(() => recordSystemOneDecision(decision())).not.toThrow();

			expect(rowCount()).toBe(0);
		});

		it('lets a row that cannot be written throw, for the router to report', () => {
			expect(() => recordSystemOneDecision(decision({ outcome: 'timeout' as never }))).toThrow();
		});

		it('keeps an input only when the router hands one over', () => {
			recordSystemOneDecision(decision({ startedAt: Date.now() - 1000 }));
			recordSystemOneDecision(decision({ input: '{"state":"kept"}' }));

			const { entries } = readSystemOneLedger(undefined);

			expect(entries[0].input).toBe('{"state":"kept"}');
			expect(entries[1]).not.toHaveProperty('input');
		});
	});

	describe('thirty days', () => {
		it('deletes a record past the window on the next write', () => {
			const now = Date.now();
			recordSystemOneDecision(decision({ startedAt: now - 31 * DAY_MS }));
			expect(rowCount()).toBe(1);
			resetSystemOneLedgerForTests();

			recordSystemOneDecision(decision({ startedAt: now }));

			expect(rowCount()).toBe(1);
			expect(readSystemOneLedger(undefined).entries[0].startedAt).toBe(now);
		});

		it('deletes a record past the window on a read too', () => {
			const now = Date.now();
			recordSystemOneDecision(decision({ startedAt: now - 31 * DAY_MS }));
			resetSystemOneLedgerForTests();

			expect(readSystemOneLedger(undefined, now).total).toBe(0);
			expect(rowCount()).toBe(0);
		});

		it('prunes at most once a day, and never returns an old record in between', () => {
			const now = Date.now();
			recordSystemOneDecision(decision({ startedAt: now }));
			expect(state.pruneCalls).toHaveLength(1);

			// Written after the prune ran: it stays in the table until tomorrow.
			recordSystemOneDecision(decision({ startedAt: now - 31 * DAY_MS }));
			readSystemOneLedger(undefined, now);

			expect(state.pruneCalls).toHaveLength(1);
			expect(rowCount()).toBe(2);
			expect(readSystemOneLedger({ since: 0 }, now).total).toBe(1);

			// A minute past the day: the first prune was stamped a few ms after `now`.
			readSystemOneLedger(undefined, now + DAY_MS + 60_000);

			expect(state.pruneCalls).toHaveLength(2);
			expect(rowCount()).toBe(1);
		});

		it('prunes with the retention window as the cutoff', () => {
			const now = Date.now();

			readSystemOneLedger(undefined, now);

			expect(state.pruneCalls).toEqual([now - SYSTEM_ONE_LEDGER_RETENTION_MS]);
		});
	});

	describe('readSystemOneLedger', () => {
		it('answers an empty page with the reason while the database is not open', () => {
			state.ready = false;

			expect(readSystemOneLedger(undefined)).toEqual({
				entries: [],
				total: 0,
				retentionDays: 30,
				notice: SYSTEM_ONE_LEDGER_UNAVAILABLE_NOTICE,
			});
		});

		it('still returns what was kept, with a notice, once usage statistics are off', () => {
			recordSystemOneDecision(decision());
			state.statsEnabled = false;

			const page = readSystemOneLedger(undefined);

			expect(page.total).toBe(1);
			expect(page.notice).toBe(SYSTEM_ONE_LEDGER_STATS_OFF_NOTICE);
		});

		it('narrows by task, outcome and time', () => {
			const now = Date.now();
			recordSystemOneDecision(decision({ startedAt: now - 3 * DAY_MS }));
			recordSystemOneDecision(decision({ taskId: 'injection-screen', startedAt: now - 1000 }));
			recordSystemOneDecision(
				decision({
					outcome: 'failed-closed',
					code: 'timeout',
					startedAt: now,
					model: undefined,
					answers: undefined,
					usage: undefined,
					costUsd: undefined,
				})
			);

			expect(readSystemOneLedger({ taskId: 'injection-screen' }).total).toBe(1);
			expect(readSystemOneLedger({ outcome: 'timeout' }).entries[0].outcome).toBe('failed-closed');
			expect(readSystemOneLedger({ outcome: 'ok' }).total).toBe(2);
			expect(readSystemOneLedger({ since: now - DAY_MS }).total).toBe(2);
		});

		it(`returns ${SYSTEM_ONE_LEDGER_DEFAULT_LIMIT} records by default and as many as the limit asks for`, () => {
			const now = Date.now();
			for (let i = 0; i < SYSTEM_ONE_LEDGER_DEFAULT_LIMIT + 5; i++) {
				recordSystemOneDecision(decision({ startedAt: now - i }));
			}

			const page = readSystemOneLedger(undefined);
			expect(page.entries).toHaveLength(SYSTEM_ONE_LEDGER_DEFAULT_LIMIT);
			expect(page.total).toBe(SYSTEM_ONE_LEDGER_DEFAULT_LIMIT + 5);
			expect(readSystemOneLedger({ limit: 3 }).entries).toHaveLength(3);
		});

		it('rejects a query it cannot read, with the reason', () => {
			expect(() => readSystemOneLedger({ outcome: 'sideways' })).toThrow(/is not an outcome/);
			expect(() => readSystemOneLedger({ taskId: 'no-such-task' })).toThrow(/is not a task/);
			expect(() => readSystemOneLedger({ limit: 0 })).toThrow(/limit/);
		});

		it("returns an agent's own requests with the tab and the cached mark, filtered by verb", () => {
			recordSystemOneDecision(decision());
			recordSystemOneDecision(
				decision({ taskId: 'agent:rank', agentId: 'agent-1', tabId: 'tab-7', cached: true })
			);

			const page = readSystemOneLedger({ taskId: 'agent:rank' });

			expect(page.total).toBe(1);
			expect(page.entries[0]).toMatchObject({
				taskId: 'agent:rank',
				agentId: 'agent-1',
				tabId: 'tab-7',
				cached: true,
			});
		});
	});

	describe('keepSystemOneDecision', () => {
		// Built at run time so no secret-shaped literal sits in the source.
		const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
		const request = {
			state: `The deploy log holds ${secret}.`,
			questions: { failed: noul('Did the deploy fail?') },
		};

		beforeEach(() => {
			vi.mocked(captureException).mockClear();
		});

		it('keeps the decision, and no input unless it is handed the request', () => {
			keepSystemOneDecision(decision(), null);

			expect(readSystemOneLedger(undefined).entries[0]).not.toHaveProperty('input');
		});

		it('keeps the request it is handed, redacted', () => {
			keepSystemOneDecision(decision(), request);

			const kept = readSystemOneLedger(undefined).entries[0].input ?? '';
			expect(kept).toContain('deploy log');
			expect(kept).toContain('Did the deploy fail?');
			expect(kept).not.toContain(secret);
		});

		it('never throws for a record that cannot be kept, and reports it', () => {
			expect(() =>
				keepSystemOneDecision(decision({ outcome: 'timeout' as never }), request)
			).not.toThrow();

			expect(rowCount()).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
			expect(vi.mocked(captureException).mock.calls[0][1]).toMatchObject({
				operation: 'systemOne:recordDecision',
			});
		});
	});

	describe('readSystemOneAgentSpend', () => {
		const spent = (overrides: Partial<SystemOneDecision>): SystemOneDecision =>
			decision({ taskId: 'agent:yes', agentId: 'agent-1', costUsd: 0.25, ...overrides });

		it("sums agents' own requests since a time, per agent", () => {
			const now = Date.now();
			recordSystemOneDecision(spent({ startedAt: now }));
			recordSystemOneDecision(spent({ startedAt: now, taskId: 'agent:rank' }));
			recordSystemOneDecision(spent({ startedAt: now, agentId: 'agent-2', costUsd: 1 }));
			recordSystemOneDecision(spent({ startedAt: now - 2 * DAY_MS, costUsd: 9 }));
			// A task's run is Maestro's spend, whatever agent it names.
			recordSystemOneDecision(decision({ startedAt: now, agentId: 'agent-1', costUsd: 9 }));

			const rows = readSystemOneAgentSpend(now - DAY_MS);

			expect(rows?.map((row) => [row.agentId, row.requests, row.costUsd])).toEqual([
				['agent-2', 1, 1],
				['agent-1', 2, 0.5],
			]);
		});

		it('reads what is there while usage statistics are off: money already spent still counts', () => {
			recordSystemOneDecision(spent({}));
			state.statsEnabled = false;

			expect(readSystemOneAgentSpend(0)).toHaveLength(1);
		});

		it('answers null, not zero, while the database is not open', () => {
			recordSystemOneDecision(spent({}));
			state.ready = false;

			expect(readSystemOneAgentSpend(0)).toBeNull();
		});
	});
});
