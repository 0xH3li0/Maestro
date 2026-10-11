/**
 * useVoiceModeSwitch - re-bind the live voice session to Tab, Agent, or Conductor.
 *
 * Two controls switch the mode and they have to agree: the segmented switch in
 * the HUD, and the Tab key while the HUD is up. Both call this, so the key walks
 * the modes in the order the switch draws them and refuses the same way when
 * there is no agent to bind to.
 *
 * Switching re-binds the session without ending it; the new mode applies from
 * the next thing you say. The agent and tab it binds to come from what you were
 * just doing (`scopeForMode`), so Conductor -> Agent lands on the agent your
 * last request went to, and Agent -> Tab pins the tab it landed in. From there
 * the binding follows the user to another agent or tab: see
 * `useVoiceScopeFollow`.
 */

import { useCallback } from 'react';

import {
	scopeForMode,
	stepSwitchableVoiceMode,
	switchableVoiceMode,
	voiceScopeMode,
	type SwitchableVoiceMode,
} from '../../../shared/acappella/voice-mode';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { resolveFocusedAiTabId } from '../../utils/panelLayout';

export interface VoiceModeSwitch {
	/** The mode the switch shows. A document conversation reads as Tab. */
	mode: SwitchableVoiceMode;
	/** Re-bind to `next`. Flashes why when there is nothing to bind to. */
	switchTo: (next: SwitchableVoiceMode) => void;
	/**
	 * Step to the neighbouring mode, wrapping.
	 *
	 * A mode with nothing to bind to (Tab or Agent with no agent open) is stepped
	 * OVER rather than refused: the key is a cycle, and a cycle that stops dead on
	 * a mode it cannot enter leaves the modes past it unreachable from the
	 * keyboard.
	 */
	cycle: (direction?: 1 | -1) => void;
}

export function useVoiceModeSwitch(): VoiceModeSwitch {
	const scope = useVoiceSessionStore((s) => s.scope);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);

	const mode = switchableVoiceMode(scope);
	const isDocument = voiceScopeMode(scope) === 'document';

	const targetFor = useCallback(
		(next: SwitchableVoiceMode) => {
			const { activeSessionId, sessions } = useSessionStore.getState();
			return scopeForMode(next, {
				scope,
				lastDispatch,
				focusedAgentId: activeSessionId || null,
				// The same answer the follow rule uses (`useVoiceScopeFollow`), so
				// picking Tab mode and then moving tabs agree about "this tab".
				activeTabOf: (agentId) =>
					resolveFocusedAiTabId(sessions.find((session) => session.id === agentId)),
			});
		},
		[lastDispatch, scope]
	);

	const switchTo = useCallback(
		(next: SwitchableVoiceMode) => {
			// Leaving a document conversation for plain Tab mode is a real change even
			// though both read as Tab, so it is the one same-value switch that runs.
			if (next === mode && !isDocument) return;
			const target = targetFor(next);
			if (!target) {
				notifyCenterFlash({
					message: 'Open an agent first',
					detail: `${next === 'tab' ? 'Tab' : 'Agent'} mode needs an agent to talk to.`,
					color: 'yellow',
				});
				return;
			}
			void window.maestro.voice.setScope(target);
		},
		[isDocument, mode, targetFor]
	);

	const cycle = useCallback(
		(direction: 1 | -1 = 1) => {
			let next = stepSwitchableVoiceMode(mode, direction);
			// Conductor always binds, so this ends within one lap.
			while (next !== mode && !targetFor(next)) {
				next = stepSwitchableVoiceMode(next, direction);
			}
			if (next === mode) return;
			const target = targetFor(next);
			if (target) void window.maestro.voice.setScope(target);
		},
		[mode, targetFor]
	);

	return { mode, switchTo, cycle };
}
