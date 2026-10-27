/**
 * The "Publish anyway" chip (spec section 8.5, D3): a bot reply the outbound
 * screen's model pass flagged waits here instead of going to the room. The
 * classifier is trained on prompt injection, not credentials, so a flag is a
 * reason to look, not proof. Publish anyway posts the reply as it is; Discard
 * ends the request as `bot.failed`, which costs the guest nothing (X5).
 *
 * The request line names the server-stamped actor (A2), never a name from
 * the ciphertext.
 */

import { ShieldAlert } from 'lucide-react';
import type { Theme } from '../../types';
import { describeSketchActor } from '../../../shared/sketch/attribution';
import type { SketchBotRequest } from '../../stores/sketchSessionStore';
import { HeaderActionButton } from '../ui/HeaderActionButton';

export interface SketchHeldReplyChipProps {
	request: SketchBotRequest;
	theme: Theme;
	onPublish: (replyTo: string) => void;
	onDiscard: (replyTo: string) => void;
}

export function SketchHeldReplyChip({
	request,
	theme,
	onPublish,
	onDiscard,
}: SketchHeldReplyChipProps) {
	return (
		<div
			role="group"
			aria-label="Held bot reply"
			className="flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-xs select-none"
			style={{
				border: `1px solid ${theme.colors.warning}`,
				backgroundColor: theme.colors.bgMain,
				color: theme.colors.textMain,
			}}
		>
			<div
				className="flex items-center gap-1.5 font-medium"
				style={{ color: theme.colors.warning }}
			>
				<ShieldAlert className="w-3.5 h-3.5 shrink-0" />
				Reply held before posting
			</div>
			<div style={{ color: theme.colors.textDim }}>
				Answering {describeSketchActor(request.actor)}
			</div>
			<div className="select-text break-words">
				{request.heldReason ?? 'The secret screen flagged the reply.'}
			</div>
			<div className="flex gap-2 pt-0.5">
				<HeaderActionButton theme={theme} onClick={() => onPublish(request.replyTo)}>
					Publish anyway
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={() => onDiscard(request.replyTo)}
				>
					Discard
				</HeaderActionButton>
			</div>
		</div>
	);
}
