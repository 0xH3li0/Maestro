/**
 * Cue prompt-injection screen: score one untrusted value with the
 * `injection-screen` Local Models assignment.
 *
 * One function, {@link scoreCueInjectionText}, handed to the Cue engine as its
 * scorer (`CueEngineDeps.scoreInjection`). The engine never imports this
 * module: the standalone runner (`maestro-cli cue engine`) builds an engine
 * with no scorer, because that process does not load the model stack.
 *
 * It only ever returns a score or the reason there is none. Whether a run is
 * blocked is the dispatch service's call (`resolveCueInjectionDecision`), so
 * the failure policy lives in one place and this module cannot fail a run open
 * or closed by accident.
 *
 * `off` (the default assignment) is reported apart from `unavailable`: the
 * policy treats "nobody assigned a model" and "the assigned model could not
 * run" differently for a command that never asked to be screened.
 *
 * The whole value is scored. `classifyText` reads every token in overlapping
 * windows and reports the highest score, so an injection at the end of a long
 * comment is not hidden by the text before it.
 */

import type {
	CueInjectionScore,
	CueInjectionScoreRequest,
} from '../../shared/cue/injection-screen';
import { LOCAL_MODEL_TASKS } from '../../shared/local-models/tasks';
import { logger } from '../utils/logger';
import { runClassifierTask } from './task-router';

const LOG_CONTEXT = '[CueInjectionScreen]';

const TASK_ID = 'injection-screen';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = 'Settings > Local Models > Assignments';

/**
 * How long one value may take. Long enough for a cold classifier to load and
 * read a 10,000 character body; short enough that an event is not held for
 * minutes. A timeout is `unavailable`, so the policy decides.
 */
export const CUE_INJECTION_SCREEN_TIMEOUT_MS = 60 * 1000;

/**
 * Score one untrusted value.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runClassifierTask`). The dispatch
 * service treats a throw as `unavailable` too, so even that cannot strand an
 * event.
 */
export async function scoreCueInjectionText(
	request: CueInjectionScoreRequest
): Promise<CueInjectionScore> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];

	const verdict = await runClassifierTask(TASK_ID, {
		text: request.text,
		signal: AbortSignal.timeout(CUE_INJECTION_SCREEN_TIMEOUT_MS),
	});

	switch (verdict.status) {
		case 'off':
			return {
				status: 'off',
				reason: `${task.label} is off. Assign it a classifier model in ${ASSIGNMENT_LOCATION}.`,
			};
		case 'cancelled':
			logger.warn('Cue injection screen timed out', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				variable: request.variable,
				source: verdict.source,
			});
			return { status: 'unavailable', reason: 'The assigned model took too long to answer.' };
		case 'unavailable':
			logger.warn('Cue injection screen could not run: assigned model unavailable', LOG_CONTEXT, {
				subscription: request.subscriptionName,
				variable: request.variable,
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return { status: 'unavailable', reason: verdict.reason };
		case 'ok':
			return { status: 'scored', score: verdict.score };
	}
}
