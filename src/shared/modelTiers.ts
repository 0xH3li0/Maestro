/**
 * Provider-normalized model tiers and effort levels.
 *
 * Maestro speaks one vocabulary for "how much horsepower does this turn need":
 * `low | medium | high`, for both the model TIER and the EFFORT level. Every
 * provider spells those differently (or not at all), so this module is the one
 * place that translates. An Auto Run document says `tier="high"`; what actually
 * reaches the command line depends on which agent is running it.
 *
 * Two separate axes, deliberately:
 *
 * - **Tier** picks WHICH model. Only meaningful where we can name a model with
 *   confidence, which is fewer providers than you would hope (see below).
 * - **Effort** picks how hard that model thinks. Orthogonal: a low-tier model
 *   at high effort is a perfectly sensible request.
 *
 * The ladder rule for effort: `low` is the FLOOR of the provider's ladder,
 * `high` is the CEILING, `medium` is the middle rung. That is why the mapping
 * is not the identity even where the provider happens to use the same three
 * words. Claude's ladder runs `low, medium, high, xhigh, max`, so Maestro's
 * `high` means `max` (the actual ceiling) and Maestro's `medium` means `high`
 * (the actual middle). Codex runs the same five rungs today. The tables below
 * are written out per provider rather than computed from an index so the
 * resolution is auditable by reading it - a surprising row should be obvious
 * here rather than discovered at runtime.
 *
 * Unmapped is a first-class answer. `undefined` means "we have no opinion for
 * this provider, use the agent's own configured default", and callers surface
 * that as a visible warning rather than a silent substitution. Quietly running
 * a deep-planning task on whatever the default model is - when the document
 * asked for the top tier - is the failure this module exists to prevent.
 */

import type { ToolType } from './types';
import { FALLBACK_CONTEXT_WINDOW, getModelContextWindowOverride } from './agentConstants';
import { isValidAgentId, type AgentId } from './agentIds';
import { getAgentDisplayName } from './agentMetadata';
import {
	agentRunOnSupport,
	parseRunOnTarget,
	runOnTargetLabel,
	storedRunOnNamesSource,
	type RunOnTarget,
} from './local-models/run-on';

/** The one vocabulary: model tier and effort level both use these three rungs. */
export const TIER_LEVELS = ['low', 'medium', 'high'] as const;

/** Which model to use. Resolved per provider by {@link resolveTierModel}. */
export type ModelTier = (typeof TIER_LEVELS)[number];

/** How hard the model should think. Resolved by {@link resolveEffortLevel}. */
export type EffortLevel = (typeof TIER_LEVELS)[number];

/** Narrow an unknown value to a tier/effort rung, or `undefined` if it isn't one. */
export function asTierLevel(value: unknown): ModelTier | undefined {
	return TIER_LEVELS.includes(value as ModelTier) ? (value as ModelTier) : undefined;
}

/**
 * Effort ladders, per provider, floor to ceiling.
 *
 * Mirrors the `effort` / `reasoningEffort` option in `src/main/agents/definitions.ts`
 * minus the leading empty string (which means "provider default", not a rung).
 * OpenCode is absent on purpose: it exposes no effort knob at all, so an effort
 * hint on an OpenCode agent has nothing to write and resolves to `undefined`.
 *
 * These are static rather than read from runtime discovery because a document
 * must resolve identically on every machine. Discovery can ADD rungs a given
 * install supports; it cannot be allowed to silently change what `high` means
 * for a playbook someone else wrote.
 */
