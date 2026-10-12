/**
 * Tests for per-provider tab session parking.
 *
 * The behavior these lock down: changing an agent's provider must preserve the
 * user's tabs and transcripts, and a turn already in flight keeps running under
 * the provider it was sent with - so its late events belong to that provider,
 * not to whatever the agent is configured with by the time they land.
 */

import { describe, it, expect } from 'vitest';
import {
	switchTabProvider,
	resolveTurnProvider,
	updateProviderSlot,
	codifyTurnSettings,
	captureQueuedTurnSettings,
	codifyQueuedTurnSettings,
	turnRunOnLabel,
	tabSessionLaunch,
	settleAutoTurnOnTab,
	autoTurnLaunch,
} from '../../../renderer/utils/providerTabSessions';
import { promptCacheLifetimeMs, type AutoRouteStamp } from '../../../shared/autoTurn';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { AITab, Session } from '../../../renderer/types';
import type { ToolType } from '../../../shared/types';

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...overrides,
	} as AITab;
}

function makeSession(toolType: ToolType, overrides: Partial<Session> = {}): Session {
	return { id: 'session-1', toolType, ...overrides } as Session;
}

describe('switchTabProvider', () => {
	it('parks the outgoing provider session and clears the live slot', () => {
		const tab = makeTab({
			agentSessionId: 'claude-abc',
			usageStats: { inputTokens: 5 } as any,
			customModel: 'sonnet',
			customEffort: 'high',
		});

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.usageStats).toBeUndefined();
		expect(result.customModel).toBeUndefined();
		expect(result.customEffort).toBeUndefined();
		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			usageStats: { inputTokens: 5 },
			customModel: 'sonnet',
			customEffort: 'high',
		});
	});

	it('never leaves the tab transcript behind', () => {
		const logs = [{ id: 'l1', timestamp: 1, source: 'user', text: 'keep me' }] as any;
		const tab = makeTab({ logs, name: 'My Tab', starred: true });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.logs).toBe(logs);
		expect(result.name).toBe('My Tab');
		expect(result.starred).toBe(true);
		expect(result.id).toBe('tab-1');
	});

	it('restores a previously parked session on the way back', () => {
		const tab = makeTab({
			agentSessionId: 'codex-xyz',
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = switchTabProvider(tab, 'codex', 'claude-code');

		expect(result.agentSessionId).toBe('claude-abc');
		expect(result.customModel).toBe('opus');
		expect(result.providerSessions?.['codex']?.agentSessionId).toBe('codex-xyz');
		// The live provider owns the live fields, so it holds no parked entry.
		expect(result.providerSessions?.['claude-code']).toBeUndefined();
	});

	it('survives a round trip through a third provider', () => {
		let tab = makeTab({ agentSessionId: 'claude-abc' });

		tab = switchTabProvider(tab, 'claude-code', 'codex');
		tab = switchTabProvider(tab, 'codex', 'opencode');
		tab = switchTabProvider(tab, 'opencode', 'claude-code');

		expect(tab.agentSessionId).toBe('claude-abc');
	});

	it('does not resume a session the incoming provider never had', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.awaitingSessionId).toBe(false);
	});

	it('returns the tab untouched when the provider did not change', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		expect(switchTabProvider(tab, 'claude-code', 'claude-code')).toBe(tab);
	});
});

describe('resolveTurnProvider', () => {
	it('attributes an in-flight turn to the provider it was sent with', () => {
		const tab = makeTab({ turnProvider: 'claude-code' });
		// The user switched the agent to Codex while Claude was still working.
		expect(resolveTurnProvider(tab, makeSession('codex'))).toBe('claude-code');
	});

	it('falls back to the current provider for a tab that never sent', () => {
		expect(resolveTurnProvider(makeTab(), makeSession('codex'))).toBe('codex');
	});
});

