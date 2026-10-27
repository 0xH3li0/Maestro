/**
 * The Sketch tab's chat pane: the session's chat, newest at the bottom. It
 * holds what the agent posts with `sketch_chat_post` (T12), the room's chat
 * as the bot relay mirrors it (`sketchBotRelay.ts`), and the conductor's own
 * `@bot` messages and their local replies. Names come from the posting actor,
 * never from the text. Bot replies the outbound screen holds wait at the
 * bottom with their "Publish anyway" chip (`SketchHeldReplyChip`).
 */

import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { SketchBotRequest, SketchChatMessage } from '../../stores/sketchSessionStore';
import { SketchHeldReplyChip } from './SketchHeldReplyChip';

export interface SketchChatPaneProps {
	messages: readonly SketchChatMessage[];
	theme: Theme;
	/** Bot replies held for "Publish anyway" (`status: 'held'`). */
	heldReplies?: readonly SketchBotRequest[];
	onPublishHeld?: (replyTo: string) => void;
	onDiscardHeld?: (replyTo: string) => void;
}

const NO_HELD: readonly SketchBotRequest[] = [];
const noop = () => {};

export function SketchChatPane({
	messages,
	theme,
	heldReplies = NO_HELD,
	onPublishHeld = noop,
	onDiscardHeld = noop,
}: SketchChatPaneProps) {
	const listRef = useStickToBottom<HTMLDivElement>(messages.length + heldReplies.length);
	return (
		<aside
			className="w-72 shrink-0 flex flex-col min-h-0"
			aria-label="Sketch chat"
			style={{
				borderLeft: `1px solid ${theme.colors.border}`,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			<div
				className="px-3 py-2 text-xs font-medium select-none"
				style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
			>
				Chat
			</div>
			<div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-3">
				{messages.map((message) => (
					<div key={message.id} className="flex flex-col gap-0.5">
						<div className="flex items-baseline gap-2 text-xs select-none">
							<span className="font-medium" style={{ color: theme.colors.accent }}>
								{message.actor.name}
							</span>
							<span style={{ color: theme.colors.textDim }}>{formatRelativeTime(message.ts)}</span>
						</div>
						<div
							className="text-sm whitespace-pre-wrap break-words select-text"
							style={{ color: theme.colors.textMain }}
						>
							{message.text}
						</div>
					</div>
				))}
				{heldReplies.map((request) => (
					<SketchHeldReplyChip
						key={request.replyTo}
						request={request}
						theme={theme}
						onPublish={onPublishHeld}
						onDiscard={onDiscardHeld}
					/>
				))}
			</div>
		</aside>
	);
}
