/**
 * System One decisions: one record per task run that was handed to an engine.
 *
 * `runSystemOneTask` (the task router) is the only producer. It records every
 * run that reached the System One path, answered or not, with the outcome the
 * task's fail policy gave it, so "what did System One decide, and what happened
 * when it could not" has one answer.
 *
 * A record carries the question ids and the typed answers, never the state or
 * the text of a question: those are the user's content, and keeping them is a
 * separate, off-by-default choice.
 *
 * Today a record goes to the system log. {@link recordSystemOneDecision} is the
 * one function the decision ledger changes to keep them.
 */

import type { SystemOneEngineChoice } from '../../../shared/local-models/system-one-settings';
import type {
	SystemOneAnswers,
	SystemOneErrorCode,
	SystemOneUsage,
} from '../../../shared/local-models/system-one';
import type { LocalModelTaskId } from '../../../shared/local-models/tasks';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'SystemOne';

/**
 * How a run ended.
 *
 *   - `ok`            - the engine answered every question.
 *   - `failed-open`   - no answer, and the work went ahead unchecked.
 *   - `failed-closed` - no answer, and the work stopped.
 *   - `unavailable`   - no answer, for a task with no fail policy: its caller
 *                       decided what that means.
 *   - `cancelled`     - the caller aborted. Not a fault.
 */
export type SystemOneDecisionOutcome =
	| 'ok'
	| 'failed-open'
	| 'failed-closed'
	| 'unavailable'
	| 'cancelled';

export interface SystemOneDecision {
	taskId: LocalModelTaskId;
	/** The engine that was asked. `off` when the task was assigned and no engine was chosen. */
	engine: SystemOneEngineChoice;
	/** The model the engine says answered. Absent with no answer. */
	model?: string;
	questionIds: string[];
	/** Absent with no answer. */
	answers?: SystemOneAnswers;
	outcome: SystemOneDecisionOutcome;
	/** Why there was no answer. `off` when no engine was chosen. Absent on `ok`. */
	code?: SystemOneErrorCode | 'off';
	/** Epoch ms the run started. */
	startedAt: number;
	/** From the start of the run to its outcome, with machine sleep removed. */
	latencyMs: number;
	/** What the engine counted. Absent with no answer. */
	usage?: SystemOneUsage;
	costUsd?: number;
}

/** Record one decision. It must never fail the run it describes. */
export function recordSystemOneDecision(decision: SystemOneDecision): void {
	const summary = {
		taskId: decision.taskId,
		engine: decision.engine,
		outcome: decision.outcome,
		latencyMs: decision.latencyMs,
		questionIds: decision.questionIds,
		...(decision.model !== undefined ? { model: decision.model } : {}),
		...(decision.code !== undefined ? { code: decision.code } : {}),
		...(decision.usage ? { inputTokens: decision.usage.inputTokens } : {}),
	};
	if (decision.outcome === 'ok') logger.debug('System One decision', LOG_CONTEXT, summary);
	else logger.info('System One gave no answer', LOG_CONTEXT, summary);
}
