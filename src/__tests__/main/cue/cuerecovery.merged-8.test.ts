// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-recovery-service.test.ts
//   - src/__tests__/main/cue/cue-auth-detector.test.ts

import { detectCueAuthFailure, reportCueAuthFailure } from '../../../main/cue/cue-auth-detector';
import {
	EVENT_PRUNE_AGE_MS,
	SLEEP_THRESHOLD_MS,
	createCueRecoveryService,
} from '../../../main/cue/cue-recovery-service';
import type { CueConfig, CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { CueRunResult } from '../../../shared/cue/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: (...args: unknown[]) => mockInitCueDb(...args),
	closeCueDb: () => mockCloseCueDb(),
	pruneCueEvents: (...args: unknown[]) => mockPruneCueEvents(...args),
	getLastHeartbeat: () => mockGetLastHeartbeat(),
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: {
		markAuthRequired: (...args: unknown[]) => markAuthRequired(...args),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), cue: vi.fn() },
}));

// ===== from src/__tests__/main/cue/cue-recovery-service.test.ts =====

const mockInitCueDb = vi.fn();

const mockCloseCueDb = vi.fn();

const mockPruneCueEvents = vi.fn();

const mockGetLastHeartbeat = vi.fn<() => number | null>();

const mockCaptureException = vi.fn();

function baseConfig(subscriptions: CueSubscription[]): CueConfig {
	return {
		subscriptions,
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
	};
}

