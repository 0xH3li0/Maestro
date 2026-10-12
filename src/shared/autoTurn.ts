/**
 * Resolving a turn sent on the Auto model (`autoModel.ts`).
 *
 * The `model-routing` task answers a tier and an effort for a prompt
 * (`routeTurn`). This module turns that answer into what a launch uses: a
 * model, an effort and a place. It is pure and shared, so the desktop composer,
 * the queue, Auto Run, Cue and the CLI cannot resolve one turn two ways.
 *
 * Three rules, each a decision made once and written down:
 *
 *   1. **The model is kept while the provider's cache is warm.** A turn that
 *      resumes a provider session whose last activity is inside the provider's
 *      prompt-cache lifetime keeps that session's model and place
 *      ({@link autoModelHold}). The router's tier is recorded and NOT applied;
 *      its effort is. Switching models mid-session throws the cache away, which
 *      costs more than the cheaper model saves. A session start, and a session
 *      idle past the lifetime, take the tier.
 *   2. **A send never waits on the router and never fails on it.** `routeTurn`
 *      owns the timeout. A turn with no decision (the task is off, the router
 *      was slow or down) runs on the agent's default: no model named, so the
 *      provider-level setting and then the harness's own default apply, with the
 *      agent's own effort. A held model (rule 1) is still kept.
 *   3. **The choice is locked at send.** What the router answered is frozen in
 *      an {@link AutoRouteStamp} when the message is sent or queued, and what
 *      the turn did with it in an {@link AutoTurnStamp}. A queued message is
 *      routed when it is queued, never again when it drains.
 *
 * Rule 1 is decided when the turn takes the tab (the hold), and the route is
 * applied when the router answers. They are two steps because a send does not
 * wait: the tab is marked busy at once, with a `pending` stamp that carries the
 * hold, and the stamp is finished when the answer lands.
 *
 * A tier resolves through {@link resolveTurnSettings}, the join Auto Run and
 * Cue use, so `medium` chosen by the router launches where `tier="medium"`
 * launches in a playbook: the agent's own tier target, then the harness
 * default, then the built-in table. A target a layer names and that cannot be
 * used sets `refusal`, and the turn must not launch on some other model.
 */

import { isAutoModel, AUTO_MODEL_LABEL } from './autoModel';
import type { HintDirective, ModelHint } from './autorunModelHints';
import { resolveTurnSettings, type ResolvedTurnSettings } from './autorunTurnSettings';
import { DURATION_MS } from './duration';
import {
	isModelRouteSkipped,
	type ModelRoutingSkipReason,
	type RouteTurnResult,
} from './local-models/model-routing-task';
import type { RunOnTarget } from './local-models/run-on';
import type { TierRouting } from './modelTiers';
import type { EffortLevel, ModelTier } from './tierLevels';
import type { ToolType } from './types';

// ---------------------------------------------------------------------------
// Rule 1: the model a live session keeps
// ---------------------------------------------------------------------------

/**
 * How long a provider keeps a session's prompt cache after its last request,
 * for a provider with no row below. Anthropic's default cache lifetime.
 */
export const DEFAULT_PROMPT_CACHE_LIFETIME_MS = 5 * DURATION_MS.minute;

/**
 * Prompt-cache lifetimes, per provider, where one is documented. Sparse: a
 * provider with no row gets the default, which is also the shortest, so an
 * unknown provider is never assumed warm for longer than a known one.
 */
const PROMPT_CACHE_LIFETIME_MS: Partial<Record<ToolType, number>> = {
	// Anthropic's default cache: five minutes, refreshed by each read.
	'claude-code': 5 * DURATION_MS.minute,
	// OpenAI keeps a cached prefix for five to ten minutes of inactivity. The
	// floor is taken: a model switched a little early costs one cache write.
	codex: 5 * DURATION_MS.minute,
};

/** How long a session of this provider stays warm after its last activity. */
export function promptCacheLifetimeMs(toolType: ToolType): number {
	return PROMPT_CACHE_LIFETIME_MS[toolType] ?? DEFAULT_PROMPT_CACHE_LIFETIME_MS;
}

/** What a provider session last ran on, as rule 1 reads it. */
export interface AutoSessionLaunch {
	/** The model it ran on. `undefined` is the agent's default. */
	model?: string;
	/** The place it ran, when a tier decided it. `undefined` is the agent's own Run on target. */
	runOn?: RunOnTarget;
	/** Epoch ms of the session's last activity. `undefined` when nobody knows. */
	lastActiveAt?: number;
}

/** The launch a turn keeps under rule 1: the session's model and place. */
export interface AutoModelHold {
	model?: string;
	runOn?: RunOnTarget;
}

/**
 * Rule 1 for one turn: the launch it keeps, or `undefined` when it may take the
 * router's tier. `session` is the provider session the turn RESUMES, absent at
 * a session start. A session whose last activity is unknown is read as cold: it
 * was not launched recently by anything that kept a record.
 */