const EFFORT_LADDERS: Partial<Record<ToolType, Record<EffortLevel, string>>> = {
	// Ladder: low, medium, high, xhigh, max
	'claude-code': { low: 'low', medium: 'high', high: 'max' },
	// Ladder: low, medium, high, xhigh, max (Codex 0.162.1, every listed model in
	// models_cache.json). `minimal` was the floor of the older ladder and the
	// current models reject it with a 400 ("'minimal' is not supported with the
	// 'gpt-6.1-sol' model"), so mapping low to it failed every cheap turn. `ultra`
	// is listed for some models but is a delegation mode, not a deeper rung, and
	// the API refused it too.
	codex: { low: 'low', medium: 'high', high: 'max' },
	// Ladder: low, medium, high - the one provider where the mapping IS the identity.
	'factory-droid': { low: 'low', medium: 'medium', high: 'high' },
	// Ladder: low, medium, high, xhigh. Even-length, so "middle" is a judgment
	// call: medium takes the lower of the two central rungs, matching the name.
	'copilot-cli': { low: 'low', medium: 'medium', high: 'xhigh' },
};

/**
 * Model tiers, per provider.
 *
 * Deliberately sparse. A tier map is only shipped where the identifiers are
 * stable enough that a playbook written today still resolves correctly in six
 * months:
 *
 * - `claude-code` uses the permanent aliases, which always resolve to the
 *   current model in each tier. Safe indefinitely.
 * - `factory-droid` takes one model family so the three tiers are genuinely
 *   comparable. The IDs are versioned and will need revising, but they are
 *   already hard-coded in the agent definition, so this is no new exposure.
 * - `codex` maps by FAMILY. Its catalogue names three lines that keep their
 *   role across generations: Luna ("fast and affordable"), Sol ("workhorse for
 *   coding") and Astra ("frontier intelligence"); gpt-5.6-luna became
 *   gpt-6-luna. The table names the newest listed member of each family. The
 *   slugs DO churn, so they must be bumped when a generation lands; two things
 *   keep that from going wrong quietly: a stale slug is refused by Codex with a
 *   400 rather than run on some other model, and the agent detector logs a
 *   warning naming the replacement when a slug here is not in the user's
 *   catalogue (`staleCodexTierModels`). All three were checked with a real
 *   turn on Codex CLI 0.162.1 with a ChatGPT login (2026-10-11).
 *
 * Absent on purpose: `copilot-cli` discovers its catalogue at runtime
 * (models.dev) with no stable family names; `opencode` runs whatever the user
 * configured, which may be a local Ollama model with no knowable tier.
 * Guessing for those would produce a table that silently rots into naming
 * models the user cannot run. They resolve to the agent default, and the
 * caller says so out loud.
 */
const TIER_MODELS: Partial<Record<ToolType, Record<ModelTier, string>>> = {
	'claude-code': { low: 'haiku', medium: 'sonnet', high: 'opus' },
	'factory-droid': {
		low: 'claude-haiku-4-5-20251001',
		medium: 'claude-sonnet-4-5-20250929',
		high: 'claude-opus-4-5-20251101',
	},
	codex: { low: 'gpt-6-luna', medium: 'gpt-6.1-sol', high: 'gpt-6-astra' },
};

/** The Codex model family behind each tier (see the `codex` row above). */
export const CODEX_TIER_FAMILIES: Readonly<Record<ModelTier, string>> = Object.freeze({
	low: 'luna',
	medium: 'sol',
	high: 'astra',
});

/** One entry of Codex's `models_cache.json`, as much of it as the tier check reads. */
export interface CodexCatalogModel {
	slug?: string;
	visibility?: string;
	priority?: number;
}

/**
 * The Codex tier slugs that are not in this catalogue, each with the newest
 * listed member of the same family to replace it with (or `null` when the
 * family is gone). Empty when every tier slug is listed. For a warning only:
 * the tier table itself is never rewritten at runtime, because a document must
 * resolve to the same model on every machine.
 */
export function staleCodexTierModels(
	catalog: readonly CodexCatalogModel[]
): Array<{ tier: ModelTier; slug: string; replacement: string | null }> {
	const listed = catalog.filter(
		(m): m is CodexCatalogModel & { slug: string } =>
			typeof m.slug === 'string' && m.visibility !== 'hide'
	);
	const slugs = new Set(listed.map((m) => m.slug));
	const stale: Array<{ tier: ModelTier; slug: string; replacement: string | null }> = [];
	for (const tier of TIER_LEVELS) {
		const slug = TIER_MODELS.codex?.[tier];
		if (!slug || slugs.has(slug)) continue;
		const family = CODEX_TIER_FAMILIES[tier];
		const newest = listed
			.filter((m) => m.slug.split('-').pop() === family)
			.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
		stale.push({ tier, slug, replacement: newest?.slug ?? null });
	}
	return stale;
}

