// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useRetryStore, noteRetryProgress } from '../../../../../renderer/stores/retryStore';
import { DEFAULT_BATCH_STATE } from '../../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState, LogEntry } from '../../../../../renderer/types';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useAgentThinkingListener } from '../../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { useAgentToolExecutionListener } from '../../../../../renderer/hooks/agent/internal/useAgentToolExecutionListener';
import {
	useThoughtStreamCaptureListener,
	THOUGHT_FLUSH_MS,
} from '../../../../../renderer/hooks/agent/internal/useThoughtStreamCaptureListener';
import { useThoughtStreamStore } from '../../../../../renderer/stores/thoughtStreamStore';

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentExitListener.test.tsx =====
let mockIsWebDesktop = false;
vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop,
}));

let handler: ((sessionId: string, code: number) => Promise<void>) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onExit: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
	getActiveProcesses: vi.fn().mockResolvedValue([]),
};

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		processQueuedItemRef: { current: null },
		addHistoryEntryRef: { current: null },
		spawnBackgroundSynopsisRef: { current: null },
		rightPanelRef: { current: null },
		batchedUpdater: {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
			flushNow: vi.fn(),
		},
		activeHiddenToolRef: makeRef(),
	};
}

describe('useAgentExitListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		mockIsWebDesktop = false;
		useRetryStore.setState({ retries: {}, outages: {} } as any);
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcess,
			stats: { recordQuery: vi.fn().mockResolvedValue(undefined) },
			logger: { log: vi.fn() },
		};
	});

	it('skips terminal-tab format session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-terminal-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('skips batch session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-batch-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('transitions an exiting AI tab to idle', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
		});
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(updated.state).toBe('idle');
	});

	describe('on a web-desktop client', () => {
		// Every process:* event is fanned out to every connected browser, so a
		// web-desktop client must render the exit (tab idle) but never run the
		// one-shot effects the desktop renderer owns: stats row, queue dequeue,
		// synopsis (and with it the History entry), spoken notification.
		beforeEach(() => {
			mockIsWebDesktop = true;
		});

		it('flips the tab idle but records no stats row', async () => {
			const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 1000,
			});
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentExitListener(makeDeps()));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].state).toBe('idle');
			expect(updated.state).toBe('idle');
			expect((window as any).maestro.stats.recordQuery).not.toHaveBeenCalled();
		});

		it('leaves the execution queue intact and dispatches nothing', async () => {
			const tabA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
			const tabB = createMockAITab({ id: 'tab-B', state: 'idle' });
			const itemB = {
				id: 'item-B',
				timestamp: 1,
				tabId: 'tab-B',
				type: 'message' as const,
				text: 'BRAVO',
				readOnlyMode: true,
			};
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-A',
				state: 'busy',
				busySource: 'ai',
				executionQueue: [itemB] as any,
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = makeDeps();
			deps.processQueuedItemRef.current = processQueuedItem as any;

			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-A', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs.find((t) => t.id === 'tab-A')?.state).toBe('idle');
			expect(updated.aiTabs.find((t) => t.id === 'tab-B')?.state).toBe('idle');
			expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-B']);
			expect(updated.state).toBe('idle');
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('never spawns the exit synopsis', async () => {
			const tab = createMockAITab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: 0,
				agentSessionId: 'asid-1',
				logs: [
					{ id: 'l-user', timestamp: 1, source: 'user', text: 'do work' },
					{ id: 'l-tool', timestamp: 2, source: 'tool', text: 'Edit(file.ts)' },
					{ id: 'l-out', timestamp: 3, source: 'stdout', text: 'done' },
				] as any,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
				busySource: 'ai',
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const spawn = vi.fn();
			const addHistory = vi.fn();
			const deps = makeDeps();
			deps.spawnBackgroundSynopsisRef.current = spawn as any;
			deps.addHistoryEntryRef.current = addHistory as any;

			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			expect(spawn).not.toHaveBeenCalled();
			expect(addHistory).not.toHaveBeenCalled();
		});
	});

	it('appends a system log on terminal exit', async () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-terminal', 1);
		});

		const updated = useSessionStore.getState().sessions[0];
		const log = updated.shellLogs[updated.shellLogs.length - 1];
		expect(log?.text).toContain('exited with code 1');
	});

	it('retires a finished orphan and dispatches the next queued item for ANOTHER tab exactly once', async () => {
		// Regression: A is a closed/orphaned tab whose turn just finished. B is a
		// second closed/orphaned tab with a queued read-only message; C is an open
		// tab with a queued read-only message. When A exits, the retire branch must
		// dequeue B's item (in lockstep with the post-reducer spawn) and mark B busy
		// - NOT leave it in the queue. Leaving it queued caused B to run twice (once
		// from queuedItemToProcess at A's exit, again when that run exited) and never
		// surface as busy in the UI.
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const orphanB = createMockAITab({ id: 'tab-B', state: 'idle', agentSessionId: 'asid-B' });
		const tabC = createMockAITab({ id: 'tab-C', state: 'idle' });
		const itemB = {
			id: 'item-B',
			timestamp: 1,
			tabId: 'tab-B',
			type: 'message' as const,
			text: 'BRAVO',
			readOnlyMode: true,
		};
		const itemC = {
			id: 'item-C',
			timestamp: 2,
			tabId: 'tab-C',
			type: 'message' as const,
			text: 'CHARLIE',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tabC],
			orphanedThinkingTabs: [orphanA, orphanB],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [itemB, itemC] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			// queued-item dispatch is fired on a setTimeout(0) after the reducer
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		// A retired; B promoted to busy and dequeued; C still queued.
		expect(updated.orphanedThinkingTabs?.map((t) => t.id)).toEqual(['tab-B']);
		expect(updated.orphanedThinkingTabs?.[0].state).toBe('busy');
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-C']);
		expect(updated.state).toBe('busy');
		// Spawned exactly once, with B's item.
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem.mock.calls[0][1].id).toBe('item-B');
	});

	it('retires a finished orphan with no queued work and goes idle', async () => {
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [createMockAITab({ id: 'tab-C', state: 'idle' })],
			orphanedThinkingTabs: [orphanA],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.orphanedThinkingTabs).toBeUndefined();
		expect(updated.state).toBe('idle');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	// Desktop document/spec-mode Auto Run synopsizes each task from this exit path,
	// which sets up the synopsis and dispatches it via runExitSynopsis (reaching
	// spawnBackgroundSynopsisRef), so the run-scoped model override must reach the
	// synopsis spawn config here for parity with the CLI batch processor.
	function setupSynopsisRun(opts: { sessionCustomModel?: string; runModelOverride?: string }) {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
			agentSessionId: 'asid-1',
			// Auto Run tabs opt into the exit-path synopsis via saveToHistory.
			saveToHistory: true,
			// Thinking on -> tool logs are recorded, so the activity gate trusts the
			// tool log below as evidence of meaningful work.
			showThinking: 'on',
			logs: [
				{ id: 'l-user', timestamp: 1, source: 'user', text: 'do the task' },
				{ id: 'l-tool', timestamp: 2, source: 'tool', text: 'Edit(file.ts)' },
			],
		} as any);
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			customModel: opts.sessionCustomModel,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const spawn = vi.fn().mockResolvedValue({ success: false });
		const deps = makeDeps();
		deps.spawnBackgroundSynopsisRef.current = spawn as any;
		// runExitSynopsis bails before spawning unless a history-entry sink exists.
		deps.addHistoryEntryRef.current = vi.fn() as any;
		// The active run exposes its per-run model override via getBatchStateRef.
		const batchState: BatchRunState = {
			...DEFAULT_BATCH_STATE,
			isRunning: true,
			runModelOverride: opts.runModelOverride,
		};
		deps.getBatchStateRef.current = (() => batchState) as any;
		return { deps, spawn };
	}

	it('spawns the exit-path synopsis under the run model override, not the session model', async () => {
		const { deps, spawn } = setupSynopsisRun({
			sessionCustomModel: 'session-sonnet',
			runModelOverride: 'run-opus',
		});

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		// 6th arg is the synopsis sessionConfig.
		const sessionConfig = spawn.mock.calls[0][5];
		expect(sessionConfig.customModel).toBe('run-opus');
	});

	it('falls back to the session model when the run has no model override', async () => {
		const { deps, spawn } = setupSynopsisRun({
			sessionCustomModel: 'session-sonnet',
			runModelOverride: undefined,
		});

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		const sessionConfig = spawn.mock.calls[0][5];
		expect(sessionConfig.customModel).toBe('session-sonnet');
	});

	// Agent Resilience: the exiting turn failed and a resend is counting down.
	// The reducer must leave the queue alone. Draining it would fail every item
	// against the same provider, and the dispatch would supersede the pending
	// retry (noteDispatch), silently discarding the prompt that is waiting.
	it('holds the execution queue while a retry is counting down', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
		const queued = {
			id: 'item-1',
			timestamp: 1,
			tabId: 'tab-1',
			type: 'message' as const,
			text: 'QUEUED',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queued] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);
		useRetryStore.setState({
			retries: {
				'sess-1:tab-1': {
					sessionId: 'sess-1',
					tabId: 'tab-1',
					key: 'sess-1:tab-1',
					outageId: 'outage-1',
					strategy: { kind: 'fixed', delayMs: 60_000, maxAttempts: 5 },
					mode: 'auto',
					status: 'scheduled',
					attempt: 0,
					startedAt: 0,
					nextRetryAt: 60_000,
					lastMessage: 'overloaded',
				},
			},
		} as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-1']);
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('drains the queue normally once the retry has settled', async () => {
		// Same shape as above with no retry entry: proves the hold is the retry's
		// doing, not the exit code or the read-only flag.
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
		const queued = {
			id: 'item-1',
			timestamp: 1,
			tabId: 'tab-1',
			type: 'message' as const,
			text: 'QUEUED',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queued] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(useSessionStore.getState().sessions[0].executionQueue).toEqual([]);
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('deletes activeHiddenToolRef entry on AI exit', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentThinkingListener.test.tsx =====
vi.mock('../../../../../renderer/stores/retryStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../renderer/stores/retryStore')>()),
	noteRetryProgress: vi.fn(),
}));

