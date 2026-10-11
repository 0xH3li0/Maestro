/**
 * Cue gate: shared, process-agnostic pieces.
 *
 * A subscription may carry a `gate`: a condition in plain language, such as
 * "the comment asks for a code change or reports a bug". Before Cue starts a
 * run for an event, the `cue-gate` Local Models task answers yes or no against
 * the event payload. A "no" skips the run and records why.
 *
 * The point is COST. Most Cue events do not need a cloud turn, and a small
 * local model can tell which ones do. A gate is NOT a security control: the
 * event payload is untrusted text and can argue its way past a yes/no model.
 * The prompt-injection screen is the control for hostile text.
 *
 * Failure policy: a gate whose model cannot answer fails OPEN. The run starts,
 * and the user is warned, because a missing gate model must not silently stop
 * automation the user depends on. `gate_on_unavailable: skip` turns that into
 * fail closed for a subscription whose runs are not worth an unchecked turn.
 *
 * Everything here is pure, with no Electron, Node, or DOM dependency: the
 * reply contract, the caps that keep an event inside a small model context,
 * the policy, and the record stamped on the event. The model call is
 * main-process only (`src/main/local-models/cue-gate.ts`), and the dispatch
 * service (`src/main/cue/cue-dispatch-service.ts`) is the one place a gate is
 * applied.
 */

import type { CueEvent } from './contracts';

/** What a gate does when its model cannot answer. */
export const CUE_GATE_ON_UNAVAILABLE = ['run', 'skip'] as const;
export type CueGateOnUnavailable = (typeof CUE_GATE_ON_UNAVAILABLE)[number];

/** Fail open: see the failure policy in the module comment. */
export const DEFAULT_CUE_GATE_ON_UNAVAILABLE: CueGateOnUnavailable = 'run';

/** Longest gate condition accepted from cue.yaml. A condition is one sentence. */
export const CUE_GATE_MAX_CONDITION_LENGTH = 1000;

/** Longest reason kept from a model reply. */
export const CUE_GATE_MAX_REASON_LENGTH = 240;

/**
 * A gate as a person sets it: the condition and what to do when no model can
 * answer. The shape every authoring surface speaks (the trigger panel, the
 * Scheduled Task form, `maestro-cli cue gate`, `cue schedule --gate`), so a
 * gate set by clicking and one set from the CLI are the same two keys on disk.
 */
export interface CueGateSetting {
	condition: string;
	/** Absent means {@link DEFAULT_CUE_GATE_ON_UNAVAILABLE}. */
	onUnavailable?: CueGateOnUnavailable;
}

/** What a gate write reports. `updated` names every subscription it changed. */
export type CueGateWriteResult = { ok: true; updated: string[] } | { ok: false; error: string };

/** Narrow a value from the CLI, the bridge, or a form to a policy. */
export function parseCueGateOnUnavailable(value: unknown): CueGateOnUnavailable | null {
	return typeof value === 'string' && (CUE_GATE_ON_UNAVAILABLE as readonly string[]).includes(value)
		? (value as CueGateOnUnavailable)
		: null;
}

/**
 * Why a condition cannot be saved, or `null` when it can. The same two rules
 * the cue.yaml validator applies, so a surface refuses a gate when it is
 * typed instead of writing a file the engine then rejects.
 */
export function cueGateConditionProblem(condition: string): string | null {
	if (condition.trim().length === 0) {
		return 'A gate needs a condition the event must meet, in plain language.';
	}
	if (condition.trim().length > CUE_GATE_MAX_CONDITION_LENGTH) {
		return `A gate condition is at most ${CUE_GATE_MAX_CONDITION_LENGTH} characters. One sentence is enough.`;
	}
	return null;
}

/** The gate a subscription (or a raw cue.yaml record) carries, when it has one. */
export function readCueGateSetting(sub: {
	gate?: unknown;
	gate_on_unavailable?: unknown;
}): CueGateSetting | null {
	if (typeof sub.gate !== 'string' || sub.gate.trim().length === 0) return null;
	const onUnavailable = parseCueGateOnUnavailable(sub.gate_on_unavailable);
	return { condition: sub.gate.trim(), ...(onUnavailable ? { onUnavailable } : {}) };
}

