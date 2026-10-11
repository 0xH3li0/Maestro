/**
 * @file acappella-voice-mode.test.ts
 *
 * The three ways to talk to Maestro - Tab, Agent, Conductor - and the binding
 * rules each one imposes on a routing decision.
 */

import { describe, it, expect } from 'vitest';

import {
	SWITCHABLE_VOICE_MODES,
	applyAgentScope,
	scopeForMode,
	stepSwitchableVoiceMode,
	switchableVoiceMode,
	tabScopeDecision,
	voiceScopeMode,
	voiceScopeTabId,
	type ModeTargetContext,
} from '../../shared/acappella/voice-mode';
import type { RosterAgent } from '../../shared/acappella/protocol';
import type { RouteDecision } from '../../shared/acappella/route-decision';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'philosopher',
		name: 'Philosopher',
		agentType: 'claude-code',
		cwd: '/p',
		tabs: [
			{ id: 'p-main', name: 'Main', lastActiveAt: 1 },
			{ id: 'p-ideas', name: 'Ideas', lastActiveAt: 2 },
		],
	},
	{
		sessionId: 'backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/b',
		tabs: [{ id: 'b-auth', name: 'Auth', lastActiveAt: 3 }],
	},
];

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'philosopher' },
		tabAction: 'current',
		prompt: 'summarize the thread',
		confidence: 0.8,
		...overrides,
	};
}

