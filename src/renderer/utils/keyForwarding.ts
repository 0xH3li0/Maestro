/**
 * Hand a keystroke that a surface swallowed to the main keyboard handler.
 *
 * Some surfaces own their keys and stop the event before it reaches `window`,
 * where `useMainKeyboardHandler` listens: xterm, a focused webview guest, the
 * Sketch Book canvas. When one of those keys is an app shortcut, the surface
 * dispatches a copy on `window`, and the main handler answers it like any
 * other press. Only the fields a shortcut match reads are copied.
 */

/** The parts of a keystroke a shortcut match reads. */
export interface ForwardedKey {
	key: string;
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/** Dispatch a copy of `source` as a keydown on `window`. */
export function forwardKeyToMainHandler(source: ForwardedKey): void {
	window.dispatchEvent(
		new KeyboardEvent('keydown', {
			key: source.key,
			code: source.code,
			metaKey: source.metaKey,
			ctrlKey: source.ctrlKey,
			altKey: source.altKey,
			shiftKey: source.shiftKey,
			bubbles: true,
			cancelable: true,
		})
	);
}
