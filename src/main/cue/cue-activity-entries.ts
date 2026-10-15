/**
 * The Cue activity view's one mapping, shared by every surface that shows it.
 *
 * Two readers serve `cue activity`: the desktop app answers `get_cue_activity`
 * from the engine's in-memory log (`cueCallbacks.ts`), and the CLI reads
 * `cue.db` itself when the app is not running (`cue-control.ts`). Both go
 * through this module so they cannot disagree about ids, status names,
 * ordering, or what `limit` means.
 *
 * Runtime imports are limited to `src/shared`, so the CLI bundle can load it
 * without Electron or the engine; the main-process types below are type-only.
 */

import { composeCueSubscriptionId } from '../../shared/cue/subscription-id';
import type { CueEventType, CueRunResult, CueRunStatus } from './cue-types';
import type { CueEventRecord } from './cue-db';
import type { CueActivityEntry } from '../web-server/types';

/**
 * How many runs the activity log holds, and so how many rows the engine
 * restores from `cue.db` at start. The CLI's database reader asks for the
 * same window, so a filtered read sees exactly the runs the app would.
 */
export const CUE_ACTIVITY_LOG_MAX = 1000;

/**
 * Rebuild a run result from its `cue_events` row. A row carries no stdout,
 * stderr or exit code, so those come back empty. An orphaned `running` row
 * (the process ended before the run could finalize) is reported as `failed`,
 * so the activity view does not paint it as a zero-duration success.
 */
export function cueEventRecordToRunResult(
	record: CueEventRecord,
	sessionNamesById: Map<string, string>
): CueRunResult {
	let payload: Record<string, unknown> = {};
	if (record.payload) {
		try {
			const parsed = JSON.parse(record.payload);
			if (parsed && typeof parsed === 'object') {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			// Non-JSON or corrupt payload - leave empty rather than fail the read.
		}
	}
	const startedAt = new Date(record.createdAt).toISOString();
	const endedAt = record.completedAt ? new Date(record.completedAt).toISOString() : '';
	const durationMs = record.completedAt ? Math.max(0, record.completedAt - record.createdAt) : 0;
	const status: CueRunStatus =
		record.status === 'running' ? 'failed' : (record.status as CueRunStatus);
	return {
		runId: record.id,
		sessionId: record.sessionId,
		sessionName: sessionNamesById.get(record.sessionId) ?? record.sessionId,
		subscriptionName: record.subscriptionName,
		event: {
			id: record.id,
			type: record.type as CueEventType,
			timestamp: startedAt,
			triggerName: record.triggerName,
			payload,
		},
		status,
		stdout: '',
		stderr: '',
		exitCode: null,
		durationMs,
		startedAt,
		endedAt,
	};
}

/**
 * Turn `cue_events` rows, newest first as `getRecentCueEvents` returns them,
 * into run results in activity-log order (oldest first, newest last), which
 * is the order the engine's live `push()` produces.
 */
export function cueEventRecordsToRunResults(
	records: CueEventRecord[],
	sessionNamesById: Map<string, string>
): CueRunResult[] {
	return records
		.slice()
		.reverse()
		.map((record) => cueEventRecordToRunResult(record, sessionNamesById));
}

/** Collapse the engine's run status onto the four states the activity view shows. */
function activityStatus(status: CueRunStatus): CueActivityEntry['status'] {
	if (status === 'completed') return 'completed';
	if (status === 'running') return 'running';
	// `timeout` and `stopped` are terminal failure variants.
	if (status === 'failed' || status === 'timeout' || status === 'stopped') return 'failed';
	return 'triggered';
}

/**
 * The activity view's rows: runs from one agent (or all), newest first, at
 * most `limit` of them.
 *
 * `runs` is in activity-log order, oldest first. The agent filter runs before
 * the limit, so the caller gets `limit` matching runs rather than `limit` runs
 * of which some were then filtered away, and the limit keeps the NEWEST runs.
 */
export function toCueActivityEntries(
	runs: CueRunResult[],
	options: { sessionId?: string; limit?: number } = {}
): CueActivityEntry[] {
	const { sessionId, limit } = options;
	const matching =
		typeof sessionId === 'string' && sessionId.length > 0
			? runs.filter((r) => r.sessionId === sessionId)
			: runs;
	const newestFirst = matching.slice().reverse();
	const limited =
		typeof limit === 'number' && limit > 0 ? newestFirst.slice(0, limit) : newestFirst;
	return limited.map((r) => ({
		id: r.runId,
		// Same identity contract as the subscriptions list: the pipeline
		// discriminator falls back to base-name stripping when the run has no
		// `pipelineName`, matching how `getCueGraphData`'s flatten emits ids.
		subscriptionId: composeCueSubscriptionId(r.sessionId, {
			name: r.subscriptionName,
			pipeline_name: r.pipelineName,
		}),
		subscriptionName: r.subscriptionName,
		eventType: r.event.type,
		sessionId: r.sessionId,
		timestamp: Date.parse(r.startedAt) || 0,
		status: activityStatus(r.status),
		result: r.status === 'completed' ? r.stdout || undefined : r.stderr || undefined,
		duration: r.durationMs,
	}));
}
