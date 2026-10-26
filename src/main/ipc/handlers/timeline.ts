/**
 * Timeline IPC (`timeline:read`).
 *
 * One agent's timeline through `readAgentTimeline()` in
 * `src/main/agent-timeline.ts`, the same reader the main-process system prompt
 * uses. The renderer's prompt builders call it for `{{RECENT_TIMELINE}}`.
 * Options arrive from the renderer, so only well-typed fields are kept, and
 * Computer History is read only while its Encore Feature is on.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { readAgentTimeline, timelineAgentFor } from '../../agent-timeline';
import { findStoredSession, isSshRecord } from '../../utils/maestro-system-prompt';
import { getSettingsStore } from '../../stores/getters';
import { isEncoreFeatureEnabled } from '../../../shared/encoreFeatureDefaults';
import {
	DEFAULT_TIMELINE_SOURCES,
	isTimelineSource,
	type TimelineEvent,
	type TimelineSource,
} from '../../../shared/timeline';

const LOG_CONTEXT = '[Timeline]';

/** Read options the renderer may pass to `timeline:read`. */
export interface TimelineReadRequest {
	sinceMs: number;
	untilMs?: number;
	sources?: TimelineSource[];
	tail?: number;
	perSourceTail?: number;
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keep only well-typed read options; `sinceMs` is required. */
function toRequest(raw: unknown): TimelineReadRequest {
	const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const sinceMs = finite(r.sinceMs);
	if (sinceMs === undefined) throw new Error('timeline: sinceMs must be a finite number');
	const tail = finite(r.tail);
	const perSourceTail = finite(r.perSourceTail);
	return {
		sinceMs,
		untilMs: finite(r.untilMs),
		sources: Array.isArray(r.sources) ? r.sources.filter(isTimelineSource) : undefined,
		tail: tail === undefined ? undefined : Math.floor(tail),
		perSourceTail: perSourceTail === undefined ? undefined : Math.floor(perSourceTail),
	};
}

async function readForAgent(agentId: unknown, rawOptions: unknown): Promise<TimelineEvent[]> {
	if (typeof agentId !== 'string' || agentId.length === 0) {
		throw new Error('timeline: agentId must be a non-empty string');
	}
	const request = toRequest(rawOptions);
	const record = findStoredSession(agentId);
	if (!record) return [];
	const sources = request.sources ?? [...DEFAULT_TIMELINE_SOURCES];
	const computerHistory =
		sources.includes('computer') && isEncoreFeatureEnabled(getSettingsStore(), 'computerHistory');
	const cwd: string = record.cwd || record.projectRoot || '';
	return readAgentTimeline(
		timelineAgentFor({
			id: record.id,
			cwd,
			isGitRepo: record.isGitRepo,
			isSsh: isSshRecord(record),
		}),
		{ ...request, sources, computerHistory }
	);
}

export function registerTimelineHandlers(): void {
	ipcMain.handle(
		'timeline:read',
		withIpcErrorLogging({ context: LOG_CONTEXT, operation: 'read' }, readForAgent)
	);
}
