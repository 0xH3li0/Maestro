/**
 * The Sketch Book hop from main to a window, for the work only a renderer can
 * do: opening a sketch tab (the tab is part of the agent model the window
 * owns) and drawing PNG or SVG (Excalidraw measures text in a DOM).
 *
 * The request goes to the window that owns the sketch's agent, so a sketch tab
 * opens where that agent lives. With no owner (an export of a sketch whose
 * agent is gone), the primary window draws it. The window answers on
 * `remote:sketchCommand` through `window.maestro.sketch.onRemoteCommand`.
 *
 * The window resolver is set once at startup by `registerSketchHandlers()`;
 * until then every request fails with a plain message instead of hanging.
 */

import type { BrowserWindow } from 'electron';
import {
	normalizeSketchRendererResult,
	type SketchRendererRequest,
	type SketchRendererResult,
} from '../../shared/sketch/commands';
import { isWebContentsAvailable } from '../utils/safe-send';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';

/** The channel a window listens on for Sketch Book requests. */
export const SKETCH_REMOTE_COMMAND_CHANNEL = 'remote:sketchCommand';

/** Opening a tab is one store write. */
const OPEN_REPLY_MS = 10_000;
/** The first export loads Excalidraw and its fonts before it can draw. */
const EXPORT_REPLY_MS = 45_000;

/** The window that owns an agent, or the primary window for `null`. */
export type SketchWindowResolver = (agentId: string | null) => BrowserWindow | null;

/** Sends one request to a window and resolves with its checked reply. */
export type SketchRendererBridge = (
	agentId: string | null,
	request: SketchRendererRequest
) => Promise<SketchRendererResult>;

let resolveWindow: SketchWindowResolver | null = null;

/** Set at startup, where the window registry is known. */
export function setSketchWindowResolver(resolver: SketchWindowResolver | null): void {
	resolveWindow = resolver;
}

export const requestSketchRenderer: SketchRendererBridge = async (agentId, request) => {
	const win = resolveWindow?.(agentId) ?? null;
	if (!win || !isWebContentsAvailable(win)) {
		return { success: false, error: 'No Maestro window is open to show the sketch.' };
	}
	return requestFromRenderer<SketchRendererResult>(win, SKETCH_REMOTE_COMMAND_CHANNEL, {
		args: [request],
		fallback: { success: false, error: 'The Maestro window did not answer in time.' },
		parse: normalizeSketchRendererResult,
		timeoutMs: request.action === 'export' ? EXPORT_REPLY_MS : OPEN_REPLY_MS,
	});
};