describe('cue-recovery-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('init', () => {
		it('returns ok and initializes the DB + prunes events', () => {
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(true);
			expect(mockInitCueDb).toHaveBeenCalledOnce();
			expect(mockPruneCueEvents).toHaveBeenCalledWith(EVENT_PRUNE_AGE_MS);
		});

		it('prunes with the user configured retention window', () => {
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
				getCueHistoryRetentionDays: () => 30,
			});

			service.init();

			expect(mockPruneCueEvents).toHaveBeenCalledWith(30 * 24 * 60 * 60 * 1000);
		});

		it('falls back to EVENT_PRUNE_AGE_MS when the setting is unusable', () => {
			// 0 would mean "delete every row" - the resolver must swallow it.
			for (const bad of [undefined, 0, -1, NaN, 'abc']) {
				mockPruneCueEvents.mockClear();
				const service = createCueRecoveryService({
					onLog: vi.fn(),
					getSessions: () => new Map(),
					onDispatch: vi.fn(),
					getCueHistoryRetentionDays: () => bad,
				});

				service.init();

				expect(mockPruneCueEvents).toHaveBeenCalledWith(EVENT_PRUNE_AGE_MS);
			}
		});

		it('re-reads the setting on every init so a change needs no app restart', () => {
			let days: unknown = 7;
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
				getCueHistoryRetentionDays: () => days,
			});

			service.init();
			days = 21;
			service.init();

			expect(mockPruneCueEvents).toHaveBeenNthCalledWith(1, 7 * 24 * 60 * 60 * 1000);
			expect(mockPruneCueEvents).toHaveBeenNthCalledWith(2, 21 * 24 * 60 * 60 * 1000);
		});

		it('returns ok=false and logs/captures when DB init throws', () => {
			const dbError = new Error('disk full');
			mockInitCueDb.mockImplementation(() => {
				throw dbError;
			});
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe(dbError);
			}
			expect(onLog).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('Failed to initialize Cue database')
			);
			expect(mockCaptureException).toHaveBeenCalledWith(
				dbError,
				expect.objectContaining({ extra: { operation: 'cue.dbInit' } })
			);
			// pruneCueEvents must NOT be called after init failed.
			expect(mockPruneCueEvents).not.toHaveBeenCalled();
		});

		it('wraps non-Error throw values in an Error', () => {
			mockInitCueDb.mockImplementation(() => {
				throw 'plain string failure';
			});
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBeInstanceOf(Error);
				expect(result.error.message).toBe('plain string failure');
			}
		});
	});

	describe('detectSleepAndReconcile', () => {
		it('does nothing when there is no last heartbeat (first ever start)', () => {
			mockGetLastHeartbeat.mockReturnValue(null);
			const onDispatch = vi.fn();
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onDispatch).not.toHaveBeenCalled();
		});

		it('does nothing when the gap is below the sleep threshold', () => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			// Gap of just 1 minute - well under SLEEP_THRESHOLD_MS (2 minutes).
			mockGetLastHeartbeat.mockReturnValue(now - 60_000);

			const onDispatch = vi.fn();
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () =>
					new Map([
						[
							's1',
							{
								config: baseConfig([
									{
										name: 'beat',
										event: 'time.heartbeat',
										enabled: true,
										prompt: 'tick',
										interval_minutes: 1,
									},
								]),
								sessionName: 'Test',
							},
						],
					]),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onDispatch).not.toHaveBeenCalled();
			expect(onLog).not.toHaveBeenCalledWith('cue', expect.stringContaining('Sleep detected'));
		});

		it('dispatches a catch-up event for each missed time.heartbeat subscription', () => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			// 10-minute gap - well over both the threshold and the 1-min interval.
			mockGetLastHeartbeat.mockReturnValue(now - 10 * 60_000);

			const onDispatch =
				vi.fn<(sessionId: string, sub: CueSubscription, event: CueEvent) => void>();
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () =>
					new Map([
						[
							's1',
							{
								config: baseConfig([
									{
										name: 'beat',
										event: 'time.heartbeat',
										enabled: true,
										prompt: 'tick',
										interval_minutes: 1,
									},
								]),
								sessionName: 'Test',
							},
						],
					]),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Sleep detected'));
			expect(onDispatch).toHaveBeenCalledOnce();
			const [sessionId, sub, event] = onDispatch.mock.calls[0];
			expect(sessionId).toBe('s1');
			expect(sub.name).toBe('beat');
			expect(event.type).toBe('time.heartbeat');
			expect(event.payload).toMatchObject({
				reconciled: true,
				missedCount: 10,
			});
		});

		it('survives errors thrown by getLastHeartbeat', () => {
			mockGetLastHeartbeat.mockImplementation(() => {
				throw new Error('db read failed');
			});
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			expect(() => service.detectSleepAndReconcile()).not.toThrow();
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('Sleep detection failed'));
		});

		it('uses the documented sleep threshold value', () => {
			expect(SLEEP_THRESHOLD_MS).toBe(120_000);
		});
	});

	describe('shutdown', () => {
		it('closes the DB', () => {
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			service.shutdown();

			expect(mockCloseCueDb).toHaveBeenCalledOnce();
		});

		it('does not throw when DB close fails (e.g. never initialized)', () => {
			mockCloseCueDb.mockImplementation(() => {
				throw new Error('not open');
			});
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			expect(() => service.shutdown()).not.toThrow();
		});
	});
});

// ===== from src/__tests__/main/cue/cue-auth-detector.test.ts =====

const markAuthRequired = vi.fn();

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'agent-1',
		sessionName: 'Nightly Triage',
		subscriptionName: 'triage',
		event: {
			id: 'evt-1',
			type: 'time.interval',
			timestamp: 1755000000000,
			triggerName: 'nightly',
			payload: {},
		} as unknown as CueRunResult['event'],
		status: 'failed',
		stdout: '',
		stderr: '',
		exitCode: 1,
		durationMs: 120,
		startedAt: '2026-08-18T00:00:00.000Z',
		endedAt: '2026-08-18T00:00:01.000Z',
		...overrides,
	};
}

