/**
 * Tests for LocalModelsGatewaySection - the table of agents and the gateway
 * each one's provider traffic goes through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session, Theme } from '../../../../../renderer/types';
import { LocalModelsGatewaySection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsGatewaySection';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		error: '#ff0000',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function agent(overrides: Partial<Session>): Session {
	return { id: 'a', name: 'Agent', toolType: 'claude-code', aiTabs: [], ...overrides } as Session;
}

function seed(...sessions: Session[]) {
	useSessionStore.setState({ sessions });
}

function row(agentId: string): HTMLElement {
	const found = screen
		.getAllByTestId('local-models-gateway-row')
		.find((el) => el.getAttribute('data-agent-id') === agentId);
	if (!found) throw new Error(`no row for ${agentId}`);
	return found;
}

beforeEach(() => {
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	useSettingsStore.setState({ shellEnvVars: {} });
});

describe('LocalModelsGatewaySection', () => {
	it('lists every agent by name with its gateway, and leaves terminals out', () => {
		seed(
			agent({ id: 'z', name: 'Zed', toolType: 'codex', gatewayUrl: 'http://localhost:4000' }),
			agent({ id: 'a', name: 'Alpha' }),
			agent({ id: 't', name: 'Shell', toolType: 'terminal' })
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		const rows = screen.getAllByTestId('local-models-gateway-row');
		expect(rows.map((el) => el.getAttribute('data-agent-id'))).toEqual(['a', 'z']);
		expect(within(row('z')).getByRole('textbox')).toHaveValue('http://localhost:4000');
		expect(within(row('z')).getByText('Codex')).toBeInTheDocument();
	});

	it('says there are no agents when there are none', () => {
		seed();

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.getByTestId('local-models-gateway-empty')).toBeInTheDocument();
	});

	it("notes the user's responsibility for subscription terms", () => {
		seed();

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.getByText(/you are responsible for your\s+provider's terms/)).toBeInTheDocument();
	});

	it('saves a gateway on commit, normalized, and flushes it to main', async () => {
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		const input = within(row('a')).getByRole('textbox');

		fireEvent.change(input, { target: { value: 'http://127.0.0.1:8787/anthropic/' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter' });
		});

		await waitFor(() =>
			expect(useSessionStore.getState().sessions[0].gatewayUrl).toBe(
				'http://127.0.0.1:8787/anthropic'
			)
		);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
		expect(within(row('a')).getByRole('textbox')).toHaveValue('http://127.0.0.1:8787/anthropic');
	});

	it('shows why a value was refused and stores nothing', async () => {
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		const input = within(row('a')).getByRole('textbox');

		fireEvent.change(input, { target: { value: 'nope' } });
		await act(async () => {
			fireEvent.blur(input);
		});

		await waitFor(() =>
			expect(within(row('a')).getByTestId('gateway-url-a-status')).toHaveTextContent('not a URL')
		);
		expect(useSessionStore.getState().sessions[0].gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('disables the field for Copilot CLI with the reason', () => {
		seed(agent({ id: 'c', name: 'Copilot', toolType: 'copilot-cli' }));

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(within(row('c')).getByRole('textbox')).toBeDisabled();
		expect(within(row('c')).getByTestId('gateway-url-c-status')).toHaveTextContent(
			'ignores base-URL variables'
		);
	});

	it('warns that a loopback gateway cannot be reached from an SSH remote', () => {
		seed(
			agent({
				id: 'r',
				name: 'Remote',
				gatewayUrl: 'http://127.0.0.1:8787',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
			} as Partial<Session>)
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(within(row('r')).getByTestId('gateway-url-r-status')).toHaveTextContent(
			'SSH remote "box" cannot reach'
		);
	});

	it('shows the effective environment with the gateway as the source', () => {
		seed(agent({ id: 'a', name: 'Alpha', gatewayUrl: 'http://127.0.0.1:8787' }));
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-env-toggle-a'));

		const envRow = within(screen.getByTestId('gateway-env-a')).getByTestId('gateway-env-a-row');
		expect(envRow).toHaveAttribute('data-env-key', 'ANTHROPIC_BASE_URL');
		expect(envRow).toHaveTextContent('http://127.0.0.1:8787');
		expect(envRow).toHaveTextContent('Local Models gateway');
	});

	it("badges the agent's own variable when it beats the gateway", () => {
		seed(
			agent({
				id: 'a',
				name: 'Alpha',
				gatewayUrl: 'http://127.0.0.1:8787',
				customEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
			})
		);
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-env-toggle-a'));

		const envRow = within(screen.getByTestId('gateway-env-a')).getByTestId('gateway-env-a-row');
		expect(envRow).toHaveTextContent('https://mine.example.com');
		expect(envRow).toHaveTextContent('This agent');
		expect(within(row('a')).getByTestId('gateway-url-a-status')).toHaveTextContent('Not applied');
	});

	it('offers no environment view for an agent with no gateway', () => {
		seed(agent({ id: 'a', name: 'Alpha' }));

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.queryByTestId('gateway-env-toggle-a')).toBeNull();
	});
});
