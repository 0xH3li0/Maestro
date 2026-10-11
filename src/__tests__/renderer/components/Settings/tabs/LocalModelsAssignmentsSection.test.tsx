/**
 * Tests for LocalModelsAssignmentsSection - one row per Local Models task with
 * a source picker filtered by the task's need, the main process's readiness
 * verdict inline, and the Utility Agent controls that define the picker's
 * "Utility Agent" choice.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import type { LocalModelTaskReadiness } from '../../../../../shared/local-models/task-readiness';
import { LocalModelsAssignmentsSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsAssignmentsSection';
import { buildAssignmentOptionGroups } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/assignmentOptions';
import { useLocalModelEndpoints, useLocalModels } from '../../../../../renderer/hooks/localModels';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { LOCAL_MODEL_TASKS } from '../../../../../shared/local-models/tasks';
import {
	BGE_SMALL_EN_ID,
	LOCAL_MODEL_CATALOG,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#3b2a5c',
		accentForeground: '#ffffff',
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

const INSTALLED = new Set([QWEN3_1_7B_ID, BGE_SMALL_EN_ID]);

function listing(id: string): LocalModelListing {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: INSTALLED.has(id)
			? {
					id,
					status: 'installed',
					manifest: { installedAt: Date.now(), verifiedAt: Date.now() } as never,
					bytesOnDisk: entry.bytes,
				}
			: { id, status: 'not-installed', manifest: null, bytesOnDisk: 0 },
		installPaths: [],
	};
}

const ollama: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const qwenName = getLocalModel(QWEN3_1_7B_ID)!.displayName;
const bgeName = getLocalModel(BGE_SMALL_EN_ID)!.displayName;

const api = () => window.maestro.localModels as unknown as Record<string, ReturnType<typeof vi.fn>>;
const endpointsApi = () =>
	window.maestro.localModels.endpoints as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** The section takes the tab's hook state; this stands in for the tab. */
function Section() {
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	return <LocalModelsAssignmentsSection theme={theme} models={models} endpoints={endpoints} />;
}

function optionLabels(taskLabel: string): string[] {
	const select = screen.getByLabelText(taskLabel);
	return within(select)
		.getAllByRole('option')
		.map((option) => option.textContent ?? '');
}

