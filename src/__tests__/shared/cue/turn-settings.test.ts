import { describe, it, expect } from 'vitest';
import {
	cueTurnSettingsOf,
	formatCueTurnSettings,
	resolveCueTurnSettings,
	sameCueTurnSettings,
} from '../../../shared/cue/turn-settings';

describe('cueTurnSettingsOf', () => {
	it('returns undefined when nothing is set, so ordinary subs thread nothing', () => {
		expect(cueTurnSettingsOf({})).toBeUndefined();
		expect(cueTurnSettingsOf({ model: '   ' })).toBeUndefined();
	});

	it('keeps only the set fields, with the model trimmed', () => {
		expect(cueTurnSettingsOf({ tier: 'high', model: undefined, effort: 'low' })).toEqual({
			tier: 'high',
			effort: 'low',
		});
		expect(cueTurnSettingsOf({ model: ' gpt-5.5-codex ' })).toEqual({ model: 'gpt-5.5-codex' });
	});
});

describe('resolveCueTurnSettings', () => {
	it('falls through to the agent values when the sub sets nothing', () => {
		const resolved = resolveCueTurnSettings('claude-code', undefined, 'sonnet', 'medium');
		expect(resolved).toMatchObject({ model: 'sonnet', effort: 'medium' });
		expect(resolved.notes).toEqual([]);
		expect(resolved.warnings).toEqual([]);
	});

	it('maps tier and effort to ladder positions, not same-named strings', () => {
		const resolved = resolveCueTurnSettings(
			'claude-code',
			{ tier: 'high', effort: 'high' },
			'sonnet',
			'low'
		);
		expect(resolved.model).toBe('opus');
		expect(resolved.effort).toBe('max');
		expect(resolved.notes.join(' ')).toContain('(subscription)');
	});

	it('passes a pinned model through verbatim and notes it', () => {
		const resolved = resolveCueTurnSettings('codex', { model: 'gpt-5.5-codex' }, 'gpt-5');
		expect(resolved.model).toBe('gpt-5.5-codex');
		expect(resolved.notes[0]).toBe('model="gpt-5.5-codex" (subscription)');
	});

	it('lets a pinned model win over a tier it was wrongly paired with', () => {
		const resolved = resolveCueTurnSettings('claude-code', { tier: 'low', model: 'opus-4-7' });
		expect(resolved.model).toBe('opus-4-7');
		expect(resolved.notes.some((n) => n.startsWith('tier='))).toBe(false);
	});

	it('keeps the agent model and warns when the provider has no tier table', () => {
		const resolved = resolveCueTurnSettings('codex', { tier: 'high' }, 'gpt-5');
		expect(resolved.model).toBe('gpt-5');
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toMatch(/codex has no model tier mapping/);
	});

	it('warns when the provider has no effort setting', () => {
		const resolved = resolveCueTurnSettings('opencode', { effort: 'high' });
		expect(resolved.effort).toBeUndefined();
		expect(resolved.warnings[0]).toMatch(/opencode has no effort setting/);
	});
});

describe('sameCueTurnSettings', () => {
	it('treats absent as matching absent and blank model as absent', () => {
		expect(sameCueTurnSettings({}, {})).toBe(true);
		expect(sameCueTurnSettings({ model: '' }, {})).toBe(true);
	});

	it('distinguishes any differing axis', () => {
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'high' })).toBe(true);
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'low' })).toBe(false);
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'high', effort: 'low' })).toBe(false);
	});
});

describe('formatCueTurnSettings', () => {
	it('labels what the YAML set, and nothing when it set nothing', () => {
		expect(formatCueTurnSettings({})).toBe('');
		expect(formatCueTurnSettings({ tier: 'high', effort: 'low' })).toBe('tier high, effort low');
		expect(formatCueTurnSettings({ model: 'gpt-5.5-codex' })).toBe('model gpt-5.5-codex');
	});
});