/**
 * The BUILT-IN model for a tier on this provider, or `undefined` when Maestro
 * has no opinion. `undefined` means "fall back to the agent's configured
 * model" - the caller is expected to report that it did, so the author learns
 * their hint had no effect rather than silently getting the wrong model.
 *
 * This is the table alone. A launch that acts on a tier goes through
 * {@link resolveTierTarget}, which reads the agent's own targets and the
 * harness defaults first. Call this only where the provider's own model for a
 * tier is the question (the cheap synopsis turn, a label, the Suggest rules).
 */
export function resolveTierModel(toolType: ToolType, tier: ModelTier): string | undefined {
	return TIER_MODELS[toolType]?.[tier];
}

/**
 * Where one tier launches: a model on the harness's own provider, or a Run on
 * target (`shared/local-models/run-on.ts`).
 *
 *   - `provider-model` with a `model`: the provider, on that model.
 *   - `provider-model` with no `model`, or `provider`: the provider, on the
 *     agent's own configured model. The tier names where, not which.
 *   - `source`: the same harness pointed at a model on a Local Models source.
 */
export type TierTarget = { type: 'provider-model'; model?: string } | RunOnTarget;

/** One layer's targets. Sparse: an absent tier falls through to the next layer. */
export type TierTargets = Partial<Record<ModelTier, TierTarget>>;

/** The persisted `harnessTierDefaults` setting: only what the user changed. */
export type HarnessTierDefaults = Partial<Record<AgentId, TierTargets>>;

/** The layer a tier's target came from. Shown wherever a tier is shown. */
export type TierTargetSource = 'agent' | 'harness-default' | 'built-in';

/** A layer's name for a person: beside a picker, in a note, in a refusal. */
export const TIER_TARGET_SOURCE_LABELS: Readonly<Record<TierTargetSource, string>> = Object.freeze({
	agent: 'Agent',
	'harness-default': 'Harness default',
	'built-in': 'Built-in',
});

export type TierTargetParse = { ok: true; target: TierTarget } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one stored target and put it in the form that is stored: trimmed, with
 * no unknown keys. A source goes through `parseRunOnTarget`, so a tier cannot
 * hold a source a Run on launch would refuse as malformed.
 */
export function parseTierTarget(value: unknown): TierTargetParse {
	if (!isPlainObject(value)) {
		return { ok: false, error: 'A tier target is an object with a type.' };
	}
	if (value.type === 'provider-model') {
		if (value.model === undefined || value.model === null) {
			return { ok: true, target: { type: 'provider-model' } };
		}
		if (typeof value.model !== 'string') {
			return { ok: false, error: "A tier target's model is text." };
		}
		const model = value.model.trim();
		return {
			ok: true,
			target: model === '' ? { type: 'provider-model' } : { type: 'provider-model', model },
		};
	}
	if (value.type !== 'provider' && value.type !== 'source') {
		return {
			ok: false,
			error: 'A tier target is a provider model, "provider", or a source and a model.',
		};
	}
	return parseRunOnTarget(value);
}

/**
 * One layer's entries as stored, with the keys that are not tiers dropped. An
 * entry is NOT checked here: {@link resolveTierTarget} reads it at launch and
 * refuses a malformed one by name. Dropping it instead would let that tier fall
 * through to the next layer, which is a silent substitution.
 */
function readTierTargets(value: unknown): TierTargets {
	if (!isPlainObject(value)) return {};
	const targets: TierTargets = {};
	for (const tier of TIER_LEVELS) {
		const entry = value[tier];
		if (entry !== undefined && entry !== null) targets[tier] = entry as TierTarget;
	}
	return targets;
}

