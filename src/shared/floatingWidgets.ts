/**
 * Floating widgets: small always-on-top desktop windows that show a piece of
 * Maestro (the throughput gauge, the media player) outside the app window.
 *
 * This module is the contract shared by the main process (window controllers
 * and the state relay) and the renderer (the widget bodies). See
 * `Plans/floating-widgets.md`.
 */

/** Every widget that can float. The order is stable; tests and IPC rely on it. */
export const FLOATING_WIDGET_IDS = ['throughput-gauge', 'media-player'] as const;

export type FloatingWidgetId = (typeof FLOATING_WIDGET_IDS)[number];

/** Whether a value (an IPC argument, a URL parameter) names a known widget. */
export function isFloatingWidgetId(value: unknown): value is FloatingWidgetId {
	return typeof value === 'string' && (FLOATING_WIDGET_IDS as readonly string[]).includes(value);
}

export interface FloatingWidgetSize {
	width: number;
	height: number;
}

/**
 * Which window owns a widget's live state and takes its commands:
 * - `app`: the primary app window (the gauge's rate engine runs there).
 * - `widget`: the widget's own window (the media player owns its media element),
 *   so a command may have to create that window and wait for it to mount.
 */
export type FloatingWidgetAuthority = 'app' | 'widget';

/** The fixed shape of one widget's window. */
export interface FloatingWidgetSpec {
	id: FloatingWidgetId;
	authority: FloatingWidgetAuthority;
	/** The size a widget opens at when nothing was saved. */
	defaultSize: FloatingWidgetSize;
	/** The smallest size the window may take, and the smallest size ever saved. */
	minSize: FloatingWidgetSize;
}

export const FLOATING_WIDGET_SPECS: Record<FloatingWidgetId, FloatingWidgetSpec> = {
	'throughput-gauge': {
		id: 'throughput-gauge',
		authority: 'app',
		defaultSize: { width: 300, height: 220 },
		minSize: { width: 200, height: 150 },
	},
	'media-player': {
		id: 'media-player',
		authority: 'widget',
		// Sized for audio: a transport strip. Video grows the window from the widget.
		defaultSize: { width: 420, height: 96 },
		minSize: { width: 280, height: 72 },
	},
};

/**
 * Where the user left a widget window, persisted per widget in the window-state
 * store. Every field is optional because a stored record may be partial or
 * damaged; readers sanitize it before use.
 */
export interface FloatingWidgetBounds {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}
