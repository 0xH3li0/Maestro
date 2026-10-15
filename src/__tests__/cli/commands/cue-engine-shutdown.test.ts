/**
 * @file cue-engine-shutdown.test.ts
 * @description What `maestro-cli cue engine start` does on SIGINT / SIGTERM.
 *
 * `engine.stop()` clears the engine's maps and ends no run. A runner that
 * called only that left a run in flight orphaned: its agent kept running under
 * pid 1 and its row stayed `running`. The handler has to stop the runs, wait
 * for their processes, and only then stop the engine, and neither a hung child
 * nor a second signal may keep the process alive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => ({
		pid: process.pid,
		mode: 'standalone',
		startedAt: '2026-09-25T00:00:00.000Z',
	})),
}));

vi.mock('../../../cli/services/cue-standalone-engine', () => ({
	createStandaloneCueEngine: vi.fn(),
	waitForStandaloneCueProcesses: vi.fn(),
}));

vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(() => vi.fn()),
}));

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(() => []),
}));

import { cueEngineStart } from '../../../cli/commands/cue-engine';
import {
	createStandaloneCueEngine,
	waitForStandaloneCueProcesses,
} from '../../../cli/services/cue-standalone-engine';

type SignalHandler = () => void;

describe('cue engine start: SIGINT / SIGTERM', () => {
	const calls: string[] = [];
	const handlers = new Map<string, SignalHandler>();
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let releaseWait: (stillAlive: number) => void;

	const engine = {
		start: vi.fn(),
		getStatus: vi.fn(() => ({})),
		triggerSubscription: vi.fn(),
		stopAll: vi.fn(() => void calls.push('stopAll')),
		stop: vi.fn(() => void calls.push('stop')),
	};

	/** Start the runner (it never returns) and hand back its signal handlers. */
	const startRunner = async (): Promise<void> => {
		void cueEngineStart({ json: true });
		await vi.waitFor(() => expect(handlers.has('SIGTERM')).toBe(true));
	};

	beforeEach(() => {
		vi.useFakeTimers();
		calls.length = 0;
		handlers.clear();
		vi.clearAllMocks();
		vi.mocked(createStandaloneCueEngine).mockResolvedValue(engine as never);
		vi.mocked(waitForStandaloneCueProcesses).mockImplementation(
			() =>
				new Promise<number>((resolve) => {
					calls.push('wait');
					releaseWait = (stillAlive) => {
						calls.push('waited');
						resolve(stillAlive);
					};
				})
		);
		// Captured, never registered: a real listener would outlive the test.
		vi.spyOn(process, 'on').mockImplementation(((event: string, handler: SignalHandler) => {
			handlers.set(event, handler);
			return process;
		}) as never);
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('stops the runs, waits for their processes, then stops the engine and exits 0', async () => {
		await startRunner();

		handlers.get('SIGTERM')?.();
		// The engine is still up while the runs' processes are on their way out.
		expect(calls).toEqual(['stopAll', 'wait']);
		expect(exitSpy).not.toHaveBeenCalled();

		releaseWait(0);
		await vi.advanceTimersByTimeAsync(300);
		expect(calls).toEqual(['stopAll', 'wait', 'waited', 'stop']);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it('bounds the wait, so a child that will not exit cannot keep the runner alive', async () => {
		await startRunner();

		handlers.get('SIGINT')?.();

		const [timeoutMs] = vi.mocked(waitForStandaloneCueProcesses).mock.calls[0];
		expect(timeoutMs).toBeGreaterThan(0);
		expect(Number.isFinite(timeoutMs)).toBe(true);

		// What the bounded wait answers when a child outlived it.
		releaseWait(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(calls).toEqual(['stopAll', 'wait', 'waited', 'stop']);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it('exits at once on a second signal, without waiting for the runs', async () => {
		await startRunner();

		handlers.get('SIGTERM')?.();
		expect(exitSpy).not.toHaveBeenCalled();

		handlers.get('SIGTERM')?.();
		expect(calls).toEqual(['stopAll', 'wait', 'stop']);
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('still stops the engine and exits when the wait itself fails', async () => {
		vi.mocked(waitForStandaloneCueProcesses).mockRejectedValue(new Error('boom'));
		await startRunner();

		handlers.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(300);
		expect(calls).toEqual(['stopAll', 'stop']);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});
});
