/**
 * @fileoverview Tests for GroupSettingsModal: the explainer, the tabbed form
 * seeded from a group's defaults, the save that omits every blank field, and
 * Clear defaults.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GroupSettingsModal } from '../../../renderer/components/GroupSettingsModal';
import { __resetRememberedModalTabsForTests } from '../../../renderer/components/ui/ModalTabStrip';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { AgentConfig, Group } from '../../../renderer/types';
import { createMockTheme } from '../../helpers/mockTheme';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-group-settings'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
		getTopLayer: () => undefined,
		closeTopLayer: vi.fn().mockResolvedValue(true),
		getLayers: () => [],
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
	}),
}));

const theme = createMockTheme();

const createGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'g-backend',
	name: 'Backend',
	emoji: '🌳',
	collapsed: false,
	...overrides,
});

const docsGroup: Group = { id: 'g-docs', name: 'Docs', emoji: '📚', collapsed: false };

/** Show one tab of the form. Only the active tab's fields are rendered. */
const openTab = (name: string) =>
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

describe('GroupSettingsModal', () => {
	let setGroups: ReturnType<typeof vi.fn>;
	let onClose: ReturnType<typeof vi.fn>;

	const renderModal = (group: Group) =>
		render(
			<GroupSettingsModal theme={theme} group={group} setGroups={setGroups} onClose={onClose} />
		);

	/** The groups the last write through `setGroups` would leave in the store. */
	const written = (group: Group): Group[] => {
		const updater = setGroups.mock.calls.at(-1)?.[0] as (prev: Group[]) => Group[];
		return updater([group, docsGroup]);
	};

	beforeEach(() => {
		setGroups = vi.fn();
		onClose = vi.fn();
		// The form remembers its last tab per app session; start every case on General.
		__resetRememberedModalTabsForTests();

		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				path: '/usr/local/bin/claude',
				binaryName: 'claude',
				hidden: false,
				configOptions: [{ key: 'model', type: 'text', label: 'Model', default: '' }],
			} as unknown as AgentConfig,
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'claude-sonnet' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet', 'claude-opus']);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [], groups: [] } as never);
	});

	it('names the group, says the defaults are copied at create, and shows every tab', () => {
		renderModal(createGroup());

		expect(screen.getByText('Group Settings: 🌳 Backend')).toBeInTheDocument();
		const explainer = screen.getByTestId('group-settings-explainer');
		expect(explainer).toHaveTextContent('Nothing here is read while an agent runs.');
		expect(explainer).toHaveTextContent('Leave a field blank to use the Maestro default.');
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
			'General',
			'Provider',
			'Models',
			'Environment',
			'Peers',
			'SSH',
		]);
		// The form names no agent.
		expect(screen.queryByText('Agent Name')).not.toBeInTheDocument();
	});

	it('seeds the form from the group defaults', () => {
		renderModal(
			createGroup({
				defaults: {
					projectRoot: '/srv/app',
					nudgeMessage: 'Be brief.',
					customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
				},
			})
		);

		expect(screen.getByDisplayValue('/srv/app')).toBeInTheDocument();
		expect(screen.getByDisplayValue('Be brief.')).toBeInTheDocument();

		openTab('Environment');
		expect(screen.getByDisplayValue('CLAUDE_CONFIG_DIR')).toBeInTheDocument();
		expect(screen.getByDisplayValue('~/.claude-work')).toBeInTheDocument();
	});

	it('saves only what is set, through setGroups, and closes', () => {
		const group = createGroup({ shortLabel: 'BE' });
		renderModal(group);

		fireEvent.change(screen.getByPlaceholderText(/appended to every message/), {
			target: { value: '  Be brief.  ' },
		});
		fireEvent.click(screen.getByText('Save'));

		expect(setGroups).toHaveBeenCalledTimes(1);
		const [saved, untouched] = written(group);
		expect(saved.defaults).toEqual({ nudgeMessage: 'Be brief.' });
		// The pill label is a property of the group and is carried over.
		expect(saved.shortLabel).toBe('BE');
		expect(untouched).toBe(docsGroup);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('stores no defaults field for a form that holds no opinion', () => {
		const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
		renderModal(group);

		fireEvent.change(screen.getByDisplayValue('Be brief.'), { target: { value: '' } });
		fireEvent.click(screen.getByText('Save'));

		expect(written(group)[0]).not.toHaveProperty('defaults');
	});

	it('saves from the keyboard with Cmd+S', () => {
		const group = createGroup({ defaults: { nudgeMessage: 'Be brief.' } });
		renderModal(group);

		fireEvent.keyDown(window, { key: 's', metaKey: true });

		expect(written(group)[0].defaults).toEqual({ nudgeMessage: 'Be brief.' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('refuses a relative default working directory before the save', () => {
		renderModal(createGroup());

		fireEvent.change(screen.getByLabelText('Default Working Directory'), {
			target: { value: 'projects/app' },
		});

		expect(screen.getByText('Enter an absolute path')).toBeInTheDocument();
		expect(screen.getByText('Save')).toBeDisabled();
		fireEvent.keyDown(window, { key: 's', metaKey: true });
		expect(setGroups).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	describe('Provider tab', () => {
		it('starts on no default provider and keeps the env vars when one is chosen', async () => {
			const group = createGroup({
				defaults: { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
			});
			renderModal(group);
			openTab('Provider');

			const select = screen.getByTestId('group-settings-provider');
			expect(select).toHaveValue('');
			fireEvent.change(select, { target: { value: 'claude-code' } });
			// The provider's own settings load once it is chosen.
			await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());

			fireEvent.click(screen.getByText('Save'));
			expect(written(group)[0].defaults).toEqual({
				toolType: 'claude-code',
				customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
			});
		});

		it('does not write the provider model back as a group default', async () => {
			const group = createGroup({ defaults: { toolType: 'claude-code' } });
			renderModal(group);
			openTab('Provider');

			// The panel shows the provider's own model; the group has no opinion on it.
			await waitFor(() => expect(screen.getByDisplayValue('claude-sonnet')).toBeInTheDocument());
			fireEvent.click(screen.getByText('Save'));

			expect(written(group)[0].defaults).toEqual({ toolType: 'claude-code' });
		});
	});

	describe('Peers tab', () => {
		it('enables the group grant for this group', () => {
			useSessionStore.setState({
				sessions: [
					{ id: 'a1', name: 'Infra', groupId: 'g-backend' },
					{ id: 'a2', name: 'Docs', groupId: 'g-backend' },
				],
				groups: [createGroup()],
			} as never);
			const group = createGroup();
			renderModal(group);
			openTab('Peers');

			const grant = screen.getByRole('checkbox', { name: /Peers in my group/ });
			expect(grant).not.toBeDisabled();

			fireEvent.click(grant);
			fireEvent.click(screen.getByText('Save'));
			expect(written(group)[0].defaults).toEqual({
				groupPeerAccess: { read: true, write: false },
			});
		});
	});

	describe('Clear defaults', () => {
		it('is disabled for a group that holds none', () => {
			renderModal(createGroup());
			expect(screen.getByTestId('group-settings-clear')).toBeDisabled();
		});

		it('removes the field after a confirmation, and closes', () => {
			const group = createGroup({ shortLabel: 'BE', defaults: { nudgeMessage: 'Be brief.' } });
			renderModal(group);

			fireEvent.click(screen.getByTestId('group-settings-clear'));
			// Nothing is written until the confirmation is answered.
			expect(setGroups).not.toHaveBeenCalled();

			const confirm = screen.getByRole('dialog', { name: 'Clear defaults' });
			expect(confirm).toHaveTextContent('clearing is not published to them');
			fireEvent.click(within(confirm).getByRole('button', { name: 'Clear defaults' }));

			const [cleared] = written(group);
			expect(cleared).not.toHaveProperty('defaults');
			expect(cleared.shortLabel).toBe('BE');
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('writes nothing when the confirmation is cancelled', () => {
			renderModal(createGroup({ defaults: { nudgeMessage: 'Be brief.' } }));

			fireEvent.click(screen.getByTestId('group-settings-clear'));
			const confirm = screen.getByRole('dialog', { name: 'Clear defaults' });
			fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('dialog', { name: 'Clear defaults' })).not.toBeInTheDocument();
			expect(setGroups).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});
	});
});
