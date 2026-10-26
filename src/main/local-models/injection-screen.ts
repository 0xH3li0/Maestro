/**
 * Prompt-injection screen: score one untrusted value with the
 * `injection-screen` Local Models assignment, for any caller.
 *
 * {@link scoreInjectionText} is the one entry point. Cue reaches it through
 * `scoreCueInjectionText` (`cue-injection-screen.ts`), Sketch Book through its
 * guardrail gate. It only ever returns a score or the reason there is none:
 * whether the text is blocked or withheld is the caller's decision, so a
 * caller's failure policy cannot be applied twice or by accident here.
 *
 * `off` (the default assignment) is reported apart from `unavailable`: callers
 * treat "nobody assigned a model" and "the assigned model could not run"
 * differently.
 *
 * The whole value is scored. `classifyText` reads every token in overlapping
 * windows and reports the highest score, so an injection at the end of a long
 * value is not hidden by the text before it.
 *
 * Assigned to System One, the screen is one typed yes or no question for the
 * engine in force (`runSystemOneTask`) instead of a classifier run, and its
 * P(yes) is the score. An engine that gives no answer is `unavailable`, never
 * `off` (someone asked for a screen), and it carries the task's fail policy.
 * No classifier is asked in its place.
 *
 * {@link resolveInjectionSource} names the source that WOULD score, without
 * sending anything, so a caller can say where text goes before it goes there.
 * A caller that must approve the source first passes `allowSource`: it sees
 * the source the run resolved, and refusing it sends nothing.
 * {@link resolveLocalInjectionClassifier} finds an installed local classifier
 * whatever the assignment is, and `localModelId` scores on it, for text that
 * must stay on this machine while a cloud engine is in force.
 */

import { cueInjectionScoreFromSystemOne } from '../../shared/cue/injection-screen';
import type {
	InjectionScore,
	InjectionScreenPurpose,
	InjectionSourceInfo,
	InjectionSourceResolution,
} from '../../shared/local-models/injection-screen';
import { allLocalModels, getLocalModel } from '../../shared/local-models/model-catalog';
import { systemOneEngineHost } from '../../shared/local-models/system-one';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import {
	isLocalModelOfferedForTask,
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelAssignment,
} from '../../shared/local-models/tasks';
import { logger } from '../utils/logger';
import { isInstalled } from './model-store';
import { readLocalModelAssignments } from './sources';
import { resolveSystemOneForTask, type ResolvedSystemOneEngine } from './system-one/service';
import {
	runClassifierTask,
	runSystemOneTask,
	systemOneOffReason,
	type SystemOneTaskOptions,
	type SystemOneTaskResult,
} from './task-router';

const LOG_CONTEXT = '[InjectionScreen]';

const TASK_ID = 'injection-screen';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/**
 * How long a classifier run may take when the caller gives no signal of its
 * own. Long enough for a cold classifier to load and read a 10,000 character
 * body; short enough that nobody waits minutes. A timeout is `unavailable`.
 */
export const INJECTION_SCREEN_TIMEOUT_MS = 60 * 1000;

/** What a caller asks the screen. */
export interface InjectionScoreRequest {
	text: string;
	/** Who is asking, for the log and the decision record. */
	purpose: InjectionScreenPurpose;
	/** Free-text context for the log (Cue: "<subscription>.<variable>"). Never the text. */
	label: string;
	/** The agent the text is for, kept on the decision record. */
	agentId?: string;
	/**
	 * Called with the resolved source BEFORE any text is sent. Returning false
	 * stops the call, which then resolves `unavailable`. Sketch Book uses it to
	 * enforce cloud consent; Cue omits it.
	 */
	allowSource?: (source: InjectionSourceInfo) => boolean;
	/**
	 * Score on this installed catalog classifier instead of the assignment
	 * ({@link resolveLocalInjectionClassifier}). Sketch Book screens text written
	 * before a switch to a cloud engine this way, so it never reaches that engine
	 * (spec H1). `allowSource` still sees the source first.
	 */
	localModelId?: string;
	/**
	 * Stops the run. Reaches both the System One and the classifier path. With
	 * none, the classifier path stops after {@link INJECTION_SCREEN_TIMEOUT_MS}
	 * and the System One path has only the engine's own budget.
	 */
	signal?: AbortSignal;
}

