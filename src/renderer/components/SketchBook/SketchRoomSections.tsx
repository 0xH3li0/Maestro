/**
 * The room parts of the Collaborate panel's tabs (spec sections 6, 8.8 and
 * 8.9, hosted spec §8), from the room as the server reports it in
 * `room.stats`:
 *
 * - People ({@link SketchRoomMembers}): who is in the room, online or when
 *   last seen, the counters that are not zero, the lock state, and Kick
 *   (temporary: a footnote says Revoke is the real fix) and Unlock.
 * - Safety ({@link SketchFlaggedElements}): flagged elements from the audit
 *   log (spec section 8.3, rule 5), with a one-click delete stamped as the
 *   conductor.
 *
 * The room's links are rows of the Share tab, which joins each link with its
 * `room.stats` cap ({@link findRoomStatsCap}).
 *
 * Kick and Unlock go through `window.maestro.sketch.roomAction` to main's
 * `sketch-room-admin.ts`, which `maestro-cli sketch kick|unlock` reaches too.
 * The stats come live from the session, which the room client keeps current.
 * Every action runs through the panel's `run`, so one spinner and one error
 * line serve the whole panel.
 */

import React from 'react';
import { Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import {
	canKickRoomActor,
	canUnlockRoomActor,
	describeRoomStatsActor,
	describeSketchAuditDecision,
	SKETCH_KICK_NOTE,
	type SketchFlaggedElement,
	type SketchRoomAction,
} from '../../../shared/sketch/room-admin';
import type { SketchRoomStats } from '../../../shared/sketch/room-stats';
import { sketchActorNameLabel, sketchActorRoleLabel } from '../../../shared/sketch/attribution';
import { GhostIconButton } from '../ui/GhostIconButton';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { useSketchSessionStore } from '../../stores/sketchSessionStore';
import { deleteSketchElementsAsConductor } from '../../services/sketchAgentWrites';

/** A section of the Collaborate panel: a rule above, a dim title. */
export function SketchPanelSection({
	title,
	theme,
	children,
}: {
	title: string;
	theme: Theme;
	children: React.ReactNode;
}) {
	return (
		<section
			className="flex flex-col gap-1 pt-2"
			style={{ borderTop: `1px solid ${theme.colors.border}` }}
		>
			<div className="font-medium" style={{ color: theme.colors.textDim }}>
				{title}
			</div>
			{children}
		</section>
	);
}

/**
 * A dim line of facts ("Online", "4 ops", "rejected 3"). Each fact stays on one
 * line and the line wraps between facts, never inside one: a wide face (a
 * monospace interface font) in a narrow panel otherwise split "0 / online"
 * across lines. Falsy entries are dropped, so a caller lists a counter only
 * when it says something.
 */
export function SketchMetaLine({
	items,
	theme,
}: {
	items: readonly (string | false | null | undefined)[];
	theme: Theme;
}) {
	const shown = items.filter((item): item is string => Boolean(item));
	if (shown.length === 0) return null;
	return (
		<div
			className="flex flex-wrap gap-x-2 gap-y-0.5"
			data-sketch-meta-line=""
			style={{ color: theme.colors.textDim }}
		>
			{shown.map((item, index) => (
				<span key={`${index}-${item}`} className="whitespace-nowrap">
					{index > 0 && (
						<span aria-hidden="true" className="pr-2">
							·
						</span>
					)}
					{item}
				</span>
			))}
		</div>
	);
}

/** The room's stats for a link, or undefined while the room has not reported it. */
export function findRoomStatsCap(stats: SketchRoomStats | null, capId: string) {
	return stats?.caps.find((cap) => cap.capId === capId);
}

/** The live room stats of a sketch, or null while the room has not reported. */
export function useSketchRoomStats(sketchId: string): SketchRoomStats | null {
	return useSketchSessionStore((s) => s.sessions[sketchId]?.room?.stats ?? null);
}

/** What every room part takes from the panel. */
interface SketchRoomPartProps {
	sketchId: string;
	theme: Theme;
	busy: boolean;
	/** The panel's action runner: busy while it runs, its error shown. */
	run: (action: () => Promise<unknown>) => Promise<void>;
}

export interface SketchRoomMembersProps extends SketchRoomPartProps {
	stats: SketchRoomStats | null;
}

/** The People tab: one row per member, the facts that say something, and its actions. */
export function SketchRoomMembers({ sketchId, theme, stats, busy, run }: SketchRoomMembersProps) {
	const connection = useSketchSessionStore((s) => s.sessions[sketchId]?.room?.connection ?? null);
	const act = (action: SketchRoomAction) =>
		run(() => {
			const { op, ...input } = action;
			return window.maestro.sketch.roomAction(sketchId, op, input);
		});
	const dim = { color: theme.colors.textDim };

	if (!stats) {
		return (
			<div style={dim}>
				{connection && connection !== 'stopped'
					? 'Waiting for the room to report who is in it.'
					: 'The room is not connected, so it cannot report who is in it.'}
			</div>
		);
	}
	if (stats.actors.length === 0) return <div style={dim}>No one has joined yet.</div>;

	return (
		<div className="flex flex-col">
			{stats.actors.map((actor) => (
				<div
					key={actor.actorId}
					className="flex items-start gap-2 py-2"
					style={{ borderBottom: `1px solid ${theme.colors.border}` }}
					data-sketch-room-actor={actor.actorId}
				>
					<span
						aria-hidden="true"
						className="mt-1.5 w-2 h-2 rounded-full shrink-0"
						style={{ backgroundColor: actor.online ? theme.colors.success : theme.colors.textDim }}
					/>
					<div
						className="min-w-0 flex-1 flex flex-col gap-0.5"
						title={describeRoomStatsActor(actor)}
					>
						<div className="flex items-center gap-2 min-w-0">
							<span className="min-w-0 break-words" style={{ color: theme.colors.textMain }}>
								{sketchActorNameLabel(actor)}
							</span>
							{actor.lockedOut && (
								<MiniBadge label="Locked out" theme={theme} color={theme.colors.error} />
							)}
						</div>
						<div className="break-words" style={dim}>
							{sketchActorRoleLabel(actor)}
						</div>
						<SketchMetaLine
							theme={theme}
							items={[
								actor.online ? 'Online' : `Seen ${formatRelativeTime(actor.lastSeen)}`,
								actor.toBot > 0 && `${actor.toBot} @bot`,
								actor.denyStreak > 0 && `deny streak ${actor.denyStreak}`,
								actor.guardrailTotal > 0 && `rejected ${actor.guardrailTotal}`,
								actor.unavailableTotal > 0 && `screen failed ${actor.unavailableTotal}`,
							]}
						/>
					</div>
					{canUnlockRoomActor(actor) && (
						<HeaderActionButton
							theme={theme}
							disabled={busy}
							onClick={() => void act({ op: 'unlock', actorId: actor.actorId })}
						>
							Unlock
						</HeaderActionButton>
					)}
					{canKickRoomActor(actor) && (
						<HeaderActionButton
							theme={theme}
							variant="ghost"
							disabled={busy}
							title={SKETCH_KICK_NOTE}
							onClick={() => void act({ op: 'kick', actorId: actor.actorId })}
						>
							Kick
						</HeaderActionButton>
					)}
				</div>
			))}
			{stats.actors.some(canKickRoomActor) && (
				<div className="pt-2" style={dim}>
					{SKETCH_KICK_NOTE}
				</div>
			)}
		</div>
	);
}

export interface SketchFlaggedElementsProps extends SketchRoomPartProps {
	stats: SketchRoomStats | null;
	/** The panel's error line, for an audit log that cannot be read. */
	onError: (message: string) => void;
}

/** A flagged element the board still holds, with its type for the row. */
interface LiveFlaggedElement extends SketchFlaggedElement {
	type: string;
}

/** The Safety tab's flagged elements: what the screen withheld, with a delete. */
export function SketchFlaggedElements({
	sketchId,
	theme,
	stats,
	busy,
	run,
	onError,
}: SketchFlaggedElementsProps) {
	const elements = useSketchSessionStore((s) => s.sessions[sketchId]?.scene?.elements);
	const [flagged, setFlagged] = React.useState<SketchFlaggedElement[]>([]);
	const mounted = React.useRef(true);

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// The audit log grows with every rejection the gate makes, so read it again then.
	const rejections = stats?.actors.reduce((sum, actor) => sum + actor.guardrailTotal, 0) ?? 0;
	React.useEffect(() => {
		window.maestro.sketch
			.roomAudit(sketchId)
			.then((audit) => {
				if (mounted.current) setFlagged(audit.flagged);
			})
			.catch((err: unknown) => {
				if (mounted.current) onError(ipcErrorMessage(err));
			});
	}, [sketchId, rejections, onError]);

	const liveFlagged = React.useMemo<LiveFlaggedElement[]>(() => {
		const live = new Map(
			(elements ?? [])
				.filter((element) => element.isDeleted !== true)
				.map((element) => [element.id, element])
		);
		return flagged.flatMap((entry) => {
			const element = live.get(entry.elementId);
			return element ? [{ ...entry, type: String(element.type ?? 'element') }] : [];
		});
	}, [elements, flagged]);

	const dim = { color: theme.colors.textDim };

	return (
		<SketchPanelSection title="Flagged elements" theme={theme}>
			{liveFlagged.length === 0 && <div style={dim}>Nothing on the board is withheld.</div>}
			{liveFlagged.map((entry) => (
				<div
					key={entry.elementId}
					className="flex items-center justify-between gap-2 py-1"
					data-sketch-flagged-element={entry.elementId}
				>
					<div className="min-w-0">
						<div className="break-words" style={{ color: theme.colors.textMain }}>
							{entry.type} by{' '}
							{entry.actor ? `${entry.actor.kind} ${entry.actor.id}` : 'an unknown author'}
						</div>
						<div className="break-words" style={dim}>
							{describeSketchAuditDecision({ ...entry, status: 'flagged' })},{' '}
							{formatRelativeTime(entry.ts)}
						</div>
					</div>
					<GhostIconButton
						ariaLabel={`Delete the flagged ${entry.type}`}
						title="Delete it from the board"
						color={theme.colors.textDim}
						disabled={busy}
						onClick={() =>
							void run(() => deleteSketchElementsAsConductor(sketchId, [entry.elementId]))
						}
					>
						<Trash2 className="w-3.5 h-3.5" />
					</GhostIconButton>
				</div>
			))}
		</SketchPanelSection>
	);
}
