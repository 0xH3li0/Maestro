/**
 * Tests for shared/local-models/tasks - the task registry, the assignment
 * reader (which is also the settings migration), and save-time validation.
 */

import { describe, it, expect } from 'vitest';
import {
	LOCAL_MODEL_TASK_IDS,
	LOCAL_MODEL_TASKS,
	isLocalModelTaskId,
	isSameLocalModelAssignment,
	localModelAssignmentProblem,
	endpointServesNeed,
	parseLocalModelAssignment,
	parseLocalModelAssignments,
	tasksNeedingKind,
	tasksUsingLocalModel,
	resolveLocalModelAssignment,
	resolveLocalModelAssignments,
	withLocalModelAssignment,
	type LocalModelTaskId,
} from '../../shared/local-models/tasks';
import {
	BGE_SMALL_EN_ID,
	KOKORO_82M_ID,
	QWEN3_1_7B_ID,
} from '../../shared/local-models/model-catalog';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';
import { SETTINGS_DEFAULTS } from '../../main/stores/defaults';

const UTILITY_AGENT_TASKS: LocalModelTaskId[] = ['tab-naming', 'tab-summary', 'ai-command'];

describe('LOCAL_MODEL_TASKS registry', () => {
	it('has one entry per task id, keyed by its own id', () => {
		expect(Object.keys(LOCAL_MODEL_TASKS).sort()).toEqual([...LOCAL_MODEL_TASK_IDS].sort());
		for (const id of LOCAL_MODEL_TASK_IDS) {
			expect(LOCAL_MODEL_TASKS[id].id).toBe(id);
			expect(LOCAL_MODEL_TASKS[id].label.trim()).not.toBe('');
			expect(LOCAL_MODEL_TASKS[id].description.trim()).not.toBe('');
		}
	});

	it('lists every task the plan names', () => {
		expect([...LOCAL_MODEL_TASK_IDS]).toEqual([
			'tab-naming',
			'tab-summary',
			'tab-cleanup',
			'ai-command',
			'git-drafts',
			'semantic-search',
			'cue-gate',
			'injection-screen',
			'secret-screen',
			'dictation',
			'spoken-notices',
			'voice-routing',
			'token-proxy',
		]);
	});

	it('is frozen', () => {
		expect(Object.isFrozen(LOCAL_MODEL_TASKS)).toBe(true);
		expect(Object.isFrozen(LOCAL_MODEL_TASKS['tab-naming'])).toBe(true);
		expect(Object.isFrozen(LOCAL_MODEL_TASKS['spoken-notices'].alsoNeeds)).toBe(true);
	});

	it('maps each task to the kind of model it needs', () => {
		expect(LOCAL_MODEL_TASKS['semantic-search'].needs).toBe('embedding');
		expect(LOCAL_MODEL_TASKS['injection-screen'].needs).toBe('classifier');
		expect(LOCAL_MODEL_TASKS['secret-screen'].needs).toBe('classifier');
		expect(LOCAL_MODEL_TASKS.dictation.needs).toBe('stt');
		expect(LOCAL_MODEL_TASKS['spoken-notices'].needs).toBe('text-gen');
		expect(LOCAL_MODEL_TASKS['spoken-notices'].alsoNeeds).toEqual(['tts']);
		for (const id of [
			'tab-naming',
			'git-drafts',
			'cue-gate',
			'voice-routing',
			'token-proxy',
		] as const) {
			expect(LOCAL_MODEL_TASKS[id].needs).toBe('text-gen');
		}
	});

	it('defaults the tasks that already run through an agent to that agent path', () => {
		for (const id of UTILITY_AGENT_TASKS) {
			expect(LOCAL_MODEL_TASKS[id].allowsUtilityAgent).toBe(true);
			expect(LOCAL_MODEL_TASKS[id].defaultAssignment).toEqual({ type: 'utility-agent' });
		}
	});

	it('defaults every new task to off, with no agent path to fall back to', () => {
		for (const id of LOCAL_MODEL_TASK_IDS) {
			if (UTILITY_AGENT_TASKS.includes(id)) continue;
			expect(LOCAL_MODEL_TASKS[id].allowsUtilityAgent).toBe(false);
			expect(LOCAL_MODEL_TASKS[id].defaultAssignment).toEqual({ type: 'off' });
		}
	});

	it('recognizes task ids and nothing else', () => {
		expect(isLocalModelTaskId('tab-naming')).toBe(true);
		expect(isLocalModelTaskId('toString')).toBe(false);
		expect(isLocalModelTaskId('nope')).toBe(false);
		expect(isLocalModelTaskId(42)).toBe(false);
	});
});

