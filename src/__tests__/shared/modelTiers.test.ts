/**
 * The tier/effort vocabulary is a contract between Auto Run documents and every
 * provider. A playbook written against `tier="high"` must keep meaning the same
 * thing, so these tests pin the mapping rather than merely exercising it.
 */

import { describe, it, expect } from 'vitest';
import {
	TIER_LEVELS,
	asTierLevel,
	cheapResumeTurnSettings,
	cheapTurnSettings,
	CODEX_TIER_FAMILIES,
	parseHarnessTierDefaults,
	parseTierTarget,
	resolveEffortLevel,
	resolveTierTarget,
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
	tierLaunchKey,
	tierTargetLaunch,
	type TierTarget,
} from '../../shared/modelTiers';

describe('tier vocabulary', () => {
	it('is exactly low, medium, high', () => {
		expect(TIER_LEVELS).toEqual(['low', 'medium', 'high']);
	});

	it('narrows only real levels', () => {
		expect(asTierLevel('high')).toBe('high');
		expect(asTierLevel('max')).toBeUndefined();
		expect(asTierLevel('')).toBeUndefined();
		expect(asTierLevel(undefined)).toBeUndefined();
		expect(asTierLevel(2)).toBeUndefined();
	});
});

describe('effort ladders', () => {
	it('maps Maestro levels to ladder POSITIONS, not to same-named strings', () => {
		// Claude's ladder is low, medium, high, xhigh, max. "high" means the
		// ceiling of that ladder, so it resolves to `max`, and "medium" means the
		// middle rung, which is Claude's `high`. Identity mapping here would mean
		// a document asking for the most effort silently got the middle.
		expect(resolveEffortLevel('claude-code', 'low')).toBe('low');
		expect(resolveEffortLevel('claude-code', 'medium')).toBe('high');
		expect(resolveEffortLevel('claude-code', 'high')).toBe('max');
	});

	it("follows codex's current five-rung ladder, never the retired minimal", () => {
		// Codex 0.162.1 models list low, medium, high, xhigh, max. gpt-6.1-sol
		// answers `minimal` with a 400, which failed every cheap Codex turn.
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
		expect(resolveEffortLevel('codex', 'medium')).toBe('high');
		expect(resolveEffortLevel('codex', 'high')).toBe('max');
		for (const level of ['low', 'medium', 'high'] as const) {
			expect(resolveEffortLevel('codex', level)).not.toBe('minimal');
		}
	});

	it('is the identity only where the provider ladder is exactly three rungs', () => {
		expect(resolveEffortLevel('factory-droid', 'low')).toBe('low');
		expect(resolveEffortLevel('factory-droid', 'medium')).toBe('medium');
		expect(resolveEffortLevel('factory-droid', 'high')).toBe('high');
	});

	it('reports no effort for a provider that has no effort knob', () => {
		// OpenCode exposes no effort/reasoning option at all, so an effort hint has
		// nothing to write. Undefined (inherit + warn), never a guessed value.
		expect(resolveEffortLevel('opencode', 'high')).toBeUndefined();
		expect(supportsEffortSelection('opencode')).toBe(false);
		expect(supportsEffortSelection('claude-code')).toBe(true);
	});
});

describe('model tiers', () => {
	it('uses Claude permanent aliases so a playbook does not rot', () => {
		expect(resolveTierModel('claude-code', 'low')).toBe('haiku');
		expect(resolveTierModel('claude-code', 'medium')).toBe('sonnet');
		expect(resolveTierModel('claude-code', 'high')).toBe('opus');
	});

	it('maps codex by family: luna, sol, astra', () => {
		expect(resolveTierModel('codex', 'low')).toBe('gpt-6-luna');
		expect(resolveTierModel('codex', 'medium')).toBe('gpt-6.1-sol');
		expect(resolveTierModel('codex', 'high')).toBe('gpt-6-astra');
		for (const tier of ['low', 'medium', 'high'] as const) {
			expect(resolveTierModel('codex', tier)?.endsWith(`-${CODEX_TIER_FAMILIES[tier]}`)).toBe(true);
		}
		expect(supportsTierSelection('codex')).toBe(true);
	});

	it('leaves discovery-driven providers without stable families unmapped', () => {
		// Copilot IDs churn per release and OpenCode runs whatever the user
		// configured. A shipped guess would rot into naming a model they cannot
		// run, so these resolve to the agent default and the caller warns.
		expect(resolveTierModel('copilot-cli', 'high')).toBeUndefined();
		expect(resolveTierModel('opencode', 'high')).toBeUndefined();
		expect(supportsTierSelection('opencode')).toBe(false);
		expect(supportsTierSelection('claude-code')).toBe(true);
	});
});

