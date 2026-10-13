// Reset a setting to its default value
// Removes the key from the store so the default takes effect

import { readSettingValue, deleteSettingValue } from '../services/storage';
import { formatSuccess, formatError } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	SETTINGS_METADATA,
	getSettingDefault,
	getSettingDefaultAtPath,
	nestedSettingPathProblem,
} from '../../shared/settingsMetadata';

interface SettingsResetOptions {
	json?: boolean;
}

export function settingsReset(key: string, options: SettingsResetOptions): void {
	try {
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];

		if (!meta) {
			throw new Error(
				`Unknown setting: "${key}". Use "maestro-cli settings list --keys-only" to see all available keys.`
			);
		}

		const pathProblem = nestedSettingPathProblem(key);
		if (pathProblem) throw new Error(pathProblem);

		const oldValue = readSettingValue(key);
		// A nested path under a setting with a field table resets to that field's
		// default. Any other nested path has no default of its own to name.
		const defaultValue = key.includes('.')
			? getSettingDefaultAtPath(key)
			: getSettingDefault(topKey);

		deleteSettingValue(key);

		if (options.json) {
			emitJsonl({
				type: 'setting_reset',
				key,
				oldValue,
				defaultValue,
			});
		} else {
			console.log(
				formatSuccess(
					defaultValue === undefined
						? `${key} reset: its fields read as their defaults`
						: `${key} reset to default (${JSON.stringify(defaultValue)})`
				)
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to reset "${key}": ${message}`));
		}
		process.exit(1);
	}
}