describe('parseLocalModelAssignment', () => {
	it('reads each assignment shape, trimming ids', () => {
		expect(parseLocalModelAssignment('cue-gate', { type: 'off' })).toEqual({ type: 'off' });
		expect(parseLocalModelAssignment('cue-gate', { type: 'local', modelId: ' m ' })).toEqual({
			type: 'local',
			modelId: 'm',
		});
		expect(
			parseLocalModelAssignment('cue-gate', { type: 'endpoint', endpointId: 'ep', model: 'llama3' })
		).toEqual({ type: 'endpoint', endpointId: 'ep', model: 'llama3' });
		expect(parseLocalModelAssignment('tab-naming', { type: 'utility-agent' })).toEqual({
			type: 'utility-agent',
		});
	});

	it('refuses the Utility Agent on a task that has no agent path', () => {
		expect(parseLocalModelAssignment('git-drafts', { type: 'utility-agent' })).toBeNull();
	});

	it('refuses malformed records', () => {
		expect(parseLocalModelAssignment('cue-gate', null)).toBeNull();
		expect(parseLocalModelAssignment('cue-gate', [])).toBeNull();
		expect(parseLocalModelAssignment('cue-gate', { type: 'cloud' })).toBeNull();
		expect(parseLocalModelAssignment('cue-gate', { type: 'local', modelId: '  ' })).toBeNull();
		expect(
			parseLocalModelAssignment('cue-gate', { type: 'endpoint', endpointId: 'ep' })
		).toBeNull();
	});

	it('keeps a model id the catalog no longer knows, so the router can name it', () => {
		expect(
			parseLocalModelAssignment('cue-gate', { type: 'local', modelId: 'retired-model' })
		).toEqual({ type: 'local', modelId: 'retired-model' });
	});
});

describe('parseLocalModelAssignments (settings migration)', () => {
	it('reads a missing or non-object setting as empty, so every task uses its default', () => {
		for (const value of [undefined, null, [], 'x', 3]) {
			expect(parseLocalModelAssignments(value)).toEqual({});
		}
	});

	it('keeps an existing Utility Agent setup working with no stored assignments', () => {
		// An install from before Local Models has utilityAgentId set and no
		// localModelAssignments at all. The utility-agent default is what keeps
		// tab naming, summaries, and AI command mode on the path they used.
		const resolved = resolveLocalModelAssignments(parseLocalModelAssignments(undefined));
		for (const id of UTILITY_AGENT_TASKS) {
			expect(resolved[id]).toEqual({ type: 'utility-agent' });
		}
	});

	it('drops unknown tasks, unusable entries, and entries equal to the default', () => {
		expect(
			parseLocalModelAssignments({
				'retired-task': { type: 'off' },
				'git-drafts': { type: 'utility-agent' },
				'tab-naming': { type: 'utility-agent' },
				'cue-gate': { type: 'off' },
				'ai-command': { type: 'off' },
				'semantic-search': { type: 'endpoint', endpointId: 'ep', model: 'nomic-embed-text' },
			})
		).toEqual({
			'ai-command': { type: 'off' },
			'semantic-search': { type: 'endpoint', endpointId: 'ep', model: 'nomic-embed-text' },
		});
	});
});

describe('resolveLocalModelAssignment', () => {
	it('falls back to the task default when nothing usable is stored', () => {
		expect(resolveLocalModelAssignment(undefined, 'tab-naming')).toEqual({ type: 'utility-agent' });
		expect(resolveLocalModelAssignment({}, 'cue-gate')).toEqual({ type: 'off' });
		expect(
			resolveLocalModelAssignment({ 'git-drafts': { type: 'utility-agent' } }, 'git-drafts')
		).toEqual({ type: 'off' });
	});

	it('returns the stored assignment', () => {
		expect(
			resolveLocalModelAssignment(
				{ 'tab-naming': { type: 'local', modelId: QWEN3_1_7B_ID } },
				'tab-naming'
			)
		).toEqual({ type: 'local', modelId: QWEN3_1_7B_ID });
	});

	it('resolves every task at once', () => {
		const resolved = resolveLocalModelAssignments({ dictation: { type: 'off' } });
		expect(Object.keys(resolved).sort()).toEqual([...LOCAL_MODEL_TASK_IDS].sort());
	});
});