/**
 * Read the persisted `harnessTierDefaults` setting. Every reader (the settings
 * store, the main process, the CLI) goes through it, so the desktop and CLI
 * Auto Run engines see the same table. Anything that is not a plain object
 * reads as empty (the built-in table), a key that is not a harness is dropped,
 * and a harness with no tier set is dropped so the record stays sparse. The
 * targets themselves are kept as stored (see {@link readTierTargets}).
 */
export function parseHarnessTierDefaults(value: unknown): HarnessTierDefaults {
	if (!isPlainObject(value)) return {};
	const defaults: HarnessTierDefaults = {};
	for (const [harness, row] of Object.entries(value)) {
		if (!isValidAgentId(harness)) continue;
		const targets = readTierTargets(row);
		if (Object.keys(targets).length > 0) defaults[harness] = targets;
	}
	return defaults;
}

/**
 * The layers a tier is resolved against, beside the harness: what a caller
 * that resolves a tier before a launch hands over. Absent means the built-in
 * table alone.
 */
export interface TierRouting {
	/** The agent's own targets (`tierTargets` on its record). */
	tierTargets?: TierTargets | null;
	/** The agent's own Run on target (`runOn` on its record), as stored. */
	runOn?: unknown;
	/** The `harnessTierDefaults` setting. */
	harnessDefaults?: HarnessTierDefaults | null;
}

/** The parts of an agent a tier is resolved against. Read as data, not trusted. */
export interface TierTargetAgent extends Pick<TierRouting, 'tierTargets' | 'runOn'> {
	/** The agent's harness, e.g. `claude-code`. */
	toolType: ToolType;
}

/**
 * Why a tier named no usable target.
 *
 *   - `tier-unmapped`: no layer names a target for this tier.
 *   - `tier-agent-runs-on-source`: only the built-in table names one, and the
 *     agent runs on a Local Models source. The table names the provider's cloud
 *     models; applying it would send the turn where the user chose not to.
 *   - `tier-invalid-target`: the layer's stored target is malformed.
 *   - `tier-unsupported-source`: the target is a source, and this harness has
 *     no Run on recipe.
 */
export type TierTargetRefusalCode =
	| 'tier-unmapped'
	| 'tier-agent-runs-on-source'
	| 'tier-invalid-target'
	| 'tier-unsupported-source';

export interface TierTargetRefusal {
	kind: 'refused';
	code: TierTargetRefusalCode;
	message: string;
	/**
	 * `false`: the tier simply does not apply, so the turn runs on the agent's
	 * own model and target and `message` is the warning to show. `true`: a layer
	 * named a target that cannot be used, so the turn must not launch at all.
	 */
	blocksLaunch: boolean;
}

export interface ResolvedTierTarget {
	kind: 'resolved';
	target: TierTarget;
	source: TierTargetSource;
}

export type TierTargetResolution = ResolvedTierTarget | TierTargetRefusal;

/**
 * The target a tier launches on for this agent, and the layer it came from.
 *
 * Layer order, first one that sets the tier wins: the agent's own
 * `tierTargets`, the `harnessTierDefaults` setting for its harness, then the
 * built-in table ({@link resolveTierModel}). A group is not a layer: its
 * targets are stamped into the agent's own when the agent is created.
 *
 * A layer that sets the tier to something unusable REFUSES. It does not fall
 * through: the next layer's target is a different model than the one the user
 * picked. The built-in table is the one layer the user did not write, so it is
 * the one layer that does not apply to an agent whose Run on target is a
 * source.
 *
 * Only the target's shape and the harness's Run on recipe are checked here.
 * Whether the source exists, is enabled and serves the model needs the saved
 * sources and the network, which `resolveRunOnLaunch` and the main process
 * decide at launch.
 */
