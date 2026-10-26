/**
 * @file settings-sketch-book.test.ts
 * @description `maestro-cli settings set` on the Sketch Book setting. The cloud
 * screening consent is granted only through the confirmation that names the
 * provider and what leaves the machine (spec section 8.10, G2 and A1), so a
 * direct write that would create or change it is refused and writes nothing.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	deleteSettingValue: vi.fn(() => true),
	readSettings: vi.fn(() => ({})),
}));

// `settings set` imports the media tools for one unrelated key.
vi.mock('../../../main/plugins/plugin-media-tools', () => ({
	resolveMediaModelDirectory: vi.fn(),
	getMediaToolStatus: vi.fn(),
	resolveMediaRuntime: vi.fn(),
}));

import { settingsSet } from '../../../cli/commands/settings-set';
import { readSettingValue, writeSettingValue } from '../../../cli/services/storage';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';

describe('settings set on the Sketch Book setting', () => {
	let errorSpy: MockInstance;

	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	it('is a known object setting', () => {
		expect(SETTINGS_METADATA.sketchBook).toMatchObject({ type: 'object', default: {} });
	});

	it.each([
		['sketchBook.cloudScreenConsent', '{"jev":{"grantedAt":1}}'],
		['sketchBook.cloudScreenConsent.jev', '{"grantedAt":1}'],
		['sketchBook.cloudScreenConsent.openjev.host', 'evil.example'],
		['sketchBook', '{"cloudScreenConsent":{"jev":{"grantedAt":1}}}'],
	])('refuses a consent write at %s and writes nothing', async (key, value) => {
		await expect(settingsSet(key, value, {})).rejects.toThrow('exit:1');

		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(errors()).toContain('maestro-cli sketch screening-consent');
	});

	it('refuses a path that names nothing', async () => {
		await expect(settingsSet('sketchBook.botPolicy', 'writers', {})).rejects.toThrow('exit:1');

		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(errors()).toContain('is not a Sketch Book setting');
	});

	it('allows clearing the object, which grants nothing', async () => {
		await settingsSet('sketchBook', '{}', {});

		expect(writeSettingValue).toHaveBeenCalledWith('sketchBook', {});
	});
});
