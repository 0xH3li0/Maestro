// Stats commands - introspect the Usage Dashboard's SQLite store.
//
//   maestro-cli stats [--range <r>] [--json]          -> aggregated dashboard metrics
//   maestro-cli stats models [--range <r>] [--json]   -> the dashboard's Models tab
//   maestro-cli stats-query "<sql>" [--json]           -> arbitrary read-only SQL
//
// All route through the running desktop app over the existing WebSocket
// bridge; the app owns the open stats database and runs the query/aggregation
// against it. The SQL path is read-only enforced in the main process.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { formatError, formatModelUsage } from '../output/formatter';
import type { ModelUsage } from '../../shared/local-models/model-usage';
import { isStatsTimeRange, STATS_TIME_RANGES } from '../../shared/stats-types';

interface StatsOptions {
	range?: string;
	json?: boolean;
}

interface StatsQueryOptions {
	json?: boolean;
	param?: string[];
}

interface AggregationResponse {
	type: string;
	data: Record<string, unknown>;
	error?: string;
}

interface StatsQueryResponse {
	type: string;
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	error?: string;
}

/**
 * `maestro-cli stats` - aggregated Usage Dashboard metrics for a time range.
 */
export async function stats(options: StatsOptions): Promise<void> {
	const range = options.range || 'week';

	if (!isStatsTimeRange(range)) {
		const message = `Invalid range "${options.range}". Must be one of: ${STATS_TIME_RANGES.join(', ')}`;
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<AggregationResponse>(
				{ type: 'get_stats_aggregation', range },
				'stats_aggregation'
			);
		});

		if (options.json) {
			console.log(JSON.stringify({ range, ...result.data }, null, 2));
			return;
		}

		printAggregationSummary(range, result.data);
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

interface ModelUsageResponse {
	type: string;
	success: boolean;
	data?: ModelUsage;
	error?: string;
}

/**
 * `maestro-cli stats models` - what every model other than a provider's own
 * did in a time range: the sources, the tasks, the agents on a Run on source,
 * System One's decisions and the token proxy. The record the Usage Dashboard's
 * Models tab draws, from the same main-process read.
 *
 * Exit codes, for scripts: 2 for a range that is not one of the six, and the
 * bridge's own codes when the app is not running, is an older build, or does
 * not answer in time. A range in which nothing ran is not a failure.
 */
export async function statsModels(options: StatsOptions): Promise<void> {
	const range = options.range || 'week';
	const fail = (message: string, code: ExitCode): never => {
		if (options.json) console.error(JSON.stringify({ error: message }));
		else console.error(formatError(message));
		return exitWith(code);
	};

	if (!isStatsTimeRange(range)) {
		return fail(
			`Invalid range "${options.range}". Must be one of: ${STATS_TIME_RANGES.join(', ')}`,
			ExitCode.InvalidUsage
		);
	}

	let reply: ModelUsageResponse;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<ModelUsageResponse>({ type: 'get_model_usage', range }, 'model_usage')
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), exitCodeForError(error));
	}
	if (!reply.success || !reply.data) {
		return fail(reply.error || 'Model usage could not be read', ExitCode.GeneralError);
	}

	console.log(options.json ? JSON.stringify(reply.data, null, 2) : formatModelUsage(reply.data));
}

/**
 * `maestro-cli stats-query` - run a single read-only SQL statement against the
 * stats database. Positional `?` placeholders bind to repeated `--param` values.
 */
export async function statsQuery(sql: string, options: StatsQueryOptions): Promise<void> {
	const params = options.param ?? [];

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<StatsQueryResponse>(
				{ type: 'stats_query', sql, params },
				'stats_query_result'
			);
		});

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						columns: result.columns,
						rows: result.rows,
						rowCount: result.rowCount,
						truncated: result.truncated,
					},
					null,
					2
				)
			);
			return;
		}

		printRowsTable(result);
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

function printAggregationSummary(range: string, data: Record<string, unknown>): void {
	const byAgent = (data.byAgent as Record<string, { count: number }>) || {};
	const bySource = (data.bySource as { user?: number; auto?: number }) || {};

	const lines: string[] = [];
	lines.push(`Usage Stats (${range})`);
	lines.push(`  Total queries:   ${data.totalQueries ?? 0}`);
	lines.push(`  Total sessions:  ${data.totalSessions ?? 0}`);
	lines.push(`  Avg duration:    ${formatMs(Number(data.avgDuration ?? 0))}`);
	lines.push(`  Source:          ${bySource.user ?? 0} user / ${bySource.auto ?? 0} auto`);

	const agentEntries = Object.entries(byAgent);
	if (agentEntries.length > 0) {
		lines.push('  By agent:');
		for (const [agent, stat] of agentEntries) {
			lines.push(`    ${agent}: ${stat.count}`);
		}
	}

	lines.push('');
	lines.push('Run with --json for the full aggregation object.');
	console.log(lines.join('\n'));
}

function printRowsTable(result: StatsQueryResponse): void {
	if (result.rows.length === 0) {
		console.log('(0 rows)');
		return;
	}

	const cols = result.columns;
	const header = cols.join('\t');
	const body = result.rows
		.map((row) => cols.map((col) => formatCell(row[col])).join('\t'))
		.join('\n');

	console.log(header);
	console.log(body);

	const note = result.truncated
		? `\n(${result.rowCount} rows, showing first ${result.rows.length})`
		: `\n(${result.rowCount} row${result.rowCount === 1 ? '' : 's'})`;
	console.log(note);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function handleCommandError(error: unknown, json?: boolean): never {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		console.error(JSON.stringify({ error: message }));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}
