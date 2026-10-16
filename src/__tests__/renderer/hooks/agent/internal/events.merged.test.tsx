// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	noteProviderModeTransition,
	__resetAnnouncedProviderMode,
} from '../../../../../renderer/hooks/agent/internal/useAgentClaudeModeResolvedListener';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentCommandExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentCommandExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useAgentDataListener } from '../../../../../renderer/hooks/agent/internal/useAgentDataListener';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
import { useAgentErrorListener } from '../../../../../renderer/hooks/agent/internal/useAgentErrorListener';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	useRetryStore,
	noteDispatch,
	cancelRetry,
	registerBatchResumer,
} from '../../../../../renderer/stores/retryStore';
import { useAuthOutageStore } from '../../../../../renderer/stores/authOutageStore';
import * as runtimeContext from '../../../../../renderer/utils/runtimeContext';
import { useAgentSessionIdListener } from '../../../../../renderer/hooks/agent/internal/useAgentSessionIdListener';
import { useAgentSlashCommandsListener } from '../../../../../renderer/hooks/agent/internal/useAgentSlashCommandsListener';
import { useAgentSshRemoteListener } from '../../../../../renderer/hooks/agent/internal/useAgentSshRemoteListener';
import { gitService } from '../../../../../renderer/services/git';
import { useAgentStderrListener } from '../../../../../renderer/hooks/agent/internal/useAgentStderrListener';

// ===== from src/__tests__/renderer/hooks/agent/internal/noteProviderModeTransition.test.ts =====
/**
 * Unit tests for the per-provider Dynamic-switch dedup
 * (`noteProviderModeTransition`).
 *
 * The TUI↔API switch is decided per Anthropic account (`configDirKey`), shared
 * by every agent on that account. The helper ensures a switch is announced
 * exactly once per account-wide transition: the first agent to observe a new
 * mode announces it; every other agent on the same account cascades silently.
 */

describe('noteProviderModeTransition', () => {
	beforeEach(() => {
		__resetAnnouncedProviderMode();
	});

	it('baselines the first observation per provider without announcing', () => {
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
			transitioned: false,
		});
	});

	it('does not announce when the mode is unchanged (the cascade: other agents follow silently)', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline
		// Three more agents on the same account resolve the same mode.
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
	});

	it('announces exactly once on a real account-wide transition, then cascades silently', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline

		// First agent to hit the limit flips the account to API → announce once.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api')).toEqual({
			transitioned: true,
			prevMode: 'interactive',
		});
		// Every other agent on the same account that resolves API after the flip
		// must NOT re-announce.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
	});

	it('announces the switch back to Time Limits once when the quota window resets', () => {
		noteProviderModeTransition('/Users/me/.claude', 'api'); // baseline (account already limited)

		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
			transitioned: true,
			prevMode: 'api',
		});
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
	});

	it('tracks each provider (account) independently', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline A
		noteProviderModeTransition('/Users/me/.claude-work', 'interactive'); // baseline B

		// Account A flips; account B is untouched.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(true);
		expect(noteProviderModeTransition('/Users/me/.claude-work', 'interactive').transitioned).toBe(
			false
		);
		// Account B's own later flip announces on its own schedule.
		expect(noteProviderModeTransition('/Users/me/.claude-work', 'api').transitioned).toBe(true);
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentCommandExitListener.test.tsx =====
let handler: ((sessionId: string, code: number) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onCommandExit: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

describe('useAgentCommandExitListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});

	it('appends a system log on non-zero exit code', () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 2);

		const updated = useSessionStore.getState().sessions[0];
		const sysLog = updated.shellLogs[updated.shellLogs.length - 1];
		expect(sysLog?.text).toContain('exited with code 2');
		expect(sysLog?.source).toBe('system');
	});

	it('does not append a log on zero exit code', () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].shellLogs).toEqual([]);
	});

	it('keeps session busy when an AI tab is still busy', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].state).toBe('busy');
	});

	it('transitions session to idle when no AI tabs busy', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'idle' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].state).toBe('idle');
	});

	it('skips no-op render when session is missing (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentCommandExitListener());
		handler!('missing', 0);
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentDataListener.test.tsx =====
let handlerUseAgentDataListener: ((sessionId: string, data: string) => void) | undefined;
const mockUnsubscribeUseAgentDataListener = vi.fn();

const mockProcessUseAgentDataListener = {
	onData: vi.fn((h: any) => {
		handlerUseAgentDataListener = h;
		return mockUnsubscribeUseAgentDataListener;
	}),
};

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

describe('useAgentDataListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlerUseAgentDataListener = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentDataListener,
			agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
		};
	});

	it('routes ai-formatted ids through batched appendLog with isAi=true', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handlerUseAgentDataListener!('sess-1-ai-tab-1', 'hello\n');

		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'hello\n');
		expect(batched.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
		expect(batched.updateCycleBytes).toHaveBeenCalledWith('sess-1', 6);
	});

	it('routes plain session ids as terminal output', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handlerUseAgentDataListener!('sess-1', 'terminal output');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'terminal output');
		expect(batched.markDelivered).not.toHaveBeenCalled();
	});

	it('drops empty terminal output', () => {
		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handlerUseAgentDataListener!('sess-1', '   ');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('ignores -terminal and -batch- session ids', () => {
		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handlerUseAgentDataListener!('sess-1-terminal', 'data');
		handlerUseAgentDataListener!('sess-1-batch-x', 'data');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('deletes the matching activeHiddenToolRef entry on first chunk', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const ref = makeRef();
		ref.current.set('sess-1:tab-1', { toolName: 'Read' });
		const batched = makeBatched();

		renderHook(() => useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: ref }));

		handlerUseAgentDataListener!('sess-1-ai-tab-1', 'data');
		expect(ref.current.has('sess-1:tab-1')).toBe(false);
	});

	it('clears lingering session.agentError on next data chunk', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			agentError: { type: 'auth_expired', message: 'expired', timestamp: 0 } as any,
			state: 'error',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);
		handlerUseAgentDataListener!('sess-1-ai-tab-1', 'data');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.agentError).toBeUndefined();
		expect(updated.state).toBe('busy');
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentErrorListener.test.tsx =====
let handlerUseAgentErrorListener: ((sessionId: string, error: any) => void) | undefined;
let authExpiredHandler: ((payload: any) => void) | undefined;
const mockUnsubscribeUseAgentErrorListener = vi.fn();
const mockAuthUnsubscribe = vi.fn();

