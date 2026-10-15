// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-concurrency.test.ts
//   - src/__tests__/main/cue/cue-session-registry.test.ts
//   - src/__tests__/main/cue/cue-text-utils.test.ts

import { CueEngine } from '../../../main/cue/cue-engine';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import type { CueSessionRegistry } from '../../../main/cue/cue-session-registry';
import type { SessionState } from '../../../main/cue/cue-session-state';
import {
	MAX_HISTORY_RESPONSE_LENGTH,
	buildCuePersistedOutput,
	sliceHeadByChars,
	sliceTailByChars,
} from '../../../main/cue/cue-text-utils';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import { createMockConfig, createMockDeps, createMockSession } from './cue-test-helpers';
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

// ===== from src/__tests__/main/cue/cue-concurrency.test.ts =====

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();

const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();

describe('CueEngine Concurrency Control', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;
	let fileWatcherCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

		fileWatcherCleanup = vi.fn();
		mockCreateCueFileWatcher.mockReturnValue(fileWatcherCleanup);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('max_concurrent enforcement', () => {
		it('allows dispatching when below max_concurrent', async () => {
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 3,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Initial fire should dispatch (1/3 concurrent)
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('queues events when at max_concurrent limit', async () => {
			// Create a never-resolving onCueRun to keep runs active
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			// Allow the initial fire to start (never completes)
			await vi.advanceTimersByTimeAsync(10);

			// First call dispatched
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Trigger another interval - should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);
			// Still only 1 call - the second was queued
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Verify queue has an entry
			const queueStatus = engine.getQueueStatus();
			expect(queueStatus.get('session-1')).toBe(1);

			engine.stopAll();
			engine.stop();
		});

		it('logs queue activity with correct format', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 5,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			// Trigger another interval - should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Event queued for "Test Session"')
			);
			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('1/5 in queue'));

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue draining', () => {
		it('dequeues and dispatches when a slot frees up', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createMockDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Trigger another - should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			// Complete the first run - should drain the queue
			resolveRun!({
				runId: 'r1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(10);

			// The queued event should now be dispatched
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			// Queue should be empty
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue overflow', () => {
		it('drops oldest entry when queue is full', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 2,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			// Fill the queue (size 2)
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 1
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 2

			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// Overflow - should drop oldest
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: still 2, but oldest dropped

			expect(engine.getQueueStatus().get('session-1')).toBe(2);
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Queue full for "Test Session", dropping oldest event')
			);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('stale event eviction', () => {
		it('drops stale events during drain', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createMockDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 1, // 1 minute timeout
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Queue an event
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			// Wait long enough for the queued event to become stale (> 1 minute)
			vi.advanceTimersByTime(2 * 60 * 1000);

			// Complete the first run - drain should evict the stale event
			resolveRun!({
				runId: 'r1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(10);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Dropping stale queued event'),
				expect.objectContaining({ type: 'queueDropped', reason: 'stale' })
			);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue cleanup', () => {
		it('stopAll clears all queues', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.stopAll();
			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('removeSession clears queue for that session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.removeSession('session-1');
			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('engine stop clears all queues', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.stop();
			expect(engine.getQueueStatus().size).toBe(0);
		});
	});

	describe('stopRun concurrency slot release', () => {
		it('stopRun frees the concurrency slot so queued events dispatch immediately', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})), // Never resolves
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			// First run starts immediately
			await vi.advanceTimersByTimeAsync(10);
			expect(engine.getActiveRuns()).toHaveLength(1);

			// Second event gets queued (max_concurrent = 1)
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			// Stop the active run - should free the slot and drain the queue
			const activeRun = engine.getActiveRuns()[0];
			engine.stopRun(activeRun.runId);

			// The queued event should have been dispatched (onCueRun called again)
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('clearQueue', () => {
		it('clears queued events for a specific session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			engine.clearQueue('session-1');
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});

		it('preserves app.startup events when preserveStartup is true', async () => {
			// Use a never-resolving onCueRun so the first run stays in-flight
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'startup-a',
						event: 'app.startup',
						enabled: true,
						prompt: 'first startup',
					},
					{
						name: 'startup-b',
						event: 'app.startup',
						enabled: true,
						prompt: 'second startup',
					},
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'heartbeat',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start('system-boot');

			// Heartbeat fires immediately and takes the slot.
			// Both startup-a and startup-b are queued (max_concurrent=1).
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// Advance time to queue another heartbeat event
			vi.advanceTimersByTime(60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(3);

			// clearQueue with preserveStartup=true should keep only the 2 startup events
			engine.clearQueue('session-1', true);
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// clearQueue without preserveStartup should wipe everything
			engine.clearQueue('session-1');
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('getQueueStatus', () => {
		it('returns empty map when no events are queued', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('returns correct count per session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);

			expect(engine.getQueueStatus().get('session-1')).toBe(3);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('multi-concurrent slots', () => {
		it('allows DIFFERENT subscriptions to run concurrently up to max_concurrent', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			// Three distinct subscriptions, each firing on start - they are
			// different roots, so the self-overlap guard does not apply and all
			// three may run in parallel.
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 3,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer-a',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
					{
						name: 'timer-b',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
					{
						name: 'timer-c',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			// All three distinct subscriptions dispatch concurrently (3 slots).
			expect(deps.onCueRun).toHaveBeenCalledTimes(3);
			expect(engine.getQueueStatus().size).toBe(0); // Nothing queued

			engine.stopAll();
			engine.stop();
		});

		it('serializes the SAME subscription even when slots are free (no self-overlap)', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			// A single subscription at max_concurrent: 3. Even though slots are
			// free, repeated firings of the SAME root must NOT overlap - the
			// re-trigger is queued and runs only after the in-flight one finishes.
			// This is the regression guard for the "double-fire" bug.
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 3,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1); // Initial fire

			// Two more ticks of the SAME subscription - both queue rather than
			// dispatching into the 2 free slots.
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1); // still only the first run
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('stress scenarios', () => {
		it('processes multiple queued events in FIFO order', async () => {
			const resolvers: ((val: CueRunResult) => void)[] = [];
			const callOrder: number[] = [];
			let callCount = 0;

			const deps = createMockDeps({
				onCueRun: vi.fn(() => {
					const idx = callCount++;
					callOrder.push(idx);
					return new Promise<CueRunResult>((resolve) => {
						resolvers.push(resolve);
					});
				}),
			});

			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			// Initial heartbeat occupies the slot
			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Queue several events via timer advances
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 1
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 2
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 3
			expect(engine.getQueueStatus().get('session-1')).toBe(3);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1); // still only 1 dispatched

			// Resolve the first run -> drain dispatches next queued event
			const makeResult = (runId: string): CueRunResult => ({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});

			resolvers[0](makeResult('r0'));
			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			// Resolve second -> third dispatched
			resolvers[1](makeResult('r1'));
			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(3);

			// Resolve third -> fourth dispatched
			resolvers[2](makeResult('r2'));
			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(4);

			// Verify events dispatched in sequential order
			expect(callOrder).toEqual([0, 1, 2, 3]);

			engine.stopAll();
			engine.stop();
		});

		it('all queued events become stale and are dropped', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createMockDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});

			const config = createMockConfig({
				settings: {
					timeout_minutes: 1, // 1 minute timeout
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			// First run occupies the slot
			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Queue several events
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 1
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 2
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// Advance time past timeout so all queued events become stale (>1 minute)
			vi.advanceTimersByTime(3 * 60 * 1000);

			// Resolve the in-flight run -> drain should evict all queued events as stale
			resolveRun!({
				runId: 'r1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(10);

			// All stale events should have been dropped
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Dropping stale queued event'),
				expect.objectContaining({ type: 'queueDropped', reason: 'stale' })
			);

			engine.stopAll();
			engine.stop();
		});

		it('enable/disable toggle during queue drain does not crash', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});

			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			// Queue some events
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// Stop engine mid-drain - should not crash
			expect(() => {
				engine.stop();
			}).not.toThrow();

			// Queue should be cleared
			expect(engine.getQueueStatus().size).toBe(0);
		});
	});
});

// ===== from src/__tests__/main/cue/cue-session-registry.test.ts =====

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	const config: CueConfig = {
		subscriptions: [],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
	};
	return {
		config,
		triggerSources: [],
		yamlWatchers: [],
		sleepPrevented: false,
		...overrides,
	};
}

describe('cue-session-registry', () => {
	let registry: CueSessionRegistry;

	beforeEach(() => {
		registry = createCueSessionRegistry();
	});

	describe('session lifecycle', () => {
		it('register / get / has / size', () => {
			expect(registry.size()).toBe(0);
			expect(registry.has('s1')).toBe(false);
			expect(registry.get('s1')).toBeUndefined();

			const state = makeState();
			registry.register('s1', state);

			expect(registry.size()).toBe(1);
			expect(registry.has('s1')).toBe(true);
			expect(registry.get('s1')).toBe(state);
		});

		it('unregister removes a session', () => {
			registry.register('s1', makeState());
			registry.register('s2', makeState());

			registry.unregister('s1');

			expect(registry.has('s1')).toBe(false);
			expect(registry.has('s2')).toBe(true);
			expect(registry.size()).toBe(1);
		});

		it('snapshot returns a defensive copy of the session map', () => {
			const stateA = makeState();
			const stateB = makeState();
			registry.register('s1', stateA);
			registry.register('s2', stateB);

			const snapshot = registry.snapshot();
			expect(snapshot.size).toBe(2);
			expect(snapshot.get('s1')).toBe(stateA);
			expect(snapshot.get('s2')).toBe(stateB);

			// Mutating the snapshot does NOT affect the registry.
			snapshot.delete('s1');
			expect(registry.has('s1')).toBe(true);
		});
	});

	describe('time.scheduled dedup', () => {
		it('markScheduledFired returns true on first fire, false on duplicate', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
		});

		it('different time slots are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(true);
		});

		it('different sessions are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s2', 'sub-1', '09:00')).toBe(true);
		});

		it('different sub names are independent', () => {
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
		});

		it('evictStaleScheduledKeys removes keys for the same (session, sub) with non-current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markScheduledFired('s1', 'sub-1', '10:00');

			registry.evictStaleScheduledKeys('s1', 'sub-1', '10:00');

			// 08:00 and 09:00 are evicted; 10:00 stays - re-firing 10:00 must still be deduped.
			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '10:00')).toBe(false);
		});

		it('evictStaleScheduledKeys does not touch other sessions or subs', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s2', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-2', '08:00');

			registry.evictStaleScheduledKeys('s1', 'sub-1', '09:00');

			// Only s1:sub-1 is evicted.
			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
			expect(registry.markScheduledFired('s1', 'sub-2', '08:00')).toBe(false);
		});

		it('clearScheduledForSession drops all scheduled keys for that session', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:00');
			registry.markScheduledFired('s1', 'sub-2', '09:00');
			registry.markScheduledFired('s2', 'sub-1', '08:00');

			registry.clearScheduledForSession('s1');

			expect(registry.markScheduledFired('s1', 'sub-1', '08:00')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-2', '09:00')).toBe(true);
			// s2 untouched
			expect(registry.markScheduledFired('s2', 'sub-1', '08:00')).toBe(false);
		});
	});

	describe('app.startup dedup', () => {
		it('markStartupFired returns true on first fire, false on duplicate', () => {
			expect(registry.markStartupFired('s1', 'init')).toBe(true);
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
		});

		it('different sessions are independent', () => {
			expect(registry.markStartupFired('s1', 'init')).toBe(true);
			expect(registry.markStartupFired('s2', 'init')).toBe(true);
		});

		it("clearStartupForSession drops only that session's startup keys", () => {
			registry.markStartupFired('s1', 'init-a');
			registry.markStartupFired('s1', 'init-b');
			registry.markStartupFired('s2', 'init-a');

			registry.clearStartupForSession('s1');

			expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
			expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
			// s2 untouched
			expect(registry.markStartupFired('s2', 'init-a')).toBe(false);
		});
	});

	describe('clearAllStartupKeys', () => {
		it('clears all startup fired-keys so subsequent fires are allowed', () => {
			registry.markStartupFired('s1', 'init-a');
			registry.markStartupFired('s1', 'init-b');
			registry.markStartupFired('s2', 'init-a');

			registry.clearAllStartupKeys();

			expect(registry.markStartupFired('s1', 'init-a')).toBe(true);
			expect(registry.markStartupFired('s1', 'init-b')).toBe(true);
			expect(registry.markStartupFired('s2', 'init-a')).toBe(true);
		});

		it('does not affect sessions, scheduled keys, or session state', () => {
			registry.register('s1', makeState());
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markStartupFired('s1', 'init');

			registry.clearAllStartupKeys();

			expect(registry.has('s1')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false); // still deduped
		});
	});

	describe('clear', () => {
		it('drops all sessions and time.scheduled keys but PRESERVES startup keys', () => {
			registry.register('s1', makeState());
			registry.register('s2', makeState());
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			registry.markStartupFired('s1', 'init');
			registry.markStartupFired('s2', 'init');

			registry.clear();

			// Sessions are gone.
			expect(registry.size()).toBe(0);
			expect(registry.has('s1')).toBe(false);

			// Scheduled keys are gone - re-firing the same slot succeeds.
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);

			// Startup keys are PRESERVED - re-firing must be deduped. This is the
			// regression target: toggling Cue off/on must NOT re-fire app.startup.
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
			expect(registry.markStartupFired('s2', 'init')).toBe(false);
		});

		it('clear is idempotent', () => {
			registry.register('s1', makeState());
			registry.clear();
			registry.clear();
			expect(registry.size()).toBe(0);
		});
	});

	describe('sweepStaleScheduledKeys', () => {
		it('returns 0 and does nothing when no keys exist', () => {
			const evicted = registry.sweepStaleScheduledKeys('09:00');
			expect(evicted).toBe(0);
		});

		it('does not evict a key that matches the current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			const evicted = registry.sweepStaleScheduledKeys('09:00');
			expect(evicted).toBe(0);
			// Key still in set - re-firing is still deduped
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(false);
		});

		it('evicts keys whose time component differs from the current time', () => {
			registry.markScheduledFired('s1', 'sub-1', '08:59');
			registry.markScheduledFired('s1', 'sub-1', '09:00');
			// At 09:01 - the 08:59 key is stale, the 09:00 key is also stale
			const evicted = registry.sweepStaleScheduledKeys('09:01');
			expect(evicted).toBe(2);
			// After eviction, both slots can fire again
			expect(registry.markScheduledFired('s1', 'sub-1', '08:59')).toBe(true);
			expect(registry.markScheduledFired('s1', 'sub-1', '09:00')).toBe(true);
		});

		it('evicts stale keys across multiple sessions and subscriptions', () => {
			registry.markScheduledFired('s1', 'sub-a', '10:00');
			registry.markScheduledFired('s2', 'sub-b', '10:00');
			registry.markScheduledFired('s1', 'sub-a', '10:01');
			const evicted = registry.sweepStaleScheduledKeys('10:01');
			// The two 10:00 keys are stale; the 10:01 key is current
			expect(evicted).toBe(2);
		});

		it('does not affect startup fired keys', () => {
			registry.markStartupFired('s1', 'init');
			registry.sweepStaleScheduledKeys('09:00');
			// Startup key is unaffected - still deduped
			expect(registry.markStartupFired('s1', 'init')).toBe(false);
		});
	});
});