/**
 * Set or remove the gate on one raw cue.yaml subscription record, in place.
 * The one place the two keys are written by a patch, so every writer agrees:
 * `null` removes both, the condition is trimmed, and the policy is written
 * only when it is not the default. A policy alone means nothing, and a
 * spelled-out default would make two otherwise identical triggers differ
 * (`triggerGroupKey` compares the keys as written).
 *
 * Throws on a condition that cannot be saved; check with
 * {@link cueGateConditionProblem} first to report it without a throw.
 */
export function writeCueGateFields(
	record: Record<string, unknown>,
	gate: CueGateSetting | null
): void {
	if (gate === null) {
		delete record.gate;
		delete record.gate_on_unavailable;
		return;
	}
	const problem = cueGateConditionProblem(gate.condition);
	if (problem) throw new Error(problem);
	record.gate = gate.condition.trim();
	if (gate.onUnavailable && gate.onUnavailable !== DEFAULT_CUE_GATE_ON_UNAVAILABLE) {
		record.gate_on_unavailable = gate.onUnavailable;
	} else {
		delete record.gate_on_unavailable;
	}
}

/**
 * Caps on the event handed to the model. A local model's whole context is a
 * few thousand tokens, and one issue body can be longer than that. Each string
 * is cut first, so a long body cannot push every later field out, and the
 * whole document is cut last. At the caps the event is roughly 1,500 tokens,
 * which leaves a 4,096 token context room for the instructions and the reply.
 */
export const CUE_GATE_EVENT_CAPS: CueGateEventCaps = Object.freeze({
	maxStringChars: 1500,
	maxArrayItems: 20,
	maxDepth: 4,
	maxTotalChars: 6000,
});

export interface CueGateEventCaps {
	maxStringChars: number;
	maxArrayItems: number;
	maxDepth: number;
	maxTotalChars: number;
}

/**
 * The reply shape `cue-gate-local.md` asks for. `reason` comes first so the
 * model states what it saw before it commits to a verdict.
 */
export const CUE_GATE_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		reason: { type: 'string', maxLength: CUE_GATE_MAX_REASON_LENGTH },
		pass: { type: 'boolean' },
	},
	required: ['reason', 'pass'],
	additionalProperties: false,
};

/** A parsed model verdict. */
export interface CueGateReply {
	pass: boolean;
	reason: string;
}

/**
 * Read a model reply. Returns `null` for anything that is not a verdict: the
 * caller treats that as "the model could not answer", never as a pass or a
 * fail, so a model that replies with prose cannot decide the run by accident.
 */
export function parseCueGateReply(value: unknown): CueGateReply | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.pass !== 'boolean') return null;
	const reason = typeof record.reason === 'string' ? clampCueGateReason(record.reason) : '';
	return { pass: record.pass, reason };
}

/** One line, bounded: a reason is shown in a table row and stored on every gated event. */
export function clampCueGateReason(reason: string): string {
	const oneLine = reason.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= CUE_GATE_MAX_REASON_LENGTH) return oneLine;
	return `${oneLine.slice(0, CUE_GATE_MAX_REASON_LENGTH - 3)}...`;
}

function compactValue(value: unknown, caps: CueGateEventCaps, depth: number): unknown {
	if (typeof value === 'string') {
		if (value.length <= caps.maxStringChars) return value;
		const dropped = value.length - caps.maxStringChars;
		return `${value.slice(0, caps.maxStringChars)} ...[${dropped} more characters not shown]`;
	}
	if (value === null || typeof value !== 'object') return value;
	if (depth >= caps.maxDepth)
		return Array.isArray(value) ? '[list not shown]' : '[object not shown]';
	if (Array.isArray(value)) {
		const shown = value
			.slice(0, caps.maxArrayItems)
			.map((item) => compactValue(item, caps, depth + 1));
		if (value.length > caps.maxArrayItems) {
			shown.push(`...[${value.length - caps.maxArrayItems} more items not shown]`);
		}
		return shown;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		// The gate's own record is bookkeeping, not part of what happened.
		if (depth === 0 && key === CUE_GATE_PAYLOAD_KEY) continue;
		out[key] = compactValue(item, caps, depth + 1);
	}
	return out;
}

/**
 * The event payload as compact JSON, cut to fit a small model context.
 * Deterministic: the same payload always produces the same text.
 */
export function compactCueGateEvent(
	payload: Record<string, unknown>,
	caps: CueGateEventCaps = CUE_GATE_EVENT_CAPS
): string {
	let json: string;
	try {
		json = JSON.stringify(compactValue(payload, caps, 0)) ?? '{}';
	} catch {
		// A payload that cannot be serialized (a cycle) carries nothing the
		// model can read. The gate still runs on the event type alone.
		json = '{}';
	}
	if (json.length <= caps.maxTotalChars) return json;
	const dropped = json.length - caps.maxTotalChars;
	return `${json.slice(0, caps.maxTotalChars)} ...[${dropped} more characters not shown]`;
}

