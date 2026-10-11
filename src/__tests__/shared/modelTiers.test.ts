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
	resolveEffortLevel,
	staleCodexTierModels,
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
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

describe('stale codex tier slugs', () => {
	// The shape of ~/.codex/models_cache.json `models` on Codex CLI 0.162.1.
	const current = [
		{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 },
		{ slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
		{ slug: 'gpt-6-sol', visibility: 'list', priority: 3 },
		{ slug: 'gpt-6-luna', visibility: 'list', priority: 4 },
		{ slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
		{ slug: 'gpt-5.6-luna', visibility: 'list', priority: 9 },
	];

	it('reports nothing when every tier slug is listed', () => {
		expect(staleCodexTierModels(current)).toEqual([]);
	});

	it('names the newest listed member of the family as the replacement', () => {
		const nextGeneration = [
			{ slug: 'gpt-7-luna', visibility: 'list', priority: 3 },
			{ slug: 'gpt-7-sol', visibility: 'list', priority: 1 },
			{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 2 },
			{ slug: 'gpt-6-luna', visibility: 'hide', priority: 9 },
		];
		expect(staleCodexTierModels(nextGeneration)).toEqual([
			{ tier: 'low', slug: 'gpt-6-luna', replacement: 'gpt-7-luna' },
			{ tier: 'high', slug: 'gpt-6-astra', replacement: null },
		]);
	});

	it('treats a hidden model as not listed', () => {
		const hidden = current.map((m) =>
			m.slug === 'gpt-6-astra' ? { ...m, visibility: 'hide' } : m
		);
		expect(staleCodexTierModels(hidden)).toEqual([
			{ tier: 'high', slug: 'gpt-6-astra', replacement: null },
		]);
	});
});