// ===== from src/__tests__/main/cue/cue-text-utils.test.ts =====

// A supplementary-plane code point (U+1F600 😀) encodes as the surrogate pair
// D83D DE00 - two UTF-16 code units. A naive `.slice()` that lands between
// them produces a lone surrogate that downstream consumers see as garbage.
const EMOJI = '😀';
// 2 code units
const TREE = '🌳';
// 2 code units
const HEART = '❤';
// 1 code unit

describe('sliceTailByChars', () => {
	it('returns the full string when shorter than max', () => {
		expect(sliceTailByChars('hello', 10)).toBe('hello');
	});

	it('returns the full string when exactly equal to max', () => {
		expect(sliceTailByChars('hello', 5)).toBe('hello');
	});

	it('returns empty string for maxChars <= 0', () => {
		expect(sliceTailByChars('hello', 0)).toBe('');
		expect(sliceTailByChars('hello', -1)).toBe('');
	});

	it('returns empty string for empty input', () => {
		expect(sliceTailByChars('', 5)).toBe('');
	});

	it('returns the last N ASCII chars when plain text', () => {
		expect(sliceTailByChars('abcdefghij', 3)).toBe('hij');
	});

	it('does not split a surrogate pair at the start of the slice', () => {
		// "ab" + "😀" → len 4 (a=1, b=1, 😀=2). slice(-3) would start at index 1,
		// landing on the b; slice(-2) lands on the high surrogate of 😀; slice(-1)
		// lands on the low surrogate and must shift forward to return just "".
		const input = 'ab' + EMOJI;
		const low = sliceTailByChars(input, 1);
		// The tail was a lone low surrogate; helper must strip it rather than
		// emit a broken half-emoji.
		expect(low).not.toMatch(/[\uDC00-\uDFFF]/);
	});

	it('includes the full emoji when the slice boundary lands exactly on the high surrogate', () => {
		// slice(-2) on "ab😀" lands on 😀's high surrogate - the whole emoji
		// fits, so the helper should return it intact.
		const input = 'ab' + EMOJI;
		expect(sliceTailByChars(input, 2)).toBe(EMOJI);
	});

	it('preserves adjacent emojis when they both fit', () => {
		const input = 'xx' + EMOJI + TREE; // 2 + 2 + 2 = 6 units
		expect(sliceTailByChars(input, 4)).toBe(EMOJI + TREE);
	});

	it('handles BMP characters (single code units) unchanged', () => {
		const input = 'x' + HEART + 'y'; // each is 1 unit
		expect(sliceTailByChars(input, 2)).toBe(HEART + 'y');
	});

	it('handles a string of only emoji', () => {
		const input = EMOJI + EMOJI + EMOJI;
		const result = sliceTailByChars(input, 3);
		// Must not start with a lone low surrogate
		expect(result).not.toMatch(/^[\uDC00-\uDFFF]/);
	});
});

