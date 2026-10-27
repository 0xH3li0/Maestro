/**
 * The B2 approval chip (spec section 5): a guest's `@bot` request that passed
 * the gate, waiting for the conductor. It shows the server-stamped actor line
 * (A2), never a name from the ciphertext, the decrypted request, and the
 * gate's verdict with its source and score.
 *
 * - Waiting: **Run** starts a restricted turn (Q4), **Deny** answers
 *   `bot.denied`, which counts toward the guest's lockout.
 * - Running: the chip stays, without buttons, until the turn answers.
 *
 * The chip goes when the request ends, the server expires it (X3), or this
 * desktop's socket closes (X7). At most three chips show per link; the chat
 * pane says how many more wait behind them (`visibleSketchApprovals()`).
 */

import { Bot } from 'lucide-react';
import type { Theme } from '../../types';
import { describeSketchActor } from '../../../shared/sketch/attribution';
import { describeSketchVerdict } from '../../../shared/sketch/bot-requests';
import type { SketchBotRequest } from '../../stores/sketchSessionStore';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { Spinner } from '../ui/Spinner';

export interface SketchApprovalChipProps {
	request: SketchBotRequest;
	theme: Theme;
	onRun: (replyTo: string) => void;
	onDeny: (replyTo: string) => void;
}

export function SketchApprovalChip({ request, theme, onRun, onDeny }: SketchApprovalChipProps) {
	const running = request.status === 'running';
	return (
		<div
			role="group"
			aria-label={running ? 'Running bot request' : 'Bot request awaiting approval'}
			className="flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-xs select-none"
			style={{
				border: `1px solid ${running ? theme.colors.border : theme.colors.accent}`,
				backgroundColor: theme.colors.bgMain,
				color: theme.colors.textMain,
			}}
		>
			<div className="flex items-center gap-1.5 font-medium" style={{ color: theme.colors.accent }}>
				{running ? (
					<Spinner size={14} color={theme.colors.accent} />
				) : (
					<Bot className="w-3.5 h-3.5 shrink-0" />
				)}
				{running ? 'Running, restricted' : 'Asks the agent'}
			</div>
			<div style={{ color: theme.colors.textDim }}>{describeSketchActor(request.actor)}</div>
			<div className="select-text whitespace-pre-wrap break-words">{request.text}</div>
			<div style={{ color: theme.colors.textDim }}>{describeSketchVerdict(request.verdict)}</div>
			{!running && (
				<div className="flex gap-2 pt-0.5">
					<HeaderActionButton theme={theme} onClick={() => onRun(request.replyTo)}>
						Run
					</HeaderActionButton>
					<HeaderActionButton theme={theme} variant="ghost" onClick={() => onDeny(request.replyTo)}>
						Deny
					</HeaderActionButton>
				</div>
			)}
		</div>
	);
}