export function autoModelHold(
	toolType: ToolType,
	session: AutoSessionLaunch | undefined,
	now: number
): AutoModelHold | undefined {
	if (!session || session.lastActiveAt === undefined) return undefined;
	if (now - session.lastActiveAt > promptCacheLifetimeMs(toolType)) return undefined;
	return {
		...(session.model && !isAutoModel(session.model) ? { model: session.model } : {}),
		...(session.runOn ? { runOn: session.runOn } : {}),
	};
}

// ---------------------------------------------------------------------------
// Rule 3: what is frozen at send
// ---------------------------------------------------------------------------

/**
 * What the router answered for one turn, as it is frozen at send: the two
 * levels and who chose them, or why there is no decision. Small enough to ride
 * on a queued item and a tab; the latency and the confidences stay in the
 * decision ledger.
 */
export type AutoRouteStamp =
	| {
			tier: ModelTier;
			effort: EffortLevel;
			/** The router that decided, as every surface names it. */
			engine: string;
			/** True only when its numbers are trained to be calibrated (Jev, OpenJev). */
			calibrated: boolean;
	  }
	| {
			skipped: ModelRoutingSkipReason;
			/** Written for a person: what was asked and why there is no answer. */
			detail: string;
			/** The router that was asked, when one was. */
			engine?: string;
	  };

/** A route that is a decision, not a skip. */
export type AutoRouteDecision = Extract<AutoRouteStamp, { tier: ModelTier }>;

export function isAutoRouteDecision(route: AutoRouteStamp | undefined): route is AutoRouteDecision {
	return route !== undefined && 'tier' in route;
}

/** `routeTurn`'s answer as the stamp a turn keeps. */
export function autoRouteStamp(result: RouteTurnResult): AutoRouteStamp {
	if (isModelRouteSkipped(result)) {
		return {
			skipped: result.skipped,
			detail: result.detail,
			...(result.engine ? { engine: result.engine.label } : {}),
		};
	}
	return {
		tier: result.tier,
		effort: result.effort,
		engine: result.engine.label,
		calibrated: result.engine.calibrated,
	};
}

/**
 * The stamp for a router that could not be reached at all (no desktop app to
 * ask, a bridge that did not answer). It is a "no decision" like any other.
 */
export function unreachableAutoRoute(detail: string): AutoRouteStamp {
	return { skipped: 'unavailable', detail };
}

/**
 * How a turn sent on Auto got its settings.
 *
 *   - `pending`     - the tab is running the turn and the router has not answered.
 *   - `routed`      - a router chose a tier and an effort.
 *   - `router-off`  - the `model-routing` task is off. Not an error.
 *   - `no-decision` - a router was asked and gave no answer in time, or could not run.
 */
export type AutoTurnStatus = 'pending' | 'routed' | 'router-off' | 'no-decision';

