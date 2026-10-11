/**
 * The HUD's mode switch: who the next sentence is for.
 *
 *   - **Tab**: this tab, verbatim. The Conductor stays out of it.
 *   - **Agent**: this agent. The Conductor only picks which of its tabs (the
 *     current one, a new one, or one you name).
 *   - **Conductor**: Maestro picks the agent and the tab.
 *
 * Switching re-binds the live session without ending it; the new mode applies
 * from the next thing you say. The agent and tab it binds to come from what you
 * were just doing (`scopeForMode`), so switching Conductor -> Agent lands on the
 * agent your last request went to, and Agent -> Tab pins the tab it landed in.
 */

import { useCallback } from 'react';

import {
	scopeForMode,
	voiceScopeMode,
	type SwitchableVoiceMode,
} from '../../../shared/acappella/voice-mode';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import type { Theme } from '../../types';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';

const MODE_OPTIONS: ReadonlyArray<SegmentedOption<SwitchableVoiceMode>> = [
	{
		value: 'tab',
		label: 'Tab',
		title: 'Talk to one tab. Everything you say goes there, word for word.',
	},
	{
		value: 'agent',
		label: 'Agent',
		title: 'Talk to one agent. The Conductor picks the tab, or opens a new one when you ask.',
	},
	{
		value: 'conductor',
		label: 'Conductor',
		title: 'Talk to Maestro. The Conductor picks the agent and the tab.',
	},
];

export function VoiceModeSwitch({ theme }: { theme: Theme }) {
	const scope = useVoiceSessionStore((s) => s.scope);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);

	// A document conversation is a tab binding that also knows its file, so it
	// reads as Tab here; switching away from it leaves the document behind.
	const mode = voiceScopeMode(scope);
	const value: SwitchableVoiceMode = mode === 'document' ? 'tab' : mode;

	const onChange = useCallback(
		(next: SwitchableVoiceMode) => {
			if (next === value && mode !== 'document') return;
			const { activeSessionId, sessions } = useSessionStore.getState();
			const target = scopeForMode(next, {
				scope,
				lastDispatch,
				focusedAgentId: activeSessionId || null,
				activeTabOf: (agentId) =>
					sessions.find((session) => session.id === agentId)?.activeTabId ?? null,
			});
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
		[lastDispatch, mode, scope, value]
	);

	return (
		<div className="px-3 py-1.5 border-b" style={{ borderColor: theme.colors.border }}>
			<SegmentedControl
				value={value}
				onChange={onChange}
				options={MODE_OPTIONS}
				theme={theme}
				ariaLabel="Who you are talking to"
				testId="voice-hud-mode"
			/>
		</div>
	);
}
