// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/stats/data-management.test.ts
//   - src/__tests__/main/stats/query-event-insert.test.ts
//   - src/__tests__/main/stats/usage-export.test.ts

import type { CueEventRecord } from '../../../main/cue/cue-db';
import { INSERT_QUERY_EVENT_SQL, bindQueryEvent } from '../../../main/stats/query-event-insert';
import {
	USAGE_EXPORT_VERSION,
	buildUsageExport,
	countUsageExportRows,
	rowsToCsv,
	usageExportToCsvFiles,
} from '../../../main/stats/usage-export';
import type { UsageExportStatsSource } from '../../../main/stats/usage-export';
import type {
	AutoRunSession,
	AutoRunTask,
	QueryEvent,
	SessionLifecycleEvent,
	StatsAggregation,
	StatsFilters,
	StatsTimeRange,
} from '../../../shared/stats-types';
import type { TokenUsageAggregate } from '../../../shared/tokenUsage';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(dbPath: string) {
				lastDbPath = dbPath;
			}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));
vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockFsMkdirSync(...args),
	copyFileSync: (...args: unknown[]) => mockFsCopyFileSync(...args),
	unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
	renameSync: (...args: unknown[]) => mockFsRenameSync(...args),
	statSync: (...args: unknown[]) => mockFsStatSync(...args),
	readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// ===== from src/__tests__/main/stats/data-management.test.ts =====

// Track Database constructor calls to verify file path
let lastDbPath: string | null = null;

// Store mock references so they can be accessed in tests
const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ count: 0, total_duration: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	// Transaction mock that immediately executes the function
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

// Mock electron's app module with trackable userData path
const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-stats-db');

// Track fs calls
const mockFsExistsSync = vi.fn(() => true);

const mockFsMkdirSync = vi.fn();

const mockFsCopyFileSync = vi.fn();

const mockFsUnlinkSync = vi.fn();

const mockFsRenameSync = vi.fn();

const mockFsStatSync = vi.fn(() => ({ size: 1024 }));

const mockFsReadFileSync = vi.fn(() => '0');
// Default: old timestamp (triggers vacuum check)
const mockFsWriteFileSync = vi.fn();