/** What a turn sent on Auto did, kept with the turn (`AITab.turnAuto`). */
export interface AutoTurnStamp {
	status: AutoTurnStatus;
	/** Rule 1: the launch the session keeps. Decided when the turn took the tab. */
	hold?: AutoModelHold;
	/** The router's answer. Absent while `pending`, and when no router was asked. */
	route?: AutoRouteStamp;
	/**
	 * Where the turn launches, when Auto decided the place: the tier's target, or
	 * the place the held session ran. Absent means the agent's own Run on target.
	 */
	runOn?: RunOnTarget;
	/** Set when the tier names a target that cannot be used. The turn must not launch. */
	refusal?: string;
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

export interface AutoTurnInput {
	toolType: ToolType;
	/** What the router answered. Absent: nothing was asked, which is no decision. */
	route?: AutoRouteStamp;
	/** Rule 1's verdict for this turn ({@link autoModelHold}). */
	hold?: AutoModelHold;
	/** The agent's own effort: used with no decision, and where the provider maps no level. */
	agentEffort?: string;
	/** The agent's tier targets and the harness defaults. */
	routing?: TierRouting;
	/**
	 * A setting someone wrote for this turn: an Auto Run document's
	 * `MAESTRO:MODEL` marker, a Cue subscription's `effort`. It wins on every axis
	 * it sets; an axis it leaves to the agent (absent, or `default`) is the
	 * router's.
	 */
	marker?: ModelHint | null;
}

/** A resolved Auto turn: what {@link resolveTurnSettings} returns, plus its stamp. */
export interface AutoTurn extends ResolvedTurnSettings {
	stamp: AutoTurnStamp;
}

/** The level a marker fixes on one axis, or `undefined` when it leaves the axis to the agent. */
function pinnedLevel(directive: HintDirective | undefined): ModelTier | undefined {
	return directive && directive !== 'default' ? directive : undefined;
}

/**
 * Whether a turn with this marker still has an axis for the router to decide.
 * A marker that fixes both tier and effort leaves nothing, so the router is
 * not asked: a decision nobody would read costs latency and, on Jev, money.
 */
export function autoTurnNeedsRoute(marker: ModelHint | null | undefined): boolean {
	return !(pinnedLevel(marker?.tier) && pinnedLevel(marker?.effort));
}

function statusOf(route: AutoRouteStamp | undefined): Exclude<AutoTurnStatus, 'pending'> {
	if (isAutoRouteDecision(route)) return 'routed';
	return route?.skipped === 'off' ? 'router-off' : 'no-decision';
}

const KEPT_MODEL_FALLBACK = "the agent's default model";

/** The line that says what Auto did, ahead of the resolver's own per-axis notes. */
function autoNote(route: AutoRouteStamp | undefined, hold: AutoModelHold | undefined): string {
	const kept = hold
		? ` The session keeps ${hold.model ?? KEPT_MODEL_FALLBACK} while the provider's cache is warm.`
		: '';
	if (isAutoRouteDecision(route)) {
		return `${AUTO_MODEL_LABEL}: ${route.engine} chose tier ${route.tier}, effort ${route.effort}.${kept}`;
	}
	const fallback = hold ? kept : " The agent's default model and effort apply.";
	if (!route) return `${AUTO_MODEL_LABEL}: no router was asked.${fallback}`;
	return route.skipped === 'off'
		? `${AUTO_MODEL_LABEL} (router off): ${route.detail}${fallback}`
		: `${AUTO_MODEL_LABEL} (no decision): ${route.detail}${fallback}`;
}

/**
 * Resolve one turn sent on Auto.
 *
 * The model starts from what the session keeps (rule 1), else from nothing,
 * which is the agent's default. The router's tier replaces it only when the
 * turn is free to choose; its effort always applies. A marker outranks the
 * router on the axes it sets, and outranks the hold too: it is an instruction
 * someone wrote for this turn.
 */
export function resolveAutoTurn(input: AutoTurnInput): AutoTurn {
	const { toolType, route, hold, agentEffort, routing, marker } = input;
	const decision = isAutoRouteDecision(route) ? route : undefined;
	const pinnedTier = pinnedLevel(marker?.tier);
	const pinnedEffort = pinnedLevel(marker?.effort);
	const tier = pinnedTier ?? (hold ? undefined : decision?.tier);
	const effort = pinnedEffort ?? decision?.effort;

	const hint: ModelHint | null =
		tier || effort || marker?.invalid?.length
			? {
					line: marker?.line ?? 0,
					...(tier ? { tier } : {}),
					...(effort ? { effort } : {}),
					scopes: {
						tier: pinnedTier ? marker?.scopes?.tier : 'auto',
						effort: pinnedEffort ? marker?.scopes?.effort : 'auto',
					},
					...(marker?.invalid?.length ? { invalid: marker.invalid } : {}),
				}
			: null;
	const resolved = resolveTurnSettings(toolType, hint, hold?.model, agentEffort, routing);

	// The place: the tier's target when a tier applied, else where the held
	// session ran. Neither means the agent's own Run on target stands.
	const runOn = resolved.runOn ?? (tier ? undefined : hold?.runOn);
	// A marker that fixes both axes asked the router nothing, so there is
	// nothing for an Auto line to say: the marker's own notes are the record.
	const notes = autoTurnNeedsRoute(marker)
		? [autoNote(route, tier ? undefined : hold), ...resolved.notes]
		: resolved.notes;

	const { runOn: _resolvedRunOn, ...rest } = resolved;
	return {
		...rest,
		...(runOn ? { runOn } : {}),
		notes,
		stamp: {
			status: statusOf(route),
			...(hold && !tier ? { hold } : {}),
			...(route ? { route } : {}),
			...(runOn ? { runOn } : {}),
			...(resolved.refusal ? { refusal: resolved.refusal.message } : {}),
		},
	};
}

/**
 * The stamp a tab carries while its turn waits for the router: rule 1's
 * verdict, and the place a held session ran.
 */
export function pendingAutoTurnStamp(hold: AutoModelHold | undefined): AutoTurnStamp {
	return {
		status: 'pending',
		...(hold ? { hold } : {}),
		...(hold?.runOn ? { runOn: hold.runOn } : {}),
	};
}

// ---------------------------------------------------------------------------
// How a turn's Auto reads
// ---------------------------------------------------------------------------

/**
 * A turn's Auto as a pill reads it: `Auto → medium · sonnet`,
 * `Auto → low · qwen3.5-4b · Maestro`, `Auto (router off)`,
 * `Auto (no decision)`. `target` is what the turn launched on, as its own pill
 * names it: the Run on label, else the model. A routed turn that kept the
 * session's model says so in place of the tier, because the tier was not
 * applied.
 */
export function autoTurnLabel(stamp: AutoTurnStamp, target?: string): string {
	switch (stamp.status) {
		case 'pending':
			return AUTO_MODEL_LABEL;
		case 'router-off':
			return `${AUTO_MODEL_LABEL} (router off)`;
		case 'no-decision':
			return `${AUTO_MODEL_LABEL} (no decision)`;
		case 'routed': {
			if (stamp.hold) return `${AUTO_MODEL_LABEL} → ${target ?? 'default'} (kept)`;
			const tier = isAutoRouteDecision(stamp.route) ? stamp.route.tier : undefined;
			const parts = [tier, target].filter(Boolean);
			return parts.length > 0 ? `${AUTO_MODEL_LABEL} → ${parts.join(' · ')}` : AUTO_MODEL_LABEL;
		}
	}
}
