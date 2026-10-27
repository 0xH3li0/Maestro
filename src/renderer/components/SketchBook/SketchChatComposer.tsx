/**
 * The Sketch tab's chat composer, at the foot of the chat pane. Enter sends,
 * Shift+Enter breaks the line. The send itself is the caller's
 * (`sendSketchConductorChat()`): a message that starts with `@bot` asks the
 * agent, anything else goes to the room. On a sketch with no room every
 * message asks the agent, and the hint says so.
 *
 * Laid out like the document chat's composer: the draft on its own row, then
 * a footer with the routing hint and Send, so neither can overlap the text in
 * a wide face (a monospace interface font, a narrow pane). The placeholder is
 * kept short for the same reason; the routing rule lives in the hint.
 *
 * The draft stays when a send fails, with the reason under it.
 */

import React from 'react';
import type { Theme } from '../../types';
import { CHAT_MAX_CHARS, payloadCharCount } from '../../../shared/sketch/payloads';
import { ChatComposerSurface, ChatSendButton } from '../ui/ChatSurface';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** Tallest the draft grows before it scrolls. */
const COMPOSER_MAX_HEIGHT = 120;

export interface SketchChatComposerProps {
	theme: Theme;
	/** The sketch has a room: plain messages go to it, `@bot` asks the agent. */
	shared: boolean;
	/** Send one message. Rejects to keep the draft. */
	onSend: (text: string) => Promise<unknown>;
}

export function SketchChatComposer({ theme, shared, onSend }: SketchChatComposerProps) {
	const [draft, setDraft] = React.useState('');
	const [sending, setSending] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);
	useAutosizeTextarea({ textareaRef, value: draft, maxHeight: COMPOSER_MAX_HEIGHT });

	const tooLong = payloadCharCount(draft.trim()) > CHAT_MAX_CHARS;
	const canSend = draft.trim().length > 0 && !tooLong && !sending;

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setError(null);
		try {
			await onSend(draft);
			setDraft('');
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setSending(false);
			textareaRef.current?.focus();
		}
	};

	return (
		<div
			className="px-2 py-2 flex flex-col gap-1"
			style={{ borderTop: `1px solid ${theme.colors.border}` }}
		>
			<ChatComposerSurface theme={theme} compact className="pt-2">
				<textarea
					ref={textareaRef}
					value={draft}
					rows={1}
					aria-label="Message"
					placeholder={shared ? 'Message the room' : 'Ask the agent'}
					className="w-full resize-none bg-transparent outline-none text-sm leading-6 select-text"
					style={{ color: theme.colors.textMain }}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						void send();
					}}
				/>
				<div className="flex items-center gap-2">
					<span
						className="flex-1 min-w-0 text-xs select-none"
						data-sketch-chat-hint=""
						style={{ color: theme.colors.textDim }}
					>
						{shared ? '@bot asks the agent' : 'Only the agent reads this'}
					</span>
					<ChatSendButton theme={theme} disabled={!canSend} onClick={() => void send()} />
				</div>
			</ChatComposerSurface>
			{(tooLong || error) && (
				<div
					className="px-1 text-xs select-text"
					role="alert"
					style={{ color: theme.colors.error }}
				>
					{tooLong ? `A message holds at most ${CHAT_MAX_CHARS} characters.` : error}
				</div>
			)}
		</div>
	);
}
