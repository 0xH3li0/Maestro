/**
 * The Local Models task router: the one choke point every housekeeping task
 * goes through before it touches a model.
 *
 * A caller names a task (`tab-naming`, `git-drafts`, ...) and hands over its
 * prompt. The router reads the user's assignment for that task
 * (`localModelAssignments`, resolved against the registry defaults in
 * `src/shared/local-models/tasks.ts`) and answers with one of:
 *
 *   - `off`               - the task does not run. The caller hides or skips it.
 *   - `use-utility-agent` - the caller keeps its EXISTING agent path. The router
 *                           never spawns an agent: that path already exists at
 *                           every caller, honors `utilityAgentId` /
 *                           `utilityModelId`, and a second copy here would drift.
 *   - `ok`                - the assigned local model or endpoint answered.
 *   - `unavailable`       - the assigned source could not run (not downloaded,
 *                           runtime will not load, server down, key missing).
 *                           The reason names that model or endpoint.
 *   - `cancelled`         - the caller aborted.
 *
 * **There is no fallback.** An unavailable local model is never swapped for an
 * endpoint, and nothing here ever reaches for a cloud agent on its own: that
 * would spend money (or ship text somewhere) the user did not choose. The
 * caller decides what an `unavailable` task means for its surface.
 *
 * Every call that reaches a model is recorded in the stats database
 * (`local_model_runs`), success or failure, honoring `statsCollectionEnabled`.
 */

import {
	isLocalModelTaskId,
	LOCAL_MODEL_TASKS,
	resolveLocalModelAssignment,
	type LocalModelAssignments,
	type LocalModelTaskId,
} from '../../shared/local-models/tasks';
import type { LocalModelRun } from '../../shared/stats-types';
import { getStatsDB } from '../stats/singleton';
import { isStatsCollectionEnabled, LOG_CONTEXT as STATS_LOG_CONTEXT } from '../stats/utils';
import { getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import { isLocalModelEndpointError, isLocalModelError } from './errors';
import { generateText, isTextGenCancelled, type TextGenSource } from './text-gen';

/** Token budget when a caller names none. Housekeeping output is short. */
export const DEFAULT_TASK_MAX_TOKENS = 512;

/** The most a caller may ask for. A housekeeping task never needs more. */
export const MAX_TASK_MAX_TOKENS = 8192;

/** What a text-generation task hands the router. */
export interface LocalTaskInput {
	prompt: string;
	system?: string;
	/** Defaults to {@link DEFAULT_TASK_MAX_TOKENS}. */
	maxTokens?: number;
	/** Defaults to 0 (see `generateText`). */
	temperature?: number;
	/** Constrain the reply to a JSON Schema; `json` is set when it parsed. */
	jsonSchema?: Record<string, unknown>;
	/** In-process callers only: an abort signal cannot cross IPC or the CLI bridge. */
	signal?: AbortSignal;
}

export type LocalTaskResult =
	| { status: 'off' }
	| { status: 'use-utility-agent' }
	| {
			status: 'ok';
			text: string;
			json?: unknown;
			source: TextGenSource;
			durationMs: number;
			tokensIn?: number;
			tokensOut?: number;
	  }
	| {
			status: 'unavailable';
			source: TextGenSource;
			/** Written for a person; names the model or endpoint and what to do. */
			reason: string;
			/** The classified failure (`model-not-installed`, `network`, ...). */
			code: string;
	  }
	| { status: 'cancelled'; source: TextGenSource };

export type LocalTaskStatus = LocalTaskResult['status'];

/**
 * Run a text-generation task through its assignment.
 *
 * Throws only for a caller bug (a task that is not text-generation) or an
 * unclassified failure inside the engine, which is a bug and belongs in Sentry.
 */
export async function runLocalTask(
	taskId: LocalModelTaskId,
	input: LocalTaskInput
): Promise<LocalTaskResult> {
	const task = LOCAL_MODEL_TASKS[taskId];
	if (task.needs !== 'text-gen') {
		throw new Error(
			`${task.label} is a ${task.needs} task; runLocalTask runs text-generation tasks only.`
		);
	}

	const assignment = resolveLocalModelAssignment(readAssignments(), taskId);
	if (assignment.type === 'off') return { status: 'off' };
	if (assignment.type === 'utility-agent') return { status: 'use-utility-agent' };

	const source: TextGenSource =
		assignment.type === 'local'
			? { type: 'local', modelId: assignment.modelId }
			: { type: 'endpoint', endpointId: assignment.endpointId, model: assignment.model };

	const startedAt = Date.now();
	const span = beginSleepAwareSpan();
	try {
		const result = await generateText({
			source,
			prompt: input.prompt,
			maxTokens: input.maxTokens ?? DEFAULT_TASK_MAX_TOKENS,
			...(input.system !== undefined ? { system: input.system } : {}),
			...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
			...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
			...(input.signal ? { signal: input.signal } : {}),
		});
		recordRun(taskId, source, startedAt, result.durationMs, 'ok', {
			tokensIn: result.tokensIn,
			tokensOut: result.tokensOut,
		});
		return {
			status: 'ok',
			text: result.text,
			...(result.json !== undefined ? { json: result.json } : {}),
			source,
			durationMs: result.durationMs,
			...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
			...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
		};
	} catch (error) {
		const durationMs = sleepAwareElapsedMs(span);
		if (isTextGenCancelled(error)) {
			recordRun(taskId, source, startedAt, durationMs, 'cancelled', { errorCode: 'cancelled' });
			return { status: 'cancelled', source };
		}
		if (isLocalModelError(error)) {
			recordRun(taskId, source, startedAt, durationMs, 'error', { errorCode: error.code });
			return {
				status: 'unavailable',
				source,
				reason: `${error.message} ${error.recovery}`,
				code: error.code,
			};
		}
		if (isLocalModelEndpointError(error)) {
			recordRun(taskId, source, startedAt, durationMs, 'error', { errorCode: error.kind });
			return { status: 'unavailable', source, reason: error.message, code: error.kind };
		}
		recordRun(taskId, source, startedAt, durationMs, 'error', { errorCode: 'unexpected' });
		throw error;
	}
}

/**
 * The transport-facing entry: IPC (`localModels:runTask`) and the CLI bridge
 * (`maestro-cli models run`) hand over untrusted values, so the task id and
 * input are checked here, once, for both. A bad request throws with a message
 * a person can act on.
 */
export async function runLocalTaskRequest(
	taskId: unknown,
	input: unknown
): Promise<LocalTaskResult> {
	if (!isLocalModelTaskId(taskId)) {
		throw new Error(`Unknown task "${String(taskId)}".`);
	}
	return runLocalTask(taskId, parseLocalTaskInput(input));
}

/** Validate a task input that crossed a process boundary. */
export function parseLocalTaskInput(value: unknown): LocalTaskInput {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Task input must be an object with a prompt.');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
		throw new Error('Task input needs a non-empty prompt.');
	}
	const input: LocalTaskInput = { prompt: record.prompt };

	if (record.system !== undefined) {
		if (typeof record.system !== 'string') throw new Error('system must be a string.');
		input.system = record.system;
	}
	if (record.maxTokens !== undefined) {
		const maxTokens = record.maxTokens;
		if (
			typeof maxTokens !== 'number' ||
			!Number.isInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > MAX_TASK_MAX_TOKENS
		) {
			throw new Error(`maxTokens must be an integer from 1 to ${MAX_TASK_MAX_TOKENS}.`);
		}
		input.maxTokens = maxTokens;
	}
	if (record.temperature !== undefined) {
		const temperature = record.temperature;
		if (typeof temperature !== 'number' || !(temperature >= 0 && temperature <= 2)) {
			throw new Error('temperature must be a number from 0 to 2.');
		}
		input.temperature = temperature;
	}
	if (record.jsonSchema !== undefined) {
		const schema = record.jsonSchema;
		if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
			throw new Error('jsonSchema must be an object.');
		}
		input.jsonSchema = schema as Record<string, unknown>;
	}
	return input;
}

