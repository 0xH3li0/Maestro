/**
 * Timeline: one time-ordered list of what happened around an agent, merged
 * from the records Maestro already keeps, so an agent reads one view first and
 * opens a single source only when it needs the detail.
 *
 * Sources, each owned elsewhere and only read here:
 * - `history`: the agent's finished turns (`src/main/history-manager.ts`).
 * - `journey`: what the user did inside Maestro (`src/shared/userJourney.ts`).
 * - `git`: commits on the working directory's current branch (first parent).
 * - `computer`: Computer History, an Encore Feature. Callers include it only
 *   while the feature is on, and never in the system prompt snapshot: it is
 *   high-volume and holds text the user merely looked at.
 *
 * A line carries a summary and a `ref` to drill into (a history entry id, a
 * commit sha), never the full record. This module is pure: the readers live in
 * `src/shared/maestro-lib/store/read-timeline.ts`.
 */

import type { StoredEvent } from './computer-history/types';
import { truncateAtWordBoundary } from './formatters';
import type { HistoryEntry } from './types';
import {
	describeJourneyEntry,
	formatDigestTime,
	type FormatJourneyLineOptions,
	type UserJourneyEntry,
} from './userJourney';

export type TimelineSource = 'history' | 'journey' | 'git' | 'computer';

export const TIMELINE_SOURCES: readonly TimelineSource[] = [
	'history',
	'journey',
	'git',
	'computer',
];

/** What `maestro-cli timeline` reads when `--sources` is not given. */
export const DEFAULT_TIMELINE_SOURCES: readonly TimelineSource[] = ['history', 'journey', 'git'];

export function isTimelineSource(value: unknown): value is TimelineSource {
	return typeof value === 'string' && (TIMELINE_SOURCES as readonly string[]).includes(value);
}

export interface TimelineEvent {
	/** Epoch ms. */
	ts: number;
	source: TimelineSource;
	/** The agent the event belongs to. Absent for `computer`, which is machine-wide. */
	agentId?: string;
	/** One line, no clock: `USER (Fix tooltip): fixed clipping in FilePreview`. */
	text: string;
	/** The handle to read more: a history entry id or a commit sha. */
	ref?: string;
}

/** Longest summary a history or commit line keeps, in characters. */
const TEXT_MAX_CHARS = 160;

/** Longest captured text a Computer History line keeps, in characters. */
const CAPTURED_TEXT_MAX_CHARS = 80;

/** Characters of a history entry id or commit sha a text line shows. */
const REF_DISPLAY_CHARS = 8;

function oneLine(text: string, max: number): string {
	return truncateAtWordBoundary(text.replace(/\s+/g, ' ').trim(), max);
}

/**
 * A history entry as a timeline event:
 * `USER (Fix tooltip): fixed clipping in FilePreview`, with `[failed]` on a
 * turn that did not complete and the consulting agent or Cue trigger named.
 */
export function historyEntryToTimelineEvent(entry: HistoryEntry, agentId: string): TimelineEvent {
	const origin =
		entry.type === 'AGENT' && entry.sourceAgentName
			? ` from ${entry.sourceAgentName}`
			: entry.type === 'CUE' && entry.cueTriggerName
				? ` ${entry.cueTriggerName}`
				: '';
	const tab = entry.sessionName ? ` (${oneLine(entry.sessionName, 40)})` : '';
	const failed = entry.success === false ? ' [failed]' : '';
	const summary = oneLine(entry.summary || '', TEXT_MAX_CHARS) || '(no summary)';
	return {
		ts: entry.timestamp,
		source: 'history',
		agentId,
		text: `${entry.type}${origin}${tab}: ${summary}${failed}`,
		ref: entry.id,
	};
}

/** A journey entry as a timeline event: `saved src/foo.ts (+12/-3)`. */
export function journeyEntryToTimelineEvent(
	entry: UserJourneyEntry,
	options: FormatJourneyLineOptions = {}
): TimelineEvent {
	return {
		ts: entry.ts,
		source: 'journey',
		agentId: entry.agentId,
		text: `user ${describeJourneyEntry(entry, options)}`,
	};
}