describe('Database VACUUM functionality', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
		// Reset statSync to throw by default (simulates file not existing)
		mockFsStatSync.mockImplementation(() => {
			throw new Error('ENOENT: no such file or directory');
		});
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('getDatabaseSize', () => {
		it('should return 0 when statSync throws (file missing)', async () => {
			// The mock fs.statSync is not configured to return size by default
			// so getDatabaseSize will catch the error and return 0
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Since mockFsExistsSync.mockReturnValue(true) is set but statSync is not mocked,
			// getDatabaseSize will try to call the real statSync on a non-existent path
			// and catch the error, returning 0
			const size = db.getDatabaseSize();

			// The mock environment doesn't have actual file, so expect 0
			expect(size).toBe(0);
		});

		it('should handle statSync gracefully when file does not exist', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// getDatabaseSize should not throw
			expect(() => db.getDatabaseSize()).not.toThrow();
		});
	});

	describe('vacuum', () => {
		it('should execute VACUUM SQL command', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should return success true when vacuum completes', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should return bytesFreed of 0 when sizes are equal (mocked)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			// With mock fs, both before and after sizes will be 0
			expect(result.bytesFreed).toBe(0);
		});

		it('should return error if database not initialized', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			// Don't initialize

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.bytesFreed).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should handle VACUUM failure gracefully', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Make VACUUM fail
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.error).toContain('database is locked');
		});

		it('should log vacuum progress with size information', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.info).mockClear();

			db.vacuum();

			// Check that logger was called with vacuum-related messages
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Starting VACUUM'),
				expect.any(String)
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('VACUUM completed'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded', () => {
		it('should skip vacuum if database size is 0 (below threshold)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuumIfNeeded();

			// Size is 0 (mock fs), which is below 100MB threshold
			expect(result.vacuumed).toBe(false);
			expect(result.databaseSize).toBe(0);
			expect(result.result).toBeUndefined();
		});

		it('should return correct databaseSize in result', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			// Size property should be present
			expect(typeof result.databaseSize).toBe('number');
		});

		it('should use default 100MB threshold when not specified', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// With 0 byte size (mocked), should skip vacuum
			const result = db.vacuumIfNeeded();

			expect(result.vacuumed).toBe(false);
		});

		it('should not vacuum with threshold 0 and size 0 since 0 is not > 0', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 0 threshold and 0 byte file: 0 is NOT greater than 0
			const result = db.vacuumIfNeeded(0);

			// The condition is: databaseSize < thresholdBytes
			// 0 < 0 is false, so vacuumed should be true (it tries to vacuum)
			expect(result.databaseSize).toBe(0);
			// Since 0 is NOT less than 0, it proceeds to vacuum
			expect(result.vacuumed).toBe(true);
		});

		it('should log appropriate message when skipping vacuum', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.debug).mockClear();

			db.vacuumIfNeeded();

			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded with custom thresholds', () => {
		it('should respect custom threshold parameter (threshold = -1 means always vacuum)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With -1 threshold, 0 > -1 is true, so should vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
		});

		it('should not vacuum with very large threshold', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 1TB threshold, should NOT trigger vacuum
			const result = db.vacuumIfNeeded(1024 * 1024 * 1024 * 1024);

			expect(result.vacuumed).toBe(false);
			expect(mockDb.prepare).not.toHaveBeenCalledWith('VACUUM');
		});
	});

	describe('initialize with vacuumIfNeeded integration', () => {
		it('should call vacuumIfNeededWeekly during initialization', async () => {
			const { logger } = await import('../../../main/utils/logger');

			// Clear logger mocks before test
			vi.mocked(logger.debug).mockClear();

			// Mock timestamp file as old (0 = epoch, triggers vacuum check)
			mockFsReadFileSync.mockReturnValue('0');

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			db.initialize();

			// With old timestamp, vacuumIfNeededWeekly should proceed to call vacuumIfNeeded
			// which logs "below vacuum threshold" for small databases (mocked as 1024 bytes)
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});

		it('should complete initialization even if vacuum would fail', async () => {
			// Make VACUUM fail if called
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('VACUUM failed: database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Initialize should not throw (vacuum is skipped due to 0 size anyway)
			expect(() => db.initialize()).not.toThrow();

			// Database should still be ready
			expect(db.isReady()).toBe(true);
		});

		it('should not block initialization for small databases', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Time the initialization (should be fast for mock)
			const start = Date.now();
			db.initialize();
			const elapsed = Date.now() - start;

			expect(db.isReady()).toBe(true);
			expect(elapsed).toBeLessThan(1000); // Should be fast in mock environment
		});
	});

	describe('vacuum return types', () => {
		it('vacuum should return object with success, bytesFreed, and optional error', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.bytesFreed).toBe('number');
			expect(result.error === undefined || typeof result.error === 'string').toBe(true);
		});

		it('vacuumIfNeeded should return object with vacuumed, databaseSize, and optional result', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			expect(typeof result.vacuumed).toBe('boolean');
			expect(typeof result.databaseSize).toBe('number');
			expect(result.result === undefined || typeof result.result === 'object').toBe(true);
		});

		it('vacuumIfNeeded should include result when vacuum is performed', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Use -1 threshold to force vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(result.result).toBeDefined();
			expect(result.result?.success).toBe(true);
		});
	});

	describe('clearOldData method', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.resetModules();
		});

		it('should return error when database is not initialized', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			// Don't initialize

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should return error when olderThanDays is 0 or negative', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const resultZero = db.clearOldData(0);
			expect(resultZero.success).toBe(false);
			expect(resultZero.error).toBe('olderThanDays must be greater than 0');

			const resultNegative = db.clearOldData(-10);
			expect(resultNegative.success).toBe(false);
			expect(resultNegative.error).toBe('olderThanDays must be greater than 0');
		});

		it('should successfully clear old data with valid parameters', async () => {
			// Mock prepare to return statements with expected behavior
			mockStatement.all.mockReturnValue([{ id: 'session-1' }, { id: 'session-2' }]);
			mockStatement.run.mockReturnValue({ changes: 5 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(5);
			expect(result.deletedAutoRunSessions).toBe(5);
			expect(result.deletedAutoRunTasks).toBe(5);
			expect(result.error).toBeUndefined();
		});

		it('should handle empty results (no old data)', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(365);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBeUndefined();
		});

		it('should calculate correct cutoff time based on days', async () => {
			let capturedCutoffTime: number | null = null;

			mockDb.prepare.mockImplementation((sql: string) => {
				return {
					run: vi.fn((cutoff: number) => {
						if (sql.includes('DELETE FROM query_events')) {
							capturedCutoffTime = cutoff;
						}
						return { changes: 0 };
					}),
					get: mockStatement.get,
					all: vi.fn(() => []),
				};
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const beforeCall = Date.now();
			db.clearOldData(7);
			const afterCall = Date.now();

			// Cutoff should be approximately 7 days ago
			const expectedCutoff = beforeCall - 7 * 24 * 60 * 60 * 1000;
			expect(capturedCutoffTime).not.toBeNull();
			expect(capturedCutoffTime!).toBeGreaterThanOrEqual(expectedCutoff - 1000);
			expect(capturedCutoffTime!).toBeLessThanOrEqual(afterCall - 7 * 24 * 60 * 60 * 1000 + 1000);
		});

		it('should handle database errors gracefully', async () => {
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql.includes('DELETE FROM query_events')) {
					return {
						run: vi.fn(() => {
							throw new Error('Database locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Database locked');
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
		});

		it('should support various time periods', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Test common time periods from Settings UI
			const periods = [7, 30, 90, 180, 365];
			for (const days of periods) {
				const result = db.clearOldData(days);
				expect(result.success).toBe(true);
			}
		});
	});

	// =====================================================================
});

// ===== from src/__tests__/main/stats/query-event-insert.test.ts =====

/** Column names from the generated INSERT, in declared order. */
function insertColumns(): string[] {
	const match = INSERT_QUERY_EVENT_SQL.match(/\(([^)]*)\)\s*VALUES/);
	if (!match) throw new Error('INSERT_QUERY_EVENT_SQL is not shaped as expected');
	return match[1].split(',').map((c) => c.trim());
}

