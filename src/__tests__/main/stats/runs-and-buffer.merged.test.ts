// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/stats/delegation.test.ts
//   - src/__tests__/main/stats/multi-window-usage.test.ts
//   - src/__tests__/main/stats/query-events-buffer.test.ts
//   - src/__tests__/main/stats/wizard-runs.test.ts

import { getQuerySourceByDay, getQuerySourceTotals } from '../../../main/stats/delegation';
import {
	clearMultiWindowUsageCache,
	getMultiWindowUsage,
	recordWindowOpened,
} from '../../../main/stats/multi-window-usage';
import {
	QUERY_EVENT_BATCH_SIZE,
	QUERY_EVENT_FLUSH_INTERVAL_MS,
	enqueueQueryEvent,
	flushQueryEventsSync,
	getQueryEventBufferSize,
	resetQueryEventBufferForTests,
} from '../../../main/stats/query-events-buffer';
import {
	clearWizardRunsCache,
	getWizardRuns,
	recordWizardRun,
} from '../../../main/stats/wizard-runs';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import type { QueryEvent, WizardRun } from '../../../shared/stats-types';
import type Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === 'userData' ? path.join(os.tmpdir(), 'maestro-test-delegation') : os.tmpdir()
		),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// ===== from src/__tests__/main/stats/delegation.test.ts =====

type Row = Record<string, unknown>;

/** Minimal stand-in for the better-sqlite3 handle these functions use. */
function fakeDb(rows: Row[]) {
	const all = vi.fn(() => rows);
	return {
		db: { prepare: vi.fn(() => ({ all })) } as unknown as Parameters<
			typeof getQuerySourceTotals
		>[0],
		all,
	};
}

describe('getQuerySourceTotals', () => {
	beforeEach(() => vi.clearAllMocks());

	it('splits turns and real summed durations by source', () => {
		const { db } = fakeDb([
			{ source: 'user', count: 12, duration: 60_000 },
			{ source: 'auto', count: 3, duration: 900_000 },
		]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 12, durationMs: 60_000 },
			autoRun: { count: 3, durationMs: 900_000 },
		});
	});

	it('counts an unrecognized source as interactive, never as delegated', () => {
		// A value from a future build must not silently inflate the score the
		// milestone track persists.
		const { db } = fakeDb([{ source: 'something-new', count: 5, duration: 5000 }]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 5, durationMs: 5000 },
			autoRun: { count: 0, durationMs: 0 },
		});
	});

	it('reports zeroes when the window has no rows', () => {
		const { db } = fakeDb([]);
		expect(getQuerySourceTotals(db)).toEqual({
			interactive: { count: 0, durationMs: 0 },
			autoRun: { count: 0, durationMs: 0 },
		});
	});

	it('defaults to every retained row', () => {
		const { db, all } = fakeDb([]);
		getQuerySourceTotals(db);
		expect(all).toHaveBeenCalledWith(0);
	});
});

describe('getQuerySourceByDay', () => {
	beforeEach(() => vi.clearAllMocks());

	it('merges both sources into one row per day, ascending', () => {
		const { db } = fakeDb([
			{ date: '2026-01-02', source: 'auto', count: 1, duration: 500 },
			{ date: '2026-01-01', source: 'user', count: 2, duration: 200 },
			{ date: '2026-01-01', source: 'auto', count: 1, duration: 800 },
		]);
		expect(getQuerySourceByDay(db)).toEqual([
			{
				date: '2026-01-01',
				interactive: { count: 2, durationMs: 200 },
				autoRun: { count: 1, durationMs: 800 },
			},
			{
				date: '2026-01-02',
				interactive: { count: 0, durationMs: 0 },
				autoRun: { count: 1, durationMs: 500 },
			},
		]);
	});

	it('returns an empty series when nothing was recorded', () => {
		const { db } = fakeDb([]);
		expect(getQuerySourceByDay(db)).toEqual([]);
	});
});

// ===== from src/__tests__/main/stats/multi-window-usage.test.ts =====

interface RunCall {
	sql: string;
	params: unknown[];
}

interface GetCall {
	sql: string;
	params: unknown[];
}

/** A fake better-sqlite3 DB capturing prepared SQL + statement calls. */
function makeFakeDb(getResult?: unknown) {
	const runCalls: RunCall[] = [];
	const getCalls: GetCall[] = [];
	const db = {
		prepare: vi.fn((sql: string) => ({
			run: vi.fn((...params: unknown[]) => {
				runCalls.push({ sql, params });
				return { changes: 1 };
			}),
			get: vi.fn((...params: unknown[]) => {
				getCalls.push({ sql, params });
				return getResult;
			}),
		})),
	};
	return { db: db as unknown as Database.Database, runCalls, getCalls };
}

