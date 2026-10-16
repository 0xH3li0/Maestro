// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import {
	isBatchRunning,
	reserveGoalRunLaunch,
	releaseGoalRunLaunch,
	clearGoalRunLaunches,
	waitForGoalRunStart,
} from '../../../../renderer/hooks/remote/goalRunLaunch';
import { renderHook, act } from '@testing-library/react';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { logger } from '../../../../renderer/utils/logger';
import type { Session } from '../../../../renderer/types';
import { useLiveOverlay } from '../../../../renderer/hooks/remote/useLiveOverlay';

// ===== from src/__tests__/renderer/hooks/remote/goalRunLaunch.test.ts =====
/**
 * goalRunLaunch tests
 *
 * Launch arbitration for `maestro-cli goal-run --visible` (issue #1286).
 *
 * Both behaviors under test exist because of a timing gap: `startBatchRun` does
 * not mark an agent running synchronously, and the goal runner can return early
 * without ever starting. Each of those, left alone, produces a specific wrong
 * answer for the CLI - two overlapping runs on one agent, or a "launched" reply
 * for a run that never began - so the tests below are written around those two
 * failures rather than around the happy path.
 */

const SESSION = 'agent-1';

/** Put the batch store into a running / not-running state for one agent. */
function setRunning(sessionId: string, isRunning: boolean): void {
	useBatchStore.setState({
		batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning } },
	});
}

/** A promise that never settles - stands in for a run that is still going. */
function pending(): Promise<void> {
	return new Promise<void>(() => {});
}

describe('goalRunLaunch', () => {
	beforeEach(() => {
		clearGoalRunLaunches();
		useBatchStore.setState({ batchRunStates: {} });
		vi.useRealTimers();
	});

	describe('reserveGoalRunLaunch', () => {
		it('grants an idle agent', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
		});

		it('refuses a second claim while the first is still in flight', () => {
			// The gap this closes: neither launch has reached START_BATCH yet, so
			// an isRunning read alone would let both through and put two goal runs
			// on one agent.
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('refuses an agent that already has a run going', () => {
			setRunning(SESSION, true);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('does not block a different agent', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			expect(reserveGoalRunLaunch('agent-2')).toBe(true);
		});

		it('grants again after release when the run never started', () => {
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			releaseGoalRunLaunch(SESSION);
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
		});

		it('still refuses after release once the run is actually running', () => {
			// Release happens as soon as the launch is confirmed, so from that point
			// on it is the batch store - not the reservation - that holds the agent.
			expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			setRunning(SESSION, true);
			releaseGoalRunLaunch(SESSION);
			expect(reserveGoalRunLaunch(SESSION)).toBe(false);
		});

		it('tolerates a double release', () => {
			reserveGoalRunLaunch(SESSION);
			releaseGoalRunLaunch(SESSION);
			expect(() => releaseGoalRunLaunch(SESSION)).not.toThrow();
		});
	});

	describe('isBatchRunning', () => {
		it('is false for an agent with no batch state', () => {
			expect(isBatchRunning('unknown')).toBe(false);
		});

		it('tracks the store', () => {
			setRunning(SESSION, true);
			expect(isBatchRunning(SESSION)).toBe(true);
			setRunning(SESSION, false);
			expect(isBatchRunning(SESSION)).toBe(false);
		});
	});

	describe('waitForGoalRunStart', () => {
		it('resolves true immediately when the run is already running', async () => {
			setRunning(SESSION, true);
			await expect(waitForGoalRunStart(SESSION, pending())).resolves.toBe(true);
		});

		it('resolves true once the store reports the run running', async () => {
			const promise = waitForGoalRunStart(SESSION, pending());
			setRunning(SESSION, true);
			await expect(promise).resolves.toBe(true);
		});

		it('ignores a store update for a different agent', async () => {
			const promise = waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 });
			setRunning('agent-2', true);
			await expect(promise).resolves.toBe(false);
		});

		it('resolves false when the runner returns without ever starting', async () => {
			// The real cases: Auto Run kill switch on, session gone, or the
			// `autorun-goal` prompt template failed to load. All of them return
			// quietly, which is exactly why success cannot be assumed.
			await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(false);
		});

		it('resolves false when the run rejects during startup', async () => {
			await expect(
				waitForGoalRunStart(SESSION, Promise.reject(new Error('spawn failed')))
			).resolves.toBe(false);
		});

		it('reports true for a run that started and finished before we looked', async () => {
			// Losing the race to a resolved promise means "did not start" only if
			// the store agrees; a very short run must not be reported as a failure.
			setRunning(SESSION, true);
			await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(true);
		});

		it('resolves false on timeout when nothing ever starts', async () => {
			await expect(waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 })).resolves.toBe(false);
		});

		it('unsubscribes from the store once settled', async () => {
			const before = useBatchStore.getState();
			await waitForGoalRunStart(SESSION, pending(), { timeoutMs: 10 });
			// A leaked listener would keep firing; setting state after the wait
			// resolved must not throw or re-resolve.
			expect(() => setRunning(SESSION, true)).not.toThrow();
			expect(before).toBeDefined();
		});
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersAutoRunRefresh.test.ts =====
/**
 * Covers the CLI/web `refresh-auto-run` bridge in useAppRemoteEventListeners.
 *
 * This verb disturbs the user in TWO ways, and `--background` has to answer both:
 * it selects the target agent (that switch is how the non-background path gets a
 * non-active agent refreshed at all), and the refresh itself flashes "Found N new
 * documents" - a confirmation of an action the USER took, which is a lie when an
 * agent took it.
 *
 * The three branches are not symmetric, so each is pinned separately.
 */

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));
vi.mock('../../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Mount the listeners with `activeSessionId` as the agent currently on screen.
 */
function setup(activeSessionId: string | null, sessions: Session[] = []) {
	vi.mocked(useSessionStore.getState).mockReturnValue({ activeSessionId } as never);

	const setActiveSessionId = vi.fn();
	const handleAutoRunRefresh = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
			setActiveSessionId,
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh,
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as never)
	);

	return { setActiveSessionId, handleAutoRunRefresh };
}

