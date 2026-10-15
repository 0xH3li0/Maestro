// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-sleep-prevention.test.ts
//   - src/__tests__/main/cue/cue-cleanup-service.test.ts
//   - src/__tests__/main/cue/cue-output-filter.test.ts

import {
	CLEANUP_INTERVAL_TICKS,
	createCueCleanupService,
} from '../../../main/cue/cue-cleanup-service';
import type { CueCleanupServiceDeps } from '../../../main/cue/cue-cleanup-service';
import { CueEngine } from '../../../main/cue/cue-engine';
import type { CueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import { buildFilteredOutputs, mergeUpstreamForwarded } from '../../../main/cue/cue-output-filter';
import type { FanInSourceCompletion } from '../../../main/cue/cue-output-filter';
import type { CueSessionRegistry } from '../../../main/cue/cue-session-registry';
import type { CueConfig, CueRunResult, CueSubscription } from '../../../main/cue/cue-types';
import { createMockConfig, createMockDeps } from './cue-test-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => {
		const config = mockLoadCueConfig(args[0] as string);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
}));
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) => mockCreateCueGitHubPoller(args[0]),
}));
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) => mockCreateCueTaskScanner(args[0]),
}));
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
	isCueDbReady: () => true,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
}));
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

// ===== from src/__tests__/main/cue/cue-sleep-prevention.test.ts =====

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();

const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();

// Mock the GitHub poller
const mockCreateCueGitHubPoller = vi.fn<(config: unknown) => () => void>();

// Mock the task scanner
const mockCreateCueTaskScanner = vi.fn<(config: unknown) => () => void>();

