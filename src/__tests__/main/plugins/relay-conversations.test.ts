import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	RelayConversations,
	cancelRelayConversationTurn,
	type RelayConversationDeps,
} from '../../../main/plugins/relay-conversations';
import { acquireProviderSessionWriter } from '../../../main/utils/provider-session-writer';
import { createMockSession } from '../../helpers/mockSession';
import type { StoredSession } from '../../../main/stores/types';

describe('durable Relay conversations', () => {
	let baseDir: string;
	let agent: StoredSession;
	let deps: RelayConversationDeps;
	let host: RelayConversations;
	const opts = { conversationId: 'discord-thread-1', messageId: 'message-1' };
	const send = (text = 'hello', overrides = {}) =>
		host.send(
			'agent',
			text,
			{ ...opts, ...overrides },
			new AbortController().signal,
			undefined,
			() => {}
		);
	beforeEach(() => {
		const root = path.join(process.cwd(), '.maestro', 'scratch');
		fs.mkdirSync(root, { recursive: true });
		baseDir = fs.mkdtempSync(path.join(root, 'relay-continuity-'));
		agent = createMockSession({
			id: 'agent',
			activeTabId: 'desktop',
			activeFileTabId: 'file',
			aiTabs: [],
			unifiedTabOrder: [],
		});
		deps = {
			baseDir,
			getAgent: () => agent,
			updateAgent: (_id, update) => {
				agent = update(agent);
			},
			run: vi.fn(async (_agent, prompt, sessionId) => ({
				success: true,
				response: `answer:${prompt}`,
				sessionId: sessionId ?? `provider:${prompt}`,
			})),
			now: () => 1000,
		};
		host = new RelayConversations(deps);
	});
	afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));
	it('creates one real background tab and resumes it across messages and host recreation', async () => {
		const first = await send();
		host = new RelayConversations(deps);
		const second = await send('continue', { messageId: 'message-2', sessionId: first.sessionId });
		expect(second.tabId).toBe(first.tabId);
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0]).toMatchObject({
			origin: 'relay',
			agentSessionId: 'provider:hello',
			hidden: false,
		});
		expect(agent.aiTabs[0].logs.map((log: { text: string }) => log.text)).toEqual([
			'hello',
			'answer:hello',
			'continue',
			'answer:continue',
		]);
		expect(agent.unifiedTabOrder).toEqual([{ type: 'ai', id: first.tabId }]);
		expect(agent.activeTabId).toBe('desktop');
		expect(agent.activeFileTabId).toBe('file');
	});
	it('retries a failed first transcript restore and preserves later manual closes', async () => {
		deps.loadTranscript = vi
			.fn()
			.mockRejectedValueOnce(new Error('SSH unavailable'))
			.mockResolvedValue([]);
		await expect(host.restore('agent', opts.conversationId, 'provider')).rejects.toThrow(
			'SSH unavailable'
		);
		expect(agent.aiTabs).toHaveLength(0);
		host = new RelayConversations(deps);
		const restored = await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0].id).toBe(restored.tabId);
		agent.aiTabs = [];
		await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(0);
		expect(deps.loadTranscript).toHaveBeenCalledTimes(2);
	});
	it('retries first materialization after the sessions write fails and memory is reloaded', async () => {
		deps.loadTranscript = vi.fn().mockResolvedValue([]);
		deps.flush = vi
			.fn()
			.mockRejectedValueOnce(new Error('disk write rejected'))
			.mockResolvedValue(undefined);
		await expect(host.restore('agent', opts.conversationId, 'provider')).rejects.toThrow(
			'disk write rejected'
		);
		const tabId = agent.aiTabs[0].id;
		// Simulate restart: the deferred sessions write failed, while the private ledger reached disk.
		agent.aiTabs = [];
		agent.unifiedTabOrder = [];
		host = new RelayConversations(deps);
		await expect(host.restore('agent', opts.conversationId, 'provider')).resolves.toMatchObject({
			success: true,
			tabId,
		});
		expect(agent.aiTabs[0].id).toBe(tabId);
		expect(deps.loadTranscript).toHaveBeenCalledTimes(2);
		agent.aiTabs = [];
		await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(0);
	});
	it('allows a new message after proven no-start failure but never reexecutes its receipt', async () => {
		vi.mocked(deps.run).mockResolvedValueOnce({
			success: false,
			response: null,
			sessionId: null,
			error: 'CLI unavailable',
			executionStarted: false,
		});
		await expect(send()).resolves.toMatchObject({ success: false });
		host = new RelayConversations(deps);
		await expect(send()).resolves.toMatchObject({ replayed: true, success: false });
		await expect(send('retry after fixing CLI', { messageId: 'message-2' })).resolves.toMatchObject(
			{ success: true }
		);
		expect(deps.run).toHaveBeenCalledTimes(2);
	});
	it('retains the uncertainty fence when provider work may have started without a session id', async () => {
		vi.mocked(deps.run).mockResolvedValueOnce({
			success: false,
			response: null,
			sessionId: null,
			error: 'lost provider connection',
		});
		await send();
		await expect(send('next', { messageId: 'message-2' })).rejects.toThrow(
			'Previous Relay execution is uncertain'
		);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('keeps two Relay threads and their provider contexts separate', async () => {
		const [one, two] = await Promise.all([
			send(),
			send('other', { conversationId: 'discord-thread-2' }),
		]);
		expect(one.tabId).not.toBe(two.tabId);
		expect(one.sessionId).not.toBe(two.sessionId);
		expect(agent.aiTabs).toHaveLength(2);
	});
	it('replays concurrent and late duplicates without another execution or transcript entry', async () => {
		const [first, duplicate] = await Promise.all([send(), send()]);
		expect(duplicate).toMatchObject({ ...first, replayed: true });
		host = new RelayConversations(deps);
		expect(await send()).toMatchObject({ replayed: true });
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].logs).toHaveLength(2);
		await expect(send('changed')).rejects.toThrow(/different content/);
	});
	it('waits for the desktop writer and uses the provider identity the desktop left', async () => {
		const first = await send();
		const release = await acquireProviderSessionWriter(
			'claude-code',
			`agent-ai-${first.tabId}`,
			first.sessionId
		);
		let finished = false;
		const pending = send('relay followup', { messageId: 'message-2' }).then(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		expect(finished).toBe(false);
		agent.aiTabs[0].agentSessionId = 'desktop-resumed-provider';
		const releaseOther = await acquireProviderSessionWriter(
			'claude-code',
			'independent-other-tab',
			'desktop-resumed-provider'
		);
		release();
		await new Promise(setImmediate);
		expect(deps.run).toHaveBeenCalledTimes(1);
		agent.aiTabs[0].agentSessionId = 'desktop-latest-provider';
		const releaseLatest = await acquireProviderSessionWriter(
			'claude-code',
			'third-tab',
			'desktop-latest-provider'
		);
		releaseOther();
		await new Promise(setImmediate);
		expect(deps.run).toHaveBeenCalledTimes(1);
		releaseLatest();
		await pending;
		expect(deps.run).toHaveBeenLastCalledWith(
			'agent',
			'relay followup',
			'desktop-latest-provider',
			expect.any(AbortSignal),
			'relay',
			undefined,
			undefined,
			false,
			true
		);
	});
	it('cancels while reacquiring a changed provider without executing or leaking a reservation', async () => {
		const first = await send();
		const processId = `agent-ai-${first.tabId}`;
		const releaseTab = await acquireProviderSessionWriter(
			'claude-code',
			processId,
			first.sessionId
		);
		const controller = new AbortController();
		const pending = host.send(
			'agent',
			'cancelled',
			{ ...opts, messageId: 'cancel-message' },
			controller.signal,
			undefined,
			() => {}
		);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		agent.aiTabs[0].agentSessionId = 'changed-before-abort';
		const releaseOther = await acquireProviderSessionWriter(
			'claude-code',
			'other-tab',
			'changed-before-abort'
		);
		releaseTab();
		await new Promise(setImmediate);
		controller.abort();
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(deps.run).toHaveBeenCalledTimes(1);
		releaseOther();
		const releaseAgain = await acquireProviderSessionWriter(
			'claude-code',
			processId,
			'changed-before-abort'
		);
		releaseAgain();
	});
	it('serializes two messages for one conversation', async () => {
		let resolveRun!: (value: { success: boolean; response: string; sessionId: string }) => void;
		vi.mocked(deps.run).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				})
		);
		const first = send();
		await vi.waitFor(() => expect(resolveRun).toBeTypeOf('function'));
		const next = send('next', { messageId: 'message-2' });
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(() => host.complete('agent', opts.conversationId, opts.messageId)).toThrow(/pending/);
		resolveRun({ success: true, response: 'first answer', sessionId: 'shared-provider' });
		await Promise.all([first, next]);
		expect(deps.run).toHaveBeenLastCalledWith(
			'agent',
			'next',
			'shared-provider',
			expect.any(AbortSignal),
			'relay',
			undefined,
			undefined,
			false,
			true
		);
	});
	it('retains an interrupted receipt and fails closed after restart', async () => {
		vi.mocked(deps.run).mockRejectedValueOnce(new Error('connection lost'));
		await expect(send()).rejects.toThrow(/connection lost/);
		host = new RelayConversations(deps);
		host.reconcileInterrupted();
		expect(await send()).toMatchObject({
			success: false,
			replayed: true,
			error: expect.stringMatching(/interrupted/),
		});
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
	});
	it('requires explicit current completion and reopens an archived conversation with the same tab', async () => {
		const first = await send();
		expect(agent.aiTabs[0].relayConversation.completedAt).toBeUndefined();
		host.complete('agent', opts.conversationId, opts.messageId);
		expect(agent.aiTabs[0].relayConversation.completedAt).toBe(1000);
		agent.aiTabs[0].hidden = true;
		agent.aiTabs[0].relayConversation.archivedAt = 2000;
		await send('wake', { messageId: 'message-2' });
		expect(agent.aiTabs[0]).toMatchObject({ id: first.tabId, hidden: false });
		expect(agent.aiTabs[0].relayConversation.completedAt).toBeUndefined();
		expect(agent.aiTabs[0].relayConversation.archivedAt).toBeUndefined();
		expect(() => host.complete('agent', opts.conversationId, opts.messageId)).toThrow(/stale/);
	});
	it('rejects a late completion after desktop conversation input', async () => {
		await send();
		agent.aiTabs[0].logs.push({
			id: 'desktop-user',
			source: 'user',
			text: 'still working',
			timestamp: 2000,
		});
		expect(() => host.complete('agent', opts.conversationId, opts.messageId)).toThrow(/stale/);
	});
	it('rejects binding the same provider to two conversation ids', async () => {
		const first = await send();
		await expect(
			send('other', { conversationId: 'other-thread', sessionId: first.sessionId })
		).rejects.toThrow(/another Relay conversation/);
		expect(agent.aiTabs).toHaveLength(1);
	});
	it('restores a manually closed conversation from the provider transcript with its original tab id', async () => {
		const first = await send();
		const logs = agent.aiTabs[0].logs;
		agent.aiTabs = [];
		agent.unifiedTabOrder = [];
		deps.loadTranscript = vi.fn(async () => logs);
		await send('reopen', { messageId: 'message-2' });
		expect(agent.aiTabs[0].id).toBe(first.tabId);
		expect(agent.aiTabs[0].logs).toHaveLength(4);
	});
	it('restores only an explicitly mapped old thread and preserves archived and manually closed tabs', async () => {
		deps.loadTranscript = vi.fn(async () => [
			{ id: 'old-user', source: 'user', timestamp: 1, text: 'old request' },
		]);
		const restored = await host.restore('agent', 'old-thread', 'old-provider');
		expect(deps.run).not.toHaveBeenCalled();
		expect(agent.aiTabs[0].logs).toHaveLength(1);
		agent.aiTabs[0].hidden = true;
		agent.aiTabs[0].relayConversation.archivedAt = 1000;
		await host.restore('agent', 'old-thread', 'old-provider');
		expect(agent.aiTabs[0].hidden).toBe(true);
		agent.aiTabs = [];
		await host.restore('agent', 'old-thread', 'old-provider');
		expect(agent.aiTabs).toHaveLength(0);
		expect(restored.tabId).toBeTypeOf('string');
	});
	it('routes the real tab Stop to the headless provider abort signal', async () => {
		vi.mocked(deps.run).mockImplementationOnce(
			(_agent, _prompt, _provider, signal) =>
				new Promise((resolve) => {
					signal!.addEventListener(
						'abort',
						() => resolve({ success: false, response: null, sessionId: null, error: 'cancelled' }),
						{ once: true }
					);
				})
		);
		const pending = send();
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('running'));
		expect(cancelRelayConversationTurn(`agent-ai-${agent.aiTabs[0].id}`)).toBe(true);
		expect(await pending).toMatchObject({ success: false, error: 'cancelled' });
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		expect(cancelRelayConversationTurn(`agent-ai-${agent.aiTabs[0].id}`)).toBe(false);
	});
	it('cancels a queued Relay turn before it gets a writer without launching a process', async () => {
		const first = await send();
		const release = await acquireProviderSessionWriter(
			'claude-code',
			`agent-ai-${first.tabId}`,
			first.sessionId
		);
		const pending = send('queued followup', { messageId: 'message-2' });
		const rejection = expect(pending).rejects.toThrow(/cancelled/);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		expect(cancelRelayConversationTurn(`agent-ai-${first.tabId}`)).toBe(true);
		await rejection;
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		release();
	});
	it('purges private receipts on uninstall and fences late and queued writes without removing user history', async () => {
		let finish!: (result: { success: boolean; response: string; sessionId: string }) => void;
		vi.mocked(deps.run).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const pending = send();
		const firstError = expect(pending).rejects.toThrow(/purged/);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('running'));
		const next = send('queued', { messageId: 'message-2' });
		const queuedError = expect(next).rejects.toThrow(/purged/);
		host.purge();
		finish({ success: true, response: 'late', sessionId: 'late-provider' });
		await Promise.all([firstError, queuedError]);
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0].logs[0].text).toBe('hello');
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		expect(fs.existsSync(path.join(baseDir, 'sh.maestro.relay'))).toBe(false);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('does not resurrect private ledger or tab when restore finishes after uninstall', async () => {
		let finish!: (
			logs: Array<{ id: string; source: string; timestamp: number; text: string }>
		) => void;
		deps.loadTranscript = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const pending = host.restore('agent', 'old', 'old-provider');
		const rejection = expect(pending).rejects.toThrow(/purged/);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		host.purge();
		finish([{ id: 'old', source: 'user', timestamp: 1, text: 'old' }]);
		await rejection;
		expect(agent.aiTabs).toHaveLength(0);
		expect(fs.existsSync(path.join(baseDir, 'sh.maestro.relay'))).toBe(false);
	});
});
