import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPill } from '../../../../../renderer/components/InputArea/components/ProviderPill';
import { ModelEffortPills } from '../../../../../renderer/components/InputArea/components/ModelEffortPills';
import { useTabProviderChoice } from '../../../../../renderer/components/InputArea/hooks/useTabProviderChoice';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useTabStore } from '../../../../../renderer/stores/tabStore';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { projectTabProvider } from '../../../../../renderer/utils/providerTabSessions';
import {
	useAgentModelEffortOptions,
	resolveModelEffort,
} from '../../../../../renderer/hooks/agent/useAgentModelEffortOptions';
import { createMockAITab } from '../../../../helpers/mockTab';
import { createMockSession } from '../../../../helpers/mockSession';
import { inputAreaTheme } from '../_fixtures';
import type { AgentConfig } from '../../../../../renderer/types';

// Exercise the actual switch action and discovery, rather than mocking parking.
function Composer() {
	const session = useSessionStore((state) => state.sessions[0]);
	const enabled = !!useSettingsStore((state) => state.encoreFeatures.ensemble);
	const choice = useTabProviderChoice(session, enabled);
	const tab = session.aiTabs[0];
	const projected = projectTabProvider(session, tab);
	const options = useAgentModelEffortOptions(projected.agent.toolType);
	const { model, effort } = resolveModelEffort(projected.tab, projected.agent, options);
	const [modelOpen, setModelOpen] = useState(false);
	const [effortOpen, setEffortOpen] = useState(false);
	return (
		<>
			{enabled && (
				<ProviderPill
					theme={inputAreaTheme}
					choice={choice}
					onOpen={() => {
						setModelOpen(false);
						setEffortOpen(false);
					}}
				/>
			)}
			<ModelEffortPills
				key={projected.agent.toolType}
				isVisible
				theme={inputAreaTheme}
				currentModel={model}
				currentEffort={effort}
				availableModels={['auto', ...options.models]}
				availableEfforts={options.efforts}
				modelMenuOpen={modelOpen}
				setModelMenuOpen={setModelOpen}
				effortMenuOpen={effortOpen}
				setEffortMenuOpen={setEffortOpen}
				modelMenuRef={{ current: null }}
				effortMenuRef={{ current: null }}
				onModelChange={(value) => useTabStore.getState().setTabModel(tab.id, value)}
				onEffortChange={(value) => useTabStore.getState().setTabEffort(tab.id, value)}
			/>
		</>
	);
}