function dispatchRefresh(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:refreshAutoRunDocs', { detail }));
}

describe('remote refresh-auto-run placement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('with no background flag (the existing behaviour)', () => {
		it('refreshes in place and flashes when the target is already on screen', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-1' });

			// undefined options means "not silent" - the flash is the point of a
			// user-initiated refresh.
			expect(handleAutoRunRefresh).toHaveBeenCalledWith(undefined);
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});

		it('switches to the target when it is a different agent', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2' });

			expect(setActiveSessionId).toHaveBeenCalledWith('agent-2');
			// The folder-path effect refreshes the newly active agent; this path
			// deliberately does not call the handler itself.
			expect(handleAutoRunRefresh).not.toHaveBeenCalled();
		});
	});

	describe('with --background', () => {
		it('refreshes the on-screen agent without flashing', () => {
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-1', background: true });

			expect(handleAutoRunRefresh).toHaveBeenCalledWith({ silent: true });
			expect(setActiveSessionId).not.toHaveBeenCalled();
		});

		it('moves nothing at all for an off-screen agent', () => {
			// Nothing on screen shows that agent's Auto Run list, and the loader
			// effect re-reads the folder when the user switches to it. Doing nothing
			// IS the refresh here - the alternative, switching, is exactly what
			// --background forbids.
			const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2', background: true });

			expect(setActiveSessionId).not.toHaveBeenCalled();
			expect(handleAutoRunRefresh).not.toHaveBeenCalled();
		});
	});

	describe('the switch names who asked for it', () => {
		// A remote verb moving the Left Bar looks exactly like a human click once
		// it has happened. Without an origin on the record, a reported focus jump
		// starts from zero evidence, which is what happened the last time one was.
		it('logs the verb and the target when it switches', () => {
			setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2' });

			expect(logger.info).toHaveBeenCalledWith('[Remote] active agent switched', undefined, {
				origin: 'refresh-auto-run',
				sessionId: 'agent-2',
			});
		});

		it('logs nothing when no switch happens', () => {
			setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2', background: true });

			expect(logger.info).not.toHaveBeenCalled();
		});

		// `info`, not `debug`: the main logger defaults to minLevel 'info' and
		// drops debug, so a debug line would never reach the macOS users who hit
		// this. Pinning the level keeps a future tidy-up from muting the evidence.
		it('logs at a level the default configuration actually emits', () => {
			setup('agent-1');

			dispatchRefresh({ sessionId: 'agent-2' });

			expect(logger.debug).not.toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledTimes(1);
		});
	});

	describe('background is an opt-in, not a default', () => {
		it.each([[undefined], [false], ['yes'], [1], [null]])(
			'still switches when background is %p',
			(value) => {
				// Anything looser than a literal `true` would silently stop the
				// web/mobile clients - which never send the field - from focusing.
				const { setActiveSessionId } = setup('agent-1');

				dispatchRefresh({ sessionId: 'agent-2', background: value });

				expect(setActiveSessionId).toHaveBeenCalledWith('agent-2');
			}
		);
	});

	it('does not confuse a session list entry for the active agent', () => {
		// The branch keys off the LIVE active id from the store, not off whether
		// the session exists. A refresh aimed at a known-but-unfocused agent is
		// still an off-screen refresh.
		const sessions = [createMockSession({ id: 'agent-2' })];
		const { setActiveSessionId, handleAutoRunRefresh } = setup('agent-1', sessions);

		dispatchRefresh({ sessionId: 'agent-2', background: true });

		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(handleAutoRunRefresh).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersBrowserTabs.test.ts =====
/**
 * Covers the CLI/web browser-tab bridge in useAppRemoteEventListeners.
 *
 * The invariant under test: a `--background` open must not move the user. It
 * creates the tab but leaves the active agent and the visible tab alone, so an
 * agent doing research can't yank the window out from under someone typing.
 */

const openAck = vi.fn();
const closeAck = vi.fn();

function setupUseAppRemoteEventListenersBrowserTabs(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId,
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setActiveSessionId, setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdate(setSessions: Mock, sessions: Session[]): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchOpen(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:openBrowserTab', { detail }));
}

function dispatchClose(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent('maestro:closeBrowserTab', { detail }));
}

describe('maestro:openBrowserTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			process: {
				sendRemoteOpenBrowserTabResponse: openAck,
				sendRemoteCloseBrowserTabResponse: closeAck,
			},
		};
	});

	it('focuses the agent and the new tab for a foreground open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } =
			setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchOpen({ sessionId: 'session-1', url: 'https://example.com/', responseChannel: 'ch' });

		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('new-tab-id');
	});

	it('does not switch agents or change the visible tab for a background open', () => {
		const sessions = [createMockSession({ id: 'session-1', activeBrowserTabId: 'existing' })];
		const { setActiveSessionId, setSessions } =
			setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(setActiveSessionId).not.toHaveBeenCalled();
		const [updated] = applyUpdate(setSessions, sessions);
		// Tab exists, but the user is left exactly where they were.
		expect(updated.browserTabs).toHaveLength(1);
		expect(updated.activeBrowserTabId).toBe('existing');
	});

	it('acks with the created tab id so the caller can close it again', () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchOpen({
			sessionId: 'session-1',
			url: 'https://example.com/',
			responseChannel: 'ch',
			background: true,
		});

		expect(openAck).toHaveBeenCalledWith('ch', true, 'new-tab-id');
	});

	it('acks false when the session does not exist', () => {
		setupUseAppRemoteEventListenersBrowserTabs([createMockSession({ id: 'session-1' })]);

		dispatchOpen({ sessionId: 'ghost', url: 'https://example.com/', responseChannel: 'ch' });

		expect(openAck).toHaveBeenCalledWith('ch', false, undefined);
	});
});

