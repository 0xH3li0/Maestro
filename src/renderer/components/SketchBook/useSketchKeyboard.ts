/**
 * Wires `sketchKeyboard.ts` to one mounted Sketch Book canvas: Maestro's
 * navigation keys go to the main handler, the moved Excalidraw actions are
 * replayed under their new chords, a key the canvas claimed never also fires
 * a Maestro shortcut, and Excalidraw's Help dialog and menu print the
 * sketch's chords.
 */

import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useKeyboardShortcutHelpers } from '../../hooks/keyboard/useKeyboardShortcutHelpers';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { forwardKeyToMainHandler } from '../../utils/keyForwarding';
import { trackShortcutUsage } from '../../utils/shortcutTracking';
import {
	excalidrawChordInit,
	excalidrawIsDarwin,
	isExcalidrawWritableTarget,
	isMaestroSketchKey,
	relabelExcalidrawShortcuts,
	sketchKeyRelabels,
	sketchKeyRemaps,
	type SketchMaestroKeyMatchers,
} from './sketchKeyboard';

/**
 * Route the keys of the canvas inside `canvas` (the element that holds
 * Excalidraw). Pass `null` until it mounts.
 */
export function useSketchKeyboard(canvas: HTMLElement | null): void {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const useCmd0AsLastTab = useSettingsStore((s) => s.useCmd0AsLastTab);
	const { isShortcut, isTabShortcut } = useKeyboardShortcutHelpers({ shortcuts, tabShortcuts });
	// Read at event time, so a rebinding applies without re-attaching listeners.
	const matchers = React.useRef<SketchMaestroKeyMatchers>({
		isShortcut,
		isTabShortcut,
		useCmd0AsLastTab,
	});
	matchers.current = { isShortcut, isTabShortcut, useCmd0AsLastTab };

	React.useEffect(() => {
		if (!canvas) return;
		const isDarwin = excalidrawIsDarwin();
		const remaps = sketchKeyRemaps(isDarwin);
		const relabels = sketchKeyRelabels(isDarwin);
		const replayed = new WeakSet<Event>();

		// Capture: runs before Excalidraw's React handler sees the key. Text
		// being typed (a text element, a dialog field) is left alone, as
		// Excalidraw leaves it, so the key reaches Maestro the normal way.
		const routeKey = (event: KeyboardEvent) => {
			if (replayed.has(event) || isExcalidrawWritableTarget(event.target)) return;
			if (isMaestroSketchKey(event, matchers.current)) {
				event.stopPropagation();
				forwardKeyToMainHandler(event);
				return;
			}
			const remap = remaps.find((entry) => eventMatchesShortcutKeys(event, entry.press));
			if (!remap || !event.target) return;
			event.preventDefault();
			event.stopPropagation();
			const replay = new KeyboardEvent('keydown', excalidrawChordInit(remap.replay, isDarwin));
			replayed.add(replay);
			event.target.dispatchEvent(replay);
			if (remap.shortcutId) trackShortcutUsage(remap.shortcutId);
		};

		// After Excalidraw, before `window`: a key the canvas claimed is the
		// sketch's, and a replayed chord never reaches Maestro as itself.
		const standDown = (event: KeyboardEvent) => {
			if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
			if (replayed.has(event) || event.defaultPrevented) event.stopPropagation();
		};

		// The menu renders inside the canvas; the Help dialog is a portal on
		// `document.body`, filled after its container is added.
		const relabel = (root: ParentNode) => relabelExcalidrawShortcuts(root, relabels);
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (!(node instanceof Element)) continue;
					if (mutation.target === document.body) {
						observer.observe(node, { childList: true, subtree: true });
					}
					relabel(node);
				}
			}
		});
		observer.observe(canvas, { childList: true, subtree: true });
		observer.observe(document.body, { childList: true });
		relabel(canvas);

		canvas.addEventListener('keydown', routeKey, true);
		document.addEventListener('keydown', standDown);
		return () => {
			canvas.removeEventListener('keydown', routeKey, true);
			document.removeEventListener('keydown', standDown);
			observer.disconnect();
		};
	}, [canvas]);
}