describe('Cue Sleep Prevention', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;
	let fileWatcherCleanup: ReturnType<typeof vi.fn>;
	let gitHubPollerCleanup: ReturnType<typeof vi.fn>;
	let taskScannerCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

		fileWatcherCleanup = vi.fn();
		mockCreateCueFileWatcher.mockReturnValue(fileWatcherCleanup);

		gitHubPollerCleanup = vi.fn();
		mockCreateCueGitHubPoller.mockReturnValue(gitHubPollerCleanup);

		taskScannerCleanup = vi.fn();
		mockCreateCueTaskScanner.mockReturnValue(taskScannerCleanup);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Cue must NOT take a sleep blocker merely because a session has time-based
	 * subscriptions registered.
	 *
	 * This block previously asserted the opposite. That behaviour, keyed
	 * `cue:schedule:{sessionId}`, held a blocker from session init to teardown -
	 * i.e. for the app's entire uptime. Having a subscription is a static
	 * property of the YAML, not a runtime state, so one job firing daily at 03:00
	 * kept the blocker up for all 24 hours.
	 *
	 * On macOS the blocker was a display-sleep assertion, which is the signal the
	 * OS uses to decide a user is present. Holding one indefinitely made the Duet
	 * Activity Scheduler refuse the entire discretionary maintenance tier:
	 * measured on one affected machine, 548,540 "Must Not Proceed" decisions and
	 * zero proceeds across 264 distinct activities in 24 hours.
	 *
	 * Running a subscription is what genuinely needs the machine awake, and that
	 * is covered per-run by `cue:run:{runId}` - see the run-level block below.
	 */
	describe('schedule-level sleep prevention is not taken', () => {
		const scheduleReason = expect.stringContaining('cue:schedule:');

		it('does not block sleep for a heartbeat subscription', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat-sub',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(scheduleReason);
		});

		it('does not block sleep for a scheduled subscription', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'scheduled-sub',
							event: 'time.scheduled',
							schedule_times: ['09:00'],
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(scheduleReason);
		});

		it('does not block sleep across refresh when a heartbeat is added', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'file-sub',
							event: 'file.changed',
							path: 'src/**',
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat-sub',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);
			engine.refreshSession('session-1', '/projects/test');

			expect(onPreventSleep).not.toHaveBeenCalledWith(scheduleReason);
		});

		it('releases nothing on teardown because nothing was taken', () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat-sub',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			engine.removeSession('session-1');

			expect(onPreventSleep).not.toHaveBeenCalledWith(scheduleReason);
			expect(onAllowSleep).not.toHaveBeenCalledWith(scheduleReason);
		});

		it('operates normally when callbacks are not provided', () => {
			const deps = createMockDeps(); // no onPreventSleep/onAllowSleep
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);

			// Should not throw
			expect(() => {
				engine.start();
				engine.removeSession('session-1');
				engine.stop();
			}).not.toThrow();
		});
	});

	describe('run-level sleep prevention', () => {
		it('adds block reason when run starts', async () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			// Advance to trigger the heartbeat (immediate fire on setup)
			await vi.advanceTimersByTimeAsync(100);

			// Should have been called with a cue:run: reason
			const runCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runCalls.length).toBeGreaterThanOrEqual(1);
		});

		it('removes block reason when run completes', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			// Let the run complete
			await vi.advanceTimersByTimeAsync(100);

			// Find the run reason that was added
			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runAddCalls.length).toBeGreaterThanOrEqual(1);

			const runReason = runAddCalls[0][0];

			// Same reason should have been removed
			expect(onAllowSleep).toHaveBeenCalledWith(runReason);
		});

		it('removes block reason when run fails', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(async () => ({
					runId: 'run-1',
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: 'heartbeat',
					event: {
						id: 'e1',
						type: 'time.heartbeat' as const,
						triggerName: 'heartbeat',
						timestamp: new Date().toISOString(),
						payload: {},
					},
					status: 'failed' as const,
					stdout: '',
					stderr: 'something broke',
					exitCode: 1,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				})),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runAddCalls.length).toBeGreaterThanOrEqual(1);

			const runReason = runAddCalls[0][0];
			expect(onAllowSleep).toHaveBeenCalledWith(runReason);
		});

		it('removes block reason when run is manually stopped', async () => {
			let resolveRun: (result: CueRunResult) => void;
			const runPromise = new Promise<CueRunResult>((resolve) => {
				resolveRun = resolve;
			});

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(() => runPromise),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Get the active run
			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(1);
			const runId = activeRuns[0].runId;

			// Stop the run
			engine.stopRun(runId);

			expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${runId}`);

			// Resolve the run promise to avoid hanging
			resolveRun!({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);
		});

		it('stopAll removes all run block reasons', async () => {
			let resolveRun1: (result: CueRunResult) => void;
			let resolveRun2: (result: CueRunResult) => void;
			let callCount = 0;

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(() => {
					callCount++;
					if (callCount === 1) {
						return new Promise<CueRunResult>((resolve) => {
							resolveRun1 = resolve;
						});
					}
					return new Promise<CueRunResult>((resolve) => {
						resolveRun2 = resolve;
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					settings: {
						timeout_minutes: 30,
						timeout_on_fail: 'break',
						max_concurrent: 2,
						queue_size: 10,
					},
					// Two DISTINCT subscriptions so both run concurrently. The
					// self-overlap guard serializes repeated firings of the SAME
					// subscription, so two ticks of one heartbeat would no longer
					// yield two concurrent runs.
					subscriptions: [
						{
							name: 'heartbeat-a',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
						{
							name: 'heartbeat-b',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Both distinct subscriptions fire on start → two concurrent runs.
			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(2);

			engine.stopAll();

			// Both run reasons should have been released
			for (const run of activeRuns) {
				expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${run.runId}`);
			}

			// Resolve promises to avoid hanging
			const makeResult = (runId: string): CueRunResult => ({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			resolveRun1!(makeResult(activeRuns[0].runId));
			resolveRun2!(makeResult(activeRuns[1].runId));
			await vi.advanceTimersByTimeAsync(100);
		});

		it('engine stop (reset) removes all run block reasons', async () => {
			let resolveRun: (result: CueRunResult) => void;

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(1);
			const runId = activeRuns[0].runId;

			engine.stop();

			// reset() should release run reason
			expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${runId}`);

			// Resolve to avoid hanging
			resolveRun!({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);
		});

		it('multiple concurrent runs each get their own block reason', async () => {
			let _callCount = 0;
			const resolvers: Array<(result: CueRunResult) => void> = [];

			const onPreventSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onCueRun: vi.fn(() => {
					_callCount++;
					return new Promise<CueRunResult>((resolve) => {
						resolvers.push(resolve);
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					settings: {
						timeout_minutes: 30,
						timeout_on_fail: 'break',
						max_concurrent: 3,
						queue_size: 10,
					},
					// Three DISTINCT subscriptions so all three run concurrently.
					// Repeated firings of one subscription now serialize (the
					// self-overlap guard), so they would not produce three
					// concurrent runs each with its own sleep-block reason.
					subscriptions: [
						{
							name: 'heartbeat-a',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
						{
							name: 'heartbeat-b',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
						{
							name: 'heartbeat-c',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// All three distinct subscriptions fire on start → three concurrent runs.
			const runReasons = onPreventSleep.mock.calls
				.filter((call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:'))
				.map((call) => call[0]);

			// Each run should have a unique reason
			const uniqueReasons = new Set(runReasons);
			expect(uniqueReasons.size).toBe(runReasons.length);
			expect(runReasons.length).toBe(3);

			// Clean up
			engine.stop();
			for (const resolve of resolvers) {
				resolve({
					runId: 'cleanup',
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: 'heartbeat',
					event: {
						id: 'e1',
						type: 'time.heartbeat',
						triggerName: 'heartbeat',
						timestamp: new Date().toISOString(),
						payload: {},
					},
					status: 'stopped',
					stdout: '',
					stderr: '',
					exitCode: null,
					durationMs: 0,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				});
			}
			await vi.advanceTimersByTimeAsync(100);
		});

		it('run with output prompt has single add/remove pair for the main runId', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			let callCount = 0;
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(async (request) => ({
					runId: request.runId,
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed' as const,
					stdout: `output-${++callCount}`,
					stderr: '',
					exitCode: 0,
					durationMs: 50,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				})),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 60,
							prompt: 'main task',
							output_prompt: 'summarize results',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Count run-level sleep calls
			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			const runRemoveCalls = onAllowSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);

			// One add (main runId) and one remove (same runId in finally)
			expect(runAddCalls).toHaveLength(1);
			expect(runRemoveCalls).toHaveLength(1);
			expect(runAddCalls[0][0]).toBe(runRemoveCalls[0][0]);
		});

		it('queued event does not add block reason until dispatched', async () => {
			let resolveRun: (result: CueRunResult) => void;
			let callCount = 0;

			const onPreventSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onCueRun: vi.fn(() => {
					callCount++;
					if (callCount === 1) {
						return new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						});
					}
					return Promise.resolve({
						runId: 'run-2',
						sessionId: 'session-1',
						sessionName: 'Test Session',
						subscriptionName: 'heartbeat',
						event: {
							id: 'e2',
							type: 'time.heartbeat' as const,
							triggerName: 'heartbeat',
							timestamp: new Date().toISOString(),
							payload: {},
						},
						status: 'completed' as const,
						stdout: '',
						stderr: '',
						exitCode: 0,
						durationMs: 50,
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					settings: {
						timeout_minutes: 30,
						timeout_on_fail: 'break',
						max_concurrent: 1, // Only 1 concurrent
						queue_size: 10,
					},
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Count current run-level adds
			const runAddsBefore = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsBefore).toBe(1); // First run started

			// Trigger another event (will be queued since max_concurrent=1)
			vi.advanceTimersByTime(60 * 1000);
			await vi.advanceTimersByTimeAsync(100);

			// Queued event should NOT have added a run reason
			const runAddsAfterQueue = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsAfterQueue).toBe(1); // Still just the first run

			// Now resolve the first run - queued event should be dispatched
			resolveRun!({
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 50,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);

			// Now the queued event should have been dispatched and added its own reason
			const runAddsAfterDrain = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsAfterDrain).toBe(2);
		});
	});
});

// ===== from src/__tests__/main/cue/cue-cleanup-service.test.ts =====

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockTracker(overrides: Partial<CueFanInTracker> = {}): CueFanInTracker {
	return {
		handleCompletion: vi.fn(),
		clearForSession: vi.fn(),
		reset: vi.fn(),
		getActiveTrackerKeys: vi.fn(() => []),
		getTrackerCreatedAt: vi.fn(() => undefined),
		expireTracker: vi.fn(),
		...overrides,
	};
}

function makeMockRegistry(overrides: Partial<CueSessionRegistry> = {}): CueSessionRegistry {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		get: vi.fn(() => undefined),
		has: vi.fn(() => false),
		snapshot: vi.fn(() => new Map()),
		size: vi.fn(() => 0),
		markScheduledFired: vi.fn(() => true),
		evictStaleScheduledKeys: vi.fn(),
		clearScheduledForSession: vi.fn(),
		markStartupFired: vi.fn(() => true),
		clearStartupForSession: vi.fn(),
		clear: vi.fn(),
		sweepStaleScheduledKeys: vi.fn(() => 0),
		...overrides,
	};
}

function makeDeps(overrides: Partial<CueCleanupServiceDeps> = {}): CueCleanupServiceDeps {
	return {
		fanInTracker: makeMockTracker(),
		registry: makeMockRegistry(),
		getSessions: vi.fn(() => []),
		getSessionTimeoutMs: vi.fn(() => 30 * 60 * 1000),
		getCurrentMinute: vi.fn(() => '09:00'),
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createCueCleanupService', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	describe('sweep - no-op cases', () => {
		it('returns zero counts when no trackers or keys exist', () => {
			const deps = makeDeps();
			const service = createCueCleanupService(deps);
			const result = service.sweep();
			expect(result).toEqual({ fanInEvicted: 0, scheduledKeysEvicted: 0 });
		});

		it('does not evict a recent fan-in tracker', () => {
			const tracker = makeMockTracker({
				getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
				getTrackerCreatedAt: vi.fn(() => Date.now() - 1000), // 1 second old
				expireTracker: vi.fn(),
			});
			const deps = makeDeps({
				fanInTracker: tracker,
				getSessions: () => [{ id: 'session-1' }],
				getSessionTimeoutMs: () => 30 * 60 * 1000, // 30 min - 2× = 60 min
			});
			const service = createCueCleanupService(deps);
			const result = service.sweep();

			expect(tracker.expireTracker).not.toHaveBeenCalled();
			expect(result.fanInEvicted).toBe(0);
		});
	});

	describe('sweep - fan-in eviction', () => {
		it('evicts a fan-in tracker whose owner session is no longer active', () => {
			const tracker = makeMockTracker({
				getActiveTrackerKeys: vi.fn(() => ['removed-session:sub-a']),
				getTrackerCreatedAt: vi.fn(() => Date.now()),
				expireTracker: vi.fn(),
			});
			const deps = makeDeps({
				fanInTracker: tracker,
				getSessions: () => [], // removed-session is gone
			});
			const service = createCueCleanupService(deps);
			const result = service.sweep();

			expect(tracker.expireTracker).toHaveBeenCalledWith('removed-session:sub-a');
			expect(result.fanInEvicted).toBe(1);
			expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('removed session'));
		});

		it('evicts a fan-in tracker whose age exceeds 2× the session timeout', () => {
			const timeoutMs = 30 * 60 * 1000; // 30 minutes
			const createdAt = Date.now() - 3 * timeoutMs; // 90 minutes ago > 2× timeout
			const tracker = makeMockTracker({
				getActiveTrackerKeys: vi.fn(() => ['session-1:sub-a']),
				getTrackerCreatedAt: vi.fn(() => createdAt),
				expireTracker: vi.fn(),
			});
			const deps = makeDeps({
				fanInTracker: tracker,
				getSessions: () => [{ id: 'session-1' }],
				getSessionTimeoutMs: () => timeoutMs,
			});
			const service = createCueCleanupService(deps);
			const result = service.sweep();

			expect(tracker.expireTracker).toHaveBeenCalledWith('session-1:sub-a');
			expect(result.fanInEvicted).toBe(1);
			expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('2× timeout'));
		});

		it('handles a key without a colon (edge case) by treating the whole key as session ID', () => {
			const tracker = makeMockTracker({
				getActiveTrackerKeys: vi.fn(() => ['orphaned-key']),
				getTrackerCreatedAt: vi.fn(() => undefined),
				expireTracker: vi.fn(),
			});
			const deps = makeDeps({
				fanInTracker: tracker,
				getSessions: () => [], // no sessions
			});
			const service = createCueCleanupService(deps);
			const result = service.sweep();

			// Should be evicted because "orphaned-key" is not in active sessions
			expect(tracker.expireTracker).toHaveBeenCalledWith('orphaned-key');
			expect(result.fanInEvicted).toBe(1);
		});
	});

	describe('sweep - scheduled key eviction', () => {
		it('reports evicted scheduled key count from registry.sweepStaleScheduledKeys', () => {
			const registry = makeMockRegistry({
				sweepStaleScheduledKeys: vi.fn(() => 3),
			});
			const deps = makeDeps({ registry });
			const service = createCueCleanupService(deps);
			const result = service.sweep();

			expect(result.scheduledKeysEvicted).toBe(3);
			expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('09:00');
			expect(deps.onLog).toHaveBeenCalledWith(
				'info',
				expect.stringContaining('3 stale scheduled key')
			);
		});

		it('passes the current minute from getCurrentMinute to the registry sweep', () => {
			const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
			const deps = makeDeps({
				registry,
				getCurrentMinute: () => '14:32',
			});
			const service = createCueCleanupService(deps);
			service.sweep();

			expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledWith('14:32');
		});
	});

	describe('onTick cadence', () => {
		it('does not sweep before CLEANUP_INTERVAL_TICKS ticks', () => {
			const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
			const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
			const deps = makeDeps({ registry, fanInTracker: tracker });
			const service = createCueCleanupService(deps);

			for (let i = 0; i < CLEANUP_INTERVAL_TICKS - 1; i++) {
				service.onTick();
			}

			expect(tracker.getActiveTrackerKeys).not.toHaveBeenCalled();
			expect(registry.sweepStaleScheduledKeys).not.toHaveBeenCalled();
		});

		it('triggers a sweep on exactly the Nth tick', () => {
			const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
			const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
			const deps = makeDeps({ registry, fanInTracker: tracker });
			const service = createCueCleanupService(deps);

			for (let i = 0; i < CLEANUP_INTERVAL_TICKS; i++) {
				service.onTick();
			}

			expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
			expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
		});

		it('sweeps again after another full interval', () => {
			const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
			const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
			const deps = makeDeps({ registry, fanInTracker: tracker });
			const service = createCueCleanupService(deps);

			for (let i = 0; i < CLEANUP_INTERVAL_TICKS * 2; i++) {
				service.onTick();
			}

			expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(2);
		});
	});

	describe('sweep - direct invocation', () => {
		it('sweep() bypasses the tick counter and runs immediately', () => {
			const registry = makeMockRegistry({ sweepStaleScheduledKeys: vi.fn(() => 0) });
			const tracker = makeMockTracker({ getActiveTrackerKeys: vi.fn(() => []) });
			const deps = makeDeps({ registry, fanInTracker: tracker });
			const service = createCueCleanupService(deps);

			// No ticks fired - sweep still runs when called directly
			service.sweep();

			expect(tracker.getActiveTrackerKeys).toHaveBeenCalledTimes(1);
			expect(registry.sweepStaleScheduledKeys).toHaveBeenCalledTimes(1);
		});
	});
});

// ===== from src/__tests__/main/cue/cue-output-filter.test.ts =====

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'process it',
		...overrides,
	};
}

function makeCompletion(overrides: Partial<FanInSourceCompletion> = {}): FanInSourceCompletion {
	return {
		sessionId: 'id-a',
		sessionName: 'Agent A',
		output: 'a-output',
		truncated: false,
		chainDepth: 0,
		...overrides,
	};
}

describe('buildFilteredOutputs', () => {
	describe('default (no filters)', () => {
		it('includes every completion when include_output_from is unset', () => {
			const completions = [makeCompletion()];
			const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub()
			);
			expect(outputCompletions).toEqual(completions);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a-output' });
			expect(forwardedOutputs).toEqual({});
		});

		it('forwards nothing when forward_output_from is unset', () => {
			const completions = [makeCompletion()];
			const { forwardedOutputs } = buildFilteredOutputs(completions, makeSub());
			expect(forwardedOutputs).toEqual({});
		});
	});

	describe('include_output_from', () => {
		it('includes only listed sources (by sessionName)', () => {
			const completions = [
				makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: ['Agent A'] })
			);
			expect(outputCompletions.map((c) => c.sessionName)).toEqual(['Agent A']);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
		});

		it('includes listed sources by sessionId as well', () => {
			const completions = [
				makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: ['id-b'] })
			);
			expect(perSourceOutputs).toEqual({ 'Agent B': 'b' });
		});

		it('returns empty maps when include_output_from is an empty array', () => {
			const completions = [makeCompletion()];
			const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: [] })
			);
			expect(outputCompletions).toEqual([]);
			expect(perSourceOutputs).toEqual({});
		});
	});

	describe('forward_output_from', () => {
		it('forwards only listed sources', () => {
			const completions = [
				makeCompletion({ sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ forward_output_from: ['Agent A'] })
			);
			expect(forwardedOutputs).toEqual({ 'Agent A': 'a' });
		});

		it('is independent of include_output_from (forward-only source is excluded from prompt)', () => {
			const completions = [
				makeCompletion({ sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub({
					include_output_from: ['Agent A'],
					forward_output_from: ['Agent B'],
				})
			);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
			expect(forwardedOutputs).toEqual({ 'Agent B': 'b' });
		});
	});
});

describe('mergeUpstreamForwarded', () => {
	it('returns the original map when upstream is undefined', () => {
		const base = { 'Agent A': 'a' };
		expect(mergeUpstreamForwarded(base, undefined, makeSub())).toEqual(base);
	});

	it('passes all upstream keys through when forward_output_from is unset', () => {
		const merged = mergeUpstreamForwarded({}, { 'Agent X': 'x', 'Agent Y': 'y' }, makeSub());
		expect(merged).toEqual({ 'Agent X': 'x', 'Agent Y': 'y' });
	});

	it('filters upstream keys by forward_output_from when set', () => {
		const merged = mergeUpstreamForwarded(
			{},
			{ 'Agent X': 'x', 'Agent Y': 'y' },
			makeSub({ forward_output_from: ['Agent X'] })
		);
		expect(merged).toEqual({ 'Agent X': 'x' });
	});

	it('preserves base entries when merging', () => {
		const merged = mergeUpstreamForwarded(
			{ 'Agent A': 'a' },
			{ 'Agent X': 'x' },
			makeSub({ forward_output_from: ['Agent A', 'Agent X'] })
		);
		expect(merged).toEqual({ 'Agent A': 'a', 'Agent X': 'x' });
	});
});