/** Field separator in the `git log` format below (ASCII unit separator). */
const GIT_FIELD_SEP = '\x1f';

/**
 * `git log` arguments for the commits on the current branch committed inside
 * the window, newest first. First parent only: a merge reads as one commit
 * rather than as every commit it brought in, which would flood the timeline
 * with work done elsewhere.
 */
export function gitTimelineArgs(
	sinceMs: number,
	untilMs: number | undefined,
	limit: number
): string[] {
	const args = [
		'log',
		'--first-parent',
		`--since=${new Date(sinceMs).toISOString()}`,
		`-n${Math.max(1, Math.floor(limit))}`,
		`--format=%H${GIT_FIELD_SEP}%ct${GIT_FIELD_SEP}%an${GIT_FIELD_SEP}%s`,
	];
	if (untilMs !== undefined) args.splice(2, 0, `--until=${new Date(untilMs).toISOString()}`);
	return args;
}

/** Parse the output of `gitTimelineArgs` into events. Malformed lines are skipped. */
export function parseGitTimeline(stdout: string, agentId: string): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	for (const line of stdout.split('\n')) {
		const [sha, committed, author, ...subject] = line.split(GIT_FIELD_SEP);
		const seconds = Number(committed);
		if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !Number.isFinite(seconds)) continue;
		events.push({
			ts: seconds * 1000,
			source: 'git',
			agentId,
			text: `commit by ${author || 'unknown'}: ${oneLine(subject.join(GIT_FIELD_SEP), TEXT_MAX_CHARS)}`,
			ref: sha,
		});
	}
	return events;
}

/**
 * A Computer History event as a timeline event, or null for a kind the
 * timeline does not show. Captured text is quoted and cut short: it is
 * untrusted, and the full event is one `computer-history query` away.
 */
export function computerEventToTimelineEvent(event: StoredEvent): TimelineEvent | null {
	const ts = Date.parse(event.ts);
	if (!Number.isFinite(ts)) return null;
	const app = event.app?.name || event.app?.id || 'an app';
	const quoted = (text: string | undefined) => {
		const cut = text ? oneLine(text, CAPTURED_TEXT_MAX_CHARS) : '';
		return cut ? ` "${cut}"` : '';
	};
	let text: string;
	switch (event.kind) {
		case 'app.activated':
			text = `switched to ${app}`;
			break;
		case 'window.changed':
			text = `${app} window${quoted(event.window?.title || event.window?.url)}`;
			break;
		case 'text.committed':
			text = `typed in ${app}:${quoted(event.text)}`;
			break;
		case 'selection.changed':
			text = `selected in ${app}:${quoted(event.text)}`;
			break;
		case 'content.snapshot':
			text = `viewed ${app}${quoted(event.window?.title || event.window?.url)}`;
			break;
		default:
			return null;
	}
	return { ts, source: 'computer', text: `user ${text}` };
}

/**
 * Drop an `app.activated` event that repeats the app of the event before it:
 * the helper reports a re-activation after every window or focus change.
 */
export function collapseRepeatedAppSwitches(events: readonly TimelineEvent[]): TimelineEvent[] {
	const out: TimelineEvent[] = [];
	for (const event of events) {
		const prev = out[out.length - 1];
		if (prev && prev.source === 'computer' && prev.text === event.text) continue;
		out.push(event);
	}
	return out;
}

/** True when `grep` matches the event's text or its ref. */
export function timelineEventMatches(event: TimelineEvent, grep: RegExp): boolean {
	return grep.test(event.text) || (!!event.ref && grep.test(event.ref));
}

export interface SelectTimelineOptions {
	/** Only events at or after this time (epoch ms). */
	sinceMs?: number;
	/** Only events at or before this time (epoch ms). */
	untilMs?: number;
	/** Only events whose text (or ref) matches, case-insensitive. */
	grep?: RegExp;
	/** Keep at most this many of each source's newest events. */
	perSourceTail?: number;
	/** Keep at most this many of the newest events overall (after `perSourceTail`). */
	tail?: number;
}

/**
 * Merge events from every source into one list, oldest first, with the window,
 * grep, and caps applied. Ties keep source order. A commit seen from two agents
 * that share a repository is kept once.
 */