describe('maestro:closeBrowserTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			process: {
				sendRemoteOpenBrowserTabResponse: openAck,
				sendRemoteCloseBrowserTabResponse: closeAck,
			},
		};
	});

	const withTabs = () =>
		createMockSession({
			id: 'session-1',
			browserTabs: [
				{ id: 'tab-a', url: 'https://a.test/' },
				{ id: 'tab-b', url: 'https://b.test/' },
			] as any,
			activeBrowserTabId: 'tab-a',
			unifiedTabOrder: [
				{ type: 'browser', id: 'tab-a' },
				{ type: 'browser', id: 'tab-b' },
			] as any,
		});

	it('removes the tab from the owning session without needing an agent id', () => {
		const sessions = [withTabs()];
		const { setSessions } = setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.browserTabs?.map((t) => t.id)).toEqual(['tab-a']);
		expect(updated.unifiedTabOrder).toEqual([{ type: 'browser', id: 'tab-a' }]);
		expect(closeAck).toHaveBeenCalledWith('ch', true);
	});

	it('leaves the visible tab alone when a background tab closes', () => {
		const sessions = [withTabs()];
		const { setSessions } = setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchClose({ tabId: 'tab-b', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBe('tab-a');
	});

	it('clears the active pointer when the closed tab was the visible one', () => {
		const sessions = [withTabs()];
		const { setSessions } = setupUseAppRemoteEventListenersBrowserTabs(sessions);

		dispatchClose({ tabId: 'tab-a', responseChannel: 'ch' });

		const [updated] = applyUpdate(setSessions, sessions);
		expect(updated.activeBrowserTabId).toBeNull();
	});

	it('acks false for an unknown tab so a cleanup no-op is distinguishable', () => {
		setupUseAppRemoteEventListenersBrowserTabs([withTabs()]);

		dispatchClose({ tabId: 'ghost-tab', responseChannel: 'ch' });

		expect(closeAck).toHaveBeenCalledWith('ch', false);
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersOpenFile.test.ts =====
/**
 * Covers `maestro:openFileTab` in useAppRemoteEventListeners - the renderer
 * side of `maestro-cli open-file`.
 *
 * The case under test is `--queue`: audio/video handed to the floating player
 * WITHOUT starting it, so an agent can put media on screen and leave pressing
 * play to the user. Queueing must reach `handleOpenFileTab` as `mediaMode:
 * 'queue'` (anything else plays), and it must not switch agents - the player
 * is app-wide, so there is nowhere to take the user.
 */

const STREAM_URL = 'maestro-media://stream/token/abc';

function setupUseAppRemoteEventListenersOpenFile() {
	const setActiveSessionId = vi.fn();
	const handleOpenFileTab = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [createMockSession({ id: 'session-1', cwd: '/projects/pod' })] },
			setActiveSessionId,
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab,
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setActiveSessionId, handleOpenFileTab };
}

function dispatchOpenUseAppRemoteEventListenersOpenFile(detail: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:openFileTab', {
			detail: { sessionId: 'session-1', filePath: '/projects/pod/ep1.mp3', ...detail },
		})
	);
}

