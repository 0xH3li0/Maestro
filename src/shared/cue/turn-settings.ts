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
 */

import type { ToolType } from '../types';
import { resolveTurnSettings, type ResolvedTurnSettings } from '../autorunTurnSettings';
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
 * `agentModel` / `agentEffort` are the agent's own configured values.
 */
export function resolveCueTurnSettings(
	toolType: ToolType,
	settings: CueTurnSettings | undefined,
	agentModel?: string,
	agentEffort?: string
): ResolvedTurnSettings {
	const pinnedModel = settings?.model?.trim();
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
		agentModel,
		agentEffort
	);
	if (pinnedModel) {
		resolved.model = pinnedModel;
		resolved.notes.unshift(`model="${pinnedModel}" (subscription)`);
	}
	return resolved;
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
