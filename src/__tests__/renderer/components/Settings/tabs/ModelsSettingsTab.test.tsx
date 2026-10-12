/**
 * Tests for ModelsSettingsTab - the Models settings tab: five inner tabs
 * (Library, Sources, System One, System Two, Gateway) over the existing
 * sections.
 *
 * Verifies the strip and its panels, that each system panel lists exactly its
 * own tasks, that the Utility Agent sits under System Two, that the last inner
 * tab is remembered, and that opening the tab only reads what is on disk
 * (nothing downloads or probes on open).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { ModelsSettingsTab } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab';
import { MODELS_SETTINGS_PANEL_STORAGE_KEY } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/ModelsSettingsTab';
import { LOCAL_MODELS_SETTINGS } from '../../../../../renderer/components/Settings/searchableSettingsLocalModels';
import {
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
	type ModelsSettingsPanel,
} from '../../../../../shared/local-models/settings-location';
import { tasksForSystem } from '../../../../../shared/local-models/tasks';
import { installLocalStorageMock } from '../../../../helpers/mockLocalStorage';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

function openPanel(label: string) {
	fireEvent.click(screen.getByRole('tab', { name: label }));
}

describe('ModelsSettingsTab', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('renders one inner tab per panel, opening on Library', () => {
		render(<ModelsSettingsTab theme={theme} />);
		expect(screen.getByTestId('models-settings-tab')).toBeInTheDocument();
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(
			MODELS_SETTINGS_PANELS.map((panel) => MODELS_SETTINGS_PANEL_LABELS[panel])
		);
		expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'settings-models-tabpanel-library');
	});

	it('shows each section on its own inner tab', () => {
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		const present = (id: string) => container.querySelector(`[data-setting-id="${id}"]`) !== null;

		expect(present('local-models-models')).toBe(true);
		expect(present('local-models-model-server')).toBe(true);
		expect(present('local-models-endpoints')).toBe(false);

		openPanel('Sources');
		expect(present('local-models-endpoints')).toBe(true);
		expect(present('local-models-models')).toBe(false);
		expect(present('local-models-model-server')).toBe(false);

		openPanel('Gateway');
		expect(present('local-models-gateway')).toBe(true);
		expect(screen.getByTestId('local-models-gateway-section')).toBeInTheDocument();
	});

	it('lists only System One tasks on System One, with the semantic index card', () => {
		render(<ModelsSettingsTab theme={theme} />);
		openPanel('System One');

		for (const task of tasksForSystem('one')) {
			expect(screen.getByTestId(`local-models-task-${task.id}`)).toBeInTheDocument();
		}
		for (const task of tasksForSystem('two')) {
			expect(screen.queryByTestId(`local-models-task-${task.id}`)).toBeNull();
		}
		expect(screen.getByTestId('semantic-index-settings')).toBeInTheDocument();
		expect(document.querySelector('[data-setting-id="local-models-utility-agent"]')).toBeNull();
	});

	it('puts the decision ledger under the System One tasks, and on no other inner tab', async () => {
		vi.mocked(window.maestro.localModels.systemOne.ledger).mockClear();
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		const ledger = () =>
			container.querySelector('[data-setting-id="local-models-system-one-ledger"]');
		expect(ledger()).toBeNull();
		expect(window.maestro.localModels.systemOne.ledger).not.toHaveBeenCalled();

		openPanel('System One');
		expect(ledger()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		expect(
			tasks.compareDocumentPosition(ledger()!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the ledger. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.ledger).toHaveBeenCalledWith({});
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();
		expect(await screen.findByTestId('system-one-ledger-empty')).toBeInTheDocument();

		openPanel('System Two');
		expect(ledger()).toBeNull();
	});

	it('puts System One for agents between the tasks and the ledger, and on no other inner tab', async () => {
		vi.mocked(window.maestro.localModels.systemOne.usage).mockClear();
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		const agents = () =>
			container.querySelector('[data-setting-id="local-models-system-one-agents"]');
		expect(agents()).toBeNull();
		expect(window.maestro.localModels.systemOne.usage).not.toHaveBeenCalled();

		openPanel('System One');
		expect(agents()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		const ledger = container.querySelector('[data-setting-id="local-models-system-one-ledger"]')!;
		expect(
			tasks.compareDocumentPosition(agents()!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			agents()!.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the spend. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.usage).toHaveBeenCalledTimes(1);
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();
		// The switch reads the tab's one report: on by default.
		expect(
			await screen.findByRole('switch', { name: 'Let agents use System One' })
		).toHaveAttribute('aria-checked', 'true');

		openPanel('System Two');
		expect(agents()).toBeNull();
	});

	it('puts the engine card above the System One tasks, and on no other inner tab', async () => {
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		const engine = () =>
			container.querySelector('[data-setting-id="local-models-system-one-engine"]');
		expect(engine()).toBeNull();

		openPanel('System One');
		expect(engine()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		expect(
			engine()!.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the report. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.report).toHaveBeenCalled();
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();

		// The fail policy column fills in from that one report.
		expect(await screen.findByTestId('local-models-task-fail-policy-cue-gate')).toHaveValue('open');

		openPanel('System Two');
		expect(engine()).toBeNull();
		expect(screen.queryByTestId('local-models-assignments-columns')).toBeNull();
	});

	it('lists only System Two tasks on System Two, with the Utility Agent under them', () => {
		render(<ModelsSettingsTab theme={theme} />);
		openPanel('System Two');

		for (const task of tasksForSystem('two')) {
			expect(screen.getByTestId(`local-models-task-${task.id}`)).toBeInTheDocument();
		}
		for (const task of tasksForSystem('one')) {
			expect(screen.queryByTestId(`local-models-task-${task.id}`)).toBeNull();
		}
		expect(screen.queryByTestId('semantic-index-settings')).toBeNull();

		const assignments = screen.getByTestId('local-models-assignments-section-two');
		const utility = document.querySelector('[data-setting-id="local-models-utility-agent"]');
		expect(utility).not.toBeNull();
		// Under the table, not above it.
		expect(
			assignments.compareDocumentPosition(utility!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('shows the tier defaults table on System Two, and on no other inner tab', () => {
		vi.mocked(window.maestro.localModels.tiers.options).mockClear();
		render(<ModelsSettingsTab theme={theme} />);
		expect(document.querySelector('[data-setting-id="models-tier-defaults"]')).toBeNull();
		// Opening Library asks no harness what it can run.
		expect(window.maestro.localModels.tiers.options).not.toHaveBeenCalled();

		openPanel('System Two');

		const tiers = document.querySelector('[data-setting-id="models-tier-defaults"]');
		expect(tiers).not.toBeNull();
		expect(screen.getByTestId('tier-defaults-section')).toBeInTheDocument();
		// Under the Utility Agent, which belongs with the assignments above it.
		const utility = document.querySelector('[data-setting-id="local-models-utility-agent"]');
		expect(
			utility!.compareDocumentPosition(tiers!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('remembers the last inner tab across mounts', () => {
		const { unmount } = render(<ModelsSettingsTab theme={theme} />);
		openPanel('Gateway');
		expect(localStorage.getItem(MODELS_SETTINGS_PANEL_STORAGE_KEY)).toBe('gateway');
		unmount();

		render(<ModelsSettingsTab theme={theme} />);
		expect(screen.getByRole('tab', { name: 'Gateway' })).toHaveAttribute('aria-selected', 'true');
	});

	it('falls back to Library when the stored inner tab no longer exists', () => {
		localStorage.setItem(MODELS_SETTINGS_PANEL_STORAGE_KEY, 'assignments');
		render(<ModelsSettingsTab theme={theme} />);
		expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
	});

	it('renders every searchable-settings entry on the inner tab it names', () => {
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		for (const entry of LOCAL_MODELS_SETTINGS) {
			expect(entry.tab).toBe('models');
			openPanel(MODELS_SETTINGS_PANEL_LABELS[entry.subTab as ModelsSettingsPanel]);
			expect(
				container.querySelector(`[data-setting-id="${entry.id}"]`),
				`${entry.id} is not rendered on ${entry.subTab}`
			).not.toBeNull();
		}
	});

	describe('panelRequest', () => {
		it('switches to the requested inner tab, remembers it, and reports it handled', () => {
			const onHandled = vi.fn();
			render(
				<ModelsSettingsTab
					theme={theme}
					panelRequest={{ subTab: 'system-two' }}
					onPanelRequestHandled={onHandled}
				/>
			);
			expect(screen.getByRole('tab', { name: 'System Two' })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(localStorage.getItem(MODELS_SETTINGS_PANEL_STORAGE_KEY)).toBe('system-two');
			expect(onHandled).toHaveBeenCalledTimes(1);
		});

		it('moves a mounted tab to a later request', () => {
			const { rerender } = render(<ModelsSettingsTab theme={theme} />);
			expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');

			rerender(<ModelsSettingsTab theme={theme} panelRequest={{ subTab: 'gateway' }} />);
			expect(screen.getByRole('tab', { name: 'Gateway' })).toHaveAttribute('aria-selected', 'true');
		});

		it('ignores an id that names no inner tab, but still reports it handled', () => {
			const onHandled = vi.fn();
			render(
				<ModelsSettingsTab
					theme={theme}
					panelRequest={{ subTab: 'assignments' }}
					onPanelRequestHandled={onHandled}
				/>
			);
			expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
			expect(onHandled).toHaveBeenCalledTimes(1);
		});

		it('leaves the remembered inner tab alone when there is no request', () => {
			localStorage.setItem(MODELS_SETTINGS_PANEL_STORAGE_KEY, 'sources');
			render(<ModelsSettingsTab theme={theme} />);
			expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
		});
	});

	it('says that nothing downloads until the user asks', () => {
		render(<ModelsSettingsTab theme={theme} />);
		expect(screen.getByText(/Nothing downloads until you ask for it/)).toBeInTheDocument();
		expect(window.maestro.localModels.download).not.toHaveBeenCalled();
	});
});
