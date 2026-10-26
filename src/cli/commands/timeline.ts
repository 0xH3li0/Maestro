// Timeline command: one time-ordered list of what happened around an agent
// (its turns, what the user did in Maestro, commits, and Computer History when
// that Encore Feature is on), each line naming where to read more.
//
// Read-only, straight off disk through `readTimeline()`, so it works with the
// desktop closed. The merge and the line format are shared with the
// `{{RECENT_TIMELINE}}` system prompt snapshot (`src/shared/timeline.ts`).

import { readLiveSessions, getTimelinePaths, resolveAgentId } from '../services/storage';
import { formatError, formatWarning } from '../output/formatter';
import { isEncoreEnabled, requireEncore } from '../utils/encore-gate';
import { compileGrep } from '../../shared/computer-history/reader';
import { readTimeline, type TimelineAgent } from '../../shared/maestro-lib/store/read-timeline';
import { parseTimeInput } from '../../shared/timeInput';
import {
	DEFAULT_TIMELINE_SOURCES,
	TIMELINE_SOURCES,
	formatTimelineLine,
	isTimelineSource,
	type TimelineSource,
} from '../../shared/timeline';
import type { SessionInfo } from '../../shared/types';

export interface TimelineOptions {
	agent?: string;
	since?: string;
	until?: string;
	sources?: string;
	tail?: string;
	grep?: string;
	json?: boolean;
}

/** `--since` when none is given. */
export const DEFAULT_TIMELINE_SINCE = '1d';

/** `--tail` when none is given. */
export const DEFAULT_TIMELINE_TAIL = 50;

function parseTime(flag: string, value: string, now: number): number {
	const parsed = parseTimeInput(value, now);
	if (parsed === null) {
		throw new Error(
			`Invalid ${flag} value: ${value} (expected 30m, 2h, 1d, 1w, ISO-8601, or epoch)`
		);
	}
	return parsed;
}

function parseTail(value: string | undefined): number {
	if (value === undefined) return DEFAULT_TIMELINE_TAIL;
	// Strict: `parseInt('5abc', 10)` is 5, which would hide a typo.
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid --tail value: ${value} (expected non-negative integer)`);
	}
	return Number(trimmed);
}

/**
 * The sources to read. `computer` is a source only while Computer History is
 * on; asking for it while the feature is off refuses the way the feature's own
 * verbs do.
 */
function parseSources(value: string | undefined, json: boolean | undefined): TimelineSource[] {
	if (value === undefined) return [...DEFAULT_TIMELINE_SOURCES];
	const names = value
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	const invalid = names.filter((name) => !isTimelineSource(name));
	if (invalid.length > 0) {
		const valid = TIMELINE_SOURCES.filter(
			(source) => source !== 'computer' || isEncoreEnabled('computerHistory')
		);
		throw new Error(
			`Invalid --sources value: ${invalid.join(', ')}. Must be one of: ${valid.join(', ')}`
		);
	}
	if (names.includes('computer')) requireEncore('computerHistory', json);
	return names as TimelineSource[];
}

function toTimelineAgent(session: SessionInfo): TimelineAgent {
	// An SSH agent's working directory is on the remote, not here.
	const isSsh = !!session.sessionSshRemoteConfig?.enabled;
	return { id: session.id, cwd: session.cwd, gitCwd: isSsh ? undefined : session.cwd };
}

export async function timeline(options: TimelineOptions): Promise<void> {
	try {
		const now = Date.now();
		const sinceMs = parseTime('--since', options.since ?? DEFAULT_TIMELINE_SINCE, now);
		const untilMs =
			options.until !== undefined ? parseTime('--until', options.until, now) : undefined;
		const tail = parseTail(options.tail);
		const sources = parseSources(options.sources, options.json);

		const sessions = readLiveSessions();
		const agentId = options.agent ? resolveAgentId(options.agent, sessions) : undefined;
		const agents = agentId ? sessions.filter((s) => s.id === agentId) : sessions;

		const { events, notes } = await readTimeline({
			paths: getTimelinePaths(),
			agents: agents.map(toTimelineAgent),
			sources,
			sinceMs,
			untilMs,
			grep: compileGrep(options.grep),
			tail,
			computerHistory: sources.includes('computer'),
			now,
		});
		if (agentId && sources.includes('git') && agents[0]?.sessionSshRemoteConfig?.enabled) {
			notes.push('git: skipped, the agent works on an SSH remote');
		}

		const names = new Map(sessions.map((s) => [s.id, s.name]));
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						events: events.map((event) => ({
							...event,
							time: new Date(event.ts).toISOString(),
							...(event.agentId ? { agentName: names.get(event.agentId) } : {}),
						})),
						notes,
					},
					null,
					2
				)
			);
			return;
		}

		for (const note of notes) console.error(formatWarning(note));
		if (events.length === 0) {
			console.log('No timeline events.');
			return;
		}
		console.log(
			events
				.map((event) =>
					formatTimelineLine(event, now, {
						agentName: !agentId && event.agentId ? names.get(event.agentId) : undefined,
					})
				)
				.join('\n')
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message }, null, 2));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