let handlerUseAgentThinkingListener: ((sessionId: string, content: string) => void) | undefined;
const mockUnsubscribeUseAgentThinkingListener = vi.fn();

const mockProcessUseAgentThinkingListener = {
	onThinkingChunk: vi.fn((h: any) => {
		handlerUseAgentThinkingListener = h;
		return mockUnsubscribeUseAgentThinkingListener;
	}),
};

let originalRaf: typeof requestAnimationFrame;
let originalCancelRaf: typeof cancelAnimationFrame;
// Map id -> callback so cancelAnimationFrame can actually remove the queued
// callback (matches real browser semantics). A vi.fn() stub here would let a
// post-unmount flushRaf() still fire the callback, masking cleanup bugs.
let scheduled: Map<number, () => void> = new Map();
let nextRafId = 0;
const cancelRafSpy = vi.fn();

function flushRaf() {
	const queued = Array.from(scheduled.values());
	scheduled.clear();
	queued.forEach((cb) => cb());
}

describe('useAgentThinkingListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		cancelRafSpy.mockClear();
		handlerUseAgentThinkingListener = undefined;
		scheduled = new Map();
		nextRafId = 0;
		originalRaf = global.requestAnimationFrame;
		originalCancelRaf = global.cancelAnimationFrame;
		global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			nextRafId += 1;
			const id = nextRafId;
			scheduled.set(id, () => cb(performance.now()));
			return id;
		}) as any;
		global.cancelAnimationFrame = ((id: number) => {
			cancelRafSpy(id);
			scheduled.delete(id);
		}) as any;

		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentThinkingListener,
		};
	});
	afterEach(() => {
		global.requestAnimationFrame = originalRaf;
		global.cancelAnimationFrame = originalCancelRaf;
	});

	it('reports model output to the retry engine even when thinking is hidden', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'Working on it');

		expect(noteRetryProgress).toHaveBeenCalledWith('sess-1', 'tab-1');
	});

	it('subscribes once and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentThinkingListener());
		expect(mockProcessUseAgentThinkingListener.onThinkingChunk).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribeUseAgentThinkingListener).toHaveBeenCalledTimes(1);
	});

	it('appends a thinking log on first chunk and merges on subsequent chunks (RAF-batched)', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'hello ');
		handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'world');

		// Before flush - no log yet.
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);

		flushRaf();

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(tabAfter.logs).toHaveLength(1);
		expect(tabAfter.logs[0].source).toBe('thinking');
		expect(tabAfter.logs[0].text).toBe('hello world');
	});

	it('skips when tab.showThinking is off', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'should not render');
		flushRaf();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	it('cancels pending RAF on unmount and post-unmount flushRaf is a no-op', () => {
		// First mount with no events scheduled - nothing to cancel.
		renderHook(() => useAgentThinkingListener()).unmount();
		expect(cancelRafSpy).not.toHaveBeenCalled();

		// Second mount: schedule a RAF, unmount, then assert flushing the RAF
		// queue does NOT invoke the previously scheduled callback (it was
		// cancelled and removed from the queue).
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		const { unmount } = renderHook(() => useAgentThinkingListener());
		handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'data');
		unmount();
		expect(cancelRafSpy).toHaveBeenCalled();

		flushRaf();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	// Regression: the fast (rAF) writer must not append a thinking log below the
	// turn's answer, which the slow (200ms batched) writer flushed in between.
	describe('stale straggler after the turn answer landed', () => {
		function makeLog(
			source: LogEntry['source'],
			text: string,
			id: string,
			timestamp = 1
		): LogEntry {
			return { id, timestamp, source, text };
		}

		/**
		 * Reproduce the real interleaving: the chunk is buffered FIRST, then the
		 * 200ms batch flushes the answer, then the rAF fires. The stdout log must
		 * therefore carry a timestamp LATER than the moment buffering started -
		 * that ordering is exactly what marks the chunk stale. Placing the answer
		 * with an earlier timestamp would instead model an intermediate assistant
		 * message, which must NOT drop the chunk (see the mid-turn cases below).
		 */
		function landAnswerAfterBuffering(logs: LogEntry[], answerText: string): LogEntry[] {
			return [...logs, makeLog('stdout', answerText, 'answer', Date.now() + 1000)];
		}

		it('drops the chunk when the turn stdout answer landed after buffering', () => {
			const logs = landAnswerAfterBuffering([makeLog('user', 'prompt', 'l1')], 'final answer');
			const tab = createMockAITab({ id: 'tab-1', showThinking: 'on', logs });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'final ans');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs.some((l) => l.source === 'thinking')).toBe(false);
			expect(tabAfter.logs).toEqual(logs);
		});

		// Greptile P1 on PR #1347: claude-code and factory-droid stream at MESSAGE
		// granularity, so an intermediate assistant message flushes as stdout
		// mid-turn and more reasoning legitimately follows it. A source-only guard
		// treated that as the final answer and silenced thinking for the rest of
		// the turn.
		it('still appends reasoning that arrives AFTER an intermediate stdout message', () => {
			const logs = [
				makeLog('user', 'prompt', 'l1'),
				makeLog('stdout', 'intermediate assistant message', 'l2'),
			];
			const tab = createMockAITab({ id: 'tab-1', showThinking: 'on', logs });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			// Buffered AFTER that stdout already existed, so it is new content.
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'more reasoning');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(3);
			expect(tabAfter.logs[2].source).toBe('thinking');
			expect(tabAfter.logs[2].text).toBe('more reasoning');
		});

		it('still appends when the last log is the user prompt (normal turn start)', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'thinking...');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs[1].source).toBe('thinking');
			expect(tabAfter.logs[1].text).toBe('thinking...');
		});

		it('still coalesces into an open thinking log', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1'), makeLog('thinking', 'hello ', 'l2')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'world');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs[1].source).toBe('thinking');
			expect(tabAfter.logs[1].text).toBe('hello world');
		});

		it('drops the stale chunk in sticky mode but keeps existing thinking logs', () => {
			const logs = landAnswerAfterBuffering(
				[makeLog('thinking', 'earlier reasoning', 'l1')],
				'final answer'
			);
			const tab = createMockAITab({ id: 'tab-1', showThinking: 'sticky', logs });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'final ans');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toEqual(logs);
			expect(tabAfter.logs.filter((l) => l.source === 'thinking')).toHaveLength(1);
		});

		it('still appends when the last log is tool activity (thinking resumes mid-turn)', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1'), makeLog('tool', 'Read(file.ts)', 'l2')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handlerUseAgentThinkingListener!('sess-1-ai-tab-1', 'back to thinking');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(3);
			expect(tabAfter.logs[2].source).toBe('thinking');
			expect(tabAfter.logs[2].text).toBe('back to thinking');
		});
	});

	it('ignores non-AI session ids', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handlerUseAgentThinkingListener!('sess-1-terminal', 'data');
		flushRaf();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentToolExecutionListener.test.tsx =====

let handlerUseAgentToolExecutionListener: ((sessionId: string, toolEvent: any) => void) | undefined;
const mockUnsubscribeUseAgentToolExecutionListener = vi.fn();

const mockProcessUseAgentToolExecutionListener = {
	onToolExecution: vi.fn((h: any) => {
		handlerUseAgentToolExecutionListener = h;
		return mockUnsubscribeUseAgentToolExecutionListener;
	}),
};

describe('useAgentToolExecutionListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlerUseAgentToolExecutionListener = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentToolExecutionListener,
		};
	});

	it('reports a tool call to the retry engine', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(noteRetryProgress).toHaveBeenCalledWith('sess-1', 'tab-1');
	});

	it('appends a tool log when targetTab has thinking enabled', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1700000000000,
			toolCallId: 'call-1',
		});

		const updated = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(updated.logs).toHaveLength(1);
		expect(updated.logs[0].source).toBe('tool');
		expect(updated.logs[0].text).toBe('Read');
	});

	it('merges completed event into a previously-running entry by toolCallId', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'completed', output: 'ok' },
			timestamp: 2,
			toolCallId: 'c1',
		});

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(tabAfter.logs).toHaveLength(1);
		expect(tabAfter.logs[0].metadata?.toolState?.status).toBe('completed');
		expect(tabAfter.logs[0].metadata?.toolState?.output).toBe('ok');
	});

	it('records tool events even when showThinking is off (hidden at render)', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('records tool events when showThinking is not set', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('attributes finalising event to most recent running entry without toolCallId', () => {
		const tab = createMockAITab({
			id: 'tab-1',
			showThinking: 'on',
			logs: [
				{
					id: 'tool-prev',
					timestamp: 1,
					source: 'tool',
					text: 'Bash',
					metadata: { toolState: { status: 'running' } },
				},
			],
		});
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'completed' },
			timestamp: 2,
		});

		const updated = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(updated.logs).toHaveLength(1);
		expect(updated.logs[0].metadata?.toolState?.status).toBe('completed');
	});

	it('skips no-op render when session is missing (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('missing-session-ai-tab-1', {
			toolName: 'Read',
			timestamp: 1,
		});
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});

	it('ignores non-AI session ids', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-terminal', { toolName: 'Read', timestamp: 1 });

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	it('tags new tool logs with renderStyle:text-stream when session is in interactive mode', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.renderStyle).toBe('text-stream');
	});

	it('stores parentToolUseId in metadata for subagent tool events', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Grep',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'child-1',
			parentToolUseId: 'toolu_task_1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.metadata?.parentToolUseId).toBe('toolu_task_1');
	});

	it('preserves parentToolUseId when a later event omits it', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Grep',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'child-1',
			parentToolUseId: 'toolu_task_1',
		});
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Grep',
			state: { status: 'completed', output: 'done' },
			timestamp: 2,
			toolCallId: 'child-1',
		});

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		expect(logs).toHaveLength(1);
		expect(logs[0].metadata?.parentToolUseId).toBe('toolu_task_1');
		expect(logs[0].metadata?.toolState?.status).toBe('completed');
	});

	it('omits parentToolUseId for main-transcript tool events', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.metadata?.parentToolUseId).toBeUndefined();
	});

	it('omits renderStyle on tool logs when session is in api mode', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handlerUseAgentToolExecutionListener!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.renderStyle).toBeUndefined();
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useThoughtStreamCaptureListener.test.tsx =====
// Capture the registered onThinkingChunk handler so tests can drive it directly.
let thinkingHandler: ((sessionId: string, content: string) => void) | undefined;
const mockUnsubscribeUseThoughtStreamCaptureListener = vi.fn();