/** A System One engine as a screen source. */
export function injectionSourceFromSystemOne(
	engine: Exclude<ResolvedSystemOneEngine, { id: 'off' }>,
	engineLabel: string
): InjectionSourceInfo {
	if (engine.id === 'local-judge') {
		return { kind: 'local-judge', locality: 'local', label: engineLabel };
	}
	const host = systemOneEngineHost(engine.engine.baseUrl);
	return {
		kind: engine.id === 'jev-cloud' ? 'jev' : 'openjev',
		locality: 'cloud',
		...(host ? { host } : {}),
		label: engineLabel,
	};
}

/**
 * A classifier assignment as a screen source. Null for anything a classifier
 * cannot run on (a classifier runs on this computer only). Shared with the
 * secret screen's model pass.
 */
export function classifierScreenSource(
	assignment: LocalModelAssignment
): InjectionSourceInfo | null {
	if (assignment.type !== 'local') return null;
	return {
		kind: 'local-classifier',
		locality: 'local',
		label: localModelAssignmentSourceLabel(assignment, []) ?? assignment.modelId,
	};
}

/**
 * The source that would score a value now, or why there is none. Reads the
 * assignment and the System One engine in force; sends nothing.
 */
export async function resolveInjectionSource(): Promise<InjectionSourceResolution> {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	if (assignment.type === 'off') return { status: 'off' };
	if (assignment.type === 'system-one') {
		const { resolved, engineLabel } = await resolveSystemOneForTask(TASK_ID);
		if (resolved.id === 'off')
			return { status: 'unavailable', reason: systemOneOffReason(TASK_ID) };
		return injectionSourceFromSystemOne(resolved, engineLabel);
	}
	return (
		classifierScreenSource(assignment) ?? {
			status: 'unavailable',
			reason: `${LOCAL_MODEL_TASKS[TASK_ID].label} runs a classifier model on this computer only. Assign one in ${ASSIGNMENT_LOCATION}.`,
		}
	);
}

/** An installed local classifier the screen can be pinned to. */
export interface LocalInjectionClassifier {
	modelId: string;
	source: InjectionSourceInfo;
}

/**
 * An installed local classifier for the screen, whatever the assignment is:
 * the assigned one when it is a local classifier, else the first installed
 * catalog classifier the task offers. Null when none is installed. Sends
 * nothing; pass `modelId` as `localModelId` to score on it.
 */
export async function resolveLocalInjectionClassifier(): Promise<LocalInjectionClassifier | null> {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	const candidates = new Set<string>();
	if (assignment.type === 'local') candidates.add(assignment.modelId);
	for (const entry of allLocalModels()) {
		if (entry.kind === 'classifier' && isLocalModelOfferedForTask(TASK_ID, entry.id)) {
			candidates.add(entry.id);
		}
	}
	for (const modelId of candidates) {
		if (getLocalModel(modelId)?.kind !== 'classifier') continue;
		if (!(await isInstalled(modelId))) continue;
		const source = classifierScreenSource({ type: 'local', modelId });
		if (source) return { modelId, source };
	}
	return null;
}

/** Why a source the caller refused gave no score. */
function refusedReason(source: InjectionSourceInfo): string {
	return `Screening on ${source.label} is not allowed for this text.`;
}