describe('Ensemble provider pill', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, ensemble: true },
		}));
		const session = createMockSession({
			id: 'agent',
			toolType: 'claude-code',
			activeTabId: 'tab-1',
			aiTabs: [
				createMockAITab({
					id: 'tab-1',
					customModel: 'auto',
					customEffort: 'high',
					runOn: { type: 'provider' },
					agentSessionId: 'native-a',
				}),
			],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(
			['claude-code', 'codex', 'opencode'].map(
				(id) => ({ id, name: id, available: true }) as AgentConfig
			)
		);
		vi.mocked(window.maestro.agents.get).mockResolvedValue({ available: true } as AgentConfig);
		vi.mocked(window.maestro.agents.getModels).mockImplementation(async (provider) =>
			provider === 'codex' ? ['gpt-model'] : ['claude-model']
		);
		vi.mocked(window.maestro.agents.getConfigOptions).mockImplementation(async (provider, key) =>
			key === 'effort' ? (provider === 'codex' ? ['low', 'medium'] : ['low', 'high']) : []
		);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
	});
	afterEach(() => {
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, ensemble: false },
		}));
		vi.restoreAllMocks();
	});

	it('renders nothing with the flag off and does not detect providers', () => {
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, ensemble: false },
		}));
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		expect(screen.queryByRole('button', { name: /Provider for this tab/ })).not.toBeInTheDocument();
		expect(window.maestro.agents.detect).not.toHaveBeenCalled();
	});

	it('switches models and efforts and restores Auto, effort and Run on on A to B to A', async () => {
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Provider for this tab: Claude Code' }));
		const codex = await screen.findByRole('menuitemradio', { name: /^Codex/ });
		await waitFor(() => expect(codex).toHaveAttribute('aria-disabled', 'false'));
		fireEvent.click(codex);
		await screen.findByRole('button', { name: 'Provider for this tab: Codex' });
		fireEvent.click(screen.getByTitle('Change model'));
		fireEvent.click(await screen.findByRole('button', { name: 'gpt-model' }));
		fireEvent.click(screen.getByTitle('Change effort level'));
		fireEvent.click(screen.getByRole('button', { name: 'medium' }));
		fireEvent.click(screen.getByRole('button', { name: 'Provider for this tab: Codex' }));
		fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Code' }));
		await screen.findByRole('button', { name: 'Provider for this tab: Claude Code' });
		expect(screen.getByTitle('Change model')).toHaveTextContent('Auto');
		expect(await screen.findByTitle('Change effort level')).toHaveTextContent('high');
		const session = useSessionStore.getState().sessions[0];
		expect(session.toolType).toBe('claude-code');
		expect(session.aiTabs[0].runOn).toEqual({ type: 'provider' });
		expect(session.aiTabs[0].providerSessions?.codex).toMatchObject({
			customModel: 'gpt-model',
			customEffort: 'medium',
		});
	});

	it('explains disabled installed providers and does not accept translation warnings', async () => {
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: /Provider for this tab/ }));
		const openCode = await screen.findByRole('menuitemradio', { name: /^OpenCode/ });
		expect(openCode).toHaveAttribute('aria-disabled', 'true');
		expect(openCode).toHaveTextContent(
			'Context translation from Claude Code to OpenCode is not available.'
		);
		fireEvent.click(openCode);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].tabProvider).toBeUndefined();
		expect(
			await screen.findByText('Context translation is unverified; review required before sending.')
		).toBeInTheDocument();
	});

	it('opens, moves and selects by keyboard, then returns focus on Escape', async () => {
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		const trigger = screen.getByRole('button', { name: /Provider for this tab/ });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		const codex = await screen.findByRole('menuitemradio', { name: /^Codex/ });
		await waitFor(() => expect(codex).toHaveAttribute('aria-disabled', 'false'));
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
		expect(codex).toHaveFocus();
		fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Provider for this tab: Codex' });
		const next = screen.getByRole('button', { name: /Provider for this tab/ });
		await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
		expect(next).toBe(trigger);
		expect(next).toHaveFocus();
		fireEvent.keyDown(next, { key: 'ArrowDown' });
		fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
		expect(next).toHaveFocus();
	});

	it('keeps SSH switching disabled without probing the local host', () => {
		useSessionStore.getState().updateSession('agent', { sshRemoteId: 'remote' });
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		expect(screen.getByRole('button', { name: /Provider for this tab/ })).toBeDisabled();
		expect(screen.getByRole('button', { name: /Provider for this tab/ })).toHaveAttribute(
			'title',
			expect.stringContaining('live SSH acceptance was skipped')
		);
		expect(window.maestro.agents.detect).not.toHaveBeenCalled();
	});

	it('leaves the menu open with a readable switch failure', async () => {
		vi.spyOn(useTabStore.getState(), 'setTabProvider').mockRejectedValue(
			new Error('Tab changed; retry.')
		);
		render(
			<LayerStackProvider>
				<Composer />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: /Provider for this tab/ }));
		const codex = await screen.findByRole('menuitemradio', { name: /^Codex/ });
		await waitFor(() => expect(codex).toHaveAttribute('aria-disabled', 'false'));
		fireEvent.click(codex);
		expect(await screen.findByRole('alert')).toHaveTextContent('Tab changed; retry.');
		expect(screen.getByRole('menu')).toBeInTheDocument();
	});
});
