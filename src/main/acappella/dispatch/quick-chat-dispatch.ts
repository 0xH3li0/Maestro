/**
 * Dispatch for a voice session bound to Quick Chat.
 *
 * Every other dispatch resolves an agent and a tab in main and then drives the
 * renderer through the `remote:*` channels (see `route-executor.ts`). This one
 * does neither. Quick Chat owns its agent and its tab, so the spoken turn is
 * handed to the SAME `send` command the window's Send button and
 * `maestro-cli quick-chat send` use, and the result says where it landed.
 *
 * Three things that path gives a spoken turn for free, and that the ordinary
 * one would get wrong:
 *
 *   - The chat's tab is created by the first sentence, exactly as by the first
 *     typed message.
 *   - An ephemeral chat's tab stays hidden. `remote:focusAiTab` would put it in
 *     front in the main window.
 *   - No app window is raised. The conversation is in the Quick Chat window,
 *     which is where the user is.
 */

import type { QuickChatController } from '../../quick-chat/quick-chat-controller';
import { QUICK_CHAT_VOICE_LABEL } from '../../../shared/acappella/quick-chat-scope';
import { VoiceDispatchError } from '../voice-session-service';
import type { VoiceDispatchResult } from '../voice-session-service';

/**
 * What a voice session needs from Quick Chat: its window as the session's
 * surface, the chat as it stands, and the send. The controller satisfies it; a
 * test hands in three functions.
 */
export type QuickChatVoiceHost = Pick<
	QuickChatController,
	'showForVoice' | 'getStatus' | 'runCommand'
>;

/** What a caller is told when a Quick Chat session is asked for and there is no Quick Chat. */
export const QUICK_CHAT_VOICE_UNAVAILABLE =
	'Quick Chat is turned off. Turn it on in Settings > Plugins to talk to it.';

/**
 * Send one spoken turn through Quick Chat and report where it landed.
 *
 * A refusal from the engine (the chat is still answering, there is no agent to
 * chat with) is the sentence the window shows for a typed message, so it is the
 * sentence the voice session reports too.
 */
export async function dispatchToQuickChat(
	prompt: string,
	host: QuickChatVoiceHost | null | undefined
): Promise<VoiceDispatchResult> {
	if (!host) throw new VoiceDispatchError(QUICK_CHAT_VOICE_UNAVAILABLE);
	if (!prompt) throw new VoiceDispatchError('There was nothing to send to Quick Chat');

	// Read before the send: whether a tab already backed the chat is what tells
	// "opened the chat" apart from "carried it on".
	const tabBefore = host.getStatus().snapshot.tabId;
	const result = await host.runCommand({ type: 'send', text: prompt });
	if (!result.ok) {
		throw new VoiceDispatchError(result.error ?? 'Quick Chat did not take the message');
	}

	const { agentId, agentName, tabId } = result.snapshot;
	if (!agentId || !tabId) {
		// `ok` with no tab would leave the session waiting on a reply it has no
		// address for.
		throw new VoiceDispatchError('Quick Chat took the message but reported no tab for it');
	}

	return {
		agentSessionId: agentId,
		agentName: agentName ?? 'Agent',
		tabId,
		tabName: QUICK_CHAT_VOICE_LABEL,
		action: tabBefore === tabId ? 'recalled' : 'created',
		promptSent: true,
	};
}
