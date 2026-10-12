/**
 * Tests for the Auto model: the word itself (shared/autoModel) and the three
 * rules a turn sent on it is resolved by (shared/autoTurn).
 *
 *   1. The model is kept while the provider's cache is warm; effort is not.
 *   2. No decision is not a failure: the agent's default applies.
 *   3. What the router answered is frozen in a stamp, and reads one way.
 */

import { describe, it, expect } from 'vitest';

import { AUTO_MODEL, isAutoModel, ownModel } from '../../shared/autoModel';
import {
	DEFAULT_PROMPT_CACHE_LIFETIME_MS,
	autoModelHold,
	autoRouteStamp,
	autoTurnLabel,
	autoTurnNeedsRoute,
	isAutoRouteDecision,
	pendingAutoTurnStamp,
	promptCacheLifetimeMs,
	resolveAutoTurn,
	unreachableAutoRoute,
	type AutoRouteStamp,
} from '../../shared/autoTurn';
import type { ModelHint } from '../../shared/autorunModelHints';
import type { RunOnTarget } from '../../shared/local-models/run-on';
import type { TierTarget } from '../../shared/modelTiers';

const NOW = 1_800_000_000_000;
const LOCAL: RunOnTarget = { type: 'source', endpointId: 'ep-maestro', model: 'qwen3.5-4b' };

const routed = (
	tier: 'low' | 'medium' | 'high',
	effort: 'low' | 'medium' | 'high'
): AutoRouteStamp => ({ tier, effort, engine: 'Embedding router (Gemma)', calibrated: false });

const OFF: AutoRouteStamp = { skipped: 'off', detail: 'Model routing is off.' };
const TIMEOUT: AutoRouteStamp = {
	skipped: 'timeout',
	detail: 'No decision within 400 ms.',
	engine: 'Local judge (Qwen)',
};

describe('the Auto model word', () => {
	it('is recognized whatever its case and spacing, and nothing else is', () => {
		expect(isAutoModel(AUTO_MODEL)).toBe(true);
		expect(isAutoModel(' Auto ')).toBe(true);
		expect(isAutoModel('AUTO')).toBe(true);
		expect(isAutoModel('automatic')).toBe(false);
		expect(isAutoModel('opus')).toBe(false);
		expect(isAutoModel('')).toBe(false);
		expect(isAutoModel(undefined)).toBe(false);
		expect(isAutoModel(null)).toBe(false);
	});

	it('is never the model an agent names for itself', () => {
		expect(ownModel('auto')).toBeUndefined();
		expect(ownModel('opus')).toBe('opus');
		expect(ownModel(undefined)).toBeUndefined();
		expect(ownModel('')).toBeUndefined();
	});
});

describe('rule 1: the model a live session keeps', () => {
	it('gives a provider with no row the default lifetime, which no row is under', () => {
		expect(promptCacheLifetimeMs('opencode')).toBe(DEFAULT_PROMPT_CACHE_LIFETIME_MS);
		expect(promptCacheLifetimeMs('claude-code')).toBeGreaterThanOrEqual(
			DEFAULT_PROMPT_CACHE_LIFETIME_MS
		);
		expect(DEFAULT_PROMPT_CACHE_LIFETIME_MS).toBe(5 * 60 * 1000);
	});

	it('holds nothing at a session start', () => {
		expect(autoModelHold('claude-code', undefined, NOW)).toBeUndefined();
	});

	it('keeps the model and the place of a session active inside the cache lifetime', () => {
		const lastActiveAt = NOW - promptCacheLifetimeMs('claude-code');
		expect(
			autoModelHold('claude-code', { model: 'haiku', runOn: LOCAL, lastActiveAt }, NOW)
		).toEqual({ model: 'haiku', runOn: LOCAL });
	});

	it('keeps the agent default too: a hold with no model is still a hold', () => {
		expect(autoModelHold('claude-code', { lastActiveAt: NOW - 1000 }, NOW)).toEqual({});
	});

	it('lets go of a session idle past the cache lifetime', () => {
		const lastActiveAt = NOW - promptCacheLifetimeMs('claude-code') - 1;
		expect(autoModelHold('claude-code', { model: 'haiku', lastActiveAt }, NOW)).toBeUndefined();
	});

	it('reads a session nobody timed as cold', () => {
		expect(autoModelHold('claude-code', { model: 'haiku' }, NOW)).toBeUndefined();
	});

	it('never holds the word auto as a model', () => {
		expect(autoModelHold('claude-code', { model: 'auto', lastActiveAt: NOW }, NOW)).toEqual({});
	});
});

