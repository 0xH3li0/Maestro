/**
 * User Journey: a per-agent log of what the USER did inside Maestro (files
 * opened, saved, created, renamed, deleted in File Preview and the Files panel,
 * and pages browsed in browser tabs), so an agent can see the user's recent
 * steps in order.
 *
 * Scope rules the recorders and the store share:
 * - Only user actions inside Maestro. Edits by other editors or by agents are
 *   already covered by filesystem mtimes and agent transcripts.
 * - Metadata only: never file contents or diffs.
 * - Browser URLs pass through `sanitizeJourneyUrl()` before they are stored,
 *   because query strings and fragments often carry tokens.
 *
 * This module holds the types and the pure helpers. The main-process store
 * (one JSONL file per agent) lives in `src/main/user-journey-manager.ts`.
 */

import { formatDurationCompact } from './duration';
import { formatTimestamp } from './formatters';
import { toLocalYmd } from './localDay';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from './worktreePaths';

/** Most entries kept per agent; the store prunes the oldest past this. */
export const JOURNEY_MAX_ENTRIES_PER_AGENT = 5000;

/** Entries older than this many days are pruned. */
export const JOURNEY_RETENTION_DAYS = 30;

export type UserJourneyKind =
	| 'file.open'
	| 'file.close'
	| 'file.save'
	| 'file.create'
	| 'file.rename'
	| 'file.delete'
	| 'browser.open'
	| 'browser.navigate'
	| 'browser.close';

export interface UserJourneyEntry {
	/** Epoch ms. */
	ts: number;
	agentId: string;
	kind: UserJourneyKind;
	/** Absolute path for `file.*`, sanitized URL for `browser.*`. For `file.rename`, the NEW path. */
	target: string;
	tabId?: string;
	/** Page title (`browser.*`). */
	title?: string;
	/** Previous absolute path (`file.rename`). */
	fromPath?: string;
	/** Time from open to close (`file.close`, `browser.close`). */
	dwellMs?: number;
	/** Line counts of a save (`file.save`). */
	linesAdded?: number;
	linesRemoved?: number;
	/** Set when the agent runs on an SSH remote. */
	sshRemoteId?: string;
}

/**
 * Drop the query string, the fragment, and any embedded credentials from a
 * URL. Returns the input unchanged when it is not a parseable URL.
 */
export function sanitizeJourneyUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	parsed.search = '';
	parsed.hash = '';
	parsed.username = '';
	parsed.password = '';
	return parsed.href;
}

/**
 * True when `next` repeats the browser location `prev` already recorded: a
 * `browser.navigate` on the same tab to the same sanitized URL. SPA routes and
 * `did-navigate-in-page` fire these duplicates (a hash change, for example,
 * sanitizes to the same target).
 */
export function shouldCollapseJourneyEntry(
	prev: UserJourneyEntry | undefined,
	next: UserJourneyEntry
): boolean {
	if (!prev || next.kind !== 'browser.navigate') return false;
	if (prev.kind !== 'browser.open' && prev.kind !== 'browser.navigate') return false;
	return prev.tabId === next.tabId && prev.target === next.target;
}

export interface FormatJourneyLineOptions {
	/** The agent's working directory; paths under it render relative to it. */
	cwd?: string;
}

/** A path for display: relative to `cwd` when it sits under it. */
function displayJourneyPath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	const candidate = normalizeWorktreePath(path);
	const root = normalizeWorktreePath(cwd);
	if (candidate === root || !isPathAtOrUnderRoot(candidate, root)) return path;
	return candidate.slice(root === '/' ? 1 : root.length + 1);
}

/** A URL for display: no scheme, no trailing slash (`docs.runmaestro.ai/cue`). */
function displayJourneyUrl(url: string): string {
	const bare = url.replace(/^https?:\/\//i, '');
	return bare.length > 1 ? bare.replace(/\/$/, '') : bare;
}

function dwellSuffix(dwellMs: number | undefined): string {
	return dwellMs !== undefined && dwellMs >= 0 ? ` (${formatDurationCompact(dwellMs)})` : '';
}

function titleSuffix(title: string | undefined): string {
	const trimmed = title?.trim();
	return trimmed ? ` "${trimmed}"` : '';
}

/**
 * One compact line per entry, for an agent-facing digest:
 * `2:02 PM opened src/foo.ts`, `2:05 PM saved src/foo.ts (+12/-3)`,
 * `2:06 PM browsed docs.runmaestro.ai/cue`. The clock is the user's locale; an
 * entry from another day than `now` also carries its date.
 */
export function formatJourneyLine(
	entry: UserJourneyEntry,
	now: number,
	options: FormatJourneyLineOptions = {}
): string {
	const sameDay = toLocalYmd(entry.ts) === toLocalYmd(now);
	const time = formatTimestamp(entry.ts, sameDay ? 'time' : 'datetime');
	const path = () => displayJourneyPath(entry.target, options.cwd);
	const url = () => displayJourneyUrl(entry.target);

	let action: string;
	switch (entry.kind) {
		case 'file.open':
			action = `opened ${path()}`;
			break;
		case 'file.close':
			action = `closed ${path()}${dwellSuffix(entry.dwellMs)}`;
			break;
		case 'file.save': {
			const counts =
				entry.linesAdded !== undefined || entry.linesRemoved !== undefined
					? ` (+${entry.linesAdded ?? 0}/-${entry.linesRemoved ?? 0})`
					: '';
			action = `saved ${path()}${counts}`;
			break;
		}
		case 'file.create':
			action = `created ${path()}`;
			break;
		case 'file.rename':
			action = entry.fromPath
				? `renamed ${displayJourneyPath(entry.fromPath, options.cwd)} to ${path()}`
				: `renamed to ${path()}`;
			break;
		case 'file.delete':
			action = `deleted ${path()}`;
			break;
		case 'browser.open':
			action = `opened browser ${url()}${titleSuffix(entry.title)}`;
			break;
		case 'browser.navigate':
			action = `browsed ${url()}${titleSuffix(entry.title)}`;
			break;
		case 'browser.close':
			action = `closed browser ${url()}${dwellSuffix(entry.dwellMs)}`;
			break;
		default:
			action = `${(entry as UserJourneyEntry).kind} ${entry.target}`;
	}
	return `${time} ${action}`;
}
