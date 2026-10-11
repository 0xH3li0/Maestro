/**
 * Tests for main/agent-run/store-watcher.ts: the `onRunsChanged` listener.
 *
 * The watcher reads the run ledger on every change to broadcast it. A second
 * reader of the ledger gets the runs from the watcher, so that the file is
 * read once per change, and not at all at start by a listener that has
 * nothing to do.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../shared/agent-run';

const mocks = vi.hoisted(() => ({
	dir: '',
	runs: [] as unknown[],
	readAgentRuns: vi.fn(),
	readAgentRunEvents: vi.fn(() => []),
	broadcastRunUpdated: vi.fn(),
	broadcastEventAppended: vi.fn(),
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../cli/services/storage', () => ({ getConfigDirectory: () => mocks.dir }));
vi.mock('../../../cli/services/agent-run-store', () => ({
	readAgentRuns: mocks.readAgentRuns,
	readAgentRunEvents: mocks.readAgentRunEvents,
}));
vi.mock('../../../main/agent-run/broadcast', () => ({
	broadcastRunUpdated: mocks.broadcastRunUpdated,
	broadcastEventAppended: mocks.broadcastEventAppended,
}));
vi.mock('../../../main/utils/logger', () => ({ logger: mocks.logger }));

import { startAgentRunStoreWatcher } from '../../../main/agent-run/store-watcher';
import type { StoreWatcherHandle } from '../../../main/agent-run/store-watcher';

const RUNS_FILE = 'maestro-agent-runs.json';

function run(id: string): AgentRun {
	return {
		id,
		createdAt: 1,
		updatedAt: 2,
		provider: 'claude-code',
		status: 'completed',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
	};
}

describe('agent-run store watcher: onRunsChanged', () => {
	let handle: StoreWatcherHandle | null;

	beforeEach(() => {
		mocks.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'run-watch-')));
		fs.writeFileSync(path.join(mocks.dir, RUNS_FILE), '{"runs":[]}');
		mocks.runs = [run('a')];
		mocks.readAgentRuns.mockReset();
		mocks.readAgentRuns.mockImplementation(() => mocks.runs);
		mocks.logger.warn.mockClear();
		handle = null;
	});

	afterEach(() => {
		handle?.stop();
		fs.rmSync(mocks.dir, { recursive: true, force: true });
	});

	/** Touches the ledger the way a write of the command line does. */
	const changeLedger = (): void => {
		fs.writeFileSync(path.join(mocks.dir, RUNS_FILE), `{"runs":[],"at":${Date.now()}}`);
	};

	it('tells the listener once at start, and reads the ledger only if the listener asks', () => {
		const readers: Array<() => AgentRun[]> = [];
		handle = startAgentRunStoreWatcher({ onRunsChanged: (readRuns) => readers.push(readRuns) });

		expect(readers).toHaveLength(1);
		// A listener with nothing to do costs no read of the file.
		expect(mocks.readAgentRuns).not.toHaveBeenCalled();

		expect(readers[0]()).toEqual([run('a')]);
		expect(mocks.readAgentRuns).toHaveBeenCalledTimes(1);
	});

	it('hands over the runs it just read after a change, with no second read', async () => {
		const readers: Array<() => AgentRun[]> = [];
		handle = startAgentRunStoreWatcher({ onRunsChanged: (readRuns) => readers.push(readRuns) });
		mocks.runs = [run('a'), run('b')];

		changeLedger();
		await vi.waitFor(() => expect(readers.length).toBeGreaterThan(1), { timeout: 5000 });

		const readsByWatcher = mocks.readAgentRuns.mock.calls.length;
		expect(readsByWatcher).toBeGreaterThan(0);
		expect(readers[readers.length - 1]()).toEqual([run('a'), run('b')]);
		expect(mocks.readAgentRuns).toHaveBeenCalledTimes(readsByWatcher);
		expect(mocks.broadcastRunUpdated).toHaveBeenCalled();
	});

	it('goes on watching when the listener throws', async () => {
		let calls = 0;
		handle = startAgentRunStoreWatcher({
			onRunsChanged: () => {
				calls += 1;
				throw new Error('The listener failed.');
			},
		});
		expect(calls).toBe(1);

		changeLedger();
		await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 5000 });

		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'store watch listener failed',
			expect.any(String),
			expect.objectContaining({ error: expect.stringContaining('The listener failed.') })
		);
	});

	it('starts and stops with no listener at all', () => {
		handle = startAgentRunStoreWatcher();
		expect(() => handle?.stop()).not.toThrow();
	});
});
