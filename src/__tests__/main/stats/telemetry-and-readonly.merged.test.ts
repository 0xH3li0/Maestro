// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/stats/multi-window-telemetry.test.ts
//   - src/__tests__/main/stats/readonly-query.test.ts

import { wireMultiWindowTelemetry } from '../../../main/stats/multi-window-telemetry';
import { runReadonlyStatsQuery } from '../../../main/stats/readonly-query';
import { WindowRegistry } from '../../../main/window-registry';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ getDbPath: () => '/tmp/does-not-matter-stats.db' }),
}));
vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		constructor(...args: unknown[]) {
			dbConstructed(...args);
		}
		prepare() {
			// A query that gets this far would need real SQLite to be meaningful;
			// guard-layer tests never reach here.
			throw new Error('prepare() reached - guard did not reject');
		}
		close() {}
	},
}));

// ===== from src/__tests__/main/stats/multi-window-telemetry.test.ts =====

// Mock Sentry so the failure-path test can assert reporting without the real
// (dynamically imported) Sentry module.
const mockCaptureException = vi.fn();

/** Minimal fake BrowserWindow - the registry only calls getBounds/isDestroyed. */
function makeWindow(): BrowserWindow {
	return {
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
		isDestroyed: vi.fn(() => false),
	} as unknown as BrowserWindow;
}

/** A fake stats DB exposing just what the telemetry wiring touches. */
function makeStatsDb(opts: { ready?: boolean; throwOnRecord?: boolean } = {}) {
	const { ready = true, throwOnRecord = false } = opts;
	return {
		isReady: vi.fn(() => ready),
		recordWindowOpened: vi.fn((..._args: unknown[]) => {
			if (throwOnRecord) throw new Error('db boom');
			return '2026-06-23';
		}),
	};
}

describe('wireMultiWindowTelemetry', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		mockCaptureException.mockClear();
		registry = new WindowRegistry();
	});

	it('records a secondary window open with the live concurrent window count', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		// Primary first (count 1, not recorded), then a secondary (count 2).
		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenCalledTimes(1);
		expect(db.recordWindowOpened).toHaveBeenCalledWith(expect.any(Number), 2);
	});

	it('does NOT record the primary window opening', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('raises the concurrent count as more secondary windows open', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });
		registry.create({ windowId: 'w3', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenNthCalledWith(1, expect.any(Number), 2);
		expect(db.recordWindowOpened).toHaveBeenNthCalledWith(2, expect.any(Number), 3);
	});

	it('records nothing when statsCollectionEnabled is false', () => {
		const db = makeStatsDb();
		const settingsStore = { get: vi.fn(() => false) };
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db, settingsStore });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(settingsStore.get).toHaveBeenCalledWith('statsCollectionEnabled');
		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('records when statsCollectionEnabled is unset (defaults to enabled)', () => {
		const db = makeStatsDb();
		const settingsStore = { get: vi.fn(() => undefined) };
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db, settingsStore });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenCalledTimes(1);
	});

	it('skips recording when the stats DB is not ready', () => {
		const db = makeStatsDb({ ready: false });
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('does not record on window close (removed)', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });
		db.recordWindowOpened.mockClear();

		registry.remove('w2');

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('swallows a stats failure (never breaks window creation) and reports it to Sentry', () => {
		const db = makeStatsDb({ throwOnRecord: true });
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });

		expect(() =>
			registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false })
		).not.toThrow();
		// The window was still registered despite the telemetry failure.
		expect(registry.get('w2')).toBeDefined();
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
	});

	it('stops recording after the returned unsubscribe is called', () => {
		const db = makeStatsDb();
		const unsubscribe = wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		unsubscribe();
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/main/stats/readonly-query.test.ts =====

// Mock better-sqlite3. The constructor records that it was reached; tests assert
// it is NOT reached for guard-rejected queries.
const dbConstructed = vi.fn();

describe('runReadonlyStatsQuery guard layer', () => {
	beforeEach(() => {
		dbConstructed.mockClear();
	});

	it('rejects empty SQL before opening the database', () => {
		expect(() => runReadonlyStatsQuery('   ')).toThrow(/empty/i);
		expect(dbConstructed).not.toHaveBeenCalled();
	});

	const disallowed: Array<[string, string]> = [
		['UPDATE', 'UPDATE query_events SET duration = 0'],
		['DELETE', 'DELETE FROM query_events'],
		['INSERT', "INSERT INTO query_events VALUES ('x','y',1)"],
		['DROP', 'DROP TABLE query_events'],
		['ALTER', 'ALTER TABLE query_events ADD COLUMN x INTEGER'],
		['CREATE', 'CREATE TABLE evil (x)'],
		['ATTACH', "ATTACH DATABASE '/tmp/evil.db' AS evil"],
		['DETACH', 'DETACH DATABASE evil'],
		['REPLACE', "REPLACE INTO query_events VALUES ('x','y',1)"],
		['VACUUM', 'VACUUM'],
		['comment-hidden write', '-- innocent\nDROP TABLE query_events'],
		['block-comment-hidden write', '/* hi */ DELETE FROM query_events'],
	];

	for (const [label, sql] of disallowed) {
		it(`rejects ${label} before opening the database`, () => {
			expect(() => runReadonlyStatsQuery(sql)).toThrow(/read-only/i);
			expect(dbConstructed).not.toHaveBeenCalled();
		});
	}

	it('lets multi-statement past the keyword guard but blocks it at prepare()', () => {
		// "SELECT 1; DROP..." starts with SELECT, so the keyword allowlist admits
		// it; the second statement is rejected one layer deeper by prepare()
		// (single-statement only) against the harmless readonly connection.
		expect(() => runReadonlyStatsQuery('SELECT 1; DROP TABLE query_events')).toThrow(
			/prepare\(\) reached/
		);
		// Real better-sqlite3 throws inside prepare() on multi-statement input;
		// here the mock proves the keyword guard let it through to that layer.
		expect(dbConstructed).toHaveBeenCalled();
	});

	const allowedKeywords: Array<[string, string]> = [
		['SELECT', 'SELECT * FROM query_events'],
		['WITH (CTE)', 'WITH t AS (SELECT 1 AS n) SELECT n FROM t'],
		['PRAGMA', 'PRAGMA table_info(query_events)'],
		['EXPLAIN', 'EXPLAIN SELECT * FROM query_events'],
		['VALUES', 'VALUES (1), (2)'],
	];

	for (const [label, sql] of allowedKeywords) {
		it(`lets ${label} through the guard to the database layer`, () => {
			// These pass the guard, so they DO reach new Database() (our mock),
			// whose prepare() then throws - proving the guard allowed them through.
			expect(() => runReadonlyStatsQuery(sql)).toThrow(/prepare\(\) reached/);
			expect(dbConstructed).toHaveBeenCalledWith('/tmp/does-not-matter-stats.db', {
				readonly: true,
				fileMustExist: true,
			});
		});
	}
});
