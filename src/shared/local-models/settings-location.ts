/**
 * Where model choices live in Settings, for every surface that has to say so.
 *
 * The Models settings tab is split into five inner tabs (panels). The renderer
 * draws them from these ids and labels, and every recovery sentence in the
 * main process, the CLI, and the renderer ("Assign it a model in ...") names
 * its place through `modelsSettingsLocation` or `taskAssignmentLocation`. So a
 * renamed tab or a task that moves between systems is one edit here, not one
 * per message.
 */

import { LOCAL_MODEL_TASKS, type LocalModelSystem, type LocalModelTaskId } from './tasks';

/** The inner tabs of the Models settings tab, in strip order. */
export const MODELS_SETTINGS_PANELS = [
	'library',
	'sources',
	'system-one',
	'system-two',
	'gateway',
] as const;

export type ModelsSettingsPanel = (typeof MODELS_SETTINGS_PANELS)[number];

/** What each inner tab is called, on its tab and in a sentence. */
export const MODELS_SETTINGS_PANEL_LABELS: Readonly<Record<ModelsSettingsPanel, string>> =
	Object.freeze({
		library: 'Library',
		sources: 'Sources',
		'system-one': 'System One',
		'system-two': 'System Two',
		gateway: 'Gateway',
	});

/** The Settings tab every model choice lives in, as a sentence names it. */
export const MODELS_SETTINGS_LOCATION = 'Settings > Models';

/** The inner tab that lists one system's tasks. */
export function systemSettingsPanel(system: LocalModelSystem): ModelsSettingsPanel {
	return system === 'one' ? 'system-one' : 'system-two';
}

/** "Settings > Models > Library". */
export function modelsSettingsLocation(panel: ModelsSettingsPanel): string {
	return `${MODELS_SETTINGS_LOCATION} > ${MODELS_SETTINGS_PANEL_LABELS[panel]}`;
}

/** The inner tab where a person assigns a task its source. */
export function taskAssignmentPanel(taskId: LocalModelTaskId): ModelsSettingsPanel {
	return systemSettingsPanel(LOCAL_MODEL_TASKS[taskId].system);
}

/** Where a person assigns a task its source: "Settings > Models > System One". */
export function taskAssignmentLocation(taskId: LocalModelTaskId): string {
	return modelsSettingsLocation(taskAssignmentPanel(taskId));
}
