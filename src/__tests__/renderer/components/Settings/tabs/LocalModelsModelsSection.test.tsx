/**
 * Tests for LocalModelsModelsSection - the Models section of the Local Models tab.
 *
 * Verifies the catalog renders grouped by what each model is for under the disk
 * total, that each row says what the model is good at and whether it fits this
 * computer, that a model too large is hidden behind a toggle, that mounting
 * reads but never downloads, that Download fires only on a click, that removing
 * a model a task is assigned to warns and names the task first, and that a
 * model the user added is labeled and can leave the Library.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import {
	LocalModelsModelsSection,
	SHOW_TOO_LARGE_MODELS_STORAGE_KEY,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsModelsSection';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useLocalModels, useLocalRuntimes } from '../../../../../renderer/hooks/localModels';
import {
	BGE_SMALL_EN_ID,
	GEMMA_4_12B_ID,
	GPT_OSS_120B_ID,
	GPT_OSS_20B_ID,
	LOCAL_MODEL_CATALOG,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
	QWEN3_5_9B_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';
import type { HardwareProfile } from '../../../../../shared/local-models/model-fit';
import type { LocalModelEntry } from '../../../../../shared/local-models/types';
import {
	USER_MODEL_UNVERIFIED_LABEL,
	userLocalModelEntry,
} from '../../../../../shared/local-models/user-models';
import { installLocalStorageMock } from '../../../../helpers/mockLocalStorage';

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

const GiB = 1024 ** 3;

function mac(ramGiB: number): HardwareProfile {
	return {
		platform: 'darwin',
		arch: 'arm64',
		totalMemoryBytes: ramGiB * GiB,
		unifiedMemory: true,
		gpus: [],
	};
}

/** A model the user added from Hugging Face, as the main process lists it. */
const USER_ENTRY = userLocalModelEntry({
	id: 'hf-unsloth-qwen3.5-2b-q4_k_m',
	displayName: 'Qwen3.5-2B-Q4_K_M',
	repo: 'unsloth/Qwen3.5-2B-GGUF',
	revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
	license: { spdx: 'apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE' },
	files: [{ path: 'Qwen3.5-2B-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_280_835_840 }],
	parametersB: 1.88,
	contextLength: 262_144,
	addedAt: 0,
});

function listing(id: string, installed: boolean, entry?: LocalModelEntry): LocalModelListing {
	entry ??= getLocalModel(id)!;
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
const hfApi = () =>
	(
		window.maestro.localModels as unknown as {
			huggingFace: Record<string, ReturnType<typeof vi.fn>>;
		}
	).huggingFace;

function rowOf(name: string): HTMLElement {
	return screen.getByText(name).closest('.rounded.border') as HTMLElement;
}
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
		installLocalStorageMock();
		api().hardware.mockResolvedValue(mac(128));
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

	it('groups the catalog by what each model is for and shows the disk total', async () => {
		render(<ModelsSection />);
		expect(await screen.findByTestId('local-models-group-embedding')).toBeInTheDocument();
		// Text models sit under a role; the other kinds under their kind.
		expect(screen.getByTestId('local-models-group-agent')).toHaveTextContent('Runs agents');
		expect(screen.getByTestId('local-models-group-housekeeping')).toBeInTheDocument();
		expect(screen.getByTestId('local-models-group-judge')).toBeInTheDocument();
		expect(screen.getByTestId('local-models-group-vision')).toBeInTheDocument();
		expect(screen.queryByText('Text generation')).not.toBeInTheDocument();
		expect(screen.getByText('Embeddings')).toBeInTheDocument();
		expect(screen.getByText('Classifiers')).toBeInTheDocument();
		expect(screen.getByText('Speech-to-text')).toBeInTheDocument();
		expect(screen.getByText('Wake word')).toBeInTheDocument();
		expect(screen.getByText('On disk')).toBeInTheDocument();
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(screen.getByText(entry.displayName)).toBeInTheDocument();
		}
		// A model is listed once, under its most specific role.
		const agents = screen.getByTestId('local-models-group-agent').parentElement as HTMLElement;
		expect(
			within(agents).getByText(getLocalModel(GPT_OSS_20B_ID)!.displayName)
		).toBeInTheDocument();
		const vision = screen.getByTestId('local-models-group-vision').parentElement as HTMLElement;
		expect(
			within(vision).getByText(getLocalModel(GEMMA_4_12B_ID)!.displayName)
		).toBeInTheDocument();
	});

	it('says what each model is good at, and names the harnesses an agent model passed', async () => {
		render(<ModelsSection />);
		await screen.findByTestId('local-models-group-agent');
		const gpt = getLocalModel(GPT_OSS_20B_ID)!;
		const row = rowOf(gpt.displayName);
		expect(row).toHaveTextContent(gpt.goodAt);
		expect(row).toHaveTextContent('Runs agents: Claude Code, Codex');
		// The size and the license are on the row too.
		expect(within(row).getByRole('link', { name: gpt.license.spdx })).toHaveAttribute(
			'href',
			gpt.license.url
		);
	});

	it('labels each model Fits, Tight with its reason, or Too large', async () => {
		// 32 GB of unified memory: 24 GB for the GPU by default, 28.8 GB at most.
		api().hardware.mockResolvedValue(mac(32));
		window.localStorage.setItem(SHOW_TOO_LARGE_MODELS_STORAGE_KEY, 'true');
		render(<ModelsSection />);
		expect(await screen.findByTestId('local-models-hardware')).toHaveTextContent(
			'32.0 GB of unified memory'
		);
		const fits = await screen.findByTestId(`local-model-fit-${QWEN3_5_9B_ID}`);
		expect(fits).toHaveAttribute('data-fit', 'fits');
		expect(fits).toHaveTextContent(/^Fits$/);

		const tooLarge = screen.getByTestId(`local-model-fit-${GPT_OSS_120B_ID}`);
		expect(tooLarge).toHaveAttribute('data-fit', 'too-large');
		expect(tooLarge).toHaveTextContent(/^Too large: Needs /);

		const tight = LOCAL_MODEL_CATALOG.map((entry) =>
			screen.getByTestId(`local-model-fit-${entry.id}`)
		).filter((line) => line.getAttribute('data-fit') === 'tight');
		for (const line of tight) expect(line).toHaveTextContent(/^Tight: Needs /);
	});

	it('hides models too large for this machine behind a toggle', async () => {
		api().hardware.mockResolvedValue(mac(16));
		render(<ModelsSection />);
		const toggle = await screen.findByTestId('local-models-show-too-large');
		const big = getLocalModel(GPT_OSS_120B_ID)!.displayName;
		expect(screen.queryByText(big)).not.toBeInTheDocument();
		expect(toggle).toHaveTextContent(/^Show models too large for this machine \(\d+\)$/);
		// A small model still shows.
		expect(screen.getByText(getLocalModel(BGE_SMALL_EN_ID)!.displayName)).toBeInTheDocument();

		fireEvent.click(toggle);
		expect(screen.getByText(big)).toBeInTheDocument();
		expect(screen.getByTestId('local-models-show-too-large')).toHaveTextContent(/^Hide /);
	});

	it('never hides a too-large model that is on disk', async () => {
		api().hardware.mockResolvedValue(mac(16));
		api().list.mockResolvedValue(
			LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id, entry.id === GPT_OSS_120B_ID))
		);
		render(<ModelsSection />);
		await screen.findByTestId('local-models-show-too-large');
		expect(screen.getByText(getLocalModel(GPT_OSS_120B_ID)!.displayName)).toBeInTheDocument();
	});

	it('says so when a GPU has no memory reading yet, instead of only calling models too large', async () => {
		api().hardware.mockResolvedValue({
			platform: 'win32',
			arch: 'x64',
			totalMemoryBytes: 32 * GiB,
			unifiedMemory: false,
			gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramBytes: null, source: 'electron' }],
		});
		render(<ModelsSection />);
		expect(await screen.findByTestId('local-models-fit-caveat')).toHaveTextContent(
			'until the model server engine is installed'
		);
	});

	it('points at Sources for the models that are cloud only', async () => {
		const onOpenSources = vi.fn();
		function WithSources() {
			const models = useLocalModels();
			const runtimes = useLocalRuntimes();
			return (
				<LocalModelsModelsSection
					theme={theme}
					models={models}
					runtimes={runtimes}
					onOpenSources={onOpenSources}
				/>
			);
		}
		render(<WithSources />);
		const note = await screen.findByTestId('local-models-cloud-only');
		for (const name of ['DeepSeek V4', 'Kimi K3', 'Kimi K2.7', 'GLM-5.3']) {
			expect(note).toHaveTextContent(name);
		}
		fireEvent.click(screen.getByTestId('local-models-open-sources'));
		expect(onOpenSources).toHaveBeenCalled();
	});

	it('lists a model the user added in its own group, labeled as not verified', async () => {
		api().list.mockResolvedValue([
			...LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id, false)),
			listing(USER_ENTRY.id, false, USER_ENTRY),
		]);
		render(<ModelsSection />);
		const group = await screen.findByTestId('local-models-group-user');
		expect(group).toHaveTextContent('Added from Hugging Face');
		expect(screen.getByTestId(`local-model-unverified-${USER_ENTRY.id}`)).toHaveTextContent(
			USER_MODEL_UNVERIFIED_LABEL
		);
		const row = rowOf(USER_ENTRY.displayName);
		expect(within(row).getByRole('link', { name: 'apache-2.0' })).toBeInTheDocument();
		// A curated row has no way out of the Library.
		expect(
			within(rowOf(getLocalModel(BGE_SMALL_EN_ID)!.displayName)).queryByRole('button', {
				name: 'Remove from Library',
			})
		).not.toBeInTheDocument();

		hfApi().remove.mockResolvedValue({
			ok: true,
			value: { id: USER_ENTRY.id, displayName: USER_ENTRY.displayName, bytes: 0 },
		});
		fireEvent.click(within(row).getByRole('button', { name: 'Remove from Library' }));
		await waitFor(() => expect(hfApi().remove).toHaveBeenCalledWith(USER_ENTRY.id));
		expect(api().remove).not.toHaveBeenCalled();
	});

	it('warns before taking an assigned user model out of the Library, and shows a refusal', async () => {
		api().list.mockResolvedValue([listing(USER_ENTRY.id, false, USER_ENTRY)]);
		useSettingsStore.setState({
			localModelAssignments: { 'tab-naming': { type: 'local', modelId: USER_ENTRY.id } },
		});
		hfApi().remove.mockResolvedValue({ ok: false, message: 'No model you added has that id.' });
		render(<ModelsSection />);
		await screen.findByTestId('local-models-group-user');
		fireEvent.click(
			within(rowOf(USER_ENTRY.displayName)).getByRole('button', { name: 'Remove from Library' })
		);
		const warning = screen.getByTestId('local-model-remove-warning');
		expect(warning).toHaveTextContent('add it again');
		expect(hfApi().remove).not.toHaveBeenCalled();
		fireEvent.click(within(warning).getByRole('button', { name: 'Remove anyway' }));
		expect(await screen.findByText('No model you added has that id.')).toBeInTheDocument();
	});

	it('reads the listing on mount and downloads nothing until a click', async () => {
		render(<ModelsSection />);
		await screen.findByTestId('local-models-group-embedding');
		expect(api().list).toHaveBeenCalled();
		expect(api().download).not.toHaveBeenCalled();

		const prompt = getLocalModel('prompt-guard-2-22m')!;
		const row = screen.getByText(prompt.displayName).closest('.rounded.border') as HTMLElement;
		fireEvent.click(within(row).getByRole('button', { name: /^Download/ }));
		await waitFor(() => expect(api().download).toHaveBeenCalledWith(prompt.id));
	});

	it('offers the text model for download and states the engine it fetches with it', async () => {
		render(<ModelsSection />);
		await screen.findByTestId('local-models-group-judge');
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
