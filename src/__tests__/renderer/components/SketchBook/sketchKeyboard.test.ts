/**
 * Who answers a key on the Sketch Book canvas (sketchKeyboard.ts): Maestro's
 * navigation keys by binding, Excalidraw's moved actions per platform, the
 * replayed chords, Excalidraw's own typing test, and the relabelled Help
 * dialog and menu.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	SKETCH_MAESTRO_SHORTCUT_IDS,
	SKETCH_MAESTRO_TAB_SHORTCUT_IDS,
	excalidrawChordInit,
	excalidrawIsDarwin,
	isExcalidrawWritableTarget,
	isMaestroSketchKey,
	relabelExcalidrawShortcuts,
	sketchKeyRelabels,
	sketchKeyRemaps,
} from '../../../../renderer/components/SketchBook/sketchKeyboard';
import { FIXED_SHORTCUTS } from '../../../../renderer/constants/shortcuts';

const key = new KeyboardEvent('keydown', { key: 'k', metaKey: true });

function matchersFor(matching: { global?: string; tab?: string }, useCmd0AsLastTab = true) {
	return {
		isShortcut: vi.fn((_e: KeyboardEvent, id: string) => id === matching.global),
		isTabShortcut: vi.fn((_e: KeyboardEvent, id: string) => id === matching.tab),
		useCmd0AsLastTab,
	};
}

describe('isMaestroSketchKey', () => {
	it.each(SKETCH_MAESTRO_SHORTCUT_IDS)('keeps %s for Maestro', (id) => {
		expect(isMaestroSketchKey(key, matchersFor({ global: id }))).toBe(true);
	});

	it.each(SKETCH_MAESTRO_TAB_SHORTCUT_IDS)('keeps the tab shortcut %s for Maestro', (id) => {
		expect(isMaestroSketchKey(key, matchersFor({ tab: id }))).toBe(true);
	});

	it('keeps Go to Last Tab only while Cmd+0 is bound to it', () => {
		expect(isMaestroSketchKey(key, matchersFor({ tab: 'goToLastTab' }, true))).toBe(true);
		expect(isMaestroSketchKey(key, matchersFor({ tab: 'goToLastTab' }, false))).toBe(false);
	});

	it('leaves every other Maestro shortcut to the canvas', () => {
		expect(isMaestroSketchKey(key, matchersFor({ global: 'fuzzyFileSearch' }))).toBe(false);
		expect(isMaestroSketchKey(key, matchersFor({ tab: 'closeTab' }))).toBe(false);
	});
});

describe('excalidrawIsDarwin', () => {
	it("uses Excalidraw's own platform test", () => {
		expect(excalidrawIsDarwin('MacIntel')).toBe(true);
		expect(excalidrawIsDarwin('iPad')).toBe(true);
		expect(excalidrawIsDarwin('Win32')).toBe(false);
		expect(excalidrawIsDarwin('Linux x86_64')).toBe(false);
	});
});

describe('sketchKeyRemaps', () => {
	it('moves Add link and Open to the fixed Sketch Book chords on macOS', () => {
		const remaps = sketchKeyRemaps(true);
		expect(remaps.map((remap) => [remap.excalidrawLabel, remap.sketchLabel])).toEqual([
			['Cmd+K', 'Cmd+Option+B'],
			['Cmd+O', 'Cmd+Option+O'],
		]);
		expect(remaps[0].press).toBe(FIXED_SHORTCUTS.sketchBookAddLink.keys);
		expect(remaps[1].press).toBe(FIXED_SHORTCUTS.sketchBookOpenFile.keys);
	});

	it('also moves Send to back and Bring to front off Previous and Next Tab elsewhere', () => {
		expect(
			sketchKeyRemaps(false).map((remap) => [remap.excalidrawLabel, remap.sketchLabel])
		).toEqual([
			['Ctrl+K', 'Ctrl+Alt+B'],
			['Ctrl+O', 'Ctrl+Alt+O'],
			['Ctrl+Shift+[', 'Ctrl+Alt+['],
			['Ctrl+Shift+]', 'Ctrl+Alt+]'],
		]);
	});

	it('relabels Reset zoom without replaying it, since Excalidraw answers Shift+0', () => {
		const relabels = sketchKeyRelabels(true);
		const resetZoom = relabels[relabels.length - 1];
		expect(resetZoom).toEqual({ excalidrawLabel: 'Cmd+0', sketchLabel: 'Shift+0' });
		expect(resetZoom).not.toHaveProperty('replay');
	});
});

describe('excalidrawChordInit', () => {
	it('replays mod as Cmd on macOS and Ctrl elsewhere', () => {
		const link = { key: 'k', code: 'KeyK', mod: true };
		expect(excalidrawChordInit(link, true)).toMatchObject({
			key: 'k',
			code: 'KeyK',
			metaKey: true,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			bubbles: true,
		});
		expect(excalidrawChordInit(link, false)).toMatchObject({ metaKey: false, ctrlKey: true });
	});
});

describe('isExcalidrawWritableTarget', () => {
	it('counts the fields Excalidraw skips its shortcuts for', () => {
		const text = document.createElement('input');
		text.type = 'text';
		const wysiwyg = document.createElement('div');
		wysiwyg.dataset.type = 'wysiwyg';
		expect(isExcalidrawWritableTarget(text)).toBe(true);
		expect(isExcalidrawWritableTarget(document.createElement('textarea'))).toBe(true);
		expect(isExcalidrawWritableTarget(wysiwyg)).toBe(true);
	});

	it('does not count a radio input or the canvas container', () => {
		const radio = document.createElement('input');
		radio.type = 'radio';
		expect(isExcalidrawWritableTarget(radio)).toBe(false);
		expect(isExcalidrawWritableTarget(document.createElement('div'))).toBe(false);
		expect(isExcalidrawWritableTarget(null)).toBe(false);
	});
});

describe('relabelExcalidrawShortcuts', () => {
	function helpRow(...groups: string[][]): HTMLElement {
		const container = document.createElement('div');
		container.className = 'HelpDialog__key-container';
		groups.forEach((group, index) => {
			if (index > 0) container.append('or');
			for (const text of group) {
				const kbd = document.createElement('kbd');
				kbd.className = 'HelpDialog__key';
				kbd.textContent = text;
				container.append(kbd);
			}
		});
		return container;
	}

	const visibleKeys = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('kbd'))
			.filter((kbd) => !kbd.hidden)
			.map((kbd) => kbd.textContent);

	it('rewrites a Help dialog row, adding a key the new chord needs', () => {
		const root = document.createElement('div');
		const link = helpRow(['Cmd', 'K']);
		root.append(link);

		relabelExcalidrawShortcuts(root, sketchKeyRelabels(true));

		expect(visibleKeys(link)).toEqual(['Cmd', 'Option', 'B']);
	});

	it('rewrites Reset zoom in place and leaves other rows alone', () => {
		const root = document.createElement('div');
		const zoom = helpRow(['Cmd', '0']);
		const copy = helpRow(['Cmd', 'C']);
		root.append(zoom, copy);

		relabelExcalidrawShortcuts(root, sketchKeyRelabels(true));

		expect(visibleKeys(zoom)).toEqual(['Shift', '0']);
		expect(visibleKeys(copy)).toEqual(['Cmd', 'C']);
	});

	it('rewrites only the matching chord of an "or" row', () => {
		const root = document.createElement('div');
		const row = helpRow(['Ctrl', 'Shift', '['], ['Ctrl', '[']);
		root.append(row);

		relabelExcalidrawShortcuts(root, sketchKeyRelabels(false));

		expect(visibleKeys(row)).toEqual(['Ctrl', 'Alt', '[', 'Ctrl', '[']);
		expect(row.textContent).toContain('or');
	});

	it("rewrites the canvas menu's shortcut column", () => {
		const root = document.createElement('div');
		const open = document.createElement('div');
		open.className = 'dropdown-menu-item__shortcut';
		open.textContent = 'Cmd+O';
		root.append(open);

		relabelExcalidrawShortcuts(root, sketchKeyRelabels(true));

		expect(open.textContent).toBe('Cmd+Option+O');
	});

	it('is safe to run again', () => {
		const root = document.createElement('div');
		const link = helpRow(['Cmd', 'K']);
		root.append(link);
		const relabels = sketchKeyRelabels(true);

		relabelExcalidrawShortcuts(root, relabels);
		relabelExcalidrawShortcuts(root, relabels);

		expect(visibleKeys(link)).toEqual(['Cmd', 'Option', 'B']);
		expect(link.querySelectorAll('kbd')).toHaveLength(3);
	});

	it('matches the root itself', () => {
		const link = helpRow(['Cmd', 'K']);
		relabelExcalidrawShortcuts(link, sketchKeyRelabels(true));
		expect(visibleKeys(link)).toEqual(['Cmd', 'Option', 'B']);
	});
});