describe('maestro:openFileTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			fs: {
				readFile: vi.fn().mockResolvedValue(STREAM_URL),
				stat: vi.fn().mockResolvedValue(null),
			},
		};
	});

	it('forwards mediaMode queue and does not switch agents', async () => {
		const { setActiveSessionId, handleOpenFileTab } = setupUseAppRemoteEventListenersOpenFile();

		dispatchOpenUseAppRemoteEventListenersOpenFile({
			background: false,
			switchToAgent: true,
			mediaMode: 'queue',
		});

		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());
		expect(handleOpenFileTab.mock.calls[0][1]).toMatchObject({
			targetSessionId: 'session-1',
			mediaMode: 'queue',
		});
		expect(setActiveSessionId).not.toHaveBeenCalled();
	});

	it('keeps the unflagged open: switch agents and play', async () => {
		const { setActiveSessionId, handleOpenFileTab } = setupUseAppRemoteEventListenersOpenFile();

		dispatchOpenUseAppRemoteEventListenersOpenFile({ background: false, switchToAgent: true });

		await vi.waitFor(() => expect(handleOpenFileTab).toHaveBeenCalled());
		expect(handleOpenFileTab.mock.calls[0][1].mediaMode).toBeUndefined();
		expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersSessionConfig.test.ts =====
/**
 * Covers the `update_session_config` allowlist in useAppRemoteEventListeners -
 * the single gate every CLI-driven per-agent edit passes through.
 *
 * The invariants under test: allowlisted keys are written and flushed to disk
 * before the ack (so a CLI read straight after the write is not racing the
 * renderer's debounced persistence), and anything outside the allowlist is
 * dropped rather than written into Session internals.
 */

const ack = vi.fn();
const setMany = vi.fn().mockResolvedValue(undefined);

function setupUseAppRemoteEventListenersSessionConfig(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdateUseAppRemoteEventListenersSessionConfig(
	setSessions: Mock,
	sessions: Session[]
): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchPatch(sessionId: string, configPatch: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateSessionConfig', {
			detail: { sessionId, configPatch, responseChannel: 'ch' },
		})
	);
}