describe('resolveAutoTurn', () => {
	it('launches a free turn on the tier the router chose, at its effort', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('medium', 'low'),
			agentEffort: 'high',
		});

		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('low');
		expect(turn.runOn).toBeUndefined();
		expect(turn.tierSource).toBe('built-in');
		expect(turn.stamp).toEqual({ status: 'routed', route: routed('medium', 'low') });
		expect(turn.notes[0]).toBe('Auto: Embedding router (Gemma) chose tier medium, effort low.');
		expect(turn.notes.join(' ')).toContain('tier="medium" (auto) -> model sonnet');
	});

	it("maps the router's effort to the provider's own ladder", () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: routed('high', 'high') });
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('max');
	});

	it('rule 1: a held session keeps its model and takes only the effort', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			hold: { model: 'haiku' },
			agentEffort: 'high',
		});

		expect(turn.model).toBe('haiku');
		expect(turn.effort).toBe('low');
		expect(turn.tierSource).toBeUndefined();
		expect(turn.stamp).toEqual({
			status: 'routed',
			hold: { model: 'haiku' },
			route: routed('high', 'low'),
		});
		expect(turn.notes[0]).toContain("The session keeps haiku while the provider's cache is warm.");
	});

	it('rule 1: a held session stays on the place a tier sent it', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'medium'),
			hold: { model: 'qwen3.5-4b', runOn: LOCAL },
		});

		expect(turn.model).toBe('qwen3.5-4b');
		expect(turn.runOn).toEqual(LOCAL);
		expect(turn.stamp.runOn).toEqual(LOCAL);
	});

	it('rule 1: a hold on the agent default passes no model at all', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'high'),
			hold: {},
		});
		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('max');
		expect(turn.stamp.hold).toEqual({});
	});

	it("rule 2: with the router off the agent's default model and effort apply", () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: OFF, agentEffort: 'high' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('high');
		expect(turn.refusal).toBeUndefined();
		expect(turn.stamp).toEqual({ status: 'router-off', route: OFF });
		expect(turn.notes).toEqual([
			"Auto (router off): Model routing is off. The agent's default model and effort apply.",
		]);
	});

	it('rule 2: a router that did not answer is no decision, never a failure', () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: TIMEOUT, agentEffort: 'low' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('low');
		expect(turn.stamp.status).toBe('no-decision');
		expect(turn.notes[0]).toMatch(/^Auto \(no decision\): No decision within 400 ms\./);
	});

	it('rule 2: a turn nobody routed is no decision as well', () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code' });
		expect(turn.stamp).toEqual({ status: 'no-decision' });
		expect(turn.model).toBeUndefined();
		expect(turn.notes[0]).toMatch(/^Auto: no router was asked\./);
	});

	it('rules 1 and 2 together: no decision still keeps a warm session on its model', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: TIMEOUT,
			hold: { model: 'sonnet' },
			agentEffort: 'medium',
		});
		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('medium');
		expect(turn.stamp).toEqual({
			status: 'no-decision',
			hold: { model: 'sonnet' },
			route: TIMEOUT,
		});
	});

	it('launches a tier the agent maps to a source on that source', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});

		expect(turn.model).toBe('qwen3.5-4b');
		expect(turn.runOn).toEqual(LOCAL);
		expect(turn.tierSource).toBe('agent');
		expect(turn.stamp.runOn).toEqual(LOCAL);
	});

	it('refuses a tier whose target cannot be used, and names it', () => {
		const turn = resolveAutoTurn({
			toolType: 'factory-droid',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});

		expect(turn.refusal?.code).toBe('tier-unsupported-source');
		expect(turn.stamp.refusal).toBe(turn.refusal?.message);
		expect(turn.stamp.refusal).toMatch(/This agent's "low" tier target/);
	});

	it('applies only the effort on a provider with no tier mapping, and says so', () => {
		const turn = resolveAutoTurn({ toolType: 'copilot-cli', route: routed('high', 'high') });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('xhigh');
		expect(turn.refusal).toBeUndefined();
		expect(turn.warnings.join(' ')).toMatch(/no model tier mapping/);
	});

	it('applies nothing on a provider with neither axis, without failing', () => {
		const turn = resolveAutoTurn({
			toolType: 'opencode',
			route: routed('low', 'low'),
			agentEffort: undefined,
		});
		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBeUndefined();
		expect(turn.refusal).toBeUndefined();
		expect(turn.warnings).toHaveLength(2);
	});
});