export function selectTimelineEvents(
	events: readonly TimelineEvent[],
	options: SelectTimelineOptions = {}
): TimelineEvent[] {
	const { sinceMs, untilMs, grep, perSourceTail, tail } = options;
	const seenCommits = new Set<string>();
	let out = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => {
			if (sinceMs !== undefined && event.ts < sinceMs) return false;
			if (untilMs !== undefined && event.ts > untilMs) return false;
			if (grep && !timelineEventMatches(event, grep)) return false;
			if (event.source === 'git' && event.ref) {
				if (seenCommits.has(event.ref)) return false;
				seenCommits.add(event.ref);
			}
			return true;
		})
		.sort((a, b) => a.event.ts - b.event.ts || a.index - b.index)
		.map(({ event }) => event);

	if (perSourceTail !== undefined) {
		const kept = new Set<TimelineEvent>();
		for (const source of TIMELINE_SOURCES) {
			const ofSource = out.filter((e) => e.source === source);
			for (const e of perSourceTail > 0 ? ofSource.slice(-perSourceTail) : []) kept.add(e);
		}
		out = out.filter((e) => kept.has(e));
	}
	if (tail !== undefined) out = tail > 0 ? out.slice(-tail) : [];
	return out;
}

/** The drill-down handle a line shows: `[entry 1a2b3c4d]`, `[commit 5e621726]`. */
function refLabel(event: TimelineEvent): string {
	if (!event.ref) return '';
	const short = event.ref.slice(0, REF_DISPLAY_CHARS);
	if (event.source === 'history') return ` [entry ${short}]`;
	if (event.source === 'git') return ` [commit ${short}]`;
	return ` [${short}]`;
}

export interface FormatTimelineLineOptions {
	/** Prefix the line with this agent name (a timeline that spans agents). */
	agentName?: string;
}

/**
 * One line per event for an agent-facing digest:
 * `2:02 PM history USER (Fix tooltip): fixed clipping [entry 1a2b3c4d]`.
 */
export function formatTimelineLine(
	event: TimelineEvent,
	now: number,
	options: FormatTimelineLineOptions = {}
): string {
	const agent = options.agentName ? `${options.agentName}: ` : '';
	return `${formatDigestTime(event.ts, now)} ${event.source} ${agent}${event.text}${refLabel(event)}`;
}

/** How far back the `{{RECENT_TIMELINE}}` snapshot reaches. */
export const RECENT_TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Most events the snapshot shows. */
export const RECENT_TIMELINE_MAX_EVENTS = 15;

/** Most events of any one source the snapshot shows, so a burst of saves cannot hide the turns. */
export const RECENT_TIMELINE_MAX_PER_SOURCE = 8;

/** The sources the snapshot reads. Computer History is never in it (see the module comment). */
export const RECENT_TIMELINE_SOURCES: readonly TimelineSource[] = ['history', 'journey', 'git'];

/** What `{{RECENT_TIMELINE}}` reads when the window is empty. */
export const RECENT_TIMELINE_EMPTY_TEXT = 'Nothing in the last 2 hours.';

/** The window and caps of the `{{RECENT_TIMELINE}}` snapshot, as of `now`. */
export function recentTimelineOptions(now: number): SelectTimelineOptions & { sinceMs: number } {
	return {
		sinceMs: now - RECENT_TIMELINE_WINDOW_MS,
		perSourceTail: RECENT_TIMELINE_MAX_PER_SOURCE,
		tail: RECENT_TIMELINE_MAX_EVENTS,
	};
}

/**
 * The `{{RECENT_TIMELINE}}` text: one `formatTimelineLine` bullet per event,
 * oldest first, or `RECENT_TIMELINE_EMPTY_TEXT`. Applies the window and the
 * caps itself, so a caller may pass a wider read.
 */
export function formatRecentTimeline(
	events: readonly TimelineEvent[],
	now: number,
	options: FormatTimelineLineOptions = {}
): string {
	const recent = selectTimelineEvents(events, recentTimelineOptions(now));
	if (recent.length === 0) return RECENT_TIMELINE_EMPTY_TEXT;
	return recent.map((event) => `- ${formatTimelineLine(event, now, options)}`).join('\n');
}
