/**
 * User Journey store: one JSONL file per agent at
 * `<userData>/journey/<agentId>.jsonl`, oldest entry first.
 *
 * Modeled on `history-manager.ts`: appends use O_APPEND so the steady-state
 * path never rewrites the file, every mutation runs through a per-agent write
 * queue, and the one read-modify-write (pruning) replaces the file atomically.
 *
 * The log lives here, never in `maestro-sessions.json`, which is already large.
 * Types, the collapse rule, and the entry normalizer live in
 * `src/shared/userJourney.ts`.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import { atomicWriteFile, createKeyedWriteQueue } from './utils/atomic-json-store';
import { stripJsonBom } from '../shared/jsonUtils';
import { sanitizeSessionId } from '../shared/history';
import {
	JOURNEY_MAX_ENTRIES_PER_AGENT,
	JOURNEY_RETENTION_DAYS,
	normalizeJourneyEntry,
	shouldCollapseJourneyEntry,
	type UserJourneyEntry,
	type UserJourneyKind,
} from '../shared/userJourney';

const LOG_CONTEXT = '[UserJourney]';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far past a limit a file may drift before it is rewritten. Without slack,
 * a file sitting at the cap (or with its oldest entry just past retention)
 * would be rewritten on every append. Readers apply the exact limits, so the
 * overshoot is never visible.
 */
const PRUNE_ENTRY_SLACK = 500;
const PRUNE_AGE_SLACK_MS = DAY_MS;

export interface ReadJourneyOptions {
	/** Only entries with `ts >= since` (epoch ms). */
	since?: number;
	/** Only the newest N entries (after the other filters). */
	tail?: number;
	/** Only these kinds. */
	kinds?: UserJourneyKind[];
}

/** What the store remembers about a file between appends, so an append never reads it. */
interface FileState {
	count: number;
	oldestTs: number | undefined;
	last: UserJourneyEntry | undefined;
}

const writeQueue = createKeyedWriteQueue();
const fileStates = new Map<string, FileState>();

function getJourneyDir(): string {
	return path.join(app.getPath('userData'), 'journey');
}

/** Absolute path of an agent's journey file. */
export function getJourneyFilePath(agentId: string): string {
	return path.join(getJourneyDir(), `${sanitizeSessionId(agentId)}.jsonl`);
}

function serializeLine(entry: UserJourneyEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

/** Parse a journey file, skipping torn or foreign lines. File order (oldest first). */
function parseJourneyJsonl(raw: string): UserJourneyEntry[] {
	const entries: UserJourneyEntry[] = [];
	for (const line of stripJsonBom(raw).split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = normalizeJourneyEntry(JSON.parse(trimmed));
			if (entry) entries.push(entry);
		} catch {
			// A torn final line from an interrupted append costs that one entry.
		}
	}
	return entries;
}

async function readFileEntries(agentId: string): Promise<UserJourneyEntry[]> {
	try {
		return parseJourneyJsonl(await fsp.readFile(getJourneyFilePath(agentId), 'utf-8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

function stateOf(entries: UserJourneyEntry[]): FileState {
	return {
		count: entries.length,
		oldestTs: entries[0]?.ts,
		last: entries[entries.length - 1],
	};
}

/** Keep entries inside retention, then the newest `JOURNEY_MAX_ENTRIES_PER_AGENT`. */
function applyLimits(entries: UserJourneyEntry[], now: number): UserJourneyEntry[] {
	const cutoff = now - JOURNEY_RETENTION_DAYS * DAY_MS;
	const fresh = entries.filter((e) => e.ts >= cutoff);
	return fresh.length > JOURNEY_MAX_ENTRIES_PER_AGENT
		? fresh.slice(fresh.length - JOURNEY_MAX_ENTRIES_PER_AGENT)
		: fresh;
}

function needsPrune(state: FileState, now: number): boolean {
	if (state.count > JOURNEY_MAX_ENTRIES_PER_AGENT + PRUNE_ENTRY_SLACK) return true;
	const cutoff = now - JOURNEY_RETENTION_DAYS * DAY_MS - PRUNE_AGE_SLACK_MS;
	return state.oldestTs !== undefined && state.oldestTs < cutoff;
}

/**
 * Append one entry to its agent's journey. Dropped when it repeats the last
 * entry (see `shouldCollapseJourneyEntry`) or is malformed. Resolves true when
 * a line was written. Never throws: a failed write is logged and reported.
 */
export async function appendJourneyEntry(raw: UserJourneyEntry): Promise<boolean> {
	const entry = normalizeJourneyEntry(raw);
	if (!entry) {
		logger.warn('Dropped a malformed journey entry', LOG_CONTEXT);
		return false;
	}
	const { agentId } = entry;
	return writeQueue.enqueue(agentId, async () => {
		try {
			let state = fileStates.get(agentId);
			if (!state) {
				state = stateOf(await readFileEntries(agentId));
				fileStates.set(agentId, state);
			}
			if (shouldCollapseJourneyEntry(state.last, entry)) return false;

			const filePath = getJourneyFilePath(agentId);
			if (state.count === 0) await fsp.mkdir(path.dirname(filePath), { recursive: true });
			await fsp.appendFile(filePath, serializeLine(entry), 'utf-8');
			state.count += 1;
			state.oldestTs = state.oldestTs === undefined ? entry.ts : Math.min(state.oldestTs, entry.ts);
			state.last = entry;

			const now = Date.now();
			if (needsPrune(state, now)) {
				const kept = applyLimits(await readFileEntries(agentId), now);
				await atomicWriteFile(filePath, kept.map(serializeLine).join(''));
				fileStates.set(agentId, stateOf(kept));
				logger.debug(`Pruned journey for agent ${agentId} to ${kept.length}`, LOG_CONTEXT);
			}
			return true;
		} catch (error) {
			// The file may now disagree with the cached state; re-read it next time.
			fileStates.delete(agentId);
			logger.error(`Failed to append journey for agent ${agentId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'journey:append', agentId });
			return false;
		}
	});
}

/** An agent's journey, oldest first, inside retention and the entry cap. */
export async function readJourney(
	agentId: string,
	options: ReadJourneyOptions = {}
): Promise<UserJourneyEntry[]> {
	let entries: UserJourneyEntry[];
	try {
		entries = applyLimits(await readFileEntries(agentId), Date.now());
	} catch (error) {
		logger.warn(`Failed to read journey for agent ${agentId}: ${error}`, LOG_CONTEXT);
		captureException(error, { operation: 'journey:read', agentId });
		return [];
	}
	const { since, tail, kinds } = options;
	if (since !== undefined) entries = entries.filter((e) => e.ts >= since);
	if (kinds && kinds.length > 0) {
		const wanted = new Set(kinds);
		entries = entries.filter((e) => wanted.has(e.kind));
	}
	if (tail !== undefined) entries = tail > 0 ? entries.slice(-tail) : [];
	return entries;
}

/** Delete an agent's journey file. Called when the agent is removed. */
export async function deleteJourney(agentId: string): Promise<void> {
	// Queued so the unlink cannot land between a pending append and its prune,
	// which would resurrect the file.
	await writeQueue.enqueue(agentId, async () => {
		fileStates.delete(agentId);
		try {
			await fsp.unlink(getJourneyFilePath(agentId));
			logger.info(`Deleted journey for agent ${agentId}`, LOG_CONTEXT);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			logger.error(`Failed to delete journey for agent ${agentId}: ${error}`, LOG_CONTEXT);
			captureException(error, { operation: 'journey:delete', agentId });
		}
	});
}
