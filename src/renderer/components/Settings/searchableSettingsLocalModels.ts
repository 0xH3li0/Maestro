/**
 * Models tab searchable-settings entries.
 *
 * One entry per section of `ModelsSettingsTab`, plus the Utility Agent controls
 * and the semantic index card beside the task tables; each `id` matches a
 * rendered `data-setting-id`, and each `subTab` is the inner tab that renders it.
 */

import {
	MODELS_SETTINGS_PANEL_LABELS,
	type ModelsSettingsPanel,
} from '../../../shared/local-models/settings-location';
import type { SearchableSetting } from './searchableSettings';

const TAB = 'models' as const;

/**
 * The tab, the inner tab and the label a result shows ("Models > System One"),
 * all from the one panel id, so a result cannot name a place it does not open.
 */
function inPanel(
	subTab: ModelsSettingsPanel
): Pick<SearchableSetting, 'tab' | 'tabLabel' | 'subTab'> {
	return {
		tab: TAB,
		tabLabel: `Models > ${MODELS_SETTINGS_PANEL_LABELS[subTab]}`,
		subTab,
	};
}

export const LOCAL_MODELS_SETTINGS: SearchableSetting[] = [
	{
		id: 'local-models-models',
		...inPanel('library'),
		label: 'Models',
		description: 'Download, verify, and remove models that run on this machine',
		keywords: [
			'local',
			'model',
			'models',
			'download',
			'install',
			'remove',
			'delete',
			'verify',
			'disk',
			'size',
			'footprint',
			'catalog',
			'offline',
			'embedding',
			'embeddings',
			'classifier',
			'text generation',
			'speech',
			'onnx',
			'gguf',
		],
	},
	{
		id: 'local-models-endpoints',
		...inPanel('sources'),
		label: 'Endpoints',
		description: 'Model servers Maestro can call, such as Ollama or LM Studio',
		keywords: [
			'endpoint',
			'endpoints',
			'server',
			'servers',
			'ollama',
			'lm studio',
			'llama.cpp',
			'openai compatible',
			'detect local servers',
			'url',
			'api key',
		],
	},
	{
		id: 'local-models-system-one',
		...inPanel('system-one'),
		label: 'System One tasks',
		description:
			'Choose which model makes each fast judgment: a decision, label, score, vector, or transcript',
		keywords: [
			'system one',
			'assignment',
			'assignments',
			'task',
			'tasks',
			'source',
			'readiness',
			'ready',
			'judgment',
			'decision',
			'cue gate',
			'prompt injection',
			'secret screen',
			'semantic search',
			'dictation',
			'voice routing',
			'tab cleanup',
		],
	},
	{
		id: 'local-models-system-two',
		...inPanel('system-two'),
		label: 'System Two tasks',
		description: 'Choose which model writes the text each task produces',
		keywords: [
			'system two',
			'assignment',
			'assignments',
			'task',
			'tasks',
			'source',
			'readiness',
			'ready',
			'generation',
			'utility agent',
			'tab naming',
			'tab summary',
			'ai command',
			'git drafts',
			'spoken notices',
			'token proxy',
		],
	},
	{
		id: 'local-models-utility-agent',
		...inPanel('system-two'),
		label: 'Utility Agent',
		description:
			'Route auxiliary tasks (tab naming, context grooming) to a cheaper or faster agent with an optional model override',
		keywords: [
			'utility',
			'auxiliary',
			'agent',
			'model',
			'tab naming',
			'context grooming',
			'grooming',
			'cheaper',
			'faster',
			'background',
			'haiku',
			'override',
		],
	},
	{
		id: 'local-models-semantic-index',
		...inPanel('system-one'),
		label: 'Semantic index',
		description:
			"Background index of History, Director's Notes, and tab transcripts for search by meaning, with a switch for Cue runs",
		keywords: [
			'semantic',
			'semantic index',
			'semantic search',
			'index',
			'indexing',
			'indexed',
			'embedding',
			'embeddings',
			'search by meaning',
			'history',
			'transcripts',
			"director's notes",
			'cue',
			'index cue runs',
			'background',
			'progress',
		],
	},
	{
		id: 'local-models-gateway',
		...inPanel('gateway'),
		label: 'Gateway',
		description:
			"Send an agent's provider traffic through a proxy such as Headroom, LiteLLM, or Maestro's own, which can compress tool results; set per agent",
		keywords: [
			'gateway',
			'proxy',
			'base url',
			'ANTHROPIC_BASE_URL',
			'OPENAI_BASE_URL',
			'headroom',
			'litellm',
			'token',
			'tokens',
			'compression',
			'compress',
			'compress early',
			'passthrough',
			'token proxy',
			'tokens saved',
			'conservation',
			'agent',
		],
	},
];