const FULL_EVENT: Omit<QueryEvent, 'id'> = {
	sessionId: 'session-1',
	agentType: 'claude-code',
	source: 'user',
	startTime: 1_700_000_000_000,
	duration: 4200,
	projectPath: 'C:\\Users\\test\\proj',
	tabId: 'tab-1',
	isRemote: true,
	isWorktree: true,
	userName: 'pedram',
	inputTokens: 1000,
	outputTokens: 250,
	cacheReadTokens: 900,
	cacheCreationTokens: 80,
	costUsd: 0.42,
};

describe('INSERT_QUERY_EVENT_SQL', () => {
	it('binds exactly one placeholder per column', () => {
		const columns = insertColumns();
		const placeholders = INSERT_QUERY_EVENT_SQL.match(/VALUES\s*\(([^)]*)\)/)?.[1]
			.split(',')
			.map((p) => p.trim());

		expect(placeholders).toHaveLength(columns.length);
		expect(new Set(placeholders)).toEqual(new Set(['?']));
	});

	it('includes the columns that were lost to drift', () => {
		expect(insertColumns()).toEqual(
			expect.arrayContaining([
				'is_worktree',
				'user_name',
				'input_tokens',
				'output_tokens',
				'cache_read_tokens',
				'cache_creation_tokens',
				'cost_usd',
			])
		);
	});

	it('produces a bind array the same length as the column list', () => {
		expect(bindQueryEvent('id-1', FULL_EVENT)).toHaveLength(insertColumns().length);
	});
});