/**
 * The user turn for the `cue-gate` task (the instructions are the
 * `cue-gate-local` prompt, sent as the system turn).
 */
export function formatCueGateInput(input: {
	condition: string;
	event: Pick<CueEvent, 'type' | 'payload'>;
}): string {
	return [
		`Condition: ${input.condition.trim()}`,
		'',
		`Event type: ${input.event.type}`,
		'Event:',
		compactCueGateEvent(input.event.payload),
	].join('\n');
}

/**
 * What the gate check found. `unavailable` covers every way a model failed to
 * give a verdict: the task is off, the model is not installed, the server is
 * down, the reply was not a verdict, or the runner cannot reach Local Models.
 */
export type CueGateCheck =
	| { status: 'pass'; reason: string }
	| { status: 'fail'; reason: string }
	| { status: 'unavailable'; reason: string };

/** What a dispatch service asks its gate evaluator. */
export interface CueGateRequest {
	condition: string;
	event: CueEvent;
	subscriptionName: string;
}

/** Answers a gate. Must resolve; a throw is treated as `unavailable`. */
export type CueGateEvaluator = (request: CueGateRequest) => Promise<CueGateCheck>;

/**
 * What happened to a gated dispatch, stamped on the event payload under
 * {@link CUE_GATE_PAYLOAD_KEY} so the activity list can say why a run started
 * or did not, including after a restart (the payload is what `cue_events`
 * keeps).
 *
 * - `passed`        - the model said the event meets the condition.
 * - `gated`         - the run was skipped: the model said no, or the model
 *                     could not answer and the subscription asked to skip.
 * - `ran-unchecked` - the model could not answer and the run started anyway
 *                     (fail open).
 */
export interface CueGateRecord {
	outcome: 'passed' | 'gated' | 'ran-unchecked';
	reason: string;
}

/** The event payload key the gate record is stored under. */
export const CUE_GATE_PAYLOAD_KEY = 'gate';

export interface CueGateDecision {
	/** Whether the run starts. */
	run: boolean;
	/** Whether the user must be told the gate did not check this event. */
	warn: boolean;
	record: CueGateRecord;
}

/**
 * Apply the failure policy to a gate check. The one place the policy lives:
 * a verdict is obeyed, and an unavailable gate runs (and warns) unless the
 * subscription set `gate_on_unavailable: skip`.
 */
export function resolveCueGateDecision(
	check: CueGateCheck,
	onUnavailable: CueGateOnUnavailable = DEFAULT_CUE_GATE_ON_UNAVAILABLE
): CueGateDecision {
	if (check.status === 'pass') {
		return {
			run: true,
			warn: false,
			record: { outcome: 'passed', reason: check.reason },
		};
	}
	if (check.status === 'fail') {
		return {
			run: false,
			warn: false,
			record: {
				outcome: 'gated',
				reason: check.reason || 'The event does not meet the gate condition.',
			},
		};
	}
	if (onUnavailable === 'skip') {
		return {
			run: false,
			warn: true,
			record: {
				outcome: 'gated',
				reason: `The gate could not be checked, and gate_on_unavailable is "skip". ${check.reason}`,
			},
		};
	}
	return {
		run: true,
		warn: true,
		record: {
			outcome: 'ran-unchecked',
			reason: `The gate could not be checked, so the run started without it. ${check.reason}`,
		},
	};
}

/** A copy of the event carrying the gate record. The original is not changed. */
export function withCueGateRecord(event: CueEvent, record: CueGateRecord): CueEvent {
	return { ...event, payload: { ...event.payload, [CUE_GATE_PAYLOAD_KEY]: record } };
}

/** The gate record on an event payload, when a gate was applied to it. */
export function readCueGateRecord(
	payload: Record<string, unknown> | undefined
): CueGateRecord | null {
	const value = payload?.[CUE_GATE_PAYLOAD_KEY];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record.outcome !== 'passed' &&
		record.outcome !== 'gated' &&
		record.outcome !== 'ran-unchecked'
	) {
		return null;
	}
	return {
		outcome: record.outcome,
		reason: typeof record.reason === 'string' ? record.reason : '',
	};
}