describe('cheap synopsis turn', () => {
	it('pins to the bottom of both ladders', () => {
		expect(cheapTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
		expect(cheapTurnSettings('codex')).toEqual({ model: 'gpt-6-luna', effort: 'low' });
	});

	it('yields all-undefined for a provider with neither axis mapped', () => {
		// Callers fall back to the agent's own config, so a synopsis still runs.
		expect(cheapTurnSettings('opencode')).toEqual({ model: undefined, effort: undefined });
	});
});

describe('cheap synopsis turn resumed on its session', () => {
	it('drops to the bottom of both ladders when the window does not shrink', () => {
		expect(cheapResumeTurnSettings('claude-code', { model: 'opus', effort: 'max' })).toEqual({
			model: 'haiku',
			effort: 'low',
		});
	});

	it('keeps the session model when the cheap one has a smaller context window', () => {
		// Resuming replays the transcript: what fit a 1M window cannot fit 200k.
		// Effort still drops, since that costs nothing to read.
		expect(cheapResumeTurnSettings('claude-code', { model: 'opus[1m]', effort: 'max' })).toEqual({
			model: 'opus[1m]',
			effort: 'low',
		});
	});

	it('drops a codex session to the luna tier (a resume across models keeps the context)', () => {
		expect(cheapResumeTurnSettings('codex', { model: 'gpt-6.1-sol', effort: 'high' })).toEqual({
			model: 'gpt-6-luna',
			effort: 'low',
		});
	});

	it('inherits the session values on a provider with no cheap tier', () => {
		expect(cheapResumeTurnSettings('opencode', { model: 'm', effort: 'e' })).toEqual({
			model: 'm',
			effort: 'e',
		});
	});

	it('works with nothing configured on the session', () => {
		expect(cheapResumeTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
		expect(cheapResumeTurnSettings('opencode')).toEqual({ model: undefined, effort: undefined });
	});
});

const LOCAL: TierTarget = { type: 'source', endpointId: 'maestro-server', model: 'qwen3.5-4b' };
const OLLAMA: TierTarget = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

describe('a stored tier target', () => {
	it('reads a provider model, trimmed', () => {
		expect(parseTierTarget({ type: 'provider-model', model: ' opus ' })).toEqual({
			ok: true,
			target: { type: 'provider-model', model: 'opus' },
		});
	});

	it('reads a provider model with no model as the provider on the agent model', () => {
		expect(parseTierTarget({ type: 'provider-model' })).toEqual({
			ok: true,
			target: { type: 'provider-model' },
		});
		expect(parseTierTarget({ type: 'provider-model', model: '  ' })).toEqual({
			ok: true,
			target: { type: 'provider-model' },
		});
	});

	it('reads a Run on target through the Run on parser, dropping unknown keys', () => {
		expect(parseTierTarget({ type: 'provider', extra: 1 })).toEqual({
			ok: true,
			target: { type: 'provider' },
		});
		expect(parseTierTarget({ ...LOCAL, contextTokens: 65_536, extra: 1 })).toEqual({
			ok: true,
			target: { ...LOCAL, contextTokens: 65_536 },
		});
	});

	it('refuses what a launch could not use', () => {
		expect(parseTierTarget(undefined).ok).toBe(false);
		expect(parseTierTarget('opus').ok).toBe(false);
		expect(parseTierTarget({ type: 'cloud' }).ok).toBe(false);
		expect(parseTierTarget({ type: 'provider-model', model: 7 }).ok).toBe(false);
		expect(parseTierTarget({ type: 'source', endpointId: 'maestro-server' }).ok).toBe(false);
		// A context a harness cannot hold its own first prompt in.
		expect(parseTierTarget({ ...LOCAL, contextTokens: 1024 }).ok).toBe(false);
	});
});

describe('the harnessTierDefaults setting', () => {
	it('reads anything that is not a plain object as the built-in table', () => {
		expect(parseHarnessTierDefaults(undefined)).toEqual({});
		expect(parseHarnessTierDefaults('nope')).toEqual({});
		expect(parseHarnessTierDefaults([LOCAL])).toEqual({});
	});

	it('keeps known harnesses and tiers, and stays sparse', () => {
		expect(
			parseHarnessTierDefaults({
				'claude-code': { low: LOCAL, ultra: LOCAL, medium: null },
				opencode: { high: { type: 'provider-model', model: 'anthropic/claude-opus' } },
				'not-a-harness': { low: LOCAL },
				codex: {},
				'copilot-cli': 'gpt-5',
			})
		).toEqual({
			'claude-code': { low: LOCAL },
			opencode: { high: { type: 'provider-model', model: 'anthropic/claude-opus' } },
		});
	});

	it('keeps a malformed target, so the launch refuses it instead of using the next layer', () => {
		const stored = { 'claude-code': { low: { type: 'source' } } };
		expect(parseHarnessTierDefaults(stored)).toEqual(stored);
	});
});

describe('resolveTierTarget', () => {
	it('uses the built-in table when no layer sets the tier', () => {
		expect(resolveTierTarget({ toolType: 'claude-code' }, 'high')).toEqual({
			kind: 'resolved',
			target: { type: 'provider-model', model: 'opus' },
			source: 'built-in',
		});
	});

	it('lets the harness default win over the built-in table', () => {
		expect(
			resolveTierTarget({ toolType: 'claude-code' }, 'low', { 'claude-code': { low: LOCAL } })
		).toEqual({ kind: 'resolved', target: LOCAL, source: 'harness-default' });
	});

	it('lets the agent win over the harness default, one tier at a time', () => {
		const agent = {
			toolType: 'claude-code' as const,
			tierTargets: { low: OLLAMA },
		};
		const defaults = { 'claude-code': { low: LOCAL, medium: LOCAL } };
		expect(resolveTierTarget(agent, 'low', defaults)).toEqual({
			kind: 'resolved',
			target: OLLAMA,
			source: 'agent',
		});
		// A tier the agent leaves on "Harness default" falls through.
		expect(resolveTierTarget(agent, 'medium', defaults)).toMatchObject({
			target: LOCAL,
			source: 'harness-default',
		});
		// And one neither sets reaches the built-in table.
		expect(resolveTierTarget(agent, 'high', defaults)).toMatchObject({
			target: { type: 'provider-model', model: 'opus' },
			source: 'built-in',
		});
	});

	it("reads only the agent's own harness row", () => {
		expect(
			resolveTierTarget({ toolType: 'claude-code' }, 'low', { codex: { low: LOCAL } })
		).toMatchObject({ source: 'built-in', target: { type: 'provider-model', model: 'haiku' } });
	});

	it('gives a harness with no built-in table a tier through its harness default', () => {
		const target = { type: 'provider-model' as const, model: 'ollama/qwen3:8b' };
		expect(
			resolveTierTarget({ toolType: 'opencode' }, 'low', { opencode: { low: target } })
		).toEqual({ kind: 'resolved', target, source: 'harness-default' });
	});

	it('reports a tier no layer maps, without blocking the launch', () => {
		// The two existing wordings: no table at all, and a table missing the tier.
		expect(resolveTierTarget({ toolType: 'opencode' }, 'high')).toEqual({
			kind: 'refused',
			code: 'tier-unmapped',
			message:
				'opencode has no model tier mapping, so tier="high" was ignored; using the agent\'s configured model.',
			blocksLaunch: false,
		});
	});

	it('refuses a malformed target and names its layer, never falling through', () => {
		const fromAgent = resolveTierTarget(
			{ toolType: 'claude-code', tierTargets: { low: { type: 'source' } as TierTarget } },
			'low',
			{ 'claude-code': { low: LOCAL } }
		);
		expect(fromAgent).toMatchObject({
			kind: 'refused',
			code: 'tier-invalid-target',
			blocksLaunch: true,
		});
		expect(fromAgent.kind === 'refused' && fromAgent.message).toContain(
			'This agent\'s "low" tier target'
		);

		const fromDefault = resolveTierTarget({ toolType: 'claude-code' }, 'low', {
			'claude-code': { low: { type: 'provider-model', model: 7 } as unknown as TierTarget },
		});
		expect(fromDefault).toMatchObject({ code: 'tier-invalid-target', blocksLaunch: true });
		expect(fromDefault.kind === 'refused' && fromDefault.message).toContain(
			'The Claude Code harness default for the "low" tier'
		);
	});

	it('refuses a source on a harness with no Run on recipe', () => {
		const resolved = resolveTierTarget(
			{ toolType: 'factory-droid', tierTargets: { low: LOCAL } },
			'low'
		);
		expect(resolved).toMatchObject({
			kind: 'refused',
			code: 'tier-unsupported-source',
			blocksLaunch: true,
		});
		// A provider model on the same harness is fine.
		expect(
			resolveTierTarget(
				{ toolType: 'factory-droid', tierTargets: { low: { type: 'provider-model', model: 'x' } } },
				'low'
			).kind
		).toBe('resolved');
	});

	it('does not apply the built-in table to an agent that runs on a source', () => {
		// The table names the provider's cloud models. The user took this agent
		// off the provider, so only a layer the user wrote may send it back.
		const agent = { toolType: 'claude-code' as const, runOn: LOCAL };
		expect(resolveTierTarget(agent, 'high')).toMatchObject({
			kind: 'refused',
			code: 'tier-agent-runs-on-source',
			blocksLaunch: false,
		});
		expect(
			resolveTierTarget(agent, 'high', {
				'claude-code': { high: { type: 'provider-model', model: 'opus' } },
			})
		).toMatchObject({ kind: 'resolved', source: 'harness-default' });
		// A stored Run on target that is malformed counts: its launch is refused,
		// and it never runs on the provider.
		expect(
			resolveTierTarget({ toolType: 'claude-code', runOn: { type: 'source' } }, 'high')
		).toMatchObject({ code: 'tier-agent-runs-on-source' });
	});
});

describe('what a resolved tier does to a launch', () => {
	it('launches a built-in model on the place the agent already runs', () => {
		expect(
			tierTargetLaunch(
				{ kind: 'resolved', target: { type: 'provider-model', model: 'opus' }, source: 'built-in' },
				'sonnet'
			)
		).toEqual({ model: 'opus' });
	});

	it('names the provider when a layer the user wrote picks a provider model', () => {
		expect(
			tierTargetLaunch(
				{ kind: 'resolved', target: { type: 'provider-model', model: 'opus' }, source: 'agent' },
				'sonnet'
			)
		).toEqual({ model: 'opus', runOn: { type: 'provider' } });
	});

	it("keeps the agent's model for a target that names only the provider", () => {
		for (const target of [{ type: 'provider-model' }, { type: 'provider' }] as TierTarget[]) {
			expect(
				tierTargetLaunch({ kind: 'resolved', target, source: 'harness-default' }, 'sonnet')
			).toEqual({ model: 'sonnet', runOn: { type: 'provider' } });
		}
	});

	it("launches a source on the source's model", () => {
		expect(
			tierTargetLaunch({ kind: 'resolved', target: LOCAL, source: 'agent' }, 'sonnet')
		).toEqual({ model: 'qwen3.5-4b', runOn: LOCAL });
	});
});

describe('tierLaunchKey', () => {
	it('is the same for a tier that resolves to what the agent already runs', () => {
		const routing = {
			tierTargets: { medium: { type: 'provider-model' as const, model: 'sonnet' } },
		};
		expect(tierLaunchKey('claude-code', 'medium', 'sonnet', routing)).toBe(
			tierLaunchKey('claude-code', undefined, 'sonnet', routing)
		);
	});

	it('differs when two tiers share a model name on different sources', () => {
		const routing = {
			tierTargets: { low: LOCAL, medium: { ...LOCAL, endpointId: 'ep-other' } },
		};
		expect(tierLaunchKey('claude-code', 'low', 'sonnet', routing)).not.toBe(
			tierLaunchKey('claude-code', 'medium', 'sonnet', routing)
		);
	});

	it('reads a tier that does not apply as no tier, and a refused one as its own', () => {
		expect(tierLaunchKey('opencode', 'high', 'm')).toBe(tierLaunchKey('opencode', undefined, 'm'));
		const refused = { tierTargets: { low: { type: 'source' } as TierTarget } };
		expect(tierLaunchKey('claude-code', 'low', 'sonnet', refused)).not.toBe(
			tierLaunchKey('claude-code', undefined, 'sonnet', refused)
		);
	});
});
