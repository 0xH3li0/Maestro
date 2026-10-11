/**
 * Tests for LocalModelsTab - the core Local Models settings tab shell.
 *
 * Verifies the section headings render, each section carries the
 * `data-setting-id` its searchable-settings entry points at, and opening the
 * tab only reads what is on disk (nothing downloads or probes on open).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { LocalModelsTab } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab';
import { LOCAL_MODELS_SETTINGS } from '../../../../../renderer/components/Settings/searchableSettingsLocalModels';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
	},
} as unknown as Theme;

describe('LocalModelsTab', () => {
	it('renders the Models, Endpoints, Assignments, and Gateway sections', () => {
		render(<LocalModelsTab theme={theme} />);
		expect(screen.getByTestId('local-models-tab')).toBeInTheDocument();
		expect(screen.getByText('Models')).toBeInTheDocument();
		expect(screen.getByText('Endpoints')).toBeInTheDocument();
		expect(screen.getByText('Assignments')).toBeInTheDocument();
		expect(screen.getByText('Gateway')).toBeInTheDocument();
		expect(screen.getByTestId('local-models-gateway-section')).toBeInTheDocument();
	});

	it('renders a section for every searchable-settings entry on the tab', () => {
		const { container } = render(<LocalModelsTab theme={theme} />);
		for (const entry of LOCAL_MODELS_SETTINGS) {
			expect(entry.tab).toBe('local-models');
			expect(container.querySelector(`[data-setting-id="${entry.id}"]`)).not.toBeNull();
		}
	});

	it('says that nothing downloads until the user asks', () => {
		render(<LocalModelsTab theme={theme} />);
		expect(screen.getByText(/Nothing downloads until you ask for it/)).toBeInTheDocument();
		expect(window.maestro.localModels.download).not.toHaveBeenCalled();
	});
});
