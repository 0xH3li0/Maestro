/**
 * A Cue subscription's model and effort, resolved for the agent that runs it.
 *
 * A subscription may set `tier` OR an exact `model`, plus `effort`. Tier and
 * effort speak Maestro's one `low | medium | high` vocabulary and resolve
 * through {@link resolveTurnSettings}, the same join Auto Run uses, so a
 * `tier: high` in cue.yaml and a `tier="high"` marker in a playbook land on the
 * same model. A pinned `model` is handed to the agent verbatim: it exists for
 * providers with no tier table (Codex, OpenCode) and for a model a tier cannot
 * name.
 *
 * Precedence, highest first: the subscription, the agent's own configured
 * value, the provider default. A tier or effort the provider cannot honor falls
 * back to the agent's value and lands in `warnings`, so the run still happens
 * and the activity log says why it ran on a different model than asked.
 *
 * `model: auto` is how a subscription opts its runs into model routing
 * ({@link cueRunIsAutoRouted}). Routing needs the prompt, which only exists
 * once the run's variables are substituted, so such a run is resolved in two
 * steps: {@link resolveCueTurnSettings} gives what it launches with when the
 * router has no decision, and the executor asks the host to finish it
 * (`CueExecutionConfig.resolveLateTurn`) when the prompt is known. A
 * subscription that does not opt in is never routed, whatever the agent's own
 * model is: an agent set to Auto then runs its Cue turns on its default.
 */

import type { ToolType } from '../types';
import { isAutoModel, ownModel } from '../autoModel';
import type { ModelHint } from '../autorunModelHints';
import {
	resolveTurnSettings,
	turnRunOnTarget,
	type ResolvedTurnSettings,
} from '../autorunTurnSettings';
import type { TierRouting } from '../modelTiers';
import type { CueSubscription } from './contracts';

/** The three per-subscription model fields, carried from dispatch to spawn. */
export type CueTurnSettings = Pick<CueSubscription, 'tier' | 'model' | 'effort'>;

/**
 * Lift the model fields off a subscription. `undefined` when none is set, so an
 * ordinary subscription threads nothing through the queue.
 */
export function cueTurnSettingsOf(sub: CueTurnSettings): CueTurnSettings | undefined {
	const settings: CueTurnSettings = {};
	if (sub.tier) settings.tier = sub.tier;
	const model = sub.model?.trim();
	if (model) settings.model = model;
	if (sub.effort) settings.effort = sub.effort;
	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Resolve a subscription's settings against the agent that runs it.
 * `agentModel` / `agentEffort` are the agent's own configured values, and
 * `routing` its tier targets and the harness defaults, so a subscription's
 * tier launches where the same tier launches in a playbook. A pinned model
 * names the model only: the run stays on the agent's own Run on target.
 */
export function resolveCueTurnSettings(
	toolType: ToolType,
	settings: CueTurnSettings | undefined,
	agentModel?: string,
	agentEffort?: string,
	routing?: TierRouting
): ResolvedTurnSettings {
	// `auto` pins nothing: it is the word for "route this run", and neither the
	// subscription's nor the agent's is ever a model name to launch on.
	const pinnedModel = ownModel(settings?.model?.trim());
	// A pinned model replaces the tier outright. The validator refuses both on
	// one subscription; dropping the tier here keeps a hand-built value from
	// reporting a tier note for a model it did not choose.
	const tier = pinnedModel ? undefined : settings?.tier;
	const effort = settings?.effort;
	const resolved = resolveTurnSettings(
		toolType,
		tier || effort
			? { tier, effort, line: 0, scopes: { tier: 'subscription', effort: 'subscription' } }
			: null,
		ownModel(agentModel),
		agentEffort,
		routing
	);
	if (pinnedModel) {
		resolved.model = pinnedModel;
		resolved.notes.unshift(`model="${pinnedModel}" (subscription)`);
	}
	return resolved;
}

/** Whether a subscription opts its runs into model routing: `model: auto`. */
export function cueRunIsAutoRouted(settings: CueTurnSettings | undefined): boolean {
	return isAutoModel(settings?.model);
}

/**
 * What a routed subscription still fixes for its run, as the marker
 * `resolveAutoTurn` takes: its `effort`. The router decides the tier (a
 * subscription cannot set both `tier` and `model`), and the effort too when
 * the subscription names none.
 */
export function cueAutoMarker(settings: CueTurnSettings | undefined): ModelHint | null {
	return settings?.effort
		? { line: 0, effort: settings.effort, scopes: { effort: 'subscription' } }
		: null;
}

/** The launch fields of a Cue run that a resolved turn decides. */
export interface CueTurnLaunch {
	customModel?: string;
	customEffort?: string;
	/** The Run on target the run launches on, as data for the Run on path. */
	runOn?: unknown;
	/** Set when the turn's tier names a target that cannot be used. The run must not start. */
	launchRefusal?: string;
}

/**
 * A resolved turn as the launch fields `executeCuePrompt` takes. One mapping
 * for both hosts (the desktop app and the standalone CLI engine) and for both
 * moments a turn is resolved (at dispatch, and once the prompt is known), so a
 * tier's place and a refusal cannot be carried one way here and another there.
 */
export function cueTurnLaunch(turn: ResolvedTurnSettings, agentRunOn: unknown): CueTurnLaunch {
	return {
		customModel: turn.model,
		customEffort: turn.effort,
		runOn: turnRunOnTarget(turn, agentRunOn),
		...(turn.refusal ? { launchRefusal: turn.refusal.message } : {}),
	};
}

/** Whether two holders carry the same model choice. Absent matches absent. */
export function sameCueTurnSettings(a: CueTurnSettings, b: CueTurnSettings): boolean {
	const x = cueTurnSettingsOf(a) ?? {};
	const y = cueTurnSettingsOf(b) ?? {};
	return x.tier === y.tier && x.model === y.model && x.effort === y.effort;
}

/**
 * Compact label for a model choice as written in YAML (`tier high, effort low`,
 * `model gpt-5.5-codex`). Empty when none is set. For listings, not for the
 * resolved per-provider value, which only exists at spawn time.
 */
export function formatCueTurnSettings(sub: CueTurnSettings): string {
	const settings = cueTurnSettingsOf(sub);
	if (!settings) return '';
	return [
		settings.model ? `model ${settings.model}` : settings.tier ? `tier ${settings.tier}` : '',
		settings.effort ? `effort ${settings.effort}` : '',
	]
		.filter(Boolean)
		.join(', ');
}
