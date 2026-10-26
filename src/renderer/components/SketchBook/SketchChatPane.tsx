/**
 * The Sketch tab's chat pane: the session's local chat (spec T12), newest at
 * the bottom. Until the room client and bot relay land (phases 05 and 06) it
 * holds only what the agent posts with `sketch_chat_post` on an unshared
 * sketch. Names come from the posting actor, never from the text.
 */

import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { SketchChatMessage } from '../../stores/sketchSessionStore';

export interface SketchChatPaneProps {
	messages: readonly SketchChatMessage[];
	theme: Theme;
}

export function SketchChatPane({ messages, theme }: SketchChatPaneProps) {
	const listRef = useStickToBottom<HTMLDivElement>(messages.length);
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
			</div>
		</aside>
	);
}