describe('detectCueAuthFailure', () => {
	it('detects an expired OAuth token on stderr', () => {
		const message = detectCueAuthFailure(
			makeResult({ stderr: 'OAuth token has expired. Please run /login.' }),
			'claude-code'
		);
		expect(message).toBeTruthy();
		// The bank names the problem and stops there - the remedy belongs to the
		// surface that shows it, which is the only place that knows whether this
		// agent signs in at all.
		expect(message).toMatch(/sign in|log in|authenticat/i);
	});

	it('detects an auth failure that only appears on stdout', () => {
		const message = detectCueAuthFailure(
			makeResult({ stdout: '{"type":"error","message":"authentication_error"}' }),
			'claude-code'
		);
		expect(message).toBeTruthy();
	});

	it('finds an auth failure at the tail of a long run', () => {
		const message = detectCueAuthFailure(
			makeResult({ stdout: `${'x'.repeat(50000)}\nOAuth token has expired` }),
			'claude-code'
		);
		expect(message).toBeTruthy();
	});

	it('ignores a completed run even when its output mentions authentication', () => {
		expect(
			detectCueAuthFailure(
				makeResult({ status: 'completed', stdout: 'I fixed the authentication_error in auth.ts' }),
				'claude-code'
			)
		).toBeNull();
	});

	it('returns null for an unrelated failure', () => {
		expect(
			detectCueAuthFailure(
				makeResult({ stderr: 'ENOENT: no such file or directory' }),
				'claude-code'
			)
		).toBeNull();
	});
});

describe('reportCueAuthFailure', () => {
	beforeEach(() => {
		markAuthRequired.mockClear();
	});

	function makeWindow() {
		return {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send: vi.fn() },
		};
	}

	it('marks the agent as needing auth and notifies the renderer', () => {
		const win = makeWindow();
		const detected = reportCueAuthFailure(
			win as never,
			makeResult({ stderr: 'OAuth token has expired' }),
			'claude-code'
		);

		expect(detected).toBe(true);
		expect(markAuthRequired).toHaveBeenCalledWith('claude-code', expect.any(String), undefined);
		expect(win.webContents.send).toHaveBeenCalledWith(
			'agent:authExpired',
			expect.objectContaining({ sessionId: 'agent-1', agentId: 'claude-code', fromPipeline: true })
		);
	});

	it('attributes the failure to the SSH remote when the run was remote', () => {
		const win = makeWindow();
		reportCueAuthFailure(
			win as never,
			makeResult({ stderr: 'OAuth token has expired' }),
			'claude-code',
			'remote-uuid'
		);
		expect(markAuthRequired).toHaveBeenCalledWith('claude-code', expect.any(String), 'remote-uuid');
	});

	it('does nothing for a run that did not fail on auth', () => {
		const win = makeWindow();
		expect(
			reportCueAuthFailure(win as never, makeResult({ stderr: 'timeout' }), 'claude-code')
		).toBe(false);
		expect(markAuthRequired).not.toHaveBeenCalled();
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	it('still reports detection when there is no renderer to notify', () => {
		expect(
			reportCueAuthFailure(null, makeResult({ stderr: 'OAuth token has expired' }), 'claude-code')
		).toBe(true);
		expect(markAuthRequired).toHaveBeenCalled();
	});

	// Deduplication belongs to the renderer's auth-outage store, which groups
	// every blocked agent into ONE prompt. Suppressing repeats here instead
	// would drop agents off that roster, and an agent that is never reported is
	// never resumed - so every failure is reported, every time.
	it('reports every blocked agent rather than deduplicating', () => {
		const win = makeWindow();
		const failure = makeResult({ stderr: 'OAuth token has expired' });

		expect(reportCueAuthFailure(win as never, failure, 'claude-code')).toBe(true);
		expect(
			reportCueAuthFailure(win as never, { ...failure, sessionId: 'agent-2' }, 'claude-code')
		).toBe(true);

		expect(win.webContents.send).toHaveBeenCalledTimes(2);
		expect(
			win.webContents.send.mock.calls.map(
				(call: unknown[]) => (call[1] as { sessionId: string }).sessionId
			)
		).toEqual(['agent-1', 'agent-2']);
	});

	it('tells the renderer which SSH remote expired so it groups separately', () => {
		const win = makeWindow();
		reportCueAuthFailure(
			win as never,
			makeResult({ stderr: 'OAuth token has expired' }),
			'claude-code',
			'remote-uuid'
		);

		expect(win.webContents.send).toHaveBeenCalledWith(
			'agent:authExpired',
			expect.objectContaining({ sshRemoteId: 'remote-uuid' })
		);
	});
});
