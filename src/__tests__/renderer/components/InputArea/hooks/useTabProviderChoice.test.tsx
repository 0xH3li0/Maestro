import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabProviderChoice } from '../../../../../renderer/components/InputArea/hooks/useTabProviderChoice';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useTabStore } from '../../../../../renderer/stores/tabStore';
import type { AgentConfig } from '../../../../../renderer/types';

describe('useTabProviderChoice', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{ id: 'claude-code', name: 'Claude Code', available: true },
			{ id: 'codex', name: 'Codex', available: true },
		]);
	});
	afterEach(() => vi.restoreAllMocks());

	it('retains a missing current provider and offers the inherited choice separately', async () => {
		const session = createMockSession({
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab({ tabProvider: 'opencode' })],
		});
		const { result } = renderHook(() => useTabProviderChoice(session, true));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.label).toBe('OpenCode');
		expect(result.current.options.find((option) => option.provider === 'opencode')?.selected).toBe(
			true
		);
		expect(result.current.options[0].label).toBe('Use agent default (Claude Code)');
		expect(result.current.options[0].problem).toContain('Context translation');
	});

	it('uses the latest pending native owner when returning to an unsupported harness', async () => {
		const session = createMockSession({
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [
				createMockAITab({
					tabProvider: 'codex',
					pendingTranslation: 'opencode',
					providerSessions: { opencode: { agentSessionId: 'latest-native' } },
				}),
			],
		});
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{ id: 'codex', name: 'Codex', available: true },
			{ id: 'opencode', name: 'OpenCode', available: true },
		]);
		const { result } = renderHook(() => useTabProviderChoice(session, true));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(
			result.current.options.find((option) => option.provider === 'opencode')?.problem
		).toBeUndefined();
		expect(result.current.options[0].problem).toContain('from OpenCode to Claude Code');
	});

	it('discards a late discovery reply after changing the target tab', async () => {
		let finish!: (agents: AgentConfig[]) => void;
		vi.mocked(window.maestro.agents.detect).mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const session = createMockSession({
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab(), createMockAITab({ id: 'tab-2' })],
		});
		const { result, rerender } = renderHook(({ value }) => useTabProviderChoice(value, true), {
			initialProps: { value: session },
		});
		rerender({ value: { ...session, activeTabId: 'tab-2' } });
		await waitFor(() => expect(result.current.loading).toBe(false));
		await act(async () => {
			finish([]);
		});
		expect(
			result.current.options.find((option) => option.provider === 'codex')?.problem
		).toBeUndefined();
	});

	it('passes inheritance through the same authoritative switch operation', async () => {
		const select = vi.spyOn(useTabStore.getState(), 'setTabProvider').mockResolvedValue();
		const session = createMockSession({
			id: 'agent',
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab({ tabProvider: 'codex' })],
		});
		const { result } = renderHook(() => useTabProviderChoice(session, true));
		await act(async () => {
			await result.current.select(undefined);
		});
		expect(select).toHaveBeenCalledWith('agent', 'tab-1', undefined);
	});

	it('fails closed when discovery fails while keeping the current readout', async () => {
		vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('Detection failed'));
		const session = createMockSession({
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab()],
		});
		const { result } = renderHook(() => useTabProviderChoice(session, true));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.label).toBe('Claude Code');
		expect(result.current.options.find((option) => option.provider === 'codex')?.problem).toContain(
			'Could not detect providers on this host: Detection failed'
		);
	});
});