describe('updateProviderSlot', () => {
	it('writes to the live fields when the turn provider is still current', () => {
		const tab = makeTab();
		const result = updateProviderSlot(tab, makeSession('codex'), 'codex', {
			agentSessionId: 'codex-new',
		});

		expect(result.agentSessionId).toBe('codex-new');
		expect(result.providerSessions).toBeUndefined();
	});

	it('parks a late session ID from a provider the agent switched away from', () => {
		// Mid-turn switch: Claude's turn finishes and reports its session ID after
		// the agent is already on Codex. Writing it live would hand Codex a resume
		// token it has never heard of.
		const tab = makeTab({ agentSessionId: null, turnProvider: 'claude-code' });
		const session = makeSession('codex');

		const result = updateProviderSlot(tab, session, 'claude-code', {
			agentSessionId: 'claude-late',
		});

		expect(result.agentSessionId).toBeNull();
		expect(result.providerSessions?.['claude-code']?.agentSessionId).toBe('claude-late');
	});

	it('merges into an existing parked entry without dropping its other fields', () => {
		const tab = makeTab({
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = updateProviderSlot(tab, makeSession('codex'), 'claude-code', {
			usageStats: { inputTokens: 3 } as any,
		});

		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			customModel: 'opus',
			usageStats: { inputTokens: 3 },
		});
	});
});