describe('multi-window-usage stats ops', () => {
	beforeEach(() => {
		// The module-level statement cache holds prepared statements keyed by SQL;
		// clear it so each test gets a fresh statement bound to its own fake DB.
		clearMultiWindowUsageCache();
	});

	describe('recordWindowOpened', () => {
		it('buckets the timestamp into a local YYYY-MM-DD date and UPSERTs (date, count)', () => {
			const { db, runCalls } = makeFakeDb();
			// Construct via local-time fields so the bucket is timezone-independent.
			const openedAt = new Date(2026, 5, 23, 10, 30, 0).getTime();

			const date = recordWindowOpened(db, openedAt, 3);

			expect(date).toBe('2026-06-23');
			expect(runCalls).toHaveLength(1);
			expect(runCalls[0].params).toEqual(['2026-06-23', 3]);
		});

		it('issues an UPSERT that increments the count and raises the peak high-water mark', () => {
			const { db, runCalls } = makeFakeDb();
			recordWindowOpened(db, new Date(2026, 0, 1, 0, 0, 0).getTime(), 2);

			const sql = runCalls[0].sql;
			expect(sql).toContain('INSERT INTO multi_window_usage_daily');
			expect(sql).toContain('ON CONFLICT(date) DO UPDATE');
			expect(sql).toContain('windows_opened = windows_opened + 1');
			expect(sql).toContain('peak_concurrent = MAX(peak_concurrent, excluded.peak_concurrent)');
		});

		it('passes the supplied concurrent window count through as the peak candidate', () => {
			const { db, runCalls } = makeFakeDb();
			recordWindowOpened(db, new Date(2026, 5, 23).getTime(), 5);
			expect(runCalls[0].params[1]).toBe(5);
		});
	});

	describe('getMultiWindowUsage', () => {
		it('maps the aggregate row to { windowsOpened, peakConcurrent }', () => {
			const { db, getCalls } = makeFakeDb({ windowsOpened: 12, peakConcurrent: 4 });

			const result = getMultiWindowUsage(db, 'week');

			expect(result).toEqual({ windowsOpened: 12, peakConcurrent: 4 });
			expect(getCalls).toHaveLength(1);
			expect(getCalls[0].sql).toContain('SUM(windows_opened)');
			expect(getCalls[0].sql).toContain('MAX(peak_concurrent)');
		});

		it('returns zeros when there is no activity in the range (undefined row)', () => {
			const { db } = makeFakeDb(undefined);
			expect(getMultiWindowUsage(db, 'month')).toEqual({ windowsOpened: 0, peakConcurrent: 0 });
		});

		it("queries with the all-time lower bound '0000-01-01' for range 'all'", () => {
			const { db, getCalls } = makeFakeDb({ windowsOpened: 1, peakConcurrent: 2 });
			getMultiWindowUsage(db, 'all');
			expect(getCalls[0].params).toEqual(['0000-01-01']);
		});
	});
});

// ===== from src/__tests__/main/stats/query-events-buffer.test.ts =====

interface MockStatement {
	run: ReturnType<typeof vi.fn>;
}

interface MockTransactionFactory {
	(fn: () => void): () => void;
}

interface MockDb {
	open: boolean;
	prepare: ReturnType<typeof vi.fn>;
	transaction: MockTransactionFactory;
}

/**
 * Fake that reproduces the two better-sqlite3 rules this module depends on:
 * a `Database` exposes a boolean `open`, and once it is closed every operation
 * throws `TypeError: The database connection is not open`. A mock that ignored
 * `open` and happily ran statements against a closed handle would stay green
 * through exactly the shutdown race MAESTRO-ZC reported from the field.
 */
function makeMockDb(): { db: MockDb; stmt: MockStatement; runs: unknown[][] } {
	const runs: unknown[][] = [];
	const assertOpen = () => {
		if (!db.open) throw new TypeError('The database connection is not open');
	};
	const stmt: MockStatement = {
		run: vi.fn((...args: unknown[]) => {
			assertOpen();
			runs.push(args);
		}),
	};
	const db: MockDb = {
		open: true,
		prepare: vi.fn(() => {
			assertOpen();
			return stmt;
		}),
		transaction: ((fn: () => void) => () => {
			assertOpen();
			fn();
		}) as MockTransactionFactory,
	};
	return { db, stmt, runs };
}

