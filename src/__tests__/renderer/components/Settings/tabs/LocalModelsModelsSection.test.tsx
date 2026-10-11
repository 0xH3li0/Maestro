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
import { useLocalModels, useLocalRuntimes } from '../../../../../renderer/hooks/localModels';
import {
	BGE_SMALL_EN_ID,
	LOCAL_MODEL_CATALOG,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
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
	const runtimes = useLocalRuntimes();
	return <LocalModelsModelsSection theme={theme} models={models} runtimes={runtimes} />;
}

const api = () => window.maestro.localModels as unknown as Record<string, ReturnType<typeof vi.fn>>;
const runtimesApi = () =>
	(window.maestro.localModels as unknown as { runtimes: Record<string, ReturnType<typeof vi.fn>> })
		.runtimes;

function runtimeListing(id: 'onnx' | 'llama', installed: boolean, bytes: number) {
	return {
		id,
		label: id === 'onnx' ? 'ONNX Runtime' : 'llama.cpp',
		models: LOCAL_MODEL_CATALOG.filter((entry) => entry.runtime === id).map((entry) => entry.id),
		installed,
		stale: false,
		downloadable: true,
		bytes,
	};
}

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
		api().download.mockResolvedValue({ status: 'complete' });
		runtimesApi().list.mockResolvedValue([
			runtimeListing('onnx', true, 100_000_000),
			runtimeListing('llama', false, 40_000_000),
		]);
		runtimesApi().install.mockResolvedValue(true);
		runtimesApi().onProgress.mockReturnValue(() => {});
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

	it('offers the text model for download and states the engine it fetches with it', async () => {
		render(<ModelsSection />);
		await screen.findByTestId('local-models-kind-text-gen');
		const qwen = getLocalModel(QWEN3_1_7B_ID)!;
		const row = screen.getByText(qwen.displayName).closest('.rounded.border') as HTMLElement;
		// llama.cpp is not installed, so the button names both downloads.
		const button = within(row).getByRole('button', { name: /^Download/ });
		expect(button).toHaveTextContent('engine');
		fireEvent.click(button);
		await waitFor(() => expect(api().download).toHaveBeenCalledWith(QWEN3_1_7B_ID));

		// An ONNX model's engine is already on disk, so its button names only itself.
		const prompt = getLocalModel('prompt-guard-2-22m')!;
		const promptRow = screen
			.getByText(prompt.displayName)
			.closest('.rounded.border') as HTMLElement;
		expect(within(promptRow).getByRole('button', { name: /^Download/ })).not.toHaveTextContent(
			'engine'
		);
	});

	it('lists the engines and installs one on its own', async () => {
		render(<ModelsSection />);
		const onnx = await screen.findByTestId('local-models-engine-onnx');
		expect(onnx).toHaveTextContent('Installed');
		expect(within(onnx).queryByRole('button')).not.toBeInTheDocument();

		const llama = screen.getByTestId('local-models-engine-llama');
		expect(llama).toHaveTextContent(getLocalModel(QWEN3_1_7B_ID)!.displayName);
		expect(runtimesApi().install).not.toHaveBeenCalled();
		fireEvent.click(within(llama).getByRole('button', { name: /^Install/ }));
		await waitFor(() => expect(runtimesApi().install).toHaveBeenCalledWith('llama'));
	});

	it('says so when an engine has no build for this platform', async () => {
		runtimesApi().list.mockResolvedValue([
			runtimeListing('onnx', true, 100_000_000),
			{ ...runtimeListing('llama', false, 0), downloadable: false },
		]);
		render(<ModelsSection />);
		const llama = await screen.findByTestId('local-models-engine-llama');
		expect(llama).toHaveTextContent('No build is published for this platform');
		expect(within(llama).queryByRole('button')).not.toBeInTheDocument();
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
