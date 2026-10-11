/**
 * The three ways to talk to Maestro, and what each one lets the Conductor do.
 *
 *   - **Tab.** You are talking to one tab. Every utterance goes to that tab,
 *     verbatim, and the Conductor is not consulted: there is nothing to decide,
 *     so asking a router would only add latency and a chance to misroute.
 *   - **Agent.** You are talking to one agent. The Conductor decides only WHICH
 *     TAB - the current one, a new one ("open a new tab about the auth bug"), or
 *     one recalled by name ("back to the migration tab") - and never moves the
 *     request to a different agent, never asks which agent you meant, and never
 *     answers in place of the agent.
 *   - **Conductor.** You are talking to Maestro. The Conductor picks the agent
 *     and the tab, asks when it is unsure, and in conversational mode talks with
 *     you until there is a request.
 *
 * A fourth binding, the document conversation, is a tab binding that also knows
 * which file it is about; its rules live in `./document-scope`.
 *
 * The rules are applied AFTER the Brain has read the utterance (Agent mode) or
 * instead of it (Tab mode), in the session service, so every Brain - keyword,
 * local model, hosted model - obeys the same boundaries without each one having
 * to be told.
 */

import type { AgentVoiceScope, RosterAgent, VoiceScope } from './protocol';
import type { RouteDecision } from './route-decision';

export type VoiceMode = 'tab' | 'agent' | 'conductor' | 'document';

/**
 * The `brainProviderId` a Tab-mode `route-decision` carries. No Brain ran, and
 * the routing log measures Brains: a dispatch stamped with this is not counted
 * as (and must not overwrite the outcome of) a routed turn.
 */
export const TAB_SCOPE_ROUTER_ID = 'tab-scope';

/** Which of the modes a scope is. */
export function voiceScopeMode(scope: VoiceScope | null | undefined): VoiceMode {
	if (!scope || scope.kind === 'conductor') return 'conductor';
	if (scope.kind === 'document') return 'document';
	return scope.tabId ? 'tab' : 'agent';
}

/** The tab a Tab-mode scope is pinned to, or null for every other mode. */
export function voiceScopeTabId(scope: VoiceScope | null | undefined): string | null {
	return scope?.kind === 'agent' && scope.tabId ? scope.tabId : null;
}

/** Narrow a scope to Tab mode. */
export function isTabScope(
	scope: VoiceScope | null | undefined
): scope is AgentVoiceScope & { tabId: string } {
	return voiceScopeTabId(scope) !== null;
}

/** Narrow a scope to Agent mode (bound to an agent, no tab pinned). */
export function isAgentModeScope(scope: VoiceScope | null | undefined): scope is AgentVoiceScope {
	return voiceScopeMode(scope) === 'agent';
}

/**
 * The decision for one utterance in Tab mode.
 *
 * The utterance is the message. Nothing is stripped (there is no routing
 * chatter to remove: you are not telling a router where to send it), and the
 * tab is recalled by id rather than "current", so clicking another tab while
 * talking cannot move the conversation. Recall is also what wakes a snoozed tab
 * or reopens a closed one, which is the right thing for a conversation the user
 * explicitly pinned.
 */
export function tabScopeDecision(
	utterance: string,
	scope: AgentVoiceScope & { tabId: string }
): RouteDecision {
	return {
		target: { sessionId: scope.sessionId },
		tabAction: 'recall',
		tabId: scope.tabId,
		prompt: utterance.trim(),
		confidence: 1,
	};
}

/**
 * Hold a Brain's decision to the bound agent, in Agent mode.
 *
 * What survives from the Brain is its reading of the TAB (current, new, or a
 * recalled tab of this agent) and its cleaned prompt. What does not:
 *
 *   - A target that is another agent, or the Conductor itself. Naming another
 *     agent in Agent mode is part of the request ("compare this with what the
 *     backend agent did"), not an instruction to leave; Conductor mode is how
 *     you address the fleet.
 *   - A recalled tab that belongs to some other agent. It degrades to the
 *     current tab rather than failing the turn.
 *   - A clarifying question or a conversational reply. Both are the Conductor
 *     speaking for itself, which is exactly what Agent mode says not to do: the
 *     words go to the agent.
 *
 * @param utterance What was said, used when the Brain produced no prompt (a
 *                  conversational reply carries none).
 */