export function resolveTierTarget(
	agent: TierTargetAgent,
	tier: ModelTier,
	harnessDefaults?: HarnessTierDefaults | null
): TierTargetResolution {
	const { toolType } = agent;
	const layers: Array<[TierTargetSource, unknown]> = [
		['agent', readTierTargets(agent.tierTargets)[tier]],
		[
			'harness-default',
			readTierTargets(
				isPlainObject(harnessDefaults)
					? (harnessDefaults as Record<string, unknown>)[toolType]
					: undefined
			)[tier],
		],
	];

	for (const [source, stored] of layers) {
		if (stored === undefined) continue;
		const where =
			source === 'agent'
				? `This agent's "${tier}" tier target`
				: `The ${getAgentDisplayName(toolType)} harness default for the "${tier}" tier`;
		const parsed = parseTierTarget(stored);
		if (!parsed.ok) {
			return {
				kind: 'refused',
				code: 'tier-invalid-target',
				message: `${where} cannot be used: ${parsed.error} Pick a target again, or clear it.`,
				blocksLaunch: true,
			};
		}
		if (parsed.target.type === 'source') {
			const support = agentRunOnSupport(toolType);
			if (!support.supported) {
				return {
					kind: 'refused',
					code: 'tier-unsupported-source',
					message: `${where} is ${runOnTargetLabel(parsed.target, [])}, which this harness cannot run on. ${support.reason} Set the tier to a provider model, or clear it.`,
					blocksLaunch: true,
				};
			}
		}
		return { kind: 'resolved', target: parsed.target, source };
	}

	const builtIn = resolveTierModel(toolType, tier);
	if (!builtIn) {
		return {
			kind: 'refused',
			code: 'tier-unmapped',
			message: supportsTierSelection(toolType)
				? `No "${tier}" tier model is mapped for ${toolType}; using the agent's configured model.`
				: `${toolType} has no model tier mapping, so tier="${tier}" was ignored; using the agent's configured model.`,
			blocksLaunch: false,
		};
	}
	if (storedRunOnNamesSource(agent.runOn)) {
		return {
			kind: 'refused',
			code: 'tier-agent-runs-on-source',
			message: `tier="${tier}" is ${builtIn} on ${getAgentDisplayName(toolType)}'s own models (${TIER_TARGET_SOURCE_LABELS['built-in']}), and this agent runs on a Local Models source, so the tier was ignored; using the agent's Run on target. Set the tier on the agent or in the harness default to send it elsewhere.`,
			blocksLaunch: false,
		};
	}
	return {
		kind: 'resolved',
		target: { type: 'provider-model', model: builtIn },
		source: 'built-in',
	};
}

/**
 * What a resolved target does to one launch: the model it runs, and where,
 * when the target decides where. `runOn` absent means the agent's own Run on
 * target stands, which is the built-in table's case (it only applies to an
 * agent that is on its provider already). Shared by the join that launches a
 * task (`resolveTurnSettings`) and the one that splits a document where the
 * settings change (`countTasksUnderActiveHint`), so the two cannot disagree.
 */
export function tierTargetLaunch(
	resolved: ResolvedTierTarget,
	agentModel?: string
): { model: string | undefined; runOn?: RunOnTarget } {
	const { target, source } = resolved;
	if (target.type === 'source') return { model: target.model, runOn: target };
	const model = target.type === 'provider-model' ? (target.model ?? agentModel) : agentModel;
	return source === 'built-in' ? { model } : { model, runOn: { type: 'provider' } };
}

/**
 * One launch's model and place as a comparable string: two tasks with the same
 * key run under the same settings. `tier` is the tier the task asked for, or
 * `undefined` for none (the agent's own model and target). A tier that does not
 * apply reads as none, which is what its launch does; a tier that is refused
 * gets a key of its own, so its tasks are not folded into a dispatch that runs.
 */
