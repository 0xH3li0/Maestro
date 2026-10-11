/**
 * Local Models tasks: the named housekeeping jobs a local model can do, and
 * which source the user assigned to each.
 *
 * A task is a JOB (name a tab, draft a commit message, screen untrusted text),
 * never a model. Every consumer asks the task router (`src/main/local-models/
 * task-router.ts`) to run its task by id, and the router reads the assignment
 * stored here to decide where the work goes. That is the rule that keeps the
 * choice of "which model does this" in one setting rather than one per feature.
 *
 * Assignments persist under the `localModelAssignments` setting as a SPARSE
 * record: a task with no stored entry uses its registry `defaultAssignment`.
 * Storing only what the user changed means a task added in a later build, or a
 * default that moves, reaches existing installs without a write.
 *
 * Everything here is pure so the renderer, the main process, and the CLI read
 * and validate an assignment by the same rules.
 */

import { getLocalModel } from './model-catalog';
import type { LocalModelKind } from './types';

/** What a task asks its assigned source to do. A subset of {@link LocalModelKind}. */
export type LocalModelTaskNeed = Extract<
	LocalModelKind,
	'text-gen' | 'embedding' | 'classifier' | 'stt' | 'tts'
>;

/**
 * Where a task's work goes.
 *
 * - `off`: the task does not run. A consumer with no model-free fallback hides
 *   its affordance.
 * - `utility-agent`: the task's EXISTING agent path, unchanged. For tab naming
 *   and summaries that is the Utility Agent (`utilityAgentId` / `utilityModelId`
 *   in Settings, or the agent's own provider when those are unset); for AI
 *   command mode it is the tab's own provider. The router never spawns an agent
 *   for this: it tells the caller to keep doing what it did before Local Models
 *   existed. Only tasks that HAVE such a path accept it
 *   ({@link LocalModelTaskDefinition.allowsUtilityAgent}).
 * - `local`: a catalog model run on this machine.
 * - `endpoint`: a model served by one of the user's `localModelEndpoints`.
 */
export type LocalModelAssignment =
	| { type: 'off' }
	| { type: 'utility-agent' }
	| { type: 'local'; modelId: string }
	| { type: 'endpoint'; endpointId: string; model: string };

export type LocalModelAssignmentType = LocalModelAssignment['type'];

/**
 * The needs a user-run model server can serve. Endpoints speak chat
 * completions and embeddings (`endpoint-client.ts`); no server runs a sequence
 * classifier or a speech model through those, so an endpoint assignment for
 * any other need is refused when saved and reported by readiness, rather than
 * accepted and then failing on every run.
 */
export const ENDPOINT_SERVED_NEEDS: readonly LocalModelTaskNeed[] = Object.freeze([
	'text-gen',
	'embedding',
]);

/** Whether an endpoint can serve a task with this need. */
export function endpointServesNeed(need: LocalModelTaskNeed): boolean {
	return ENDPOINT_SERVED_NEEDS.includes(need);
}

export const LOCAL_MODEL_ASSIGNMENT_TYPES: readonly LocalModelAssignmentType[] = Object.freeze([
	'off',
	'utility-agent',
	'local',
	'endpoint',
]);

export const OFF_ASSIGNMENT: LocalModelAssignment = Object.freeze({ type: 'off' });
export const UTILITY_AGENT_ASSIGNMENT: LocalModelAssignment = Object.freeze({
	type: 'utility-agent',
});

export const LOCAL_MODEL_TASK_IDS = [
	'tab-naming',
	'tab-summary',
	'tab-cleanup',
	'ai-command',
	'git-drafts',
	'semantic-search',
	'cue-gate',
	'injection-screen',
	'secret-screen',
	'dictation',
	'spoken-notices',
	'voice-routing',
	'token-proxy',
] as const;

export type LocalModelTaskId = (typeof LOCAL_MODEL_TASK_IDS)[number];

export interface LocalModelTaskDefinition {
	readonly id: LocalModelTaskId;
	/** What the task is called in front of a person. */
	readonly label: string;
	/** One sentence: what the task does and what changes when it is assigned. */
	readonly description: string;
	/**
	 * The kind of model the assignment picks. A source picker offers only local
	 * models and endpoint models of this kind.
	 */
	readonly needs: LocalModelTaskNeed;
	/**
	 * Capabilities the task also uses that this assignment does NOT choose, so a
	 * readiness check can name them. Spoken notices write the line with the
	 * assigned text model and speak it with the voice that is already configured.
	 */
	readonly alsoNeeds?: readonly LocalModelTaskNeed[];
	/** Whether `utility-agent` is a valid assignment: only tasks with an existing agent path. */
	readonly allowsUtilityAgent: boolean;
	/** The assignment a task has until the user picks one. */
	readonly defaultAssignment: LocalModelAssignment;
}

