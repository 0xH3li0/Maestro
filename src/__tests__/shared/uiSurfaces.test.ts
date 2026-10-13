/**
 * @file uiSurfaces.test.ts
 * @description Tests for the openable-surface registry behind
 * `maestro-cli open <surface> [--tab]`: name/alias resolution, tab resolution,
 * the discovery hint sentence, and the registry invariants that keep the CLI,
 * the main-process validator, and the renderer dispatcher agreeing.
 */

import { describe, it, expect } from 'vitest';
import {
	UI_SURFACES,
	describeSurfaceAccess,
	resolveUiSurface,
	resolveUiSurfaceSubTab,
	resolveUiSurfaceTab,
	resolveUiSurfaceTarget,
	surfaceSubTabIds,
	surfaceTabIds,
} from '../../shared/uiSurfaces';
import { MODELS_SETTINGS_PANELS } from '../../shared/local-models/settings-location';
import { formatShortcutKeysFor } from '../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';

describe('UI surface registry', () => {
	it('has unique ids and aliases across every surface', () => {
		const names = UI_SURFACES.flatMap((surface) => [surface.id, ...(surface.aliases ?? [])]);
		expect(new Set(names).size).toBe(names.length);
	});

	it('references only shortcut ids that actually exist', () => {
		for (const surface of UI_SURFACES) {
			if (!surface.shortcutId) continue;
			const shortcut = DEFAULT_SHORTCUTS[surface.shortcutId] ?? FIXED_SHORTCUTS[surface.shortcutId];
			expect(shortcut, `missing shortcut for ${surface.id}`).toBeDefined();
		}
	});

	it('gives every surface a unique set of tab ids', () => {
		for (const surface of UI_SURFACES) {
			const ids = surfaceTabIds(surface);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});

describe('resolveUiSurface', () => {
	it('resolves by id, by alias, and case-insensitively', () => {
		expect(resolveUiSurface('cue')?.id).toBe('cue');
		expect(resolveUiSurface('maestro-cue')?.id).toBe('cue');
		expect(resolveUiSurface('  Usage  ')?.id).toBe('usage-dashboard');
	});

	it('resolves the Send Feedback modal so `open feedback` works', () => {
		const feedback = resolveUiSurface('feedback');
		expect(feedback?.modal).toBe('feedback');
		expect(resolveUiSurface('bug-report')?.id).toBe('feedback');
	});

	it('resolves Tab Cleanup Suggestions so `open tab-cleanup` works', () => {
		const cleanup = resolveUiSurface('tab-cleanup');
		expect(cleanup?.modal).toBe('tabCleanup');
		expect(resolveUiSurface('cleanup')?.id).toBe('tab-cleanup');
		// Its shortcut ships unbound, but the id must still be a registered one.
		expect(DEFAULT_SHORTCUTS[cleanup!.shortcutId!].keys).toEqual([]);
	});

	it('resolves the Delegation Graph so `open delegation-graph` works', () => {
		const graph = resolveUiSurface('delegation-graph');
		expect(graph?.modal).toBe('delegationGraph');
		expect(resolveUiSurface('delegation')?.id).toBe('delegation-graph');
		expect(resolveUiSurface('peer-graph')?.id).toBe('delegation-graph');
		// Not an Encore Feature: it ships on, so `open` never refuses it.
		expect(graph?.encore).toBeUndefined();
		// Its shortcut ships unbound, but the id must still be a registered one.
		expect(DEFAULT_SHORTCUTS[graph!.shortcutId!].keys).toEqual([]);
	});

	it('names all three manual ways into the Delegation Graph once a chord is bound', () => {
		const graph = resolveUiSurface('delegation-graph')!;
		const hint = describeSurfaceAccess(graph, 'Ctrl+Cmd+G');
		expect(hint).toContain('press Ctrl+Cmd+G');
		expect(hint).toContain('search "Delegation Graph"');
		expect(hint).toContain('the hamburger menu > Delegation Graph');
		// No group was asked for, so the group's own way in is not part of it.
		expect(hint).not.toContain('For one group');
	});

	it('adds the right-click way in when the Delegation Graph was opened on a group', () => {
		const graph = resolveUiSurface('delegation-graph')!;
		const hint = describeSurfaceAccess(graph, undefined, { group: 'g-1' });
		expect(hint).toContain('search "Delegation Graph"');
		expect(hint).toMatch(
			/ For one group: right-click the group in the Left Bar > Delegation Graph\.$/
		);
	});

	it('opens only the Delegation Graph on a group', () => {
		expect(
			UI_SURFACES.filter((surface) => surface.groupClick).map((surface) => surface.id)
		).toEqual(['delegation-graph']);
	});

	it('returns null for an unknown or empty name', () => {
		expect(resolveUiSurface('nope')).toBeNull();
		expect(resolveUiSurface('')).toBeNull();
	});
});

describe('resolveUiSurfaceTab', () => {
	const cue = resolveUiSurface('cue')!;

	it('resolves a tab by id and by its display label', () => {
		expect(resolveUiSurfaceTab(cue, 'scheduled')?.id).toBe('scheduled');
		expect(resolveUiSurfaceTab(cue, 'Scheduled Tasks')?.id).toBe('scheduled');
	});

	it('deep-links Settings to the Models tab (`open settings --tab models`)', () => {
		const settings = resolveUiSurface('settings')!;
		expect(resolveUiSurfaceTab(settings, 'models')?.id).toBe('models');
		expect(resolveUiSurfaceTab(settings, 'Models')?.id).toBe('models');
	});

	it('keeps `local-models` working as an alias of the Models tab', () => {
		const settings = resolveUiSurface('settings')!;
		expect(resolveUiSurfaceTab(settings, 'local-models')?.id).toBe('models');
		expect(resolveUiSurfaceTab(settings, 'Local-Models')?.id).toBe('models');
	});

	it('does not leave a retired tab id as a tab of its own', () => {
		const settings = resolveUiSurface('settings')!;
		expect(surfaceTabIds(settings)).not.toContain('local-models');
	});

	it('returns null for a tab the surface does not have', () => {
		expect(resolveUiSurfaceTab(cue, 'nope')).toBeNull();
		const about = resolveUiSurface('about')!;
		expect(resolveUiSurfaceTab(about, 'anything')).toBeNull();
	});
});

describe('sub-tabs', () => {
	const settings = resolveUiSurface('settings')!;
	const models = resolveUiSurfaceTab(settings, 'models')!;

	it('lists every inner tab of Models, in strip order, from the one panel list', () => {
		expect(surfaceSubTabIds(models)).toEqual([...MODELS_SETTINGS_PANELS]);
		expect(surfaceSubTabIds(models)).toEqual([
			'library',
			'sources',
			'system-one',
			'system-two',
			'gateway',
		]);
	});

	it('resolves a sub-tab by id and by its display label', () => {
		expect(resolveUiSurfaceSubTab(models, 'system-one')?.id).toBe('system-one');
		expect(resolveUiSurfaceSubTab(models, 'System Two')?.id).toBe('system-two');
		expect(resolveUiSurfaceSubTab(models, 'nope')).toBeNull();
	});

	it('gives only the Models tab sub-tabs', () => {
		const withSubTabs = UI_SURFACES.flatMap((surface) =>
			(surface.tabs ?? []).filter((tab) => surfaceSubTabIds(tab).length > 0).map((tab) => tab.id)
		);
		expect(withSubTabs).toEqual(['models']);
	});
});

describe('resolveUiSurfaceTarget', () => {
	const settings = resolveUiSurface('settings')!;
	const cue = resolveUiSurface('cue')!;

	it('resolves nothing when no tab was asked for', () => {
		expect(resolveUiSurfaceTarget(settings, {})).toEqual({});
	});

	it('resolves a tab and, inside it, a sub-tab', () => {
		const target = resolveUiSurfaceTarget(settings, { tab: 'local-models', subTab: 'System One' });
		expect(target).toMatchObject({
			tab: { id: 'models' },
			subTab: { id: 'system-one' },
		});
	});

	it('resolves the Usage Dashboard Models tab, which has no sub-tab', () => {
		const dashboard = resolveUiSurface('usage-dashboard')!;
		expect(resolveUiSurfaceTarget(dashboard, { tab: 'Models' })).toMatchObject({
			tab: { id: 'models', label: 'Models' },
		});
	});

	it('resolves a tab without a sub-tab', () => {
		const target = resolveUiSurfaceTarget(settings, { tab: 'shortcuts' });
		expect(target).toMatchObject({ tab: { id: 'shortcuts' } });
		expect(target).not.toHaveProperty('subTab');
	});

	it('passes a group through for a surface that opens on one', () => {
		const graph = resolveUiSurface('delegation-graph')!;
		expect(resolveUiSurfaceTarget(graph, { group: 'g-1' })).toEqual({ group: 'g-1' });
		// No group asked for, no group key in the answer.
		expect(resolveUiSurfaceTarget(graph, {})).not.toHaveProperty('group');
	});

	it('refuses a group on a surface that does not open on one', () => {
		expect(resolveUiSurfaceTarget(cue, { group: 'g-1' })).toEqual({
			error: 'Maestro Cue does not open on one group, so --group does not apply.',
		});
		// Refused before the tab is looked at, so the group is the error named.
		expect(resolveUiSurfaceTarget(cue, { tab: 'nope', group: 'g-1' })).toEqual({
			error: expect.stringContaining('--group does not apply'),
		});
	});

	it('still refuses a tab on the Delegation Graph when a group is given', () => {
		const graph = resolveUiSurface('delegation-graph')!;
		expect(resolveUiSurfaceTarget(graph, { tab: 'peers', group: 'g-1' })).toEqual({
			error: expect.stringContaining('has no tabs'),
		});
	});

	it('refuses a sub-tab with no tab', () => {
		expect(resolveUiSurfaceTarget(settings, { subTab: 'library' })).toEqual({
			error: expect.stringContaining('--sub-tab needs --tab'),
		});
	});

	it('names the valid tabs when the tab is unknown', () => {
		expect(resolveUiSurfaceTarget(settings, { tab: 'nope' })).toEqual({
			error: expect.stringContaining('Valid tabs: general'),
		});
	});

	it('says a surface without tabs has none', () => {
		const about = resolveUiSurface('about')!;
		expect(resolveUiSurfaceTarget(about, { tab: 'x' })).toEqual({
			error: expect.stringContaining('has no tabs'),
		});
	});

	it('names the valid sub-tabs when the sub-tab is unknown', () => {
		expect(resolveUiSurfaceTarget(settings, { tab: 'models', subTab: 'nope' })).toEqual({
			error: expect.stringContaining('Valid sub-tabs: library, sources, system-one'),
		});
	});

	it('says a tab without sub-tabs has none', () => {
		expect(resolveUiSurfaceTarget(cue, { tab: 'scheduled', subTab: 'x' })).toEqual({
			error: expect.stringContaining('has no sub-tabs'),
		});
	});
});

describe('describeSurfaceAccess', () => {
	it('lists every manual path so an agent can teach the user', () => {
		const cue = resolveUiSurface('cue')!;
		const keys = DEFAULT_SHORTCUTS[cue.shortcutId!].keys;
		const hint = describeSurfaceAccess(cue, formatShortcutKeysFor(keys, false, '+'));
		expect(hint).toContain('Alt+Q');
		expect(hint).toContain('command palette');
		expect(hint).toContain(cue.click!);
	});

	it('names the tab and sub-tab to pick once the surface is open', () => {
		const settings = resolveUiSurface('settings')!;
		const target = resolveUiSurfaceTarget(settings, { tab: 'models', subTab: 'system-one' });
		if ('error' in target) throw new Error(target.error);
		const hint = describeSurfaceAccess(settings, undefined, target);
		expect(hint).toContain('then pick Models > System One.');
		expect(describeSurfaceAccess(settings, undefined, { tab: target.tab })).toContain(
			'then pick Models.'
		);
		expect(describeSurfaceAccess(settings)).not.toContain('then pick');
	});

	it('omits the hotkey clause when the surface has none', () => {
		const marketplace = resolveUiSurface('marketplace')!;
		const hint = describeSurfaceAccess(marketplace);
		expect(hint).not.toContain('press');
		expect(hint).toContain('command palette');
	});
});

describe('formatShortcutKeysFor', () => {
	it('uses macOS symbols with spaces and text with plus signs elsewhere', () => {
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true)).toBe('⌘ ⇧ K');
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], false)).toBe('Ctrl+Shift+K');
	});
});
