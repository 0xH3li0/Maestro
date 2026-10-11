/**
 * Tests for settings-location: the words every surface uses to send a person
 * to a place in the Models settings tab.
 */

import { describe, it, expect } from 'vitest';
import {
	MODELS_SETTINGS_LOCATION,
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
	modelsSettingsLocation,
	systemSettingsPanel,
	taskAssignmentLocation,
} from '../../../shared/local-models/settings-location';
import { LOCAL_MODEL_TASK_IDS, LOCAL_MODEL_TASKS } from '../../../shared/local-models/tasks';

describe('settings-location', () => {
	it('labels every panel', () => {
		for (const panel of MODELS_SETTINGS_PANELS) {
			expect(MODELS_SETTINGS_PANEL_LABELS[panel]).toBeTruthy();
		}
	});

	it('names a panel inside the Models tab', () => {
		expect(MODELS_SETTINGS_LOCATION).toBe('Settings > Models');
		expect(modelsSettingsLocation('library')).toBe('Settings > Models > Library');
	});

	it('maps each system to its panel', () => {
		expect(systemSettingsPanel('one')).toBe('system-one');
		expect(systemSettingsPanel('two')).toBe('system-two');
	});

	it("sends every task to its own system's panel", () => {
		expect(taskAssignmentLocation('cue-gate')).toBe('Settings > Models > System One');
		expect(taskAssignmentLocation('git-drafts')).toBe('Settings > Models > System Two');
		for (const taskId of LOCAL_MODEL_TASK_IDS) {
			expect(taskAssignmentLocation(taskId)).toBe(
				modelsSettingsLocation(systemSettingsPanel(LOCAL_MODEL_TASKS[taskId].system))
			);
		}
	});
});
