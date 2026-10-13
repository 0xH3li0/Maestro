/**
 * @fileoverview Tests for the shared group agent defaults helpers.
 */

import { describe, it, expect } from 'vitest';
import { withGroupDefaults } from '../../shared/groupAgentDefaults';
import type { Group } from '../../shared/types';

const group = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Backend',
	emoji: '🌳',
	collapsed: false,
	...overrides,
});

describe('withGroupDefaults', () => {
	it('sets the defaults and carries every other field over', () => {
		const before = group({ shortLabel: 'BE', color: '#9146FF', parentGroupId: 'root' });
		const after = withGroupDefaults(before, { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } });

		expect(after).toEqual({
			...before,
			defaults: { customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } },
		});
	});

	it('replaces the defaults a group already holds, whole', () => {
		const before = group({ defaults: { customModel: 'opus', nudgeMessage: 'Be brief.' } });
		expect(withGroupDefaults(before, { nudgeMessage: 'Be thorough.' }).defaults).toEqual({
			nudgeMessage: 'Be thorough.',
		});
	});

	it('removes the field for no defaults, and never stores an empty object', () => {
		const before = group({ shortLabel: 'BE', defaults: { customModel: 'opus' } });

		const cleared = withGroupDefaults(before, undefined);
		expect(cleared).not.toHaveProperty('defaults');
		expect(cleared.shortLabel).toBe('BE');

		expect(withGroupDefaults(before, {})).not.toHaveProperty('defaults');
	});

	it('does not mutate the group it was given', () => {
		const before = group({ defaults: { customModel: 'opus' } });
		withGroupDefaults(before, undefined);
		expect(before.defaults).toEqual({ customModel: 'opus' });
	});
});
