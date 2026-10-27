import { describe, it, expect, vi } from 'vitest';

let webDesktop = false;
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => webDesktop,
}));

import {
	SHORTCUT_ENCORE_FLAGS,
	availableShortcuts,
	isShortcutAvailable,
} from '../../../renderer/utils/encoreShortcuts';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import { ENCORE_FEATURE_DEFAULTS } from '../../../shared/encoreFeatureDefaults';
import { findReservedShortcutCombo, shortcutKeysEqual } from '../../../shared/shortcutKeys';

const ALL_OFF = Object.fromEntries(
	Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, false])
) as Record<keyof typeof ENCORE_FEATURE_DEFAULTS, boolean>;
const ALL_ON = Object.fromEntries(
	Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, true])
) as Record<keyof typeof ENCORE_FEATURE_DEFAULTS, boolean>;

describe('encoreShortcuts', () => {
	it('names only shortcuts and flags that exist', () => {
		const known = { ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS };
		for (const [id, flag] of Object.entries(SHORTCUT_ENCORE_FLAGS)) {
			expect(known[id], `shortcut "${id}"`).toBeDefined();
			expect(ENCORE_FEATURE_DEFAULTS, `flag "${flag}"`).toHaveProperty(flag);
		}
	});

	it('drops every Encore shortcut when its feature is off', () => {
		const visible = availableShortcuts({ ...DEFAULT_SHORTCUTS, ...FIXED_SHORTCUTS }, ALL_OFF);
		for (const id of Object.keys(SHORTCUT_ENCORE_FLAGS)) {
			expect(visible[id], id).toBeUndefined();
		}
		// A shortcut with no Encore owner is never dropped.
		expect(visible.quickAction).toBe(DEFAULT_SHORTCUTS.quickAction);
	});

	it('keeps every Encore shortcut when its feature is on', () => {
		webDesktop = false;
		const all = { ...DEFAULT_SHORTCUTS, ...FIXED_SHORTCUTS };
		expect(Object.keys(availableShortcuts(all, ALL_ON))).toEqual(Object.keys(all));
	});

	it('lists the Throughput Gauge toggle only while its feature is on', () => {
		expect(availableShortcuts(DEFAULT_SHORTCUTS, ALL_OFF).toggleThroughputGauge).toBeUndefined();
		expect(
			availableShortcuts(DEFAULT_SHORTCUTS, { ...ALL_OFF, throughputGauge: true })
				.toggleThroughputGauge
		).toBe(DEFAULT_SHORTCUTS.toggleThroughputGauge);
	});

	it('lists New Sketch Book only while Sketch Book is on, and never on web-desktop', () => {
		expect(availableShortcuts(DEFAULT_SHORTCUTS, ALL_OFF).newSketchBook).toBeUndefined();
		expect(
			availableShortcuts(DEFAULT_SHORTCUTS, { ...ALL_OFF, sketchBook: true }).newSketchBook
		).toBe(DEFAULT_SHORTCUTS.newSketchBook);
		webDesktop = true;
		expect(isShortcutAvailable('newSketchBook', ALL_ON)).toBe(false);
		webDesktop = false;
	});

	it('lists Show Sketch Books only while Sketch Book is on, and never on web-desktop', () => {
		expect(availableShortcuts(DEFAULT_SHORTCUTS, ALL_OFF).showSketchBooks).toBeUndefined();
		expect(
			availableShortcuts(DEFAULT_SHORTCUTS, { ...ALL_OFF, sketchBook: true }).showSketchBooks
		).toBe(DEFAULT_SHORTCUTS.showSketchBooks);
		webDesktop = true;
		expect(isShortcutAvailable('showSketchBooks', ALL_ON)).toBe(false);
		webDesktop = false;
	});

	it.each(['newSketchBook', 'showSketchBooks'] as const)(
		'binds %s to a chord no other shortcut or reserved combo owns',
		(id) => {
			const keys = DEFAULT_SHORTCUTS[id].keys;
			expect(findReservedShortcutCombo(keys)).toBeNull();
			const all = { ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS };
			const clashes = Object.values(all).filter(
				(shortcut) =>
					shortcut.id !== id && shortcut.keys.length > 0 && shortcutKeysEqual(shortcut.keys, keys)
			);
			expect(clashes.map((shortcut) => shortcut.id)).toEqual([]);
		}
	);

	const SKETCH_BOOK_SHORTCUT_IDS = [
		'sketchBookCollaborate',
		'sketchBookAddLink',
		'sketchBookOpenFile',
	] as const;

	it.each(SKETCH_BOOK_SHORTCUT_IDS)('lists %s only while Sketch Book is on', (id) => {
		expect(availableShortcuts(FIXED_SHORTCUTS, ALL_OFF)[id]).toBeUndefined();
		expect(availableShortcuts(FIXED_SHORTCUTS, { ...ALL_OFF, sketchBook: true })[id]).toBe(
			FIXED_SHORTCUTS[id]
		);
	});

	it.each(SKETCH_BOOK_SHORTCUT_IDS)(
		'binds %s to a chord no other shortcut or reserved combo owns',
		(id) => {
			const keys = FIXED_SHORTCUTS[id].keys;
			expect(findReservedShortcutCombo(keys)).toBeNull();
			const all = { ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS };
			const clashes = Object.values(all).filter(
				(shortcut) =>
					shortcut.id !== id && shortcut.keys.length > 0 && shortcutKeysEqual(shortcut.keys, keys)
			);
			expect(clashes.map((shortcut) => shortcut.id)).toEqual([]);
		}
	);

	it('treats a missing flag map as everything off', () => {
		expect(isShortcutAvailable('openCue', undefined)).toBe(false);
		expect(isShortcutAvailable('quickAction', undefined)).toBe(true);
	});

	it('withholds Computer History on web-desktop even with the flag on', () => {
		webDesktop = true;
		expect(isShortcutAvailable('computerHistory', ALL_ON)).toBe(false);
		webDesktop = false;
		expect(isShortcutAvailable('computerHistory', ALL_ON)).toBe(true);
	});
});