const SESSION_ID = 'session-abc';

/** Run the coalescing timer so buffered chunks land in the store. */
function flush() {
	act(() => {
		vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
	});
}

describe('useThoughtStreamCaptureListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		thinkingHandler = undefined;

		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: {
				...((window as any).maestro?.process || {}),
				onThinkingChunk: vi.fn((h: (sessionId: string, content: string) => void) => {
					thinkingHandler = h;
					return mockUnsubscribeUseThoughtStreamCaptureListener;
				}),
			},
		};

		useThoughtStreamStore.setState({
			panelSessionId: null,
			buffers: {},
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('captures Auto Run thinking chunks despite the `-batch-` streaming id', () => {
		// Regression: Auto Run spawns its agent as `{sessionId}-batch-{timestamp}`,
		// which never matched REGEX_AI_TAB, so every chunk was dropped.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'auto-run reasoning ');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('auto-run reasoning ');
	});

	// This used to assert the opposite - that interactive chunks were captured
	// "too". That was the fix for an under-capture (matching only AI tabs dropped
	// every Auto Run chunk) overshooting into an over-capture, and it is the bug
	// the user reported: both consumers of this buffer are Auto Run surfaces
	// (AutoRun.tsx's Thoughts button, RightPanel's brain button on the Auto Run
	// card), so ordinary conversation appearing there is never right.
	it('does not capture interactive `-ai-` tab thinking chunks', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'interactive reasoning');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	// The reason capture is ambient: by the time a user goes looking at a wedged
	// run, the reasoning that explains it has already streamed past.
	it('buffers with no panel open so a later open has history to show', () => {
		renderHook(() => useThoughtStreamCaptureListener());
		expect(useThoughtStreamStore.getState().panelSessionId).toBeNull();

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'reasoning nobody watched');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('reasoning nobody watched');
	});

	it('keeps parallel sessions in their own buffers', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000000`, 'mine');
			thinkingHandler?.('other-session-batch-1700000000000', 'not mine');
		});
		flush();

		const state = useThoughtStreamStore.getState();
		expect(state.buffers[SESSION_ID].entries.map((e) => e.text)).toEqual(['mine']);
		expect(state.buffers['other-session'].entries.map((e) => e.text)).toEqual(['not mine']);
	});

	it('coalesces chunks inside one flush window into a single entry', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'one ');
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'two ');
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'three');
		});
		// Nothing has landed yet - the timer has not fired.
		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID].entries;
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('one two three');
	});

	it('lands mid-coalesce chunks on unmount instead of dropping them', () => {
		const { unmount } = renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'last words');
		});
		act(() => unmount());

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('last words');
		expect(mockUnsubscribeUseThoughtStreamCaptureListener).toHaveBeenCalled();
	});

	// The Thought Stream is an Auto Run surface: both entry points (the Auto Run
	// panel's Thoughts button, and the active-run card in the Right Bar) belong to
	// a run. Interactive conversation is not part of that, and it used to leak in
	// because every spawn shape for one agent resolves to the SAME base session id
	// - the key the buffer is stored under - so an Auto Run and an ordinary chat in
	// the same agent shared one buffer.
	it('ignores an interactive AI tab chunk on the same base session', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab-7`, 'ordinary conversation ');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('ignores a background synopsis chunk', () => {
		// Non-conversational, but not an Auto Run either - a synopsis summarizes a
		// finished turn, and showing it under a run's Thoughts would misattribute it.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-synopsis-1699999999999`, 'summarizing ');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('keeps only the Auto Run chunk when both arrive for one agent', () => {
		// The reported bug, end to end: same agent, one run and one chat, and the
		// panel showed both.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'auto-run reasoning ');
			thinkingHandler?.(`${SESSION_ID}-ai-tab-7`, 'ordinary conversation ');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toContain('auto-run reasoning');
		expect(entries.map((e) => e.text).join('')).not.toContain('ordinary conversation');
	});
});