export function applyAgentScope(
	decision: RouteDecision,
	scope: AgentVoiceScope,
	roster: readonly RosterAgent[],
	utterance: string
): RouteDecision {
	const agent = roster.find((candidate) => candidate.sessionId === scope.sessionId);
	const target = { sessionId: scope.sessionId };
	// The Brain cleaned its prompt for the agent IT picked, which meant cutting
	// that agent's name out. When it picked another agent, the name is part of
	// what the bound agent has to act on, so the utterance goes over whole.
	const retargeted =
		decision.target !== 'conductor' && decision.target.sessionId !== scope.sessionId;
	const prompt = (retargeted ? '' : decision.prompt.trim()) || utterance.trim();

	const ownsTab = (tabId: string | undefined): boolean =>
		!!tabId && !!agent?.tabs.some((tab) => tab.id === tabId);

	const tabAction =
		decision.tabAction === 'recall' && !ownsTab(decision.tabId) ? 'current' : decision.tabAction;

	return {
		target,
		tabAction,
		...(tabAction === 'recall' ? { tabId: decision.tabId } : {}),
		...(tabAction === 'new' && decision.tabName ? { tabName: decision.tabName } : {}),
		prompt,
		confidence: decision.confidence,
	};
}

/** The three modes a user switches between. Document conversations are opened, not switched to. */
export type SwitchableVoiceMode = Exclude<VoiceMode, 'document'>;

/** In the order the HUD draws them, which is also the order Tab walks them. */
export const SWITCHABLE_VOICE_MODES: readonly SwitchableVoiceMode[] = ['tab', 'agent', 'conductor'];

/**
 * The mode a scope shows as in the switch.
 *
 * A document conversation is a tab binding that also knows its file, so it reads
 * as Tab; switching away from it leaves the document behind.
 */
export function switchableVoiceMode(scope: VoiceScope | null | undefined): SwitchableVoiceMode {
	const mode = voiceScopeMode(scope);
	return mode === 'document' ? 'tab' : mode;
}

/**
 * The mode one step along from `mode`, wrapping at both ends.
 *
 * One function for the Tab key and Shift+Tab, so the key walks the switch in the
 * order it is drawn rather than in an order re-derived beside it.
 */
export function stepSwitchableVoiceMode(
	mode: SwitchableVoiceMode,
	direction: 1 | -1 = 1
): SwitchableVoiceMode {
	const count = SWITCHABLE_VOICE_MODES.length;
	const index = SWITCHABLE_VOICE_MODES.indexOf(mode);
	return SWITCHABLE_VOICE_MODES[(index + direction + count) % count];
}

export interface ModeTargetContext {
	/** The live session's binding. */
	scope: VoiceScope | null;
	/** Where the last utterance actually landed, when anything has been sent. */
	lastDispatch: { agentSessionId: string; tabId: string } | null;
	/** The agent on screen, or null. */
	focusedAgentId: string | null;
	/** An agent's active AI tab, or null when unknown. */
	activeTabOf: (agentSessionId: string) => string | null;
}

/**
 * The binding for a mode, resolved from what the user is doing right now, or
 * null when there is nothing to bind to (Agent or Tab mode with no agent).
 *
 * The agent, in order: the one this session is already bound to, then the one
 * the last utterance went to (in Conductor mode, "the agent I was just talking
 * to"), then the one on screen.
 *
 * The tab, in order: the tab already pinned, then the tab the last utterance
 * landed in (what the HUD header is showing, so pinning it pins what you see
 * named), then that agent's active tab.
 */
export function scopeForMode(
	mode: SwitchableVoiceMode,
	context: ModeTargetContext
): VoiceScope | null {
	if (mode === 'conductor') return { kind: 'conductor' };

	const bound =
		context.scope && context.scope.kind !== 'conductor' ? context.scope.sessionId : null;
	const agentSessionId = bound ?? context.lastDispatch?.agentSessionId ?? context.focusedAgentId;
	if (!agentSessionId) return null;

	if (mode === 'agent') return { kind: 'agent', sessionId: agentSessionId };

	const pinned =
		context.scope?.kind === 'agent' && context.scope.sessionId === agentSessionId
			? (context.scope.tabId ?? null)
			: null;
	const dispatched =
		context.lastDispatch?.agentSessionId === agentSessionId ? context.lastDispatch.tabId : null;
	const tabId = pinned ?? dispatched ?? context.activeTabOf(agentSessionId);
	return tabId ? { kind: 'agent', sessionId: agentSessionId, tabId } : null;
}