describe('sliceHeadByChars', () => {
	it('returns the full string when shorter than max', () => {
		expect(sliceHeadByChars('hello', 10)).toBe('hello');
	});

	it('returns empty string for maxChars <= 0', () => {
		expect(sliceHeadByChars('hello', 0)).toBe('');
		expect(sliceHeadByChars('hello', -1)).toBe('');
	});

	it('returns empty string for empty input', () => {
		expect(sliceHeadByChars('', 5)).toBe('');
	});

	it('returns the first N ASCII chars', () => {
		expect(sliceHeadByChars('abcdefghij', 3)).toBe('abc');
	});

	it('does not split a surrogate pair at the end of the slice', () => {
		// "a" + "😀" + "b" → boundaries at 1,3,4. slice(0,2) lands between the
		// high and low surrogates - helper must step back to "a".
		const input = 'a' + EMOJI + 'b';
		const result = sliceHeadByChars(input, 2);
		expect(result).toBe('a');
		expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
	});

	it('includes the full emoji when it just fits', () => {
		const input = 'a' + EMOJI + 'b';
		expect(sliceHeadByChars(input, 3)).toBe('a' + EMOJI);
	});

	it('handles a string of only emoji', () => {
		const input = EMOJI + EMOJI + EMOJI;
		const result = sliceHeadByChars(input, 3);
		// Must not end with a lone high surrogate
		expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
	});

	it('handles BMP characters (single code units) unchanged', () => {
		const input = HEART + HEART + HEART;
		expect(sliceHeadByChars(input, 2)).toBe(HEART + HEART);
	});
});

