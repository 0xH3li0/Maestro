/**
 * Floating widgets: small always-on-top desktop windows that show a piece of
 * Maestro (the throughput gauge, the media player) outside the app window.
 *
 * This module is the contract shared by the main process (window controllers
 * and the state relay) and the renderer (the widget bodies). See
 * `Plans/floating-widgets.md`.
 */

import type { ThroughputHistory, ThroughputRates } from './throughputRate';

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

/**
 * What the primary window publishes for the throughput gauge widget (relayed
 * with `publishStoreState('throughput-gauge', ...)`). The rate engine stays in
 * the primary window; the widget only draws these readings.
 */
export interface ThroughputGaugeWidgetState {
	rates: ThroughputRates;
	peak: ThroughputRates;
	history: ThroughputHistory;
	/** The active agent's name when the gauge reads the active scope, else null. */
	activeAgentName: string | null;
}

/**
 * What the gauge widget asks the primary window to do. `hide` goes through the
 * gauge store, so its visible latch and the window never disagree.
 */
export type ThroughputGaugeWidgetCommand = { type: 'hide' } | { type: 'reset-peak' };

const THROUGHPUT_GAUGE_WIDGET_COMMAND_TYPES: readonly string[] = ['hide', 'reset-peak'];

/** Whether a relayed value is a command the gauge widget may send. */
export function isThroughputGaugeWidgetCommand(
	value: unknown
): value is ThroughputGaugeWidgetCommand {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === 'string' && THROUGHPUT_GAUGE_WIDGET_COMMAND_TYPES.includes(type);
}
