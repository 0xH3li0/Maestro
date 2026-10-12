/**
 * @file quickChatEngine.test.ts
 * @description The app-renderer half of Quick Chat: which agent a chat runs on,
 * the hidden-vs-kept tab it lives in, and what each window command does to it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	QUICK_CHAT_TAB_NAME,
	buildQuickChatSnapshot,
	isQuickChatTab,
	resetQuickChatEngineForTests,
	runQuickChatCommand,
	startQuickChatEngine,
} from '../../../renderer/services/quickChatEngine';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../../../shared/quickChat';
import type { Session } from '../../../renderer/types';

vi.mock('../../../renderer/services/agentNavigation', () => ({ jumpToAgent: vi.fn() }));
import { jumpToAgent } from '../../../renderer/services/agentNavigation';

const remoteCommands: CustomEvent[] = [];
const onRemoteCommand = (e: Event) => remoteCommands.push(e as CustomEvent);

function agent(id: string, overrides: Partial<Session> = {}): Session {
	const mainTab = createMockAITab({ id: `${id}-main` });
	return createMockSession({
		id,
		name: `Agent ${id}`,
		aiTabs: [mainTab],
		activeTabId: mainTab.id,
		unifiedTabOrder: [{ type: 'ai', id: mainTab.id }],
		...overrides,
	});
}

function session(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

function setQuickChatSettings(patch: Partial<typeof DEFAULT_QUICK_CHAT_SETTINGS>) {
	useSettingsStore.setState({
		quickChatSettings: { ...DEFAULT_QUICK_CHAT_SETTINGS, ...patch },
	});
}

beforeEach(() => {
	resetQuickChatEngineForTests();
	remoteCommands.length = 0;
	window.addEventListener('maestro:remoteCommand', onRemoteCommand);
	useSessionStore.setState({ sessions: [agent('a'), agent('b')], activeSessionId: 'b' });
	setQuickChatSettings({});
	useSettingsStore.setState({ defaultSaveToHistory: true });
	// The shared setup mock has no interrupt; the engine calls it on stop/new.
	(window.maestro.process as { interrupt?: unknown }).interrupt = vi.fn().mockResolvedValue(true);
	vi.mocked(jumpToAgent).mockClear();
});

afterEach(() => {
	window.removeEventListener('maestro:remoteCommand', onRemoteCommand);
});

describe('agent resolution', () => {
	it('uses the configured agent', () => {
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('a');
	});

	it('falls back to the active agent when none is configured or it is gone', () => {
		expect(buildQuickChatSnapshot().agentId).toBe('b');
		setQuickChatSettings({ agentId: 'deleted' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
	});

	it('never picks a terminal-only agent', () => {
		useSessionStore.setState({
			sessions: [agent('t', { toolType: 'terminal' }), agent('a')],
			activeSessionId: 't',
		});
		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.agentId).toBe('a');
		expect(snapshot.agents.map((x) => x.id)).toEqual(['a']);
	});

	it('lists each agent with its group and provider for the picker', () => {
		useSessionStore.setState({
			sessions: [agent('a', { groupId: 'g1', toolType: 'codex' }), agent('b', { groupId: '' })],
			groups: [{ id: 'g1', name: 'Backend', emoji: '', collapsed: false }],
			activeSessionId: 'b',
		});
		expect(buildQuickChatSnapshot().agents).toEqual([
			{ id: 'a', name: 'Agent a', groupName: 'Backend', provider: 'Codex' },
			{ id: 'b', name: 'Agent b', groupName: undefined, provider: 'Claude Code' },
		]);
	});

	it('lists agents in Left Bar order and leaves worktree children out', () => {
		useSessionStore.setState({
			sessions: [
				agent('loose', { name: 'Loose', groupId: undefined }),
				agent('z', { name: 'Zed', groupId: 'g-alpha' }),
				agent('wt', { name: 'Zed: feature', groupId: 'g-alpha', parentSessionId: 'z' }),
				agent('m', { name: 'Mid', groupId: 'g-beta' }),
				agent('y', { name: 'Yak', groupId: 'g-alpha' }),
			],
			groups: [
				{ id: 'g-beta', name: 'Beta', emoji: '', collapsed: false },
				{ id: 'g-alpha', name: 'Alpha', emoji: '', collapsed: false },
			],
			activeSessionId: 'loose',
		});
		expect(buildQuickChatSnapshot().agents.map((x) => x.id)).toEqual(['y', 'z', 'm', 'loose']);
	});
});

describe('send', () => {
	it('creates a hidden Quick Chat tab in the background and dispatches to it', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: 'hello' });
		expect(result.ok).toBe(true);

		const b = session('b');
		const tab = b.aiTabs.find((t) => t.id === result.snapshot.tabId)!;
		expect(tab).toMatchObject({
			name: QUICK_CHAT_TAB_NAME,
			quickChat: true,
			hidden: true,
			saveToHistory: true,
		});
		// The user's view did not move.
		expect(b.activeTabId).toBe('b-main');

		expect(remoteCommands).toHaveLength(1);
		expect(remoteCommands[0].detail).toEqual({
			sessionId: 'b',
			command: 'hello',
			inputMode: 'ai',
			tabId: tab.id,
			force: true,
		});
	});

	it('honors the ephemeral-history setting on a hidden tab', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.saveToHistory).toBe(false);
	});

	it('creates a visible tab when new chats are kept', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(snapshot.persistent).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
	});

	it('reuses the tab for the next message', async () => {
		const first = await runQuickChatCommand({ type: 'send', text: 'one' });
		const second = await runQuickChatCommand({ type: 'send', text: 'two' });
		expect(second.snapshot.tabId).toBe(first.snapshot.tabId);
		expect(session('b').aiTabs).toHaveLength(2);
	});

	it('stays on its agent when the setting changes mid-chat', async () => {
		const first = await runQuickChatCommand({ type: 'send', text: 'one' });
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
		expect(buildQuickChatSnapshot().tabId).toBe(first.snapshot.tabId);
	});

	it('refuses while the reply is still running', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'one' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId ? { ...t, state: 'busy' as const } : t
							),
						}
					: s
			),
		});
		const result = await runQuickChatCommand({ type: 'send', text: 'two' });
		expect(result.ok).toBe(false);
		expect(remoteCommands).toHaveLength(1);
	});

	it('rejects an empty message', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: '   ' });
		expect(result.ok).toBe(false);
		expect(remoteCommands).toHaveLength(0);
	});
});

describe('new chat', () => {
	it('deletes an ephemeral tab without putting it on the undo stack', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.tabId).toBeNull();
		const b = session('b');
		expect(b.aiTabs.some((t) => t.id === snapshot.tabId)).toBe(false);
		expect(b.closedTabHistory).toEqual([]);
	});

	it('leaves a kept tab on the agent', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		await runQuickChatCommand({ type: 'new' });
		expect(session('b').aiTabs.some((t) => t.id === snapshot.tabId)).toBe(true);
	});

	it('resets a per-chat mode back to the setting', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.persistent).toBe(false);
	});
});

describe('keep (setPersistent)', () => {
	it('reveals a hidden chat tab and switches it to the normal history rule', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		expect(result.snapshot.persistent).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)).toMatchObject({
			hidden: false,
			saveToHistory: true,
		});
	});

	it('hides a kept tab again, moving the main window off it first', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, activeTabId: snapshot.tabId! } : s)),
		});
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: false });
		expect(result.ok).toBe(true);
		const b = session('b');
		expect(b.aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(true);
		expect(b.activeTabId).toBe('b-main');
	});

	it('applies to the next tab when no chat has started', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
	});
});

describe('reveal, stop, setAgent', () => {
	it('reveal keeps the tab and jumps to it', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'reveal' });
		expect(result.ok).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
		expect(jumpToAgent).toHaveBeenCalledWith('b', { tabId: snapshot.tabId });
	});

	it('reveal fails before the first message', async () => {
		expect((await runQuickChatCommand({ type: 'reveal' })).ok).toBe(false);
	});

	it('stop interrupts only the chat tab process', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId ? { ...t, state: 'busy' as const } : t
							),
						}
					: s
			),
		});
		await runQuickChatCommand({ type: 'stop' });
		expect(window.maestro.process.interrupt).toHaveBeenCalledWith(`b-ai-${snapshot.tabId}`);
	});

	it('setAgent ends the chat and saves the new agent', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		expect(result.snapshot.agentId).toBe('a');
		expect(result.snapshot.tabId).toBeNull();
		expect(useSettingsStore.getState().quickChatSettings.agentId).toBe('a');
		expect(session('b').aiTabs.some((t) => t.id === snapshot.tabId)).toBe(false);
	});

	it('setAgent rejects an unknown agent', async () => {
		expect((await runQuickChatCommand({ type: 'setAgent', agentId: 'nope' })).ok).toBe(false);
	});
});

describe('snapshot', () => {
	it('carries the conversation and busy state of the chat tab', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId
									? {
											...t,
											state: 'busy' as const,
											thinkingStartTime: 42,
											logs: [
												{ id: 'l1', timestamp: 1, source: 'user' as const, text: 'hi' },
												{ id: 'l2', timestamp: 2, source: 'stdout' as const, text: 'hello' },
											],
										}
									: t
							),
						}
					: s
			),
		});
		const next = buildQuickChatSnapshot();
		expect(next.busy).toBe(true);
		expect(next.busySince).toBe(42);
		expect(next.messages.map((m) => m.text)).toEqual(['hi', 'hello']);
	});

	it("falls back to the agent's start time when the busy tab carries none", async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							thinkingStartTime: 77,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId
									? { ...t, state: 'busy' as const, thinkingStartTime: undefined }
									: t
							),
						}
					: s
			),
		});
		expect(buildQuickChatSnapshot().busySince).toBe(77);
	});

	it("does not borrow the agent's start time while another tab is busy too", async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							thinkingStartTime: 77,
							aiTabs: s.aiTabs.map((t) => ({
								...t,
								state: 'busy' as const,
								thinkingStartTime: t.id === snapshot.tabId ? undefined : 50,
							})),
						}
					: s
			),
		});
		expect(buildQuickChatSnapshot().busySince).toBeNull();
	});

	it('drops a chat whose tab was closed elsewhere', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== snapshot.tabId) } : s
				),
		});
		expect(buildQuickChatSnapshot().tabId).toBeNull();
	});
});

describe('snapshot streaming', () => {
	afterEach(() => vi.useRealTimers());

	async function startOwningEngine() {
		vi.useFakeTimers();
		let handler: ((command: { type: 'sync' }) => unknown) | undefined;
		vi.mocked(window.maestro.quickChat.onCommand).mockImplementationOnce((cb) => {
			handler = cb as typeof handler;
			return () => {};
		});
		const stop = startQuickChatEngine();
		// Only a window that has received a command streams snapshots.
		await handler?.({ type: 'sync' });
		vi.mocked(window.maestro.quickChat.pushSnapshot).mockClear();
		return stop;
	}

	it('re-pushes the picker list when Show Hidden changes in the main window', async () => {
		useSessionStore.setState({
			sessions: [agent('a'), agent('h', { groupId: 'hid' })],
			groups: [{ id: 'hid', name: 'Hidden', emoji: '', collapsed: false, hidden: true }],
			activeSessionId: 'a',
		});
		useSettingsStore.setState({ showHiddenGroups: false });
		const stop = await startOwningEngine();

		useSettingsStore.setState({ showHiddenGroups: true });
		vi.advanceTimersByTime(500);
		const pushed = vi.mocked(window.maestro.quickChat.pushSnapshot).mock.calls.at(-1)?.[0];
		expect(pushed?.agents.map((x) => x.id)).toEqual(['h', 'a']);
		stop();
	});

	it('re-pushes when the active agent changes', async () => {
		const stop = await startOwningEngine();
		useSessionStore.setState({ activeSessionId: 'a' });
		vi.advanceTimersByTime(500);
		expect(window.maestro.quickChat.pushSnapshot).toHaveBeenCalled();
		stop();
	});
});

describe('isQuickChatTab', () => {
	it('recognizes only tabs Quick Chat created', () => {
		expect(isQuickChatTab(createMockAITab({ quickChat: true }))).toBe(true);
		expect(isQuickChatTab(createMockAITab())).toBe(false);
		expect(isQuickChatTab(undefined)).toBe(false);
	});
});