/** Let the handler's awaited setMany + ack settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('maestro:remoteUpdateSessionConfig', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			process: {
				sendRemoteUpdateSessionConfigResponse: ack,
				kill: vi.fn().mockResolvedValue(undefined),
			},
			sessions: { setMany },
		};
	});

	it('writes the bookmark flag so the CLI can pin an agent in the Left Bar', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: false })];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { bookmarked: true });
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.bookmarked).toBe(true);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears the bookmark on an explicit false rather than treating it as unset', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: true })];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { bookmarked: false });
		await flush();

		expect(
			applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions)[0].bookmarked
		).toBe(false);
	});

	it('flushes the bookmark to disk before acking, so a follow-up CLI read is not stale', async () => {
		const sessions = [createMockSession({ id: 'session-1', bookmarked: false })];
		setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { bookmarked: true });
		await flush();

		expect(setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'session-1', bookmarked: true })],
			[]
		);
	});

	it('ignores keys outside the allowlist', async () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { bookmarked: true, aiPid: 99999, name: 'hijacked' });
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.bookmarked).toBe(true);
		expect(updated.aiPid).toBe(sessions[0].aiPid);
		expect(updated.name).toBe(sessions[0].name);
	});

	it('rejects a patch containing nothing editable', async () => {
		const sessions = [createMockSession({ id: 'session-1' })];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { aiPid: 1 });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'No editable config fields in patch',
		});
	});

	it('rejects an unknown agent', async () => {
		setupUseAppRemoteEventListenersSessionConfig([createMockSession({ id: 'session-1' })]);

		dispatchPatch('nope', { bookmarked: true });
		await flush();

		expect(ack).toHaveBeenCalledWith('ch', { success: false, error: 'Agent not found' });
	});
});

describe('maestro:remoteUpdateSessionConfig with a tabId', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			process: {
				sendRemoteUpdateSessionConfigResponse: ack,
				kill: vi.fn().mockResolvedValue(undefined),
			},
			sessions: { setMany },
		};
	});

	/** An agent whose second tab is the one under test. */
	function twoTabSession() {
		const session = createMockSession({ id: 'session-1' });
		session.aiTabs = [
			{ ...session.aiTabs[0], id: 'tab-1', hasUnread: false, saveToHistory: true },
			{ ...session.aiTabs[0], id: 'tab-2', hasUnread: false, saveToHistory: true },
		];
		return session;
	}

	it('patches only the targeted tab', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { tabId: 'tab-2', hasUnread: true });
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.aiTabs[0].hasUnread).toBe(false);
		expect(updated.aiTabs[1].hasUnread).toBe(true);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('flushes the tab flag to disk before acking', async () => {
		setupUseAppRemoteEventListenersSessionConfig([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-2', saveToHistory: false });
		await flush();

		const [[persisted]] = setMany.mock.calls.at(-1) as [Session[]];
		expect(persisted.aiTabs[1].saveToHistory).toBe(false);
		expect(persisted.aiTabs[0].saveToHistory).toBe(true);
	});

	it('ignores tab keys outside the allowlist', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { tabId: 'tab-1', starred: true, logs: [], agentSessionId: 'x' });
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.aiTabs[0].starred).toBe(true);
		expect(updated.aiTabs[0].agentSessionId).toBe(sessions[0].aiTabs[0].agentSessionId);
	});

	it('rejects an unknown tab instead of silently patching nothing', async () => {
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-nope', hasUnread: true });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', { success: false, error: 'Tab not found' });
	});

	it('writes the composer-chip settings (thinking, read-only, model, effort)', async () => {
		const sessions = [twoTabSession()];
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', {
			tabId: 'tab-2',
			showThinking: 'sticky',
			readOnlyMode: true,
			customModel: 'opus',
			customEffort: 'high',
			enterToSend: false,
		});
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.aiTabs[1].showThinking).toBe('sticky');
		expect(updated.aiTabs[1].readOnlyMode).toBe(true);
		expect(updated.aiTabs[1].customModel).toBe('opus');
		expect(updated.aiTabs[1].customEffort).toBe('high');
		expect(updated.aiTabs[1].enterToSend).toBe(false);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears an override on null so the tab inherits again', async () => {
		const sessions = [twoTabSession()];
		sessions[0].aiTabs[1] = { ...sessions[0].aiTabs[1], customModel: 'opus', enterToSend: false };
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig(sessions);

		dispatchPatch('session-1', { tabId: 'tab-2', customModel: null, enterToSend: null });
		await flush();

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionConfig(setSessions, sessions);
		expect(updated.aiTabs[1].customModel).toBeUndefined();
		expect(updated.aiTabs[1].enterToSend).toBeUndefined();
	});

	it('rejects a wrongly-typed tab value instead of persisting it', async () => {
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-1', readOnlyMode: 'yes' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: "Invalid value for tab field 'readOnlyMode'",
		});
	});

	it('rejects an unknown thinking mode', async () => {
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig([twoTabSession()]);

		dispatchPatch('session-1', { tabId: 'tab-1', showThinking: 'loud' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: "Invalid value for tab field 'showThinking'",
		});
	});

	it('rejects a tab-targeted patch with no editable tab fields', async () => {
		const { setSessions } = setupUseAppRemoteEventListenersSessionConfig([twoTabSession()]);

		// `bookmarked` is agent state, not tab state - it must not leak across.
		dispatchPatch('session-1', { tabId: 'tab-1', bookmarked: true });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'No editable tab fields in patch',
		});
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useAppRemoteEventListenersSessionCwd.test.ts =====
/**
 * Covers `maestro:remoteUpdateSessionCwd` in useAppRemoteEventListeners - the
 * renderer side of `maestro-cli update-agent --cwd`.
 *
 * The invariant under test (#1565): every path field moves together. Moving
 * only `cwd` left `projectRoot` and `autoRunFolderPath` on the old directory,
 * so the Files panel listed nothing and the Edit dialog showed the old path.
 */

