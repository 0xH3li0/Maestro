/**
 * Preload API for the timeline (`window.maestro.timeline`).
 *
 * Mirrors `timeline:read` in `src/main/ipc/handlers/timeline.ts`. The renderer's
 * system prompt builders read `{{RECENT_TIMELINE}}` through it, so a tab spawn
 * gets the same snapshot as a main-process spawn and `maestro-cli timeline`.
 */

import { ipcRenderer } from 'electron';
import type { TimelineEvent, TimelineSource } from '../../shared/timeline';

export interface TimelineReadOptions {
	/** Start of the window (epoch ms). */
	sinceMs: number;
	/** End of the window (epoch ms). */
	untilMs?: number;
	/** Default: history, journey, git. `computer` is read only while Computer History is on. */
	sources?: TimelineSource[];
	/** Keep at most this many of the newest events overall. */
	tail?: number;
	/** Keep at most this many of each source's newest events. */
	perSourceTail?: number;
}

export interface TimelineApi {
	/** One agent's timeline, oldest first. */
	read: (agentId: string, options: TimelineReadOptions) => Promise<TimelineEvent[]>;
}

export function createTimelineApi(): TimelineApi {
	return {
		read: (agentId, options) => ipcRenderer.invoke('timeline:read', agentId, options),
	};
}