describe('bindQueryEvent', () => {
	it('binds every value in column order', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-1', FULL_EVENT);
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row).toEqual({
			id: 'id-1',
			session_id: 'session-1',
			agent_type: 'claude-code',
			source: 'user',
			start_time: 1_700_000_000_000,
			duration: 4200,
			// Backslashes are normalized so a Windows path groups with its
			// posix-recorded twin.
			project_path: 'C:/Users/test/proj',
			tab_id: 'tab-1',
			is_remote: 1,
			is_worktree: 1,
			user_name: 'pedram',
			input_tokens: 1000,
			output_tokens: 250,
			cache_read_tokens: 900,
			cache_creation_tokens: 80,
			cost_usd: 0.42,
		});
	});

	it('writes NULL, not 0, for a turn that reported no usage', () => {
		// A turn whose provider said nothing is not a free turn. The aggregation
		// counts priced queries by testing for NULL, so a zero here would make
		// every historical row look like a recorded $0.00.
		const columns = insertColumns();
		const values = bindQueryEvent('id-2', {
			sessionId: 'session-2',
			agentType: 'codex',
			source: 'auto',
			startTime: 1,
			duration: 2,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.input_tokens).toBeNull();
		expect(row.output_tokens).toBeNull();
		expect(row.cache_read_tokens).toBeNull();
		expect(row.cache_creation_tokens).toBeNull();
		expect(row.cost_usd).toBeNull();
	});

	it('writes a real zero when the provider reported zero', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-3', {
			sessionId: 'session-3',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.input_tokens).toBe(0);
		expect(row.cost_usd).toBe(0);
	});

	it('distinguishes an absent boolean flag from false', () => {
		const columns = insertColumns();
		const absent = Object.fromEntries(
			columns.map((c, i) => [
				c,
				bindQueryEvent('id-4', {
					sessionId: 's',
					agentType: 'codex',
					source: 'user',
					startTime: 1,
					duration: 2,
				})[i],
			])
		);
		const explicit = Object.fromEntries(
			columns.map((c, i) => [
				c,
				bindQueryEvent('id-5', {
					sessionId: 's',
					agentType: 'codex',
					source: 'user',
					startTime: 1,
					duration: 2,
					isRemote: false,
					isWorktree: false,
				})[i],
			])
		);

		expect(absent.is_remote).toBeNull();
		expect(absent.is_worktree).toBeNull();
		expect(explicit.is_remote).toBe(0);
		expect(explicit.is_worktree).toBe(0);
	});

	it('nulls an omitted project path and tab id', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-6', {
			sessionId: 's',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.project_path).toBeNull();
		expect(row.tab_id).toBeNull();
	});

	it('nulls the sender for a turn typed at the desktop', () => {
		// NULL means "nobody was signed in", which is a different fact from an
		// account named the empty string - the "by user" breakdown counts on it.
		const columns = insertColumns();
		const values = bindQueryEvent('id-7', {
			sessionId: 's',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.user_name).toBeNull();
	});
});

// ===== from src/__tests__/main/stats/usage-export.test.ts =====

const T = Date.UTC(2026, 8, 10, 12, 0, 0);

const T_ISO = '2026-09-10T12:00:00.000Z';

function fakeDb(): UsageExportStatsSource {
	return {
		getAggregatedStats: vi.fn(() => ({ totalQueries: 1 }) as unknown as StatsAggregation),
		getQueryEvents: vi.fn(() => [
			{
				id: 'q-1',
				sessionId: 's-1',
				agentType: 'claude-code',
				source: 'user' as const,
				startTime: T,
				duration: 1500,
				projectPath: '/work/"quoted", project',
				costUsd: 0.25,
			},
		]),
		getAutoRunSessions: vi.fn(() => [
			{ id: 'ar-1', sessionId: 's-1', agentType: 'codex', startTime: T, duration: 60 },
			{ id: 'ar-2', sessionId: 's-2', agentType: 'codex', startTime: T, duration: 30 },
		]),
		getAutoRunTasks: vi.fn((id: string) =>
			id === 'ar-1'
				? [
						{
							id: 't-1',
							autoRunSessionId: 'ar-1',
							sessionId: 's-1',
							agentType: 'codex',
							taskIndex: 0,
							taskContent: 'line one\nline two',
							startTime: T,
							duration: 20,
							success: true,
						},
					]
				: []
		),
		getSessionLifecycleEvents: vi.fn(() => []),
		getResilienceEvents: vi.fn(() => []),
		getWizardRuns: vi.fn(() => []),
		getShortcutUsageByDay: vi.fn(() => [{ date: '2026-09-10', count: 4 }]),
		getMultiWindowUsage: vi.fn(() => ({ windowsOpened: 2, peakConcurrent: 3 })),
	};
}

const cueEvent: CueEventRecord = {
	id: 'cue-1',
	type: 'time.heartbeat',
	triggerName: 'hourly',
	sessionId: 's-1',
	subscriptionName: 'digest',
	status: 'completed',
	createdAt: T,
	completedAt: T + 1000,
	payload: '{"a":1}',
};

const tokenUsage = {
	totals: {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0.1,
		costEstimated: false,
		sessionCount: 1,
	},
	byAgent: [],
	byModel: [],
	byProject: [],
	byAccount: [],
	timeline: [],
} as unknown as TokenUsageAggregate;

