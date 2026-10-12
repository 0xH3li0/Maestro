/**
 * @file local-models-library.test.ts
 *
 * How the Library lists models: one group per model, by what it is for, with
 * its other roles as badges. Settings and `maestro-cli models list` both group
 * through this module.
 */

import { describe, it, expect } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	GEMMA_4_12B_ID,
	GEMMA_4_E4B_ID,
	GPT_OSS_20B_ID,
	LOCAL_MODEL_CATALOG,
	LOCAL_MODEL_KIND_LABELS,
	QWEN3_1_7B_ID,
	QWEN3_5_9B_ID,
	QWEN3_CODER_30B_A3B_ID,
	getLocalModel,
} from '../../shared/local-models/model-catalog';
import {
	CLOUD_ONLY_MODELS,
	CLOUD_ONLY_NOTE,
	LOCAL_MODEL_LIBRARY_GROUPS,
	LOCAL_MODEL_ROLE_LABELS,
	groupLocalModelsForLibrary,
	localModelLibraryGroup,
	localModelRoleBadges,
} from '../../shared/local-models/library';
import { LOCAL_MODEL_ROLES } from '../../shared/local-models/types';
import { userLocalModelEntry } from '../../shared/local-models/user-models';

const USER_ENTRY = userLocalModelEntry({
	id: 'hf-someone-model-q4_k_m',
	displayName: 'model-Q4_K_M',
	repo: 'someone/model-GGUF',
	revision: '0'.repeat(40),
	license: { spdx: 'mit', url: 'https://huggingface.co/someone/model-GGUF' },
	files: [{ path: 'model-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_000_000_000 }],
	parametersB: 1.5,
	contextLength: 8192,
	addedAt: 0,
});

describe('Library groups', () => {
	it('lists the roles first, then the user group, then every non-text kind', () => {
		expect(LOCAL_MODEL_LIBRARY_GROUPS.map((group) => group.id)).toEqual([
			...LOCAL_MODEL_ROLES,
			'user',
			'embedding',
			'classifier',
			'stt',
			'tts',
			'wake-word',
		]);
		for (const group of LOCAL_MODEL_LIBRARY_GROUPS) {
			expect(group.label.length).toBeGreaterThan(0);
			// A kind group's line is the tasks that use it, built where it is drawn.
			if (group.kind) expect(group.label).toBe(LOCAL_MODEL_KIND_LABELS[group.kind]);
			else expect(group.description).toMatch(/\.$/);
		}
	});

	it('lists a text model once, under its first role that is not housekeeping', () => {
		const groupOf = (id: string) => localModelLibraryGroup(getLocalModel(id)!);
		expect(groupOf(GPT_OSS_20B_ID)).toBe('agent');
		// An agent that also reads images is still listed with the agents.
		expect(groupOf(GEMMA_4_E4B_ID)).toBe('agent');
		expect(groupOf(GEMMA_4_12B_ID)).toBe('vision');
		expect(groupOf(QWEN3_1_7B_ID)).toBe('judge');
		expect(groupOf(QWEN3_5_9B_ID)).toBe('housekeeping');
		expect(groupOf(BGE_SMALL_EN_ID)).toBe('embedding');
		expect(localModelLibraryGroup(USER_ENTRY)).toBe('user');
	});

	it('groups every model exactly once, in group order, and drops empty groups', () => {
		const groups = groupLocalModelsForLibrary([...LOCAL_MODEL_CATALOG, USER_ENTRY], (e) => e);
		const ids = groups.flatMap((group) => group.items.map((entry) => entry.id));
		expect(ids).toHaveLength(LOCAL_MODEL_CATALOG.length + 1);
		expect(new Set(ids).size).toBe(ids.length);
		const order = LOCAL_MODEL_LIBRARY_GROUPS.map((group) => group.id);
		const seen = groups.map((group) => group.group.id);
		expect(seen).toEqual(order.filter((id) => seen.includes(id)));
		// Every role has a model today, so all four headings are drawn.
		for (const role of LOCAL_MODEL_ROLES) expect(seen).toContain(role);
		expect(groupLocalModelsForLibrary([], (e: typeof USER_ENTRY) => e)).toEqual([]);
		// Within a group the catalog order is kept.
		const agents = groups.find((group) => group.group.id === 'agent')!.items;
		const catalogOrder = LOCAL_MODEL_CATALOG.filter((e) => e.roles?.includes('agent'));
		expect(agents).toEqual(catalogOrder);
	});

	it('badges every role, and names the harnesses an agent model passed', () => {
		expect(localModelRoleBadges(getLocalModel(GPT_OSS_20B_ID)!)).toEqual([
			'Runs agents: Claude Code, Codex',
			LOCAL_MODEL_ROLE_LABELS.housekeeping,
		]);
		expect(localModelRoleBadges(getLocalModel(QWEN3_CODER_30B_A3B_ID)!)[0]).toBe(
			'Runs agents: Claude Code'
		);
		expect(localModelRoleBadges(getLocalModel(GEMMA_4_12B_ID)!)).toEqual([
			LOCAL_MODEL_ROLE_LABELS.housekeeping,
			LOCAL_MODEL_ROLE_LABELS.vision,
		]);
		// Nothing was measured for a model the user added, or for a non-text model.
		expect(localModelRoleBadges(USER_ENTRY)).toEqual([]);
		expect(localModelRoleBadges(getLocalModel(BGE_SMALL_EN_ID)!)).toEqual([]);
	});

	it('names the cloud-only models in one sentence that claims no protocol', () => {
		expect(CLOUD_ONLY_MODELS).toEqual(['DeepSeek V4', 'Kimi K3', 'Kimi K2.7 Code', 'GLM-5.3']);
		for (const name of CLOUD_ONLY_MODELS) expect(CLOUD_ONLY_NOTE).toContain(name);
		expect(CLOUD_ONLY_NOTE).toContain('with your own key');
		expect(CLOUD_ONLY_NOTE).not.toMatch(/openai|compatible|anthropic/i);
	});
});
