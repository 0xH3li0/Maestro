/**
 * Sketch Book bot presence on sleep, wake and quit (spec section 5, wire
 * contract obligation 5).
 *
 * The room sockets live in the renderer windows, so main only tells them:
 * `powerMonitor` `suspend` and app `before-quit` push `online:false`, and each
 * window sends `bot.presence {online:false}` for every shared sketch before it
 * closes the socket; `resume` pushes `online:true`, and each window reconnects
 * (the next `welcome` announces the bot again, D4). A crash sends nothing; the
 * server treats the closed conductor socket as offline (X7).
 *
 * Wired in `src/main/index.ts` beside the other `powerMonitor` listeners and
 * through the quit handler's `notifySketchRoomsQuitting`.
 */

import type { SketchPresenceChange, SketchPresenceReason } from '../../shared/sketch/commands';
import { logger } from '../utils/logger';

/** Matches `SKETCH_PRESENCE_CHANNEL` in `src/main/preload/sketch.ts`. */
export const SKETCH_PRESENCE_CHANNEL = 'sketch:presence';

const LOG_CONTEXT = '[SketchBook][Presence]';

export interface SketchPresenceDeps {
	/** Broadcast to every window (`safeSend`). */
	publish: (channel: string, change: SketchPresenceChange) => void;
	/** The Sketch Book Encore Feature. Off sends nothing. */
	isEnabled: () => boolean;
}

export interface SketchPresence {
	/** `powerMonitor` `suspend`. */
	suspend(): void;
	/** `powerMonitor` `resume`. Ignored once the app is quitting. */
	resume(): void;
	/** A confirmed `before-quit`, before any other cleanup. */
	quit(): void;
}

export function createSketchPresence(deps: SketchPresenceDeps): SketchPresence {
	let quitting = false;

	function publish(online: boolean, reason: SketchPresenceReason): void {
		if (!deps.isEnabled()) return;
		logger.info(`Rooms going ${online ? 'online' : 'offline'} (${reason})`, LOG_CONTEXT);
		deps.publish(SKETCH_PRESENCE_CHANNEL, { online, reason });
	}

	return {
		suspend: () => {
			if (!quitting) publish(false, 'suspend');
		},
		resume: () => {
			if (!quitting) publish(true, 'resume');
		},
		quit: () => {
			if (quitting) return;
			quitting = true;
			publish(false, 'quit');
		},
	};
}