describe('buildUsageExport', () => {
	it('collects every table for the range and flattens Auto Run tasks across sessions', () => {
		const db = fakeDb();
		const bundle = buildUsageExport({
			db,
			range: 'week',
			sinceMs: T,
			appVersion: '1.2.3',
			cueEvents: null,
			tokenUsage: null,
			notes: ['a note'],
			now: T,
		});

		expect(bundle.exportVersion).toBe(USAGE_EXPORT_VERSION);
		expect(bundle.exportedAt).toBe(T_ISO);
		expect(bundle.rangeStart).toBe(T_ISO);
		expect(bundle.queryEvents).toHaveLength(1);
		expect(bundle.autoRunSessions).toHaveLength(2);
		expect(bundle.autoRunTasks.map((task) => task.id)).toEqual(['t-1']);
		expect(db.getAutoRunTasks).toHaveBeenCalledTimes(2);
		expect(db.getWizardRuns).toHaveBeenCalledWith('week');
		expect(bundle.multiWindowUsage).toEqual({ windowsOpened: 2, peakConcurrent: 3 });
		expect(bundle.notes).toEqual(['a note']);
	});

	it('reports no range start for all time', () => {
		const bundle = buildUsageExport({
			db: fakeDb(),
			range: 'all',
			sinceMs: 0,
			appVersion: '1.2.3',
			cueEvents: null,
			tokenUsage: null,
			notes: [],
		});
		expect(bundle.rangeStart).toBeNull();
	});
});

describe('countUsageExportRows', () => {
	const base = {
		db: fakeDb(),
		range: 'week' as const,
		sinceMs: T,
		appVersion: '1.2.3',
		notes: [],
	};

	it('leaves Cue and token tables out when they were not collected', () => {
		const counts = countUsageExportRows(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		expect(counts['query-events']).toBe(1);
		expect(counts['auto-run-tasks']).toBe(1);
		expect(counts).not.toHaveProperty('cue-events');
		expect(counts).not.toHaveProperty('token-usage-by-agent');
	});

	it('counts Cue runs and token tables when present, including zero rows', () => {
		const counts = countUsageExportRows(
			buildUsageExport({ ...base, cueEvents: [cueEvent], tokenUsage })
		);
		expect(counts['cue-events']).toBe(1);
		expect(counts['token-usage-by-agent']).toBe(0);
	});
});

describe('rowsToCsv', () => {
	it('keeps the header for an empty table', () => {
		expect(rowsToCsv([] as { date: string; count: number }[], ['date', 'count'])).toBe(
			'date,count'
		);
	});

	it('escapes quotes, commas, and newlines, and writes timestamps as ISO time', () => {
		const csv = rowsToCsv(
			[{ id: 'x', startTime: T, note: 'say "hi", then\nleave', missing: undefined as unknown }],
			['id', 'startTime', 'note', 'missing']
		);
		expect(csv).toBe(`id,startTime,note,missing\n"x","${T_ISO}","say ""hi"", then\nleave",""`);
	});

	it('serializes nested values as JSON', () => {
		expect(rowsToCsv([{ meta: { a: 1 } }], ['meta'])).toBe('meta\n"{""a"":1}"');
	});
});

describe('usageExportToCsvFiles', () => {
	const base = {
		db: fakeDb(),
		range: 'month' as const,
		sinceMs: T,
		appVersion: '1.2.3',
		notes: ['Cue keeps 7 days of run history.'],
		now: T,
	};

	it('writes one CSV per table plus export-info.json', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		expect(files.map((file) => file.name)).toEqual([
			'query-events.csv',
			'auto-run-sessions.csv',
			'auto-run-tasks.csv',
			'session-lifecycle.csv',
			'resilience-events.csv',
			'wizard-runs.csv',
			'shortcut-usage-by-day.csv',
			'multi-window-usage.csv',
			'export-info.json',
		]);
		const info = JSON.parse(files.at(-1)!.content);
		expect(info).toMatchObject({
			appVersion: '1.2.3',
			range: 'month',
			notes: ['Cue keeps 7 days of run history.'],
			aggregation: { totalQueries: 1 },
			tokenUsageTotals: null,
		});
		expect(info.rowCounts['query-events']).toBe(1);
	});

	it('adds Cue and token files when that data was collected', () => {
		const names = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: [cueEvent], tokenUsage })
		).map((file) => file.name);
		expect(names).toContain('cue-events.csv');
		expect(names).toContain('token-usage-by-model.csv');
		expect(names).toContain('token-usage-timeline.csv');
	});

	it('includes token and cost columns on query events', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		const [header, row] = files[0].content.split('\n');
		expect(header).toBe(
			'id,sessionId,agentType,source,startTime,duration,projectPath,tabId,isRemote,isWorktree,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,costUsd'
		);
		expect(row).toContain(`"${T_ISO}"`);
		expect(row).toContain('"/work/""quoted"", project"');
		expect(row.endsWith('"0.25"')).toBe(true);
	});
});