function readAssignments(): LocalModelAssignments | undefined {
	return getSettingsStore().get('localModelAssignments', {}) as LocalModelAssignments | undefined;
}

/**
 * Record one run. Best-effort: a stats write that fails must never turn a task
 * that worked into one that did not, so an unexpected failure is reported to
 * Sentry and swallowed (the same contract as multi-window telemetry).
 */
function recordRun(
	taskId: LocalModelTaskId,
	source: TextGenSource,
	startedAt: number,
	durationMs: number,
	outcome: LocalModelRun['outcome'],
	extra: { errorCode?: string; tokensIn?: number; tokensOut?: number }
): void {
	try {
		if (!isStatsCollectionEnabled(getSettingsStore())) return;
		const db = getStatsDB();
		if (!db.isReady()) return;
		db.recordLocalModelRun({
			taskId,
			sourceType: source.type,
			modelId: source.type === 'local' ? source.modelId : source.model,
			...(source.type === 'endpoint' ? { endpointId: source.endpointId } : {}),
			startedAt,
			durationMs,
			outcome,
			...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
			...(extra.tokensIn !== undefined ? { tokensIn: extra.tokensIn } : {}),
			...(extra.tokensOut !== undefined ? { tokensOut: extra.tokensOut } : {}),
		});
	} catch (error) {
		logger.warn(`Failed to record local model run: ${error}`, STATS_LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'stats:recordLocalModelRun',
			taskId,
		});
	}
}
