/**
 * Tests for LocalModelsModelsSection - the Models section of the Local Models tab.
 *
 * Verifies the catalog renders grouped by kind under the disk total, that
 * mounting reads but never downloads, that Download fires only on a click, and
 * that removing a model a task is assigned to warns and names the task first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import { LocalModelsModelsSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsModelsSection';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useLocalModels } from '../../../../../renderer/hooks/localModels';
import {
	BGE_SMALL_EN_ID,
	LOCAL_MODEL_CATALOG,
	PARAKEET_TDT_V2_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#3b2a5c',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

function listing(id: string, installed: boolean): LocalModelListing {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: installed
			? {
					id,
					status: 'installed',
					manifest: {
						installedAt: Date.now(),
						verifiedAt: Date.now(),
					} as never,
					bytesOnDisk: entry.bytes,
				}
			: { id, status: 'not-installed', manifest: null, bytesOnDisk: 0 },
		installPaths: [],
	};
}

/** The section takes the tab's hook state; this stands in for the tab. */
function ModelsSection() {
	const models = useLocalModels();
	return <LocalModelsModelsSection theme={theme} models={models} />;
}

const api = () => window.maestro.localModels as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('LocalModelsModelsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api().list.mockResolvedValue(
			LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id, entry.id === BGE_SMALL_EN_ID))
		);
		api().footprint.mockResolvedValue({
			bytes: getLocalModel(BGE_SMALL_EN_ID)!.bytes,
			models: [{ id: BGE_SMALL_EN_ID, bytes: getLocalModel(BGE_SMALL_EN_ID)!.bytes }],
		});
		api().onProgress.mockReturnValue(() => {});
		useSettingsStore.setState({ localModelAssignments: {} });
	});

	it('groups the catalog by kind and shows the disk total', async () => {
		render(<ModelsSection />);
		expect(await screen.findByTestId('local-models-kind-embedding')).toBeInTheDocument();
		expect(screen.getByText('Text generation')).toBeInTheDocument();
		expect(screen.getByText('Embeddings')).toBeInTheDocument();
		expect(screen.getByText('Classifiers')).toBeInTheDocument();
		expect(screen.getByText('Speech-to-text')).toBeInTheDocument();
		expect(screen.getByText('Wake word')).toBeInTheDocument();
		expect(screen.getByText('On disk')).toBeInTheDocument();
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(screen.getByText(entry.displayName)).toBeInTheDocument();
		}
	});

	it('reads the listing on mount and downloads nothing until a click', async () => {
		render(<ModelsSection />);
		await screen.findByTestId('local-models-kind-embedding');
		expect(api().list).toHaveBeenCalled();
		expect(api().download).not.toHaveBeenCalled();

		const prompt = getLocalModel('prompt-guard-2-22m')!;
		const row = screen.getByText(prompt.displayName).closest('.rounded.border') as HTMLElement;
		fireEvent.click(within(row).getByRole('button', { name: /^Download/ }));
		await waitFor(() => expect(api().download).toHaveBeenCalledWith(prompt.id));
	});

	it('names the voice slot a voice model serves', async () => {
		render(<ModelsSection />);
		expect(
			await screen.findByTestId(`local-model-used-by-${PARAKEET_TDT_V2_ID}`)
		).toHaveTextContent('Voice (speech-to-text)');
	});

	it('removes an unassigned model without a warning', async () => {
		useSettingsStore.setState({ localModelAssignments: {} });
		render(<ModelsSection />);
		const name = getLocalModel(BGE_SMALL_EN_ID)!.displayName;
		const row = (await screen.findByText(name)).closest('.rounded.border') as HTMLElement;
		fireEvent.click(within(row).getByRole('button', { name: /^Remove/ }));
		await waitFor(() => expect(api().remove).toHaveBeenCalledWith(BGE_SMALL_EN_ID));
		expect(screen.queryByTestId('local-model-remove-warning')).not.toBeInTheDocument();
	});

	it('warns and names the tasks before removing a model a task is assigned', async () => {
		useSettingsStore.setState({
			localModelAssignments: { 'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID } },
		});
		render(<ModelsSection />);
		expect(await screen.findByTestId(`local-model-used-by-${BGE_SMALL_EN_ID}`)).toHaveTextContent(
			'Semantic search'
		);

		const name = getLocalModel(BGE_SMALL_EN_ID)!.displayName;
		const row = screen.getByText(name).closest('.rounded.border') as HTMLElement;
		fireEvent.click(within(row).getByRole('button', { name: /^Remove/ }));

		const warning = screen.getByTestId('local-model-remove-warning');
		expect(warning).toHaveTextContent('Semantic search');
		expect(api().remove).not.toHaveBeenCalled();

		fireEvent.click(within(warning).getByRole('button', { name: 'Keep it' }));
		expect(screen.queryByTestId('local-model-remove-warning')).not.toBeInTheDocument();
		expect(api().remove).not.toHaveBeenCalled();

		fireEvent.click(within(row).getByRole('button', { name: /^Remove/ }));
		fireEvent.click(
			within(screen.getByTestId('local-model-remove-warning')).getByRole('button', {
				name: 'Remove anyway',
			})
		);
		await waitFor(() => expect(api().remove).toHaveBeenCalledWith(BGE_SMALL_EN_ID));
	});
});