const mockProcessUseAgentErrorListener = {
	onAgentError: vi.fn((h: any) => {
		handlerUseAgentErrorListener = h;
		return mockUnsubscribeUseAgentErrorListener;
	}),
	onAuthExpired: vi.fn((h: any) => {
		authExpiredHandler = h;
		return mockAuthUnsubscribe;
	}),
};

function makeRefUseAgentErrorListener(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

const baseError = {
	type: 'auth_expired',
	message: 'expired',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

const overloadError = {
	type: 'rate_limited',
	message: 'API Error: 529 Overloaded',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

function seedSnapshot(sessionId: string, tabId: string) {
	noteDispatch(
		sessionId,
		{ id: 'item-1', timestamp: 1, tabId, type: 'message', text: 'hi' },
		{ conductorProfile: '', customAICommands: [], speckitCommands: [], openspecCommands: [] }
	);
}

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		pauseBatchOnErrorRef: { current: null },
		addHistoryEntryRef: { current: null },
		activeHiddenToolRef: makeRefUseAgentErrorListener(),
	};
}

describe('useAgentErrorListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlerUseAgentErrorListener = undefined;
		authExpiredHandler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		useModalStore.getState().closeAll();
		useAuthOutageStore.setState({ outages: {} });
		useRetryStore.setState({ retries: {}, outages: {} });
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentErrorListener,
		};
	});

	it('opens the agentError modal and stamps session error state', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', { ...baseError, type: 'agent_crashed' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(updated.agentError?.type).toBe('agent_crashed');
		expect(updated.aiTabs[0].agentError?.type).toBe('agent_crashed');

		const modal = useModalStore.getState();
		const agentErrorEntry = modal.modals.get('agentError');
		expect(agentErrorEntry).toBeDefined();
		expect(agentErrorEntry?.data).toEqual({ sessionId: 'sess-1' });
	});
	it('renders remote errors without scheduling a second host retry', () => {
		const remote = vi.spyOn(runtimeContext, 'isWebDesktop').mockReturnValue(true);
		const tab = createMockAITab({ id: 'remote-tab' });
		const session = createMockSession({
			id: 'remote-agent',
			aiTabs: [tab],
			activeTabId: 'remote-tab',
		});
		useSessionStore.setState({ sessions: [session] });
		seedSnapshot('remote-agent', 'remote-tab');
		const { unmount } = renderHook(() => useAgentErrorListener(makeDeps()));
		try {
			handlerUseAgentErrorListener!('remote-agent-ai-remote-tab', overloadError);
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.agentError?.message).toBe(overloadError.message);
			expect(updated.aiTabs[0].logs.find((log) => log.source === 'error')?.text).toBe(
				overloadError.message
			);
			expect(useRetryStore.getState().retries).toEqual({});
		} finally {
			unmount();
			remote.mockRestore();
		}
	});

	// An expired token downs every agent and pipeline on the provider at once,
	// so it skips the generic error modal and goes straight to the login flow.
	it('routes auth_expired to the reauth modal instead of the agentError modal', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', baseError);

		const modal = useModalStore.getState();
		expect(modal.modals.get('agentError')?.open ?? false).toBe(false);
		// Addressed by provider, not by agent - one login fixes every agent on it.
		expect(modal.modals.get('reauth')?.data).toEqual({ providerKey: 'claude-code' });
		// The session still carries the error so the transcript and Left Bar agree.
		expect(useSessionStore.getState().sessions[0].agentError?.type).toBe('auth_expired');
		// The failing tab is recorded now so the resume can replay exactly it.
		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toEqual([
			{ sessionId: 'sess-1', tabIds: ['tab-1'] },
		]);
	});

	// The whole point of the provider scope: 30 agents on one expired token is
	// one problem with one fix, not 30 dialogs.
	it('raises ONE prompt for many agents sharing an expired provider', () => {
		const sessions = Array.from({ length: 30 }, (_, i) =>
			createMockSession({
				id: `sess-${i}`,
				toolType: 'claude-code',
				aiTabs: [createMockAITab({ id: `tab-${i}` })],
				activeTabId: `tab-${i}`,
			})
		);
		useSessionStore.setState({ sessions } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		let opens = 0;
		const unsub = useModalStore.subscribe((state, prev) => {
			if (state.modals.get('reauth') !== prev.modals.get('reauth')) opens++;
		});
		sessions.forEach((s, i) => handlerUseAgentErrorListener!(`${s.id}-ai-tab-${i}`, baseError));
		unsub();

		expect(opens).toBe(1);
		// ...but every one of them is on the roster, or its queued work could
		// never be resumed.
		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toHaveLength(30);
	});

	it('keeps a different provider on its own prompt', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'sess-claude',
					toolType: 'claude-code',
					aiTabs: [createMockAITab({ id: 'tab-1' })],
					activeTabId: 'tab-1',
				}),
				createMockSession({
					id: 'sess-codex',
					toolType: 'codex',
					aiTabs: [createMockAITab({ id: 'tab-2' })],
					activeTabId: 'tab-2',
				}),
			],
		} as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-claude-ai-tab-1', baseError);
		handlerUseAgentErrorListener!('sess-codex-ai-tab-2', baseError);

		const outages = useAuthOutageStore.getState().outages;
		expect(Object.keys(outages).sort()).toEqual(['claude-code', 'codex']);
	});

	// Cue spawns its agents outside the ProcessManager, so a pipeline auth
	// failure arrives on its own channel - and that is the case where a silent
	// failure costs the most.
	it('folds a pipeline auth failure into the same provider outage', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		authExpiredHandler!({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			message: 'OAuth token has expired.',
			fromPipeline: true,
		});

		expect(useModalStore.getState().modals.get('reauth')?.data).toEqual({
			providerKey: 'claude-code',
		});
		const outage = useAuthOutageStore.getState().outages['claude-code'];
		expect(outage.fromPipeline).toBe(true);
		// A pipeline run owns no AI tab, so there is no turn to replay for it.
		expect(outage.blocked).toEqual([{ sessionId: 'sess-1', tabIds: [] }]);
	});

	it('ignores a pipeline auth failure for an agent that no longer exists', () => {
		useSessionStore.setState({ sessions: [] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		authExpiredHandler!({
			sessionId: 'deleted',
			agentId: 'claude-code',
			message: 'OAuth token has expired.',
		});

		expect(useModalStore.getState().modals.get('reauth')?.open ?? false).toBe(false);
	});

	it('clears stale agentSessionId on session_not_found', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBeNull();
		// Modal should NOT open for session_not_found
		const entry = useModalStore.getState().modals.get('agentError');
		expect(entry?.open ?? false).toBe(false);
	});

	it('stamps recoveryAction with the last user prompt on session_not_found', () => {
		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the thing that died',
		};
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			logs: [userLog],
		});
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toEqual({
			lastUserPrompt: 'do the thing that died',
			tabId: 'tab-1',
		});
	});

	it('omits recoveryAction when no user message exists yet', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id', logs: [] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toBeUndefined();
	});

	it('appends an error log entry to the targeted tab', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog).toBeDefined();
		expect(errorLog?.text).toBe('expired');
	});

	it('tags the error log with renderStyle=text-stream when the session is interactive', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBe('text-stream');
	});

	it('leaves renderStyle unset on API-mode (non-interactive) errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBeUndefined();
	});

	it('deletes the activeHiddenToolRef entry on error', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentErrorListener(deps));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', baseError);

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});

	it('seeds auto-resume metadata and stashes the last prompt on a limit error', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the rate-limited thing',
		};
		const tab = createMockAITab({ id: 'tab-1', logs: [userLog] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', {
			...baseError,
			type: 'rate_limited',
			message: 'usage limit',
		});

		// Synchronous pause: error stamped, paused, retry counter seeded to 0.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.state).toBe('error');
		expect(paused.agentErrorPaused).toBe(true);
		expect(paused.agentError?.type).toBe('rate_limited');
		expect(paused.agentError?.resumeAttemptCount).toBe(0);

		// The captured prompt rides along on the error log so Phase 3 can re-fire it.
		const errorLog = paused.aiTabs[0].logs.find((l) => l.source === 'error');
		expect(errorLog?.recoveryAction).toEqual({
			lastUserPrompt: 'do the rate-limited thing',
			tabId: 'tab-1',
		});

		// Best-effort reset estimate is patched in asynchronously.
		expect(getLimitResetAt).toHaveBeenCalledWith('claude-code');
		await waitFor(() => {
			expect(useSessionStore.getState().sessions[0].agentError?.limitResetAt).toBe(1700000123456);
		});
	});

	it('does not stamp a local reset estimate on an SSH-backed session', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const tab = createMockAITab({ id: 'tab-1' });
		// SSH-backed: the local usage snapshot reflects the wrong account, so the
		// estimate must be skipped and the session left to the interval fallback.
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			sshRemoteId: 'remote-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', {
			...baseError,
			type: 'rate_limited',
			message: 'usage limit',
		});

		// Still pauses synchronously; only the local reset probe is skipped.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.agentErrorPaused).toBe(true);
		expect(getLimitResetAt).not.toHaveBeenCalled();
		expect(paused.agentError?.limitResetAt).toBeUndefined();
	});

	it('auto-retries a recoverable overload error and suppresses the modal', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);
		// A prompt must have been dispatched so there's something to resend.
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', overloadError);

		// No blocking error state / modal - the retry engine owns it.
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).not.toBe('error');
		expect(updated.agentError).toBeUndefined();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);

		// A retry was scheduled with the availability strategy.
		const entry = useRetryStore.getState().retries['sess-1:tab-1'];
		expect(entry?.strategy).toBe('availability');
		expect(entry?.attempt).toBe(0);

		// The transcript gets ONE outage-marker entry (a live status card anchor):
		// a non-blocking system entry carrying the outage id, not a red error frame.
		const markers = updated.aiTabs[0].logs.filter((l) => l.retryOutageId);
		expect(markers).toHaveLength(1);
		expect(markers[0].source).toBe('system');
		expect(markers[0].retryOutageId).toBe(entry?.outageId);
		expect(updated.aiTabs[0].logs.some((l) => l.source === 'error')).toBe(false);

		cancelRetry('sess-1', 'tab-1'); // clear the pending timer
	});

	it('collapses a continued outage into the single existing marker (no new entries)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		// First failure → one marker appended.
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', overloadError);
		const outageId = useRetryStore.getState().retries['sess-1:tab-1']?.outageId;

		// A second failure for the same outage (the resend failed again) must NOT
		// append another transcript entry - the live card already covers it.
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', overloadError);

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		const markers = logs.filter((l) => l.retryOutageId);
		expect(markers).toHaveLength(1);
		expect(markers[0].retryOutageId).toBe(outageId);

		cancelRetry('sess-1', 'tab-1');
	});

	it('auto-continues an Auto Run batch (resumes instead of pausing for the user)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		// A running batch owns the turn; register the resume hook App normally wires.
		const resumer = vi.fn();
		registerBatchResumer(resumer);
		const pauseBatchOnError = vi.fn();
		const deps = {
			...makeDeps(),
			getBatchStateRef: {
				current: () => ({
					isRunning: true,
					errorPaused: false,
					documents: ['plan.md'],
					currentDocumentIndex: 0,
				}),
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		} as any;

		renderHook(() => useAgentErrorListener(deps));
		handlerUseAgentErrorListener!('sess-1-ai-tab-1', overloadError);

		// The batch was parked (so the loop can be resumed) but the modal stays shut.
		expect(pauseBatchOnError).toHaveBeenCalled();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);

		// A batch-resume retry was scheduled (no prompt snapshot needed).
		const entry = useRetryStore.getState().retries['sess-1:tab-1'];
		expect(entry?.mode).toBe('batch-resume');
		expect(entry?.strategy).toBe('availability');

		cancelRetry('sess-1', 'tab-1');
		registerBatchResumer(null);
	});

	it('falls back to the error modal when there is no prompt to resend', () => {
		const tab = createMockAITab({ id: 'tab-2' });
		const session = createMockSession({ id: 'sess-2', aiTabs: [tab], activeTabId: 'tab-2' });
		useSessionStore.setState({ sessions: [session] } as any);
		// No seedSnapshot → nothing captured → cannot auto-retry.

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-2-ai-tab-2', overloadError);

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true);
		expect(useRetryStore.getState().retries['sess-2:tab-2']).toBeUndefined();
	});

	// An Auto Run task process owns no AI tab. Before this guard the tab fallback
	// resolved to getActiveTab(), so killing an Auto Run painted the batch's error
	// into the user's unrelated chat tab and flipped the whole agent to `error`.
	it('leaves the active chat tab alone when a running Auto Run errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const pauseBatchOnError = vi.fn();
		const deps = {
			...makeDeps(),
			getBatchStateRef: {
				current: () => ({
					isRunning: true,
					errorPaused: false,
					documents: ['plan.md'],
					currentDocumentIndex: 0,
				}),
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		} as any;

		renderHook(() => useAgentErrorListener(deps));
		handlerUseAgentErrorListener!('sess-1-batch-1700000000000', {
			...baseError,
			type: 'agent_crashed',
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).not.toBe('error');
		expect(updated.agentError).toBeUndefined();
		expect(updated.agentErrorPaused ?? false).toBe(false);
		expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length);
		expect(updated.aiTabs[0].agentError).toBeUndefined();

		// The Auto Run banner is the surface, not the blocking modal.
		expect(pauseBatchOnError).toHaveBeenCalled();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
	});

	// session_not_found nulls the target tab's agentSessionId. Borrowing the
	// active tab for a batch error severed an unrelated conversation's resume
	// chain, which is unrecoverable once the process is gone.
	it('never clears the active chat tab agentSessionId for a batch error', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		// No batch state registered: the straggler path still must not touch the tab.
		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-batch-1700000000000', {
			...baseError,
			type: 'session_not_found',
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('claude-abc');
		expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length);
	});

	it('skips synopsis-process errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handlerUseAgentErrorListener!('sess-1-synopsis', baseError);

		expect(useSessionStore.getState().sessions[0].state).not.toBe('error');
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentSessionIdListener.test.tsx =====
let handlerUseAgentSessionIdListener:
	| ((sessionId: string, agentSessionId: string) => Promise<void>)
	| undefined;
const mockUnsubscribeUseAgentSessionIdListener = vi.fn();

const mockProcessUseAgentSessionIdListener = {
	onSessionId: vi.fn((h: any) => {
		handlerUseAgentSessionIdListener = h;
		return mockUnsubscribeUseAgentSessionIdListener;
	}),
};

function makeBatchedUseAgentSessionIdListener(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

describe('useAgentSessionIdListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlerUseAgentSessionIdListener = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentSessionIdListener,
			agentSessions: { registerSessionOrigin: vi.fn().mockResolvedValue(undefined) },
		};
	});

	it('captures agent session id on the targeted tab', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() =>
			useAgentSessionIdListener({ batchedUpdater: makeBatchedUseAgentSessionIdListener() })
		);
		await handlerUseAgentSessionIdListener!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.aiTabs[0].awaitingSessionId).toBe(false);
		// Non-claude-code: session-level id is also stamped.
		expect(updated.agentSessionId).toBe('agent-uuid-1');
	});

	it('skips session-level id for claude-code (treats fork ids as throwaway)', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() =>
			useAgentSessionIdListener({ batchedUpdater: makeBatchedUseAgentSessionIdListener() })
		);
		await handlerUseAgentSessionIdListener!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.agentSessionId).toBeUndefined();
	});

	it('detects resume failure when ID changes on non-claude-code', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatchedUseAgentSessionIdListener();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handlerUseAgentSessionIdListener!('sess-1-ai-tab-1', 'new-id');

		// Resume failure → context gauge zeroed
		expect(batched.updateContextUsage).toHaveBeenCalledWith('sess-1', 0);
		const updated = useSessionStore.getState().sessions[0];
		const log = updated.aiTabs[0].logs.find((l) => l.text.includes('resume failed'));
		expect(log).toBeDefined();
	});

	it('keeps original id on claude-code mismatch (silent fork)', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatchedUseAgentSessionIdListener();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handlerUseAgentSessionIdListener!('sess-1-ai-tab-1', 'fork-id');

		expect(batched.updateContextUsage).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe('old-id');
	});

	it('ignores batch session ids', async () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() =>
			useAgentSessionIdListener({ batchedUpdater: makeBatchedUseAgentSessionIdListener() })
		);
		await handlerUseAgentSessionIdListener!('sess-1-batch-tab-1', 'agent-uuid-1');

		expect(useSessionStore.getState().sessions[0].agentSessionId).toBeUndefined();
	});

	it('skips no-op render when session is missing', async () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() =>
			useAgentSessionIdListener({ batchedUpdater: makeBatchedUseAgentSessionIdListener() })
		);
		await handlerUseAgentSessionIdListener!('missing-ai-tab-1', 'agent-uuid-1');
		// No session found - nothing to update, so the store setter is never invoked at all.
		expect(setSessionsSpy).not.toHaveBeenCalled();
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toEqual([]);
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentSlashCommandsListener.test.tsx =====
let onSlashCommandsHandler: ((sessionId: string, slashCommands: string[]) => void) | undefined;
const mockUnsubscribeUseAgentSlashCommandsListener = vi.fn();

