// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/stores/codexUsageStore.test.ts
//   - src/__tests__/main/stores/corrupt-store-recovery.test.ts

import {
	CODEX_USAGE_SNAPSHOT_TTL_MS,
	SNAPSHOT_RETENTION_MS,
	__resetForTests,
	clearCodexUsageSnapshots,
	getAllCodexUsageSnapshots,
	getRetainedCodexUsageSnapshots,
	resolveCodexHomeKey,
	setCodexUsageSnapshot,
} from '../../../main/stores/codexUsageStore';
import type { CodexUsageSnapshot } from '../../../main/stores/codexUsageStore';
import {
	corruptStorePath,
	createStoreDeserializer,
} from '../../../main/stores/corrupt-store-recovery';
import * as fs from 'fs';
import * as os from 'os';
import path, * as path_1 from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStoreConstructorCalls } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			data: Record<string, unknown>;
			options: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.options = options;
				this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
				mockStoreConstructorCalls.push(options);
			}
			get(key: string, defaultValue?: unknown): unknown {
				if (Object.prototype.hasOwnProperty.call(this.data, key)) {
					return this.data[key];
				}
				return defaultValue;
			}
			set(key: string, value: unknown): void {
				this.data[key] = value;
			}
		},
	};
});
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const homedir = () => '/Users/test';
	return {
		...actual,
		homedir,
		default: {
			...actual,
			homedir,
		},
	};
});
const { mockCaptureException } = vi.hoisted(() => ({
	mockCaptureException: vi.fn(
		async (_error: Error | unknown, _extra?: Record<string, unknown>) => {}
	),
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
	captureException: mockCaptureException,
}));

// ===== from src/__tests__/main/stores/codexUsageStore.test.ts =====

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

function makeSnapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
	return {
		sampledAt: new Date(FROZEN_NOW).toISOString(),
		codexHomeKey: '/Users/test/.codex',
		authState: 'authenticated',
		session: { percent: 12, resetsAt: '2026-05-15T17:00:00.000Z' },
		weekly: { percent: 40, resetsAt: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
}

function agedSnapshot(codexHomeKey: string, ageMs: number): CodexUsageSnapshot {
	return makeSnapshot({
		codexHomeKey,
		sampledAt: new Date(FROZEN_NOW - ageMs).toISOString(),
	});
}

describe('codexUsageStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		__resetForTests();
		mockStoreConstructorCalls.length = 0;
	});

	describe('lazy singleton', () => {
		it('does not construct the Store at module load', () => {
			expect(mockStoreConstructorCalls).toHaveLength(0);
		});

		it('constructs the Store on first method call', () => {
			getAllCodexUsageSnapshots();
			expect(mockStoreConstructorCalls).toHaveLength(1);
			expect(mockStoreConstructorCalls[0]).toMatchObject({
				name: 'codex-usage-snapshots',
				defaults: { snapshots: {} },
			});
		});
	});

	describe('read and write', () => {
		it('round-trips a snapshot keyed by codexHomeKey', () => {
			const snapshot = makeSnapshot();
			setCodexUsageSnapshot(snapshot);

			expect(getAllCodexUsageSnapshots()).toEqual({ [snapshot.codexHomeKey]: snapshot });
		});

		it('keeps accounts isolated from one another', () => {
			const work = makeSnapshot({ codexHomeKey: '/Users/test/.codex-work' });
			const personal = makeSnapshot({ codexHomeKey: '/Users/test/.codex-personal' });
			setCodexUsageSnapshot(work);
			setCodexUsageSnapshot(personal);

			expect(getAllCodexUsageSnapshots()).toEqual({
				[work.codexHomeKey]: work,
				[personal.codexHomeKey]: personal,
			});
		});

		it('overwrites the snapshot for an account it already holds', () => {
			setCodexUsageSnapshot(makeSnapshot({ session: { percent: 12, resetsAt: 'x' } }));
			const refreshed = makeSnapshot({ session: { percent: 90, resetsAt: 'y' } });
			setCodexUsageSnapshot(refreshed);

			expect(getAllCodexUsageSnapshots()).toEqual({ [refreshed.codexHomeKey]: refreshed });
		});

		it('clears every account', () => {
			setCodexUsageSnapshot(makeSnapshot());
			clearCodexUsageSnapshots();

			expect(getAllCodexUsageSnapshots()).toEqual({});
			expect(getRetainedCodexUsageSnapshots()).toEqual({});
		});
	});

	describe('retention beyond the TTL', () => {
		it('keeps an expired snapshot for display while hiding it from the live map', () => {
			// The Codex account whose agents all moved away: the dashboard keeps
			// drawing its last known bars, nothing may decide on them.
			const expired = agedSnapshot('/Users/test/.codex-capped', 25 * 60 * 60 * 1000);
			setCodexUsageSnapshot(expired);

			expect(getAllCodexUsageSnapshots()).toEqual({});
			expect(getRetainedCodexUsageSnapshots()).toEqual({ [expired.codexHomeKey]: expired });
		});

		it('survives a neighboring write', () => {
			const expired = agedSnapshot('/Users/test/.codex-capped', 30 * 60 * 60 * 1000);
			setCodexUsageSnapshot(expired);
			const fresh = makeSnapshot({ codexHomeKey: '/Users/test/.codex-spare' });
			setCodexUsageSnapshot(fresh);

			expect(getAllCodexUsageSnapshots()).toEqual({ [fresh.codexHomeKey]: fresh });
			expect(getRetainedCodexUsageSnapshots()).toEqual({
				[expired.codexHomeKey]: expired,
				[fresh.codexHomeKey]: fresh,
			});
		});

		it('drops a snapshot past the retention window', () => {
			const ancient = agedSnapshot('/Users/test/.codex-ancient', SNAPSHOT_RETENTION_MS + 60_000);
			setCodexUsageSnapshot(ancient);

			expect(getRetainedCodexUsageSnapshots()).toEqual({});
		});

		it('drops an unparseable snapshot rather than retaining it', () => {
			setCodexUsageSnapshot(
				makeSnapshot({ codexHomeKey: '/Users/test/.codex-bad', sampledAt: 'garbage' })
			);
			const fresh = makeSnapshot({ codexHomeKey: '/Users/test/.codex-new' });
			setCodexUsageSnapshot(fresh);

			expect(getRetainedCodexUsageSnapshots()).toEqual({ [fresh.codexHomeKey]: fresh });
		});

		it('uses the same two clocks as the Claude store', () => {
			expect(CODEX_USAGE_SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
			expect(SNAPSHOT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
		});
	});

	// The subject ends in `path.resolve`, so a POSIX literal picks up a drive
	// letter on Windows. Expect through the same resolver rather than pinning
	// the separator this machine happens to use.
	describe('resolveCodexHomeKey', () => {
		it('falls back to ~/.codex when CODEX_HOME is unset', () => {
			expect(resolveCodexHomeKey({})).toBe(path.resolve('/Users/test/.codex'));
		});

		it('honors an explicit CODEX_HOME', () => {
			expect(resolveCodexHomeKey({ CODEX_HOME: '/Users/test/.codex-work' })).toBe(
				path.resolve('/Users/test/.codex-work')
			);
		});
	});
});