describe('buildCuePersistedOutput', () => {
	it('returns null for both fields when the run printed nothing', () => {
		// NULL (not '') is what makes `WHERE output_excerpt IS NOT NULL` the
		// noise filter on cue_events - a heartbeat that says nothing must not
		// leave a row that looks like it has something to read.
		expect(buildCuePersistedOutput({ stdout: '', stderr: '' })).toEqual({
			excerpt: null,
			fullOutput: null,
		});
	});

	it('treats whitespace-only output as silent', () => {
		expect(buildCuePersistedOutput({ stdout: '   \n\t ', stderr: '' }).excerpt).toBeNull();
	});

	it('excerpts stdout for a chatty run and carries the full output', () => {
		const { excerpt, fullOutput } = buildCuePersistedOutput({
			stdout: 'Reviewed 3 PRs. Merged the docs fix.',
			stderr: '',
		});
		expect(excerpt).toBe('Reviewed 3 PRs. Merged the docs fix.');
		expect(fullOutput).toBe('Reviewed 3 PRs. Merged the docs fix.');
	});

	it('falls back to stderr for the excerpt when stdout is empty', () => {
		// A failed run kept for its error output must not be reduced to a bare
		// trigger label. fullOutput stays null - stderr has its own column.
		const { excerpt, fullOutput } = buildCuePersistedOutput({
			stdout: '',
			stderr: 'Agent exited with status 3.',
		});
		expect(excerpt).toBe('Agent exited with status 3.');
		expect(fullOutput).toBeNull();
	});

	it('head-truncates full output at the persisted cap', () => {
		const long = 'x'.repeat(MAX_HISTORY_RESPONSE_LENGTH + 500);
		const { fullOutput } = buildCuePersistedOutput({ stdout: long, stderr: '' });
		expect(fullOutput).toHaveLength(MAX_HISTORY_RESPONSE_LENGTH);
	});

	it('strips ANSI codes out of the excerpt', () => {
		const { excerpt } = buildCuePersistedOutput({
			stdout: '\u001b[32mBuild passed.\u001b[0m',
			stderr: '',
		});
		expect(excerpt).toBe('Build passed.');
	});
});
