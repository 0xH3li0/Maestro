/**
 * Whether Sketch Book can be offered on this client.
 *
 * Two conditions, and every entry point (hotkey, command palette, hamburger
 * menu, the tab bar `+` menu) asks this one function so they cannot drift: the
 * `sketchBook` Encore flag is on, AND this is the desktop app. The `sketch:*`
 * channels are desktop only (the web bridge refuses them), so an entry offered
 * in the browser build would create nothing.
 */

import { isWebDesktop } from './runtimeContext';

export function canUseSketchBook(
	encoreFeatures: { sketchBook?: boolean } | null | undefined
): boolean {
	return encoreFeatures?.sketchBook === true && !isWebDesktop();
}
