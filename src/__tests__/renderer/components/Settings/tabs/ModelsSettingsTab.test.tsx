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

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { ModelsSettingsTab } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab';
import { MODELS_SETTINGS_PANEL_STORAGE_KEY } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/ModelsSettingsTab';
import { LOCAL_MODELS_SETTINGS } from '../../../../../renderer/components/Settings/searchableSettingsLocalModels';
import {
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
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
		expect(present('local-models-endpoints')).toBe(false);

		openPanel('Sources');
		expect(present('local-models-endpoints')).toBe(true);
		expect(present('local-models-models')).toBe(false);

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

	it('renders every searchable-settings entry on one of its inner tabs', () => {
		const { container } = render(<ModelsSettingsTab theme={theme} />);
		const seen = new Set<string>();
		for (const panel of MODELS_SETTINGS_PANELS) {
			openPanel(MODELS_SETTINGS_PANEL_LABELS[panel]);
			for (const el of container.querySelectorAll('[data-setting-id]')) {
				seen.add(el.getAttribute('data-setting-id')!);
			}
		}
		for (const entry of LOCAL_MODELS_SETTINGS) {
			expect(entry.tab).toBe('local-models');
			expect(seen.has(entry.id)).toBe(true);
		}
	});

	it('says that nothing downloads until the user asks', () => {
		render(<ModelsSettingsTab theme={theme} />);
		expect(screen.getByText(/Nothing downloads until you ask for it/)).toBeInTheDocument();
		expect(window.maestro.localModels.download).not.toHaveBeenCalled();
	});
});