function defineTask(task: LocalModelTaskDefinition): LocalModelTaskDefinition {
	if (task.defaultAssignment.type === 'utility-agent' && !task.allowsUtilityAgent) {
		throw new Error(`Task "${task.id}" defaults to the Utility Agent but does not allow it.`);
	}
	return Object.freeze({
		...task,
		...(task.alsoNeeds ? { alsoNeeds: Object.freeze([...task.alsoNeeds]) } : {}),
	});
}

/**
 * Every task, keyed by id. Tasks that already run through an agent today
 * (tab naming, summaries, AI command mode) default to `utility-agent`, so
 * nothing changes until the user opts in to a local model; every task that is
 * new with Local Models defaults to `off`.
 */
export const LOCAL_MODEL_TASKS: Readonly<Record<LocalModelTaskId, LocalModelTaskDefinition>> =
	Object.freeze({
		'tab-naming': defineTask({
			id: 'tab-naming',
			label: 'Tab naming',
			description: 'Names a new AI tab from the first message sent in it.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
		}),
		'tab-summary': defineTask({
			id: 'tab-summary',
			label: 'Summaries',
			description:
				'Writes the tab hover summary, the group chat participant summary, and context summaries.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
		}),
		'tab-cleanup': defineTask({
			id: 'tab-cleanup',
			label: 'Tab cleanup suggestions',
			description:
				'Suggests tabs to close, snooze, or bring back from snooze. Every action still needs your confirmation.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'ai-command': defineTask({
			id: 'ai-command',
			label: 'AI command mode',
			description: 'Turns a plain-English request in command mode into a shell command.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
		}),
		'git-drafts': defineTask({
			id: 'git-drafts',
			label: 'Git drafts',
			description:
				'Drafts commit messages and pull request titles and bodies from the diff. Fills the fields, never submits.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'semantic-search': defineTask({
			id: 'semantic-search',
			label: 'Semantic search',
			description: 'Finds history, transcripts, and documents by meaning rather than exact words.',
			needs: 'embedding',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'cue-gate': defineTask({
			id: 'cue-gate',
			label: 'Cue gate',
			description:
				'Checks a Cue subscription gate condition against the event before an agent is started.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'injection-screen': defineTask({
			id: 'injection-screen',
			label: 'Prompt-injection screen',
			description: 'Scores untrusted text for prompt injection before Cue passes it to an agent.',
			needs: 'classifier',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'secret-screen': defineTask({
			id: 'secret-screen',
			label: 'Secret screen',
			description:
				'Extra model coverage when scanning content for secrets before it is published. Pattern detection always runs.',
			needs: 'classifier',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		dictation: defineTask({
			id: 'dictation',
			label: 'Dictation',
			description: 'Transcribes speech into any text box without starting a voice session.',
			needs: 'stt',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'spoken-notices': defineTask({
			id: 'spoken-notices',
			label: 'Spoken notices',
			description: 'Writes a one-line summary to speak aloud when an agent finishes a turn.',
			needs: 'text-gen',
			alsoNeeds: ['tts'],
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'voice-routing': defineTask({
			id: 'voice-routing',
			label: 'Voice routing',
			description:
				'Decides which agent and tab a spoken request is for. Off keeps the voice brain chosen in A Cappella settings.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'token-proxy': defineTask({
			id: 'token-proxy',
			label: 'Token proxy',
			description: 'Summarizes large tool output for the token-conservation proxy.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
	});

/** The persisted `localModelAssignments` setting: only the tasks the user changed. */
export type LocalModelAssignments = Partial<Record<LocalModelTaskId, LocalModelAssignment>>;

export function isLocalModelTaskId(value: unknown): value is LocalModelTaskId {
	return (
		typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_TASKS, value)
	);
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Read one stored assignment for a task, or `null` when it is not a usable
 * shape for that task. Only the SHAPE is checked: a model id that is no longer
 * in the catalog, or an endpoint that was removed, is kept, so the router can
 * report that exact model or endpoint as unavailable instead of the task
 * silently reverting to its default.
 */
export function parseLocalModelAssignment(
	taskId: LocalModelTaskId,
	value: unknown
): LocalModelAssignment | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case 'off':
			return OFF_ASSIGNMENT;
		case 'utility-agent':
			return LOCAL_MODEL_TASKS[taskId].allowsUtilityAgent ? UTILITY_AGENT_ASSIGNMENT : null;
		case 'local': {
			const modelId = nonEmptyString(record.modelId);
			return modelId ? { type: 'local', modelId } : null;
		}
		case 'endpoint': {
			const endpointId = nonEmptyString(record.endpointId);
			const model = nonEmptyString(record.model);
			return endpointId && model ? { type: 'endpoint', endpointId, model } : null;
		}
		default:
			return null;
	}
}

/**
 * Read the persisted `localModelAssignments` setting. This is also the settings
 * migration: it runs on every load, so there is no one-shot write to miss.
 *
 * - Anything that is not a plain object reads as empty, so an install from
 *   before Local Models (no setting at all) gets every default. Because the
 *   tasks that already ran through an agent default to `utility-agent`, a user
 *   who set `utilityAgentId` / `utilityModelId` keeps exactly the behavior they
 *   configured: those two settings are still what `utility-agent` means.
 * - Unknown task ids (a task a later build dropped) and unusable entries (a
 *   malformed record, or `utility-agent` on a task that has no agent path) are
 *   dropped, which leaves that task on its default.
 * - An entry equal to its task's default is dropped too, so the stored record
 *   stays sparse and a default that moves in a later build still reaches it.
 */
export function parseLocalModelAssignments(value: unknown): LocalModelAssignments {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	const assignments: LocalModelAssignments = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!isLocalModelTaskId(key)) continue;
		const assignment = parseLocalModelAssignment(key, entry);
		if (!assignment) continue;
		if (isSameLocalModelAssignment(assignment, LOCAL_MODEL_TASKS[key].defaultAssignment)) continue;
		assignments[key] = assignment;
	}
	return assignments;
}

export function isSameLocalModelAssignment(
	a: LocalModelAssignment,
	b: LocalModelAssignment
): boolean {
	if (a.type !== b.type) return false;
	if (a.type === 'local' && b.type === 'local') return a.modelId === b.modelId;
	if (a.type === 'endpoint' && b.type === 'endpoint') {
		return a.endpointId === b.endpointId && a.model === b.model;
	}
	return true;
}

/** The assignment a task runs with: the stored one, else the task's default. */
export function resolveLocalModelAssignment(
	assignments: LocalModelAssignments | undefined,
	taskId: LocalModelTaskId
): LocalModelAssignment {
	const stored = assignments?.[taskId];
	const parsed = stored === undefined ? null : parseLocalModelAssignment(taskId, stored);
	return parsed ?? LOCAL_MODEL_TASKS[taskId].defaultAssignment;
}

/** Every task's effective assignment, for a surface that lists them all. */
export function resolveLocalModelAssignments(
	assignments: LocalModelAssignments | undefined
): Record<LocalModelTaskId, LocalModelAssignment> {
	const resolved = {} as Record<LocalModelTaskId, LocalModelAssignment>;
	for (const taskId of LOCAL_MODEL_TASK_IDS) {
		resolved[taskId] = resolveLocalModelAssignment(assignments, taskId);
	}
	return resolved;
}

/**
 * Why an assignment the user is about to SAVE does not fit a task, or `null`
 * when it does. Stricter than {@link parseLocalModelAssignment}: a local model
 * must be in the catalog and of the kind the task needs, because picking a
 * text model for an embedding task is a mistake to refuse at the picker, not a
 * failure to discover at run time. An endpoint is refused for a need no server
 * serves ({@link endpointServesNeed}); otherwise its models are discovered at
 * run time, so only their shape is checked here and readiness reports a wrong
 * one.
 */
export function localModelAssignmentProblem(
	taskId: LocalModelTaskId,
	value: unknown
): string | null {
	const task = LOCAL_MODEL_TASKS[taskId];
	const assignment = parseLocalModelAssignment(taskId, value);
	if (!assignment) {
		const type =
			typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
		if (type === 'utility-agent') {
			return `${task.label} has no Utility Agent path. Choose off, a local model, or an endpoint.`;
		}
		if (type === 'local') return 'A local assignment needs a model id.';
		if (type === 'endpoint') return 'An endpoint assignment needs an endpoint id and a model name.';
		return `Assignment type must be one of: ${LOCAL_MODEL_ASSIGNMENT_TYPES.join(', ')}.`;
	}
	if (assignment.type === 'local') {
		const model = getLocalModel(assignment.modelId);
		if (!model) return `"${assignment.modelId}" is not a known local model.`;
		if (model.kind !== task.needs) {
			return `${model.displayName} is a ${model.kind} model, but ${task.label} needs a ${task.needs} model.`;
		}
	}
	if (assignment.type === 'endpoint' && !endpointServesNeed(task.needs)) {
		return `${task.label} needs a ${task.needs} model, which an endpoint cannot serve. Choose off or a local model.`;
	}
	return null;
}

/**
 * Store one task's assignment, returning the next persisted record. Choosing a
 * task's default removes its entry rather than writing the default down, which
 * keeps the record sparse (see {@link parseLocalModelAssignments}). The caller
 * validates with {@link localModelAssignmentProblem} first.
 */
export function withLocalModelAssignment(
	assignments: LocalModelAssignments,
	taskId: LocalModelTaskId,
	assignment: LocalModelAssignment
): LocalModelAssignments {
	const next: LocalModelAssignments = { ...assignments };
	if (isSameLocalModelAssignment(assignment, LOCAL_MODEL_TASKS[taskId].defaultAssignment)) {
		delete next[taskId];
	} else {
		next[taskId] = assignment;
	}
	return next;
}

/**
 * The tasks whose EFFECTIVE assignment runs a given local model, in registry
 * order. Reads defaults too, so a task that would run the model without a
 * stored entry still counts. This is the list a surface names before removing
 * the model, because removing it turns each of those tasks unavailable.
 */
export function tasksUsingLocalModel(
	assignments: LocalModelAssignments | undefined,
	modelId: string
): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.filter((taskId) => {
		const assignment = resolveLocalModelAssignment(assignments, taskId);
		return assignment.type === 'local' && assignment.modelId === modelId;
	}).map((taskId) => LOCAL_MODEL_TASKS[taskId]);
}

/** The tasks that can be assigned a model of this kind, in registry order. */
export function tasksNeedingKind(kind: LocalModelKind): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId]).filter(
		(task) => task.needs === kind
	);
}

/**
 * The tasks whose EFFECTIVE assignment calls a given endpoint, in registry
 * order. The endpoint twin of {@link tasksUsingLocalModel}: removing or
 * disabling the endpoint turns each of these tasks unavailable, so a surface
 * names them first.
 */
export function tasksUsingEndpoint(
	assignments: LocalModelAssignments | undefined,
	endpointId: string
): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.filter((taskId) => {
		const assignment = resolveLocalModelAssignment(assignments, taskId);
		return assignment.type === 'endpoint' && assignment.endpointId === endpointId;
	}).map((taskId) => LOCAL_MODEL_TASKS[taskId]);
}

/**
 * The one-string spelling of an assignment: `off`, `utility-agent`,
 * `local:<model-id>`, or `endpoint:<endpoint-id>:<model>`. The settings picker
 * uses it as an option value and `maestro-cli models assign` takes it as an
 * argument, so the two cannot disagree about what a choice means. Endpoint ids
 * are UUIDs and never contain a colon, so everything after the second colon is
 * the model, which keeps an Ollama tag (`qwen3:latest`) intact.
 */
export function formatLocalModelAssignmentSpec(assignment: LocalModelAssignment): string {
	switch (assignment.type) {
		case 'off':
		case 'utility-agent':
			return assignment.type;
		case 'local':
			return `local:${assignment.modelId}`;
		case 'endpoint':
			return `endpoint:${assignment.endpointId}:${assignment.model}`;
	}
}

/**
 * Read a spelling written by {@link formatLocalModelAssignmentSpec}, or `null`
 * when it is not one. Only the SHAPE is checked; whether it fits a task is
 * {@link localModelAssignmentProblem}.
 */
export function parseLocalModelAssignmentSpec(spec: string): LocalModelAssignment | null {
	const trimmed = spec.trim();
	if (trimmed === 'off') return OFF_ASSIGNMENT;
	if (trimmed === 'utility-agent') return UTILITY_AGENT_ASSIGNMENT;
	if (trimmed.startsWith('local:')) {
		const modelId = nonEmptyString(trimmed.slice('local:'.length));
		return modelId ? { type: 'local', modelId } : null;
	}
	if (trimmed.startsWith('endpoint:')) {
		const rest = trimmed.slice('endpoint:'.length);
		const separator = rest.indexOf(':');
		if (separator < 0) return null;
		const endpointId = nonEmptyString(rest.slice(0, separator));
		const model = nonEmptyString(rest.slice(separator + 1));
		return endpointId && model ? { type: 'endpoint', endpointId, model } : null;
	}
	return null;
}