const mockProcessUseAgentSlashCommandsListener = {
	onSlashCommands: vi.fn((handler: any) => {
		onSlashCommandsHandler = handler;
		return mockUnsubscribeUseAgentSlashCommandsListener;
	}),
};

describe('useAgentSlashCommandsListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		onSlashCommandsHandler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentSlashCommandsListener,
		};
	});

	it('registers exactly one listener on mount and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentSlashCommandsListener());
		expect(mockProcessUseAgentSlashCommandsListener.onSlashCommands).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribeUseAgentSlashCommandsListener).toHaveBeenCalledTimes(1);
	});

	it('writes normalised commands to the matching session', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('sess-1', ['help', '/clear', 'config']);

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.agentCommands?.map((c) => c.command)).toEqual(['/help', '/clear', '/config']);
		updated?.agentCommands?.forEach((c) => {
			expect(c.description).toBeDefined();
		});
	});

	it('skips no-op renders when the session does not exist (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('missing-session', ['/help']);
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});

	it('handles empty command arrays', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('sess-1', []);

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.agentCommands).toEqual([]);
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentSshRemoteListener.test.tsx =====
vi.mock('../../../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

let handlerUseAgentSshRemoteListener: ((sessionId: string, remote: any) => void) | undefined;
const mockUnsubscribeUseAgentSshRemoteListener = vi.fn();

const mockProcessUseAgentSshRemoteListener = {
	onSshRemote: vi.fn((h: any) => {
		handlerUseAgentSshRemoteListener = h;
		return mockUnsubscribeUseAgentSshRemoteListener;
	}),
};

describe('useAgentSshRemoteListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlerUseAgentSshRemoteListener = undefined;
		vi.mocked(gitService.isRepo).mockResolvedValue(false);
		vi.mocked(gitService.getBranches).mockResolvedValue([] as any);
		vi.mocked(gitService.getTags).mockResolvedValue([] as any);
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentSshRemoteListener,
		};
	});

	it('stamps sshRemote on the matching session', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handlerUseAgentSshRemoteListener!('sess-1-ai-tab-1', {
			id: 'r-1',
			name: 'remote',
			host: 'h.example',
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.sshRemote?.id).toBe('r-1');
		expect(updated.sshRemoteId).toBe('r-1');
	});

	it('does NOT re-fetch when same remote already attached and session is already a git repo', async () => {
		const session = createMockSession({
			id: 'sess-1',
			isGitRepo: true,
			sshRemote: { id: 'r-1', name: 'r', host: 'h' } as any,
			sshRemoteId: 'r-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handlerUseAgentSshRemoteListener!('sess-1', { id: 'r-1', name: 'r', host: 'h' });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// Probe is gated off by session.isGitRepo; nothing to refetch when the
		// remote already has its branches/tags cached.
		expect(gitService.isRepo).not.toHaveBeenCalled();
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
	});

	it('triggers git probe when new remote attaches and session is not yet a git repo', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main'] as any);
		vi.mocked(gitService.getTags).mockResolvedValue([] as any);

		const session = createMockSession({ id: 'sess-1', isGitRepo: false });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handlerUseAgentSshRemoteListener!('sess-1', { id: 'r-1', name: 'r', host: 'h' });

		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(gitService.isRepo).toHaveBeenCalledWith(expect.any(String), 'r-1');
	});

	it('does NOT re-probe on a duplicate event for the SAME remote (e.g. reconnect/replay)', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const session = createMockSession({
			id: 'sess-1',
			isGitRepo: false,
			sshRemote: { id: 'r-1', name: 'r', host: 'h' } as any,
			sshRemoteId: 'r-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		// Same remote ID arrives again - could be a reconnect or a duplicate
		// IPC event. The store already has remote 'r-1' attached and the
		// previous probe already returned non-git, so re-probing would burn
		// 3 IPC calls for nothing.
		handlerUseAgentSshRemoteListener!('sess-1', { id: 'r-1', name: 'r', host: 'h' });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(gitService.isRepo).not.toHaveBeenCalled();
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
	});

	it('skips no-op render when session is missing', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSshRemoteListener());
		handlerUseAgentSshRemoteListener!('missing-session', { id: 'r-1', name: 'r', host: 'h' });
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/hooks/agent/internal/useAgentStderrListener.test.tsx =====
let onStderrHandler: ((sessionId: string, data: string) => void) | undefined;
const mockUnsubscribeUseAgentStderrListener = vi.fn();

const mockProcessUseAgentStderrListener = {
	onStderr: vi.fn((handler: any) => {
		onStderrHandler = handler;
		return mockUnsubscribeUseAgentStderrListener;
	}),
};

function makeBatchedUseAgentStderrListener(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

describe('useAgentStderrListener', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		onStderrHandler = undefined;
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcessUseAgentStderrListener,
		};
	});

	it('subscribes once and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() =>
			useAgentStderrListener({ batchedUpdater: makeBatchedUseAgentStderrListener() })
		);
		expect(mockProcessUseAgentStderrListener.onStderr).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribeUseAgentStderrListener).toHaveBeenCalledTimes(1);
	});

	it('routes ai-tab-format stderr to the AI tab with isStderr=true', () => {
		const batched = makeBatchedUseAgentStderrListener();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1-ai-tab-1', 'oh no\n');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'oh no\n', true);
	});

	it('routes plain session ids to the terminal log with isStderr=true', () => {
		const batched = makeBatchedUseAgentStderrListener();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1', 'oops');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'oops', true);
	});

	it('drops empty/whitespace-only stderr', () => {
		const batched = makeBatchedUseAgentStderrListener();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1', '   ');
		onStderrHandler!('sess-1', '\n\t');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('ignores batch session ids', () => {
		const batched = makeBatchedUseAgentStderrListener();
		renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
		onStderrHandler!('sess-1-batch-tab-1', 'data');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});
});