// ===== from src/__tests__/main/stores/corrupt-store-recovery.test.ts =====

let tempDir: string;

let storePath: string;

/** Sidecars this store produced, newest last. */
function sidecars(): string[] {
	return fs
		.readdirSync(tempDir)
		.filter((name) => name.startsWith('maestro-sessions.corrupt-'))
		.sort();
}

describe('corruptStorePath', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = fs.mkdtempSync(path_1.join(os.tmpdir(), 'maestro-store-recovery-'));
		storePath = path_1.join(tempDir, 'maestro-sessions.json');
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('stamps the sidecar so a second incident cannot overwrite the first', () => {
		const first = corruptStorePath(storePath, new Date(2026, 8, 22, 7, 15, 30));
		const second = corruptStorePath(storePath, new Date(2026, 8, 22, 9, 0, 0));

		expect(path_1.basename(first)).toBe('maestro-sessions.corrupt-20260922-071530.json');
		expect(path_1.dirname(first)).toBe(tempDir);
		expect(second).not.toBe(first);
	});
});

describe('createStoreDeserializer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = fs.mkdtempSync(path_1.join(os.tmpdir(), 'maestro-store-recovery-'));
		storePath = path_1.join(tempDir, 'maestro-sessions.json');
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('parses a healthy document, BOM included', () => {
		const deserialize = createStoreDeserializer(storePath);

		expect(deserialize('\uFEFF{"sessions":[{"id":"a"}]}')).toEqual({
			sessions: [{ id: 'a' }],
		});
		expect(sidecars()).toHaveLength(0);
	});

	it('quarantines a truncated document and falls back to an empty one', () => {
		const torn = '{"sessions":[{"id":"a","name":"unterminat';
		fs.writeFileSync(storePath, torn, 'utf-8');

		const result = createStoreDeserializer(storePath)(torn);

		expect(result).toEqual({});
		// The bad file is out of the way, so the next read starts clean.
		expect(fs.existsSync(storePath)).toBe(false);
		// ...and its bytes are still on disk, under a name that says what happened.
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path_1.join(tempDir, preserved[0]), 'utf-8')).toBe(torn);
	});

	it('reports the corruption rather than swallowing it', () => {
		const torn = '{"sessions":[';
		fs.writeFileSync(storePath, torn, 'utf-8');

		createStoreDeserializer(storePath)(torn);

		expect(mockCaptureException).toHaveBeenCalledOnce();
		const [error, extra] = mockCaptureException.mock.calls[0];
		expect(error).toBeInstanceOf(SyntaxError);
		expect(extra).toMatchObject({
			operation: 'store:deserialize',
			storeFile: 'maestro-sessions.json',
			quarantined: true,
		});
	});

	it('still preserves the contents when the file cannot be renamed', () => {
		// No file on disk at all: rename fails, so the in-memory copy is written.
		const torn = 'not json at all';

		const result = createStoreDeserializer(storePath)(torn);

		expect(result).toEqual({});
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path_1.join(tempDir, preserved[0]), 'utf-8')).toBe(torn);
	});

	it('rethrows anything that is not a parse failure', () => {
		const deserialize = createStoreDeserializer(storePath);
		const exploding = {
			charCodeAt() {
				throw new RangeError('string too long');
			},
		} as unknown as string;

		expect(() => deserialize(exploding)).toThrow(RangeError);
		expect(mockCaptureException).not.toHaveBeenCalled();
	});
});