describe('a marker outranks the router on the axes it sets', () => {
	const marker = (hint: Partial<ModelHint>): ModelHint => ({ line: 3, ...hint });

	it('asks the router only while an axis is left to it', () => {
		expect(autoTurnNeedsRoute(null)).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ effort: 'low' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high', effort: 'default' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high', effort: 'low' }))).toBe(false);
	});

	it("keeps the marker's tier and takes the router's effort", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ tier: 'high', scopes: { tier: 'task' } }),
		});
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('low');
		expect(turn.notes.join(' ')).toContain('tier="high" (task) -> model opus');
		expect(turn.notes.join(' ')).toContain('effort="low" (auto) -> low');
	});

	it("keeps the marker's effort and takes the router's tier", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ effort: 'high', scopes: { effort: 'subscription' } }),
		});
		expect(turn.model).toBe('haiku');
		expect(turn.effort).toBe('max');
	});

	it('reads default as an axis left to the agent, which on Auto is the router', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('medium', 'medium'),
			marker: marker({ tier: 'default', effort: 'default' }),
		});
		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('high');
	});

	it('needs no route and writes no Auto line when the marker sets both axes', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			marker: marker({ tier: 'high', effort: 'low', scopes: { tier: 'task', effort: 'task' } }),
		});
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('low');
		expect(turn.notes.some((note) => note.startsWith('Auto'))).toBe(false);
	});

	it("still reports a marker's misspelled value", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ invalid: [{ attribute: 'tier', value: 'hgih' }] }),
		});
		expect(turn.model).toBe('haiku');
		expect(turn.warnings.join(' ')).toContain('Ignored tier="hgih" on line 4');
	});
});

describe('rule 3: what is frozen', () => {
	it('stamps a decision with the two levels and who chose them', () => {
		const stamp = autoRouteStamp({
			tier: 'medium',
			effort: 'low',
			tierConfidence: 0.7,
			engine: { id: 'jev-cloud', label: 'Jev (TypeSafe cloud)', calibrated: true },
			latencyMs: 212,
		});
		expect(stamp).toEqual({
			tier: 'medium',
			effort: 'low',
			engine: 'Jev (TypeSafe cloud)',
			calibrated: true,
		});
		expect(isAutoRouteDecision(stamp)).toBe(true);
	});

	it('stamps a skip with its reason, and the router when one was asked', () => {
		expect(
			autoRouteStamp({ skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 })
		).toEqual({ skipped: 'off', detail: 'Model routing is off.' });
		expect(
			autoRouteStamp({
				skipped: 'timeout',
				detail: 'slow',
				engine: { id: 'local-judge', label: 'Local judge (Qwen)', calibrated: false },
				latencyMs: 400,
			})
		).toEqual({ skipped: 'timeout', detail: 'slow', engine: 'Local judge (Qwen)' });
		expect(isAutoRouteDecision(OFF)).toBe(false);
		expect(isAutoRouteDecision(undefined)).toBe(false);
	});

	it('stamps a router that could not be reached as no decision', () => {
		const stamp = unreachableAutoRoute('The desktop app is closed.');
		expect(stamp).toEqual({ skipped: 'unavailable', detail: 'The desktop app is closed.' });
		expect(resolveAutoTurn({ toolType: 'claude-code', route: stamp }).stamp.status).toBe(
			'no-decision'
		);
	});

	it('marks a turn the router has not answered as pending, with what it holds', () => {
		expect(pendingAutoTurnStamp(undefined)).toEqual({ status: 'pending' });
		expect(pendingAutoTurnStamp({ model: 'haiku', runOn: LOCAL })).toEqual({
			status: 'pending',
			hold: { model: 'haiku', runOn: LOCAL },
			runOn: LOCAL,
		});
	});

	it('reads as the pill does', () => {
		const free = resolveAutoTurn({ toolType: 'claude-code', route: routed('medium', 'low') });
		expect(autoTurnLabel(free.stamp, free.model)).toBe('Auto → medium · sonnet');

		const local = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});
		expect(autoTurnLabel(local.stamp, 'qwen3.5-4b · Maestro')).toBe(
			'Auto → low · qwen3.5-4b · Maestro'
		);

		const kept = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			hold: { model: 'haiku' },
		});
		expect(autoTurnLabel(kept.stamp, kept.model)).toBe('Auto → haiku (kept)');

		expect(autoTurnLabel(resolveAutoTurn({ toolType: 'claude-code', route: OFF }).stamp)).toBe(
			'Auto (router off)'
		);
		expect(autoTurnLabel(resolveAutoTurn({ toolType: 'claude-code', route: TIMEOUT }).stamp)).toBe(
			'Auto (no decision)'
		);
		expect(autoTurnLabel(pendingAutoTurnStamp(undefined))).toBe('Auto');
	});
});