describe('localModelAssignmentProblem', () => {
	it('accepts a fitting assignment', () => {
		expect(localModelAssignmentProblem('tab-naming', { type: 'utility-agent' })).toBeNull();
		expect(
			localModelAssignmentProblem('git-drafts', { type: 'local', modelId: QWEN3_1_7B_ID })
		).toBeNull();
		expect(
			localModelAssignmentProblem('semantic-search', {
				type: 'endpoint',
				endpointId: 'ep',
				model: 'nomic-embed-text',
			})
		).toBeNull();
		expect(localModelAssignmentProblem('dictation', { type: 'off' })).toBeNull();
	});

	it('names the task when it has no Utility Agent path', () => {
		expect(localModelAssignmentProblem('git-drafts', { type: 'utility-agent' })).toMatch(
			/Git drafts has no Utility Agent path/
		);
	});

	it('refuses an unknown model and a model of the wrong kind', () => {
		expect(localModelAssignmentProblem('git-drafts', { type: 'local', modelId: 'nope' })).toMatch(
			/not a known local model/
		);
		expect(
			localModelAssignmentProblem('git-drafts', { type: 'local', modelId: KOKORO_82M_ID })
		).toMatch(/needs a text-gen model/);
	});

	it('explains malformed records by type', () => {
		expect(localModelAssignmentProblem('git-drafts', { type: 'local' })).toMatch(
			/needs a model id/
		);
		expect(
			localModelAssignmentProblem('git-drafts', { type: 'endpoint', endpointId: 'ep' })
		).toMatch(/endpoint id and a model name/);
		expect(localModelAssignmentProblem('git-drafts', { type: 'cloud' })).toMatch(/must be one of/);
	});

	it('refuses an endpoint for a need no endpoint serves', () => {
		const endpoint = { type: 'endpoint', endpointId: 'ep', model: 'guard' };
		expect(localModelAssignmentProblem('injection-screen', endpoint)).toMatch(
			/an endpoint cannot serve/
		);
		expect(localModelAssignmentProblem('dictation', endpoint)).toMatch(/an endpoint cannot serve/);
		expect(localModelAssignmentProblem('semantic-search', endpoint)).toBeNull();
		expect(endpointServesNeed('text-gen')).toBe(true);
		expect(endpointServesNeed('classifier')).toBe(false);
	});
});

describe('withLocalModelAssignment', () => {
	it('stores a changed assignment and removes one set back to its default', () => {
		const changed = withLocalModelAssignment({}, 'tab-naming', {
			type: 'local',
			modelId: QWEN3_1_7B_ID,
		});
		expect(changed).toEqual({ 'tab-naming': { type: 'local', modelId: QWEN3_1_7B_ID } });
		expect(withLocalModelAssignment(changed, 'tab-naming', { type: 'utility-agent' })).toEqual({});
	});

	it('does not mutate its input', () => {
		const before = { 'cue-gate': { type: 'off' as const } };
		withLocalModelAssignment(before, 'dictation', { type: 'local', modelId: 'x' });
		expect(before).toEqual({ 'cue-gate': { type: 'off' } });
	});
});

describe('isSameLocalModelAssignment', () => {
	it('compares by type and every id', () => {
		expect(isSameLocalModelAssignment({ type: 'off' }, { type: 'off' })).toBe(true);
		expect(isSameLocalModelAssignment({ type: 'off' }, { type: 'utility-agent' })).toBe(false);
		expect(
			isSameLocalModelAssignment({ type: 'local', modelId: 'a' }, { type: 'local', modelId: 'b' })
		).toBe(false);
		expect(
			isSameLocalModelAssignment(
				{ type: 'endpoint', endpointId: 'e', model: 'm' },
				{ type: 'endpoint', endpointId: 'e', model: 'n' }
			)
		).toBe(false);
	});
});

describe('localModelAssignments setting', () => {
	it('defaults to an empty (all defaults) record in metadata and the main store', () => {
		expect(SETTINGS_METADATA.localModelAssignments.default).toEqual({});
		expect(SETTINGS_METADATA.localModelAssignments.type).toBe('object');
		expect(SETTINGS_DEFAULTS.localModelAssignments).toEqual({});
	});
});

describe('tasksUsingLocalModel', () => {
	it('names every task whose effective assignment runs the model, in registry order', () => {
		const tasks = tasksUsingLocalModel(
			{
				'tab-summary': { type: 'local', modelId: QWEN3_1_7B_ID },
				'tab-naming': { type: 'local', modelId: QWEN3_1_7B_ID },
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			},
			QWEN3_1_7B_ID
		);
		expect(tasks.map((task) => task.id)).toEqual(['tab-naming', 'tab-summary']);
	});

	it('returns nothing for a model no task is assigned', () => {
		expect(tasksUsingLocalModel({}, BGE_SMALL_EN_ID)).toEqual([]);
		expect(tasksUsingLocalModel(undefined, BGE_SMALL_EN_ID)).toEqual([]);
	});

	it('ignores endpoint assignments that happen to share the model name', () => {
		expect(
			tasksUsingLocalModel(
				{ 'tab-naming': { type: 'endpoint', endpointId: 'e1', model: QWEN3_1_7B_ID } },
				QWEN3_1_7B_ID
			)
		).toEqual([]);
	});
});

describe('tasksNeedingKind', () => {
	it('lists exactly the tasks whose need matches the kind', () => {
		const embedding = tasksNeedingKind('embedding');
		expect(embedding.length).toBeGreaterThan(0);
		for (const task of embedding) expect(task.needs).toBe('embedding');
		expect(tasksNeedingKind('wake-word')).toEqual([]);
	});
});