const ackUseAppRemoteEventListenersSessionCwd = vi.fn();

function setupUseAppRemoteEventListenersSessionCwd(sessions: Session[]) {
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn();

	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);

	return { setSessions };
}

/** Run the reducer that setSessions was called with against the given state. */
function applyUpdateUseAppRemoteEventListenersSessionCwd(
	setSessions: Mock,
	sessions: Session[]
): Session[] {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater(sessions);
}

function dispatchCwd(sessionId: string, newCwd: string) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateSessionCwd', {
			detail: { sessionId, newCwd, responseChannel: 'ch' },
		})
	);
}

const oldLocation = () =>
	createMockSession({
		id: 'session-1',
		aiPid: 0,
		cwd: '/projects/old',
		fullPath: '/projects/old',
		shellCwd: '/projects/old',
		projectRoot: '/projects/old',
		autoRunFolderPath: '/projects/old/.maestro/playbooks',
	});

describe('maestro:remoteUpdateSessionCwd', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			process: { sendRemoteUpdateSessionCwdResponse: ackUseAppRemoteEventListenersSessionCwd },
		};
	});

	it('moves projectRoot and the Auto Run folder along with cwd', () => {
		const sessions = [oldLocation()];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '/projects/new');

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionCwd(setSessions, sessions);
		expect(updated.cwd).toBe('/projects/new');
		expect(updated.fullPath).toBe('/projects/new');
		expect(updated.shellCwd).toBe('/projects/new');
		expect(updated.projectRoot).toBe('/projects/new');
		expect(updated.autoRunFolderPath).toBe('/projects/new/.maestro/playbooks');
		expect(ackUseAppRemoteEventListenersSessionCwd).toHaveBeenCalledWith('ch', { success: true });
	});

	it('clears the old file tree so the Files panel reloads from the new directory', () => {
		const sessions = [
			{ ...oldLocation(), fileTree: [{ name: 'stale.ts', type: 'file' as const }] },
		];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '/projects/new');

		expect(
			applyUpdateUseAppRemoteEventListenersSessionCwd(setSessions, sessions)[0].fileTree
		).toEqual([]);
	});

	// The repair gets the full relocation, not a cwd-only patch: a stale file
	// tree or SSH override would leave the agent split in a different way.
	it('repairs an agent an older --cwd left split when moved back to its projectRoot', () => {
		const sessions = [
			{
				...oldLocation(),
				cwd: '/projects/new',
				fullPath: '/projects/new',
				shellCwd: '/projects/new',
				fileTree: [{ name: 'stale.ts', type: 'file' as const }],
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/projects/new',
				},
			},
		];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '/projects/old');

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionCwd(setSessions, sessions);
		expect(updated.cwd).toBe('/projects/old');
		expect(updated.fullPath).toBe('/projects/old');
		expect(updated.shellCwd).toBe('/projects/old');
		expect(updated.projectRoot).toBe('/projects/old');
		expect(updated.sessionSshRemoteConfig?.workingDirOverride).toBe('/projects/old');
		expect(updated.fileTree).toEqual([]);
	});

	it('stores the directory without surrounding whitespace', () => {
		const sessions = [oldLocation()];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '  /projects/new  ');

		const [updated] = applyUpdateUseAppRemoteEventListenersSessionCwd(setSessions, sessions);
		expect(updated.cwd).toBe('/projects/new');
		expect(updated.projectRoot).toBe('/projects/new');
	});

	it('refuses while the agent process is running', () => {
		const sessions = [{ ...oldLocation(), aiPid: 4242 }];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '/projects/new');

		expect(setSessions).not.toHaveBeenCalled();
		expect(ackUseAppRemoteEventListenersSessionCwd).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'Stop the agent before changing its working directory.',
		});
	});

	it('refuses while the agent is busy even when no process id is recorded', () => {
		const sessions = [{ ...oldLocation(), state: 'busy' as const }];
		const { setSessions } = setupUseAppRemoteEventListenersSessionCwd(sessions);

		dispatchCwd('session-1', '/projects/new');

		expect(setSessions).not.toHaveBeenCalled();
		expect(ackUseAppRemoteEventListenersSessionCwd).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'Stop the agent before changing its working directory.',
		});
	});
});

// ===== from src/__tests__/renderer/hooks/remote/useLiveOverlay.test.ts =====
describe('useLiveOverlay', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('cancels the copy flash timeout when unmounted', () => {
		const { result, unmount } = renderHook(() => useLiveOverlay(false));

		act(() => {
			result.current.setCopyFlash('Local URL copied!');
		});
		expect(result.current.copyFlash).toBe('Local URL copied!');
		expect(vi.getTimerCount()).toBe(1);

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});
});