/** A System One verdict as a score. Only ever a score: the caller decides what it blocks. */
function scoreFromSystemOne(
	verdict: Exclude<SystemOneTaskResult, { status: 'not-assigned' }>,
	request: InjectionScoreRequest
): InjectionScore {
	switch (verdict.status) {
		case 'ok':
			return (
				cueInjectionScoreFromSystemOne(verdict.answers) ?? {
					status: 'unavailable',
					reason: `${verdict.engineLabel} did not answer the screen's question.`,
				}
			);
		case 'cancelled':
			return {
				status: 'unavailable',
				reason: `${verdict.engineLabel} was stopped before it answered.`,
			};
		case 'failed-open':
		case 'failed-closed':
		case 'unavailable':
			logger.warn('Injection screen could not run: System One gave no answer', LOG_CONTEXT, {
				purpose: request.purpose,
				label: request.label,
				engine: verdict.engine,
				code: verdict.code,
				reason: verdict.reason,
			});
			return {
				status: 'unavailable',
				reason: verdict.reason,
				...(verdict.status === 'failed-open' ? { failPolicy: 'open' as const } : {}),
				...(verdict.status === 'failed-closed' ? { failPolicy: 'closed' as const } : {}),
			};
	}
}

/**
 * Score one untrusted value.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it). Callers treat a throw as `unavailable`.
 */
export async function scoreInjectionText(request: InjectionScoreRequest): Promise<InjectionScore> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];
	const { allowSource, signal, agentId, localModelId } = request;

	if (localModelId) return scoreOnPinnedClassifier(request, localModelId);

	// System One first: it answers `not-assigned` for any other assignment and
	// touches nothing, so the classifier path below runs exactly as it did. The
	// source check runs inside it, on the engine the run resolved.
	const options: SystemOneTaskOptions = {
		...(signal ? { signal } : {}),
		...(agentId ? { agentId } : {}),
		...(allowSource
			? {
					allowEngine: (engine, engineLabel) => {
						const source = injectionSourceFromSystemOne(engine, engineLabel);
						return allowSource(source) ? null : refusedReason(source);
					},
				}
			: {}),
	};
	const judged = await runSystemOneTask(TASK_ID, { text: request.text }, options);
	if (judged.status !== 'not-assigned') return scoreFromSystemOne(judged, request);

	if (allowSource) {
		const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
		const source = classifierScreenSource(assignment);
		// `off` sends nothing, so the classifier reports it as itself. Any other
		// source a classifier cannot run on is refused before it is reached.
		if (assignment.type !== 'off' && (!source || !allowSource(source))) {
			return {
				status: 'unavailable',
				reason: source
					? refusedReason(source)
					: `${task.label} runs a classifier model on this computer only. Assign one in ${ASSIGNMENT_LOCATION}.`,
			};
		}
	}

	return scoreOnClassifier(request);
}

/** The pinned path: one named local classifier, never the assignment or System One. */
async function scoreOnPinnedClassifier(
	request: InjectionScoreRequest,
	localModelId: string
): Promise<InjectionScore> {
	const source = classifierScreenSource({ type: 'local', modelId: localModelId });
	if (source && request.allowSource && !request.allowSource(source)) {
		return { status: 'unavailable', reason: refusedReason(source) };
	}
	return scoreOnClassifier(request, localModelId);
}

/** A classifier run, on the assignment or on a pinned model, as a score. */
async function scoreOnClassifier(
	request: InjectionScoreRequest,
	localModelId?: string
): Promise<InjectionScore> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];
	const verdict = await runClassifierTask(TASK_ID, {
		text: request.text,
		signal: request.signal ?? AbortSignal.timeout(INJECTION_SCREEN_TIMEOUT_MS),
		...(request.agentId ? { agentId: request.agentId } : {}),
		...(localModelId ? { localModelId } : {}),
	});

	switch (verdict.status) {
		case 'off':
			return {
				status: 'off',
				reason: `${task.label} is off. Assign it a classifier model in ${ASSIGNMENT_LOCATION}.`,
			};
		case 'cancelled':
			logger.warn('Injection screen timed out', LOG_CONTEXT, {
				purpose: request.purpose,
				label: request.label,
				source: verdict.source,
			});
			return { status: 'unavailable', reason: 'The assigned model took too long to answer.' };
		case 'unavailable':
			logger.warn('Injection screen could not run: assigned model unavailable', LOG_CONTEXT, {
				purpose: request.purpose,
				label: request.label,
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return { status: 'unavailable', reason: verdict.reason };
		case 'ok':
			return { status: 'scored', score: verdict.score };
	}
}