export function tierLaunchKey(
	toolType: ToolType,
	tier: ModelTier | undefined,
	agentModel?: string,
	routing?: TierRouting
): string {
	let launch: { model: string | undefined; runOn?: RunOnTarget } = { model: agentModel };
	if (tier) {
		const resolved = resolveTierTarget(
			{ toolType, tierTargets: routing?.tierTargets, runOn: routing?.runOn },
			tier,
			routing?.harnessDefaults
		);
		if (resolved.kind === 'resolved') launch = tierTargetLaunch(resolved, agentModel);
		else if (resolved.blocksLaunch) return `refused:${tier}:${resolved.code}`;
	}
	// The place a launch runs is the tier's, else the agent's own, so a tier
	// that names the place the agent is already on does not read as a change.
	const own = parseRunOnTarget(routing?.runOn);
	const place = launch.runOn ?? (own.ok ? own.target : undefined);
	const where =
		place === undefined
			? 'invalid'
			: place.type === 'source'
				? `${place.endpointId}\u0000${place.model}\u0000${place.contextTokens ?? ''}`
				: '';
	return `${launch.model ?? ''}\u0000${where}`;
}

/**
 * The provider's effort string for a level, or `undefined` when the provider
 * has no effort knob (OpenCode) or is not mapped. Same contract as
 * {@link resolveTierModel}: `undefined` is inherit-and-say-so.
 */
export function resolveEffortLevel(toolType: ToolType, level: EffortLevel): string | undefined {
	return EFFORT_LADDERS[toolType]?.[level];
}

/** True when this provider can act on a tier hint at all. */
export function supportsTierSelection(toolType: ToolType): boolean {
	return TIER_MODELS[toolType] !== undefined;
}

/** True when this provider can act on an effort hint at all. */
export function supportsEffortSelection(toolType: ToolType): boolean {
	return EFFORT_LADDERS[toolType] !== undefined;
}

/**
 * Model and effort for a throwaway summarization turn.
 *
 * A synopsis reads a conversation that already happened and writes a few
 * sentences about it. It is the cheapest useful thing an agent does, and
 * running it on the same model that just did the engineering is pure waste -
 * on a long Auto Run that is one premium turn per task, forever, for prose
 * nobody reads twice. So every synopsis is pinned to the bottom of both
 * ladders regardless of what the agent or the task was configured with.
 *
 * Safe because a synopsis is a LEAF: it resumes the finished session, and every
 * caller discards the `agentSessionId` it returns rather than adopting it. The
 * downgrade therefore cannot follow the conversation forward into the next real
 * turn. If a future caller ever DOES adopt that id, this pin has to be revisited
 * first, or the tab silently continues on the cheap model.
 */
export function cheapTurnSettings(toolType: ToolType): {
	model: string | undefined;
	effort: string | undefined;
} {
	return {
		model: resolveTierModel(toolType, 'low'),
		effort: resolveEffortLevel(toolType, 'low'),
	};
}

/**
 * `cheapTurnSettings` for a turn that RESUMES the session it summarizes, with
 * the fallbacks already applied. This is what a synopsis spawn should pass.
 *
 * The cheap tier is a MODEL swap, and a model carries a context window with
 * it. Resuming replays the whole transcript, so downgrading a session running
 * Anthropic's 1M beta (`opus[1m]`) onto a 200k model makes the synopsis of a
 * long conversation fail with "Prompt is too long": the transcript fit the
 * session's model and cannot fit the cheap one. So the session's model is kept
 * whenever the downgrade would shrink the window. Effort still drops to the
 * bottom rung, since that costs nothing to read.
 *
 * `current` is what the summarized turn ran at. It is also what the turn
 * inherits on a provider with no tier mapping (codex, opencode), where there
 * is nothing to downgrade TO.
 */
export function cheapResumeTurnSettings(
	toolType: ToolType,
	current: { model?: string; effort?: string } = {}
): {
	model: string | undefined;
	effort: string | undefined;
} {
	const cheap = cheapTurnSettings(toolType);
	const shrinksWindow =
		(getModelContextWindowOverride(current.model) ?? FALLBACK_CONTEXT_WINDOW) >
		(getModelContextWindowOverride(cheap.model) ?? FALLBACK_CONTEXT_WINDOW);
	return {
		model: shrinksWindow ? current.model : (cheap.model ?? current.model),
		effort: cheap.effort ?? current.effort,
	};
}