describe('LocalModelsAssignmentsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api().list.mockResolvedValue(LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id)));
		api().footprint.mockResolvedValue({ bytes: 0, models: [] });
		api().onProgress.mockReturnValue(() => {});
		api().taskReadiness.mockResolvedValue([]);
		endpointsApi().listModels.mockResolvedValue({
			ok: true,
			models: [{ id: 'llama3.2:latest' }],
		});
		useSettingsStore.setState({
			localModelAssignments: {},
			localModelEndpoints: [ollama],
			utilityAgentId: null,
			utilityModelId: null,
		});
	});

	it('offers each task only sources of the kind it needs', async () => {
		render(<Section />);
		await waitFor(() => expect(optionLabels('Tab naming')).toContain(qwenName));
		await waitFor(() => expect(optionLabels('Tab naming')).toContain('llama3.2:latest'));

		// Text generation: Utility Agent, the installed text model, the endpoint model.
		const tabNaming = optionLabels('Tab naming');
		expect(tabNaming).toEqual(expect.arrayContaining(['Off', 'Utility Agent']));
		expect(tabNaming).not.toContain(bgeName);

		// Embeddings: no Utility Agent path, only the embedding model.
		const semantic = optionLabels('Semantic search');
		expect(semantic).toContain(bgeName);
		expect(semantic).not.toContain(qwenName);
		expect(semantic).not.toContain('Utility Agent');

		// Classifiers: no installed classifier and no endpoint can serve one.
		expect(optionLabels('Prompt-injection screen')).toEqual(['Off']);
	});

	it('saves a pick through the shared assignment writer', async () => {
		render(<Section />);
		await waitFor(() => expect(optionLabels('Semantic search')).toContain(bgeName));

		fireEvent.change(screen.getByLabelText('Semantic search'), {
			target: { value: `local:${BGE_SMALL_EN_ID}` },
		});
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
		});

		// Choosing the default again drops the entry, keeping the record sparse.
		fireEvent.change(screen.getByLabelText('Semantic search'), { target: { value: 'off' } });
		expect(useSettingsStore.getState().localModelAssignments).toEqual({});
	});

	it('shows readiness inline, with a download button for a missing model', async () => {
		const guardName = getLocalModel(PROMPT_GUARD_2_22M_ID)!.displayName;
		useSettingsStore.setState({
			localModelAssignments: {
				'injection-screen': { type: 'local', modelId: PROMPT_GUARD_2_22M_ID },
			},
		});
		const verdicts: LocalModelTaskReadiness[] = [
			{
				taskId: 'tab-naming',
				label: 'Tab naming',
				needs: 'text-gen',
				assignment: { type: 'local', modelId: QWEN3_1_7B_ID },
				state: 'ready',
				detail: `Runs ${qwenName} on this machine.`,
			},
			{
				taskId: 'injection-screen',
				label: 'Prompt-injection screen',
				needs: 'classifier',
				assignment: { type: 'local', modelId: PROMPT_GUARD_2_22M_ID },
				state: 'unavailable',
				reason: 'model-not-installed',
				detail: `${guardName} is not downloaded.`,
				suggestedAction: 'Download it in Settings -> Local Models.',
			},
		];
		api().taskReadiness.mockResolvedValue(verdicts);
		render(<Section />);

		const ready = await within(screen.getByTestId('local-models-task-tab-naming')).findByText(
			'Ready'
		);
		expect(ready).toBeInTheDocument();

		const row = screen.getByTestId('local-models-task-injection-screen');
		expect(await within(row).findByText(`${guardName} is not downloaded.`)).toBeInTheDocument();
		// The current, not-installed pick stays visible in the picker.
		expect(optionLabels('Prompt-injection screen')).toContain(`${guardName} (not installed)`);

		fireEvent.click(within(row).getByRole('button', { name: `Download ${guardName}` }));
		expect(api().download).toHaveBeenCalledWith(PROMPT_GUARD_2_22M_ID);
		// Nothing downloads without that click.
		expect(api().download).toHaveBeenCalledTimes(1);
	});

	it('renders the Utility Agent controls that define the picker choice', async () => {
		render(<Section />);
		expect(document.querySelector('[data-setting-id="local-models-utility-agent"]')).not.toBeNull();
		expect(screen.getByLabelText('Agent')).toBeInTheDocument();
		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalled());
	});
});

describe('buildAssignmentOptionGroups', () => {
	const sources = {
		listings: LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id)),
		endpoints: [ollama, { ...ollama, id: 'ep-off', name: 'Off server', enabled: false }],
		endpointModels: {
			'ep-ollama': { ok: true as const, models: [{ id: 'qwen3:latest' }] },
			'ep-off': { ok: true as const, models: [{ id: 'hidden' }] },
		},
	};

	it('groups local models and each enabled endpoint, skipping disabled ones', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['tab-naming'],
			{ type: 'utility-agent' },
			sources
		);
		expect(groups.map((group) => group.label)).toEqual([null, 'Local models', 'Ollama']);
		expect(groups[2].options).toEqual([
			{ value: 'endpoint:ep-ollama:qwen3:latest', label: 'qwen3:latest' },
		]);
	});

	it('does not offer a model the task records as measured-unfit', () => {
		const qwen = `local:${QWEN3_1_7B_ID}`;
		const values = (taskId: 'tab-naming' | 'voice-routing') =>
			buildAssignmentOptionGroups(LOCAL_MODEL_TASKS[taskId], { type: 'off' }, sources).flatMap(
				(group) => group.options.map((option) => option.value)
			);
		// The same installed text model: offered to name tabs, not to route voice.
		expect(values('tab-naming')).toContain(qwen);
		expect(values('voice-routing')).not.toContain(qwen);
	});

	it('shows an unfit model that is already assigned, and says it is not recommended', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['voice-routing'],
			{ type: 'local', modelId: QWEN3_1_7B_ID },
			sources
		);
		expect(groups[0].options).toContainEqual({
			value: `local:${QWEN3_1_7B_ID}`,
			label: `${getLocalModel(QWEN3_1_7B_ID)!.displayName} (not recommended)`,
		});
		expect(groups.find((group) => group.label === 'Local models')).toBeUndefined();
	});

	it('keeps a current assignment no option covers, named by why', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['tab-naming'],
			{ type: 'endpoint', endpointId: 'gone', model: 'mistral' },
			sources
		);
		expect(groups[0].options).toContainEqual({
			value: 'endpoint:gone:mistral',
			label: 'mistral (endpoint removed)',
		});
	});
});