describe('voiceScopeMode', () => {
	it('tells the four bindings apart', () => {
		expect(voiceScopeMode({ kind: 'conductor' })).toBe('conductor');
		expect(voiceScopeMode(null)).toBe('conductor');
		expect(voiceScopeMode({ kind: 'agent', sessionId: 'philosopher' })).toBe('agent');
		expect(voiceScopeMode({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'tab'
		);
		expect(voiceScopeMode({ kind: 'document', sessionId: 'philosopher', path: '/a.md' })).toBe(
			'document'
		);
		expect(voiceScopeTabId({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'p-main'
		);
		expect(voiceScopeTabId({ kind: 'agent', sessionId: 'philosopher' })).toBeNull();
	});
});

describe('tabScopeDecision', () => {
	it('sends the utterance verbatim to the pinned tab', () => {
		// Nothing is stripped: in Tab mode there is no routing chatter, so "In one
		// sentence, ask the backend agent" is a message for this tab, all of it.
		expect(
			tabScopeDecision('  In one sentence, ask the backend agent about auth ', {
				kind: 'agent',
				sessionId: 'philosopher',
				tabId: 'p-ideas',
			})
		).toEqual({
			target: { sessionId: 'philosopher' },
			tabAction: 'recall',
			tabId: 'p-ideas',
			prompt: 'In one sentence, ask the backend agent about auth',
			confidence: 1,
		});
	});
});

describe('applyAgentScope', () => {
	const scope = { kind: 'agent' as const, sessionId: 'philosopher' };

	it('keeps a request that names another agent with the bound agent', () => {
		// The Brain cut "Backend" out of its prompt because it thought Backend was
		// the recipient. Philosopher needs the name to act on the request.
		const bound = applyAgentScope(
			decision({ target: { sessionId: 'backend' }, prompt: 'in one word, what is two plus two?' }),
			scope,
			ROSTER,
			'Ask Backend, in one word, what is two plus two?'
		);

		expect(bound.target).toEqual({ sessionId: 'philosopher' });
		expect(bound.tabAction).toBe('current');
		expect(bound.prompt).toBe('Ask Backend, in one word, what is two plus two?');
	});

	it('keeps the Brain’s tab choice: a new tab, with its name', () => {
		const bound = applyAgentScope(
			decision({ tabAction: 'new', tabName: 'Auth Refactor' }),
			scope,
			ROSTER,
			'open a new tab about the auth refactor'
		);

		expect(bound).toMatchObject({ tabAction: 'new', tabName: 'Auth Refactor' });
	});

	it('keeps a recall of one of the agent’s own tabs', () => {
		const bound = applyAgentScope(
			decision({ tabAction: 'recall', tabId: 'p-ideas' }),
			scope,
			ROSTER,
			'back to the ideas tab'
		);

		expect(bound).toMatchObject({ tabAction: 'recall', tabId: 'p-ideas' });
	});

	it('degrades a recall of another agent’s tab to the current tab', () => {
		const bound = applyAgentScope(
			decision({ target: { sessionId: 'backend' }, tabAction: 'recall', tabId: 'b-auth' }),
			scope,
			ROSTER,
			'back to the auth tab'
		);

		expect(bound.target).toEqual({ sessionId: 'philosopher' });
		expect(bound.tabAction).toBe('current');
		expect(bound.tabId).toBeUndefined();
	});

	it('sends a would-be clarification or conversational reply to the agent instead', () => {
		const clarified = applyAgentScope(
			decision({ target: 'conductor', clarify: 'Which agent?' }),
			scope,
			ROSTER,
			'fix it'
		);
		expect(clarified.clarify).toBeUndefined();
		expect(clarified.target).toEqual({ sessionId: 'philosopher' });

		const conversed = applyAgentScope(
			decision({ target: 'conductor', reply: 'Sure, tell me more.', prompt: '' }),
			scope,
			ROSTER,
			'I am thinking about the auth design'
		);
		expect(conversed.reply).toBeUndefined();
		expect(conversed.prompt).toBe('I am thinking about the auth design');
	});
});

describe('scopeForMode', () => {
	function context(overrides: Partial<ModeTargetContext> = {}): ModeTargetContext {
		return {
			scope: { kind: 'conductor' },
			lastDispatch: null,
			focusedAgentId: null,
			activeTabOf: () => null,
			...overrides,
		};
	}

	it('switches to the Conductor without needing an agent', () => {
		expect(scopeForMode('conductor', context())).toEqual({ kind: 'conductor' });
	});

	it('binds Agent mode to the agent the last request went to, before the one on screen', () => {
		expect(
			scopeForMode(
				'agent',
				context({
					lastDispatch: { agentSessionId: 'backend', tabId: 'b-auth' },
					focusedAgentId: 'philosopher',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'backend' });
	});

	it('falls back to the agent on screen, and refuses when there is none', () => {
		expect(scopeForMode('agent', context({ focusedAgentId: 'philosopher' }))).toEqual({
			kind: 'agent',
			sessionId: 'philosopher',
		});
		expect(scopeForMode('agent', context())).toBeNull();
		expect(scopeForMode('tab', context())).toBeNull();
	});

	it('pins Tab mode to the tab the last request landed in', () => {
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher' },
					lastDispatch: { agentSessionId: 'philosopher', tabId: 'p-ideas' },
					activeTabOf: () => 'p-main',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-ideas' });
	});

	it('pins Tab mode to the agent’s active tab when nothing has been sent', () => {
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher' },
					activeTabOf: (agent) => (agent === 'philosopher' ? 'p-main' : null),
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' });
	});

	it('keeps the bound agent rather than following a dispatch to another one', () => {
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
					lastDispatch: { agentSessionId: 'backend', tabId: 'b-auth' },
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' });
	});
});

describe('stepping through the modes (the Tab key)', () => {
	it('walks them in the order the switch draws them, wrapping at both ends', () => {
		expect(SWITCHABLE_VOICE_MODES).toEqual(['tab', 'agent', 'conductor']);

		expect(stepSwitchableVoiceMode('tab')).toBe('agent');
		expect(stepSwitchableVoiceMode('agent')).toBe('conductor');
		expect(stepSwitchableVoiceMode('conductor')).toBe('tab');

		expect(stepSwitchableVoiceMode('tab', -1)).toBe('conductor');
		expect(stepSwitchableVoiceMode('conductor', -1)).toBe('agent');
	});

	it('reads a document conversation as Tab, which is where the switch shows it', () => {
		expect(switchableVoiceMode(null)).toBe('conductor');
		expect(switchableVoiceMode({ kind: 'agent', sessionId: 'philosopher' })).toBe('agent');
		expect(switchableVoiceMode({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'tab'
		);
		expect(
			switchableVoiceMode({ kind: 'document', sessionId: 'philosopher', path: '/p/notes.md' })
		).toBe('tab');
	});
});