describe('codifyTurnSettings', () => {
	it('freezes the provider, model, and effort a turn is sent with', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(codifyTurnSettings(tab, session)).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('falls back to the agent-level overrides when the tab has none', () => {
		const session = makeSession('codex', { customModel: 'gpt-5', customEffort: 'medium' });

		expect(codifyTurnSettings(makeTab(), session)).toEqual({
			turnProvider: 'codex',
			turnModel: 'gpt-5',
			turnEffort: 'medium',
		});
	});

	it('leaves model and effort undefined when the agent default applies', () => {
		// Undefined is meaningful: consumers render no pill rather than labeling
		// the turn with a model name nobody chose.
		expect(codifyTurnSettings(makeTab(), makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});
});

describe('captureQueuedTurnSettings', () => {
	it('freezes the model and effort in force when the item is queued', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(captureQueuedTurnSettings(tab, session)).toEqual({
			model: 'opus',
			effort: 'xhigh',
		});
	});

	it('captures the agent default as an explicit pair of undefined fields', () => {
		// The OBJECT is the capture flag, so it must exist even when both values
		// are the agent's own default - otherwise dispatch falls back to the live
		// values and the item inherits a model the user picked afterwards.
		const captured = captureQueuedTurnSettings(makeTab(), makeSession('codex'));

		expect(captured).toEqual({ model: undefined, effort: undefined });
	});
});

describe('codifyQueuedTurnSettings', () => {
	it('runs a queued item under what it was queued with, not the live values', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };
		// The user has since switched the tab to a big model.
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code');

		expect(codifyQueuedTurnSettings(item, tab, session)).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'haiku',
			turnEffort: 'low',
		});
	});

	it('keeps an item queued on the agent default on the default', () => {
		const item = { turnSettings: {} };
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings(item, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});

	it('falls back to the live values for items queued before capture existed', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings({}, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('always spawns on the live provider, which owns the resume token', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };

		expect(codifyQueuedTurnSettings(item, makeTab(), makeSession('codex')).turnProvider).toBe(
			'codex'
		);
	});

	it('honors an override the user set while EDITING the queued message', () => {
		// The queued item was captured on haiku/low, then the user opened the
		// edit modal and switched it to opus/xhigh. The edit rewrites
		// turnSettings, so dispatch must spawn on the edited values - not the
		// original capture, and not the tab's live selection either.
		const edited = { turnSettings: { model: 'opus', effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(edited, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('sends an edited-back-to-default message on the agent default', () => {
		// Clearing a picker in the edit modal drops the field. That must mean
		// "use the agent default", not "fall back to the tab's current model".
		const cleared = { turnSettings: { effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(cleared, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: 'xhigh',
		});
	});
});

describe('turnRunOn: where a Run on turn ran', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

	it('names nothing for an agent on its provider', () => {
		expect(turnRunOnLabel({})).toBeUndefined();
		expect(turnRunOnLabel({ runOn: { type: 'provider' } })).toBeUndefined();
		expect(codifyTurnSettings(makeTab(), makeSession('claude-code')).turnRunOn).toBeUndefined();
	});

	it('names the model and the source for an agent on a source', () => {
		expect(turnRunOnLabel({ runOn: QWEN }, [OLLAMA])).toBe('qwen3:latest · Ollama');
	});

	it('reads the saved sources when it is handed none', () => {
		const saved = useSettingsStore.getState().localModelEndpoints;
		useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
		try {
			expect(turnRunOnLabel({ runOn: QWEN })).toBe('qwen3:latest · Ollama');
		} finally {
			useSettingsStore.setState({ localModelEndpoints: saved });
		}
	});

	it('names nothing for a stored target that cannot be read: its launch is refused', () => {
		expect(
			turnRunOnLabel({ runOn: { type: 'source', endpointId: OLLAMA.id } as never }, [OLLAMA])
		).toBeUndefined();
	});

	it('stamps the label beside the model, which stays what the spawn is handed', () => {
		const session = makeSession('claude-code', { customModel: 'opus', runOn: QWEN });

		expect(codifyTurnSettings(makeTab(), session)).toMatchObject({
			turnModel: 'opus',
			turnRunOn: 'qwen3:latest',
		});
	});

	it('reads the label live for a queued item: the launch reads the target when it spawns', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };
		const session = makeSession('claude-code', { runOn: QWEN });

		expect(codifyQueuedTurnSettings(item, makeTab(), session)).toMatchObject({
			turnModel: 'haiku',
			turnRunOn: 'qwen3:latest',
		});
		expect(
			codifyQueuedTurnSettings(item, makeTab(), makeSession('claude-code')).turnRunOn
		).toBeUndefined();
	});
});

describe('a turn sent on the Auto model', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

	const route = (
		tier: 'low' | 'medium' | 'high',
		effort: 'low' | 'medium' | 'high'
	): AutoRouteStamp => ({ tier, effort, engine: 'Embedding router', calibrated: false });
	const OFF: AutoRouteStamp = { skipped: 'off', detail: 'Model routing is off.' };

	/** A tab whose provider session last answered `idleMs` ago, on `turnModel`. */
	const liveTab = (idleMs: number, overrides: Partial<AITab> = {}): AITab =>
		makeTab({
			agentSessionId: 'claude-abc',
			turnProvider: 'claude-code',
			turnModel: 'haiku',
			logs: [{ id: 'l1', timestamp: Date.now() - idleMs, source: 'stdout', text: 'done' }] as any,
			...overrides,
		});
	const AUTO = makeSession('claude-code', { customModel: 'auto', customEffort: 'high' });
	const COLD = promptCacheLifetimeMs('claude-code') + 60_000;

	describe('tabSessionLaunch: what the session a turn would resume last ran on', () => {
		it('is nothing for a tab with no provider session: the turn starts one', () => {
			expect(tabSessionLaunch(makeTab({ turnModel: 'opus' }), AUTO)).toBeUndefined();
			expect(tabSessionLaunch(undefined, AUTO)).toBeUndefined();
		});

		it('is the last turn model, the place a tier sent it, and the newest entry time', () => {
			const tab = liveTab(1000, { turnAuto: { status: 'routed', runOn: QWEN } });
			expect(tabSessionLaunch(tab, AUTO)).toEqual({
				model: 'haiku',
				runOn: QWEN,
				lastActiveAt: tab.logs[0].timestamp,
			});
		});

		it('counts a busy tab as active now', () => {
			const tab = liveTab(COLD, { state: 'busy' });
			expect(tabSessionLaunch(tab, AUTO, 5000)?.lastActiveAt).toBe(5000);
		});

		it('is nothing when the last turn ran under another provider', () => {
			expect(tabSessionLaunch(liveTab(1000, { turnProvider: 'codex' }), AUTO)).toBeUndefined();
		});

		it('has no last activity for a session with an empty transcript, which reads as cold', () => {
			const launch = tabSessionLaunch(liveTab(0, { logs: [] }), AUTO);
			expect(launch).toEqual({ model: 'haiku' });
		});
	});

	describe('codifyTurnSettings: the turn takes the tab before the router answers', () => {
		it('never freezes the word auto as the model, and marks the turn pending', () => {
			expect(codifyTurnSettings(makeTab(), AUTO)).toEqual({
				turnProvider: 'claude-code',
				turnModel: undefined,
				turnEffort: 'high',
				turnRunOn: undefined,
				turnAuto: { status: 'pending' },
			});
		});

		it('reads the tab override first, like any model choice', () => {
			const session = makeSession('claude-code', { customModel: 'opus' });
			expect(codifyTurnSettings(makeTab({ customModel: 'auto' }), session).turnAuto).toEqual({
				status: 'pending',
			});
			expect(codifyTurnSettings(makeTab({ customModel: 'opus' }), AUTO).turnAuto).toBeUndefined();
		});

		it('rule 1: holds the model of a session whose cache is warm', () => {
			expect(codifyTurnSettings(liveTab(30_000), AUTO)).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'high',
				turnAuto: { status: 'pending', hold: { model: 'haiku' } },
			});
		});

		it('rule 1: holds the place a tier sent the session, and labels it', () => {
			const saved = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			try {
				const tab = liveTab(30_000, {
					turnModel: 'qwen3:latest',
					turnAuto: { status: 'routed', runOn: QWEN },
				});
				expect(codifyTurnSettings(tab, AUTO)).toMatchObject({
					turnModel: 'qwen3:latest',
					turnRunOn: 'qwen3:latest · Ollama',
					turnAuto: {
						status: 'pending',
						hold: { model: 'qwen3:latest', runOn: QWEN },
						runOn: QWEN,
					},
				});
			} finally {
				useSettingsStore.setState({ localModelEndpoints: saved });
			}
		});

		it('rule 1: holds nothing once the session has been idle past the cache lifetime', () => {
			expect(codifyTurnSettings(liveTab(COLD), AUTO)).toMatchObject({
				turnModel: undefined,
				turnAuto: { status: 'pending' },
			});
			expect(codifyTurnSettings(liveTab(COLD), AUTO).turnAuto?.hold).toBeUndefined();
		});

		it('a turn on a named model clears the stamp the Auto turn before it left', () => {
			const tab = liveTab(1000, { turnAuto: { status: 'routed', runOn: QWEN } });
			const codified = codifyTurnSettings(tab, makeSession('claude-code', { customModel: 'opus' }));
			expect('turnAuto' in codified).toBe(true);
			expect({ ...tab, ...codified }.turnAuto).toBeUndefined();
		});

		it('with the answer in hand the stamp is final at once', () => {
			expect(codifyTurnSettings(makeTab(), AUTO, route('medium', 'low'))).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'sonnet',
				turnEffort: 'low',
				turnRunOn: undefined,
				turnAuto: { status: 'routed', route: route('medium', 'low') },
			});
		});
	});

	describe('settleAutoTurnOnTab: the router answered', () => {
		const pending = (tab: AITab): AITab => ({ ...tab, ...codifyTurnSettings(tab, AUTO) });

		it('a session start takes the tier and the effort', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, route('high', 'low'));
			expect(settled).toMatchObject({
				turnModel: 'opus',
				turnEffort: 'low',
				turnAuto: { status: 'routed', route: route('high', 'low') },
			});
			expect(settled.turnAuto?.hold).toBeUndefined();
		});

		it('rule 1: a warm session keeps its model and changes only its effort', () => {
			const settled = settleAutoTurnOnTab(pending(liveTab(30_000)), AUTO, route('high', 'low'));
			expect(settled).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'low',
				turnAuto: { status: 'routed', hold: { model: 'haiku' } },
			});
		});

		it('rule 1 is decided when the turn took the tab, not when the answer lands', () => {
			// The busy-write appends the user bubble and marks the tab busy, which
			// would make a cold session look warm to anything that looked again.
			const cold = pending(liveTab(COLD));
			const busy: AITab = {
				...cold,
				state: 'busy',
				logs: [...cold.logs, { id: 'u', timestamp: Date.now(), source: 'user', text: 'go' }] as any,
			};
			expect(settleAutoTurnOnTab(busy, AUTO, route('high', 'low')).turnModel).toBe('opus');
		});

		it('rule 2: no decision leaves the agent default, and its own effort', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, OFF);
			expect(settled).toMatchObject({
				turnModel: undefined,
				turnEffort: 'high',
				turnAuto: { status: 'router-off', route: OFF },
			});
		});

		it('launches a tier the agent maps to a source on that source', () => {
			const saved = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			try {
				const session = makeSession('claude-code', {
					customModel: 'auto',
					tierTargets: { low: QWEN },
				});
				const tab = { ...makeTab(), ...codifyTurnSettings(makeTab(), session) };
				const settled = settleAutoTurnOnTab(tab, session, route('low', 'low'));
				expect(settled).toMatchObject({
					turnModel: 'qwen3:latest',
					turnRunOn: 'qwen3:latest · Ollama',
					turnAuto: { status: 'routed', runOn: QWEN },
				});
				expect(autoTurnLaunch(settled)).toEqual({
					model: 'qwen3:latest',
					effort: 'low',
					runOn: QWEN,
					route: route('low', 'low'),
				});
			} finally {
				useSettingsStore.setState({ localModelEndpoints: saved });
			}
		});

		it('leaves a turn that is not pending alone: a late answer rewrites nothing', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, route('high', 'low'));
			expect(settleAutoTurnOnTab(settled, AUTO, route('low', 'high'))).toBe(settled);
			const named = makeTab({ turnModel: 'opus' });
			expect(settleAutoTurnOnTab(named, AUTO, route('low', 'high'))).toBe(named);
		});
	});

	describe('autoTurnLaunch: what the spawn is handed', () => {
		it('is nothing for a turn on a named model, and for one still pending', () => {
			expect(autoTurnLaunch(makeTab({ turnModel: 'opus' }))).toBeNull();
			expect(autoTurnLaunch(makeTab({ turnAuto: { status: 'pending' } }))).toBeNull();
			expect(autoTurnLaunch(undefined)).toBeNull();
		});

		it('is the frozen model and effort, with no place when Auto decided none', () => {
			const tab = makeTab({
				turnModel: 'sonnet',
				turnEffort: 'low',
				turnAuto: { status: 'routed', route: route('medium', 'low') },
			});
			expect(autoTurnLaunch(tab)).toEqual({
				model: 'sonnet',
				effort: 'low',
				route: route('medium', 'low'),
			});
		});

		it('is empty for a turn with no decision: the agent default launches', () => {
			expect(autoTurnLaunch(makeTab({ turnAuto: { status: 'no-decision' } }))).toEqual({});
		});
	});

	describe('a queued item', () => {
		it('keeps the word, and the answer when the caller has one', () => {
			expect(captureQueuedTurnSettings(makeTab(), AUTO)).toEqual({ model: 'auto', effort: 'high' });
			expect(captureQueuedTurnSettings(makeTab(), AUTO, route('low', 'low'))).toEqual({
				model: 'auto',
				effort: 'high',
				route: route('low', 'low'),
			});
		});

		it('carries no answer on a named model', () => {
			const session = makeSession('claude-code', { customModel: 'opus' });
			expect(captureQueuedTurnSettings(makeTab(), session, route('low', 'low'))).toEqual({
				model: 'opus',
				effort: undefined,
			});
		});

		it('routed when it was queued: final the moment it takes the tab, on its own effort', () => {
			const item = {
				turnSettings: { model: 'auto', effort: 'low', route: route('high', 'medium') },
			};
			// The agent has since moved to a named model. The item is still Auto.
			const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'max' });
			expect(codifyQueuedTurnSettings(item, makeTab(), session)).toEqual({
				turnProvider: 'claude-code',
				turnModel: 'opus',
				turnEffort: 'high',
				turnRunOn: undefined,
				turnAuto: { status: 'routed', route: route('high', 'medium') },
			});
		});

		it('rule 1 is read from the tab when the item drains, not when it was queued', () => {
			const item = { turnSettings: { model: 'auto', route: route('high', 'medium') } };
			expect(codifyQueuedTurnSettings(item, liveTab(30_000), AUTO)).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'high',
				turnAuto: { status: 'routed', hold: { model: 'haiku' } },
			});
			expect(codifyQueuedTurnSettings(item, liveTab(COLD), AUTO).turnModel).toBe('opus');
		});

		it('not routed yet: pending, for the dispatch to settle', () => {
			const item = { turnSettings: { model: 'auto', effort: 'low' } };
			expect(codifyQueuedTurnSettings(item, makeTab(), AUTO)).toMatchObject({
				turnModel: undefined,
				turnEffort: 'low',
				turnAuto: { status: 'pending' },
			});
		});

		it('queued on a named model stays on it when the agent is set to Auto afterwards', () => {
			const item = { turnSettings: { model: 'haiku', effort: 'low' } };
			const codified = codifyQueuedTurnSettings(item, makeTab(), AUTO);
			expect(codified).toMatchObject({ turnModel: 'haiku', turnEffort: 'low' });
			expect(codified.turnAuto).toBeUndefined();
		});

		it('from before settings were captured follows the agent, Auto included', () => {
			expect(codifyQueuedTurnSettings({}, makeTab(), AUTO).turnAuto).toEqual({ status: 'pending' });
		});
	});
});
