/**
 * @fileoverview Tests for the shared group agent defaults helpers.
 */

import { describe, it, expect } from 'vitest';
import { withGroupDefaults, withGroupShortLabel } from '../../shared/groupAgentDefaults';
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

describe('withGroupShortLabel', () => {
	it('sets the label and carries every other field over, defaults included', () => {
		const before = group({ color: '#9146FF', defaults: { customModel: 'opus' } });
		expect(withGroupShortLabel(before, 'BE')).toEqual({ ...before, shortLabel: 'BE' });
	});

	it('replaces the label a group already holds', () => {
		expect(withGroupShortLabel(group({ shortLabel: 'BE' }), 'Back').shortLabel).toBe('Back');
	});

	it('trims the label', () => {
		expect(withGroupShortLabel(group(), '  BE  ').shortLabel).toBe('BE');
	});

	it.each([
		['an empty string', ''],
		['whitespace only', '   '],
		['undefined', undefined],
	])('removes the field for %s, and never stores an empty label', (_case, label) => {
		const before = group({ shortLabel: 'BE', defaults: { customModel: 'opus' } });
		const after = withGroupShortLabel(before, label);

		expect(after).not.toHaveProperty('shortLabel');
		expect(after.defaults).toEqual({ customModel: 'opus' });
	});

	it('does not cut a label: the cap is enforced where the label is typed', () => {
		expect(withGroupShortLabel(group(), 'Money-Sessions-2026').shortLabel).toBe(
			'Money-Sessions-2026'
		);
	});

	it('does not mutate the group it was given', () => {
		const before = group({ shortLabel: 'BE' });
		withGroupShortLabel(before, '');
		expect(before.shortLabel).toBe('BE');
	});
});