const sampleEvent: Omit<QueryEvent, 'id'> = {
	sessionId: 's1',
	agentType: 'claude-code',
	source: 'user',
	startTime: 1000,
	duration: 500,
	projectPath: '/p',
	tabId: 't1',
	isRemote: false,
};

describe('query-events-buffer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetQueryEventBufferForTests();
		vi.mocked(captureException).mockClear();
		vi.mocked(logger.warn).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('buffers a single event without writing immediately', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);

		expect(getQueryEventBufferSize()).toBe(1);
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('returns a generated id synchronously', () => {
		const { db } = makeMockDb();
		const id = enqueueQueryEvent(db as never, sampleEvent);

		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
	});

	it('flushes to the DB after the timer interval elapses', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		expect(stmt.run).not.toHaveBeenCalled();

		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS);

		expect(stmt.run).toHaveBeenCalledTimes(1);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('flushes when the batch threshold is reached, before the timer fires', () => {
		const { db, stmt } = makeMockDb();
		for (let i = 0; i < QUERY_EVENT_BATCH_SIZE; i++) {
			enqueueQueryEvent(db as never, sampleEvent);
		}

		// Threshold-flush should happen synchronously inside the last enqueue.
		expect(stmt.run).toHaveBeenCalledTimes(QUERY_EVENT_BATCH_SIZE);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('wraps the batch in a single transaction', () => {
		const { db, stmt } = makeMockDb();
		const txSpy = vi.fn(((fn: () => void) => () => fn()) as MockTransactionFactory);
		db.transaction = txSpy;

		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		expect(txSpy).toHaveBeenCalledTimes(1);
		expect(stmt.run).toHaveBeenCalledTimes(3);
	});

	it('explicit flushQueryEventsSync drains the buffer immediately', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);
		expect(stmt.run).not.toHaveBeenCalled();

		flushQueryEventsSync();

		expect(stmt.run).toHaveBeenCalledTimes(2);
		expect(getQueryEventBufferSize()).toBe(0);
	});

	it('flushQueryEventsSync is a no-op when buffer is empty', () => {
		const { db, stmt } = makeMockDb();
		// Establish a DB reference but no events
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();
		stmt.run.mockClear();

		flushQueryEventsSync();

		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('flushQueryEventsSync clears the pending timer', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		// Advancing time past the flush interval should NOT fire another flush
		// (no events buffered, no timer scheduled).
		stmt.run.mockClear();
		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS * 2);
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('schedules at most one timer for a stream of fast enqueues', () => {
		const { db, stmt } = makeMockDb();
		for (let i = 0; i < 5; i++) {
			enqueueQueryEvent(db as never, sampleEvent);
		}
		// One timer pending - advancing past the interval flushes everything.
		vi.advanceTimersByTime(QUERY_EVENT_FLUSH_INTERVAL_MS);
		expect(stmt.run).toHaveBeenCalledTimes(5);
	});

	it('drops events on flush failure rather than retrying', () => {
		const { db, stmt } = makeMockDb();
		// Make the transaction throw on first run.
		db.transaction = (() => () => {
			throw new Error('disk full');
		}) as MockTransactionFactory;

		enqueueQueryEvent(db as never, sampleEvent);
		enqueueQueryEvent(db as never, sampleEvent);

		expect(() => flushQueryEventsSync()).not.toThrow();
		// Buffer was cleared even though the transaction failed.
		expect(getQueryEventBufferSize()).toBe(0);
		// Subsequent flush is a no-op (buffer empty).
		flushQueryEventsSync();
		expect(stmt.run).not.toHaveBeenCalled();
	});

	it('passes the correct field shape to stmt.run', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		expect(stmt.run).toHaveBeenCalledTimes(1);
		const args = stmt.run.mock.calls[0];
		// 16 columns: the 10 identity/timing/flag columns, the Web Login
		// sender, plus the five token and cost columns. This used to be 9 -
		// the buffered statement had silently dropped is_worktree, so every
		// interactive turn wrote NULL there while the direct insert path
		// wrote the real flag.
		expect(args).toHaveLength(16);
		// args[0] is the generated id; args[1..] mirror the event fields.
		expect(args[1]).toBe('s1');
		expect(args[2]).toBe('claude-code');
		expect(args[3]).toBe('user');
		expect(args[4]).toBe(1000);
		expect(args[5]).toBe(500);
		expect(args[6]).toBe('/p');
		expect(args[7]).toBe('t1');
		expect(args[8]).toBe(0); // isRemote false → 0
	});

	it('carries is_worktree through the buffer', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, { ...sampleEvent, isWorktree: true });
		flushQueryEventsSync();

		expect(stmt.run.mock.calls[0][9]).toBe(1);
	});

	it('writes NULL token columns for a turn that reported no usage', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, sampleEvent);
		flushQueryEventsSync();

		// NULL rather than 0 - an unreported turn is not a free turn. Index 10
		// is the sender, which is NULL for a turn typed at the desktop.
		expect(stmt.run.mock.calls[0].slice(11)).toEqual([null, null, null, null, null]);
	});

	it('carries per-turn token and cost values through the buffer', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, {
			...sampleEvent,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 900,
			cacheCreationTokens: 5,
			costUsd: 0.75,
		});
		flushQueryEventsSync();

		expect(stmt.run.mock.calls[0].slice(11)).toEqual([100, 20, 900, 5, 0.75]);
	});

	it('encodes isRemote=true as 1 and missing tabId as null', () => {
		const { db, stmt } = makeMockDb();
		enqueueQueryEvent(db as never, {
			...sampleEvent,
			isRemote: true,
			tabId: undefined,
		});
		flushQueryEventsSync();

		const args = stmt.run.mock.calls[0];
		expect(args[7]).toBe(null);
		expect(args[8]).toBe(1);
	});

	it('handles undefined isRemote as null', () => {
		const { db, stmt } = makeMockDb();
		const eventWithoutRemote = { ...sampleEvent };
		delete (eventWithoutRemote as { isRemote?: unknown }).isRemote;
		enqueueQueryEvent(db as never, eventWithoutRemote);
		flushQueryEventsSync();

		const args = stmt.run.mock.calls[0];
		expect(args[8]).toBe(null);
	});

	it('survives a DB reference change between flushes', () => {
		const first = makeMockDb();
		const second = makeMockDb();

		enqueueQueryEvent(first.db as never, sampleEvent);
		flushQueryEventsSync();
		expect(first.stmt.run).toHaveBeenCalledTimes(1);

		// New DB reference - buffer module clears its statement cache and
		// prepares against the new DB.
		enqueueQueryEvent(second.db as never, sampleEvent);
		flushQueryEventsSync();
		expect(second.stmt.run).toHaveBeenCalledTimes(1);
		expect(first.stmt.run).toHaveBeenCalledTimes(1);
	});

	it('does not flush before any enqueue establishes a DB reference', () => {
		// No enqueue has happened, so flush has no DB to write to.
		expect(() => flushQueryEventsSync()).not.toThrow();
	});

	// MAESTRO-ZC: `closeStatsDB()` runs inside the quit handler's `before-quit`
	// listener, which re-enters `app.quit()`; the re-emitted `before-quit` then
	// ran this module's flush listener against an already-closed connection.
	// better-sqlite3 threw, and the catch reported it to Sentry as a crash.
	describe('flushing after the stats DB was closed (MAESTRO-ZC)', () => {
		it('does not report the closed connection to Sentry', () => {
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;
			flushQueryEventsSync();

			expect(captureException).not.toHaveBeenCalled();
		});

		it('drops the batch without throwing, and empties the buffer', () => {
			const { db, stmt } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;

			expect(() => flushQueryEventsSync()).not.toThrow();
			expect(stmt.run).not.toHaveBeenCalled();
			expect(getQueryEventBufferSize()).toBe(0);
		});

		it('logs the dropped count so the loss is not silent', () => {
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);
			enqueueQueryEvent(db as never, sampleEvent);

			db.open = false;
			flushQueryEventsSync();

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('already closed'),
				expect.anything(),
				expect.objectContaining({ count: 3 })
			);
		});

		it('still reports genuinely unexpected write failures to Sentry', () => {
			// The carve-out is for a closed handle only - a real write fault on an
			// open connection (disk full, corruption) must keep paging.
			const { db, stmt } = makeMockDb();
			stmt.run.mockImplementationOnce(() => {
				throw new Error('database disk image is malformed');
			});
			enqueueQueryEvent(db as never, sampleEvent);

			flushQueryEventsSync();

			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('swallows a statement-preparation failure instead of aborting the caller', () => {
			// `StatsDB.close()` calls this during quit cleanup, so an exception that
			// escapes the flush skips the `db.close()` and the `initialized = false`
			// that follow it. A prepare can still fail on a handle that reports
			// `open` (damaged schema, disk fault), so it has to sit inside the same
			// error boundary as the transaction.
			const { db } = makeMockDb();
			enqueueQueryEvent(db as never, sampleEvent);
			db.prepare.mockImplementationOnce(() => {
				throw new Error('no such table: query_events');
			});

			expect(() => flushQueryEventsSync()).not.toThrow();
			expect(getQueryEventBufferSize()).toBe(0);
			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});

// ===== from src/__tests__/main/stats/wizard-runs.test.ts =====

const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(),
	all: vi.fn(() => [] as unknown[]),
};

const mockDb = {
	prepare: vi.fn(() => mockStatement),
} as unknown as Database.Database;

const baseRun: WizardRun = {
	id: 'run-1',
	sessionId: 'session-1',
	agentType: 'claude-code',
	surface: 'inline',
	mode: 'new',
	outcome: 'generated',
	startedAt: 1_000,
	endedAt: 61_000,
	exchanges: 4,
	documents: 2,
	tasks: 17,
	activeMs: 42_000,
	projectPath: '/Users/pedram/Projects/Maestro',
};

describe('wizard-runs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearWizardRunsCache();
		mockStatement.all.mockReturnValue([]);
	});

	describe('recordWizardRun', () => {
		it('binds every column in schema order and returns the caller-supplied id', () => {
			const id = recordWizardRun(mockDb, baseRun);

			expect(id).toBe('run-1');
			expect(mockStatement.run).toHaveBeenCalledWith(
				'run-1',
				'session-1',
				'claude-code',
				'inline',
				'new',
				'generated',
				1_000,
				61_000,
				4,
				2,
				17,
				'/Users/pedram/Projects/Maestro',
				42_000
			);
		});

		it('uses INSERT OR REPLACE so a milestone re-flush overwrites rather than duplicates', () => {
			recordWizardRun(mockDb, baseRun);
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			expect(sql).toContain('INSERT OR REPLACE INTO wizard_runs');
		});

		it('stores a missing project path as NULL rather than the string "undefined"', () => {
			recordWizardRun(mockDb, { ...baseRun, projectPath: undefined });
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				null,
				expect.anything()
			);
		});

		it('stores a run with no measured active time as NULL, not 0', () => {
			recordWizardRun(mockDb, { ...baseRun, activeMs: undefined });
			const args = mockStatement.run.mock.calls[0] as unknown[];
			expect(args[12]).toBeNull();
		});
	});

	describe('getWizardRuns', () => {
		it('maps snake_case rows back to the WizardRun shape', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'run-2',
					session_id: 'session-2',
					agent_type: 'codex',
					surface: 'onboarding',
					mode: 'iterate',
					outcome: 'in-progress',
					started_at: 5,
					ended_at: 9,
					exchanges: 1,
					documents: 0,
					tasks: 0,
					project_path: '/tmp/project',
					active_ms: 3,
				},
			]);

			expect(getWizardRuns(mockDb, 'week')).toEqual([
				{
					id: 'run-2',
					sessionId: 'session-2',
					agentType: 'codex',
					surface: 'onboarding',
					mode: 'iterate',
					outcome: 'in-progress',
					startedAt: 5,
					endedAt: 9,
					exchanges: 1,
					documents: 0,
					tasks: 0,
					projectPath: '/tmp/project',
					activeMs: 3,
				},
			]);
		});

		it('turns a NULL project path into undefined, not null', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'run-3',
					session_id: '',
					agent_type: 'claude-code',
					surface: 'inline',
					mode: 'new',
					outcome: 'abandoned',
					started_at: 1,
					ended_at: 2,
					exchanges: 0,
					documents: 0,
					tasks: 0,
					project_path: null,
					active_ms: null,
				},
			]);

			expect(getWizardRuns(mockDb, 'all')[0].projectPath).toBeUndefined();
		});

		it('turns a NULL active time into undefined so untimed rows stay distinguishable from 0', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'run-4',
					session_id: '',
					agent_type: 'claude-code',
					surface: 'inline',
					mode: 'new',
					outcome: 'generated',
					started_at: 1,
					ended_at: 2,
					exchanges: 0,
					documents: 1,
					tasks: 1,
					project_path: null,
					active_ms: null,
				},
			]);

			expect(getWizardRuns(mockDb, 'all')[0].activeMs).toBeUndefined();
		});

		it('filters by start time so the dashboard time range is honored', () => {
			getWizardRuns(mockDb, 'all');
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			expect(sql).toContain('WHERE started_at >= ?');
			expect(mockStatement.all).toHaveBeenCalledWith(0);
		});
	});
});
