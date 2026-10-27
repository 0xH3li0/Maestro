/**
 * The Sketch tab's Room panel (spec sections 6, 8.8 and 8.9, hosted spec §8):
 * a shared sketch's room as the server reports it in `room.stats`.
 *
 * - The room's screening value (`<SketchScreeningBadge>`) and the Y4 banner
 *   (`<SketchScreenOutageBanner>`), the same two the tab header shows.
 * - Members: role, online state, ops, `@bot` requests, deny streak,
 *   rejections, screen failures and lock state, with Kick (temporary: the
 *   panel says Revoke is the real fix) and Unlock.
 * - Links: expiry, `@bot` suspension, who is on them, with Unsuspend and
 *   Revoke.
 * - Flagged elements from the audit log (spec section 8.3, rule 5), with a
 *   one-click delete stamped as the conductor.
 * - Reset all access, asked again in place.
 *
 * Kick, Unlock and Unsuspend go through `window.maestro.sketch.roomAction`
 * to main's `sketch-room-admin.ts`, which `maestro-cli sketch kick|unlock|
 * unsuspend` reaches too; Revoke and Reset are the Share panel's own verbs.
 * The stats come live from the session, which the room client keeps current.
 */

import React from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import type { Theme } from '../../types';
import { formatFutureTime, formatRelativeTime } from '../../../shared/formatters';
import {
	canKickRoomActor,
	canUnlockRoomActor,
	describeRoomStatsActor,
	describeRoomStatsCap,
	describeSketchAuditDecision,
	SKETCH_KICK_NOTE,
	type SketchFlaggedElement,
	type SketchRoomAction,
} from '../../../shared/sketch/room-admin';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { useSketchSessionStore } from '../../stores/sketchSessionStore';
import { deleteSketchElementsAsConductor } from '../../services/sketchAgentWrites';
import { SketchScreenOutageBanner, SketchScreeningBadge } from './SketchRoomScreening';

export interface SketchRoomPanelProps {
	sketchId: string;
	theme: Theme;
	onClose: () => void;
}

/** A flagged element the board still holds, with its type for the row. */
interface LiveFlaggedElement extends SketchFlaggedElement {
	type: string;
}

function Section({
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

export function SketchRoomPanel({ sketchId, theme, onClose }: SketchRoomPanelProps) {
	const room = useSketchSessionStore((s) => s.sessions[sketchId]?.room ?? null);
	const elements = useSketchSessionStore((s) => s.sessions[sketchId]?.scene?.elements);
	const stats = room?.stats ?? null;
	const [flagged, setFlagged] = React.useState<SketchFlaggedElement[]>([]);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [armedReset, setArmedReset] = React.useState(false);
	const mounted = React.useRef(true);

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Ask the server for fresh stats once on open; pushes keep them current after.
	React.useEffect(() => {
		window.maestro.sketch.roomStats(sketchId).catch(() => undefined);
	}, [sketchId]);

	// The audit log grows with every rejection the gate makes, so read it again then.
	const rejections = stats?.actors.reduce((sum, actor) => sum + actor.guardrailTotal, 0) ?? 0;
	const readAudit = React.useCallback(async () => {
		try {
			const audit = await window.maestro.sketch.roomAudit(sketchId);
			if (mounted.current) setFlagged(audit.flagged);
		} catch (err) {
			if (mounted.current) setError(ipcErrorMessage(err));
		}
	}, [sketchId]);
	React.useEffect(() => {
		void readAudit();
	}, [readAudit, rejections]);

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

	/** Run one action: busy while it runs, its error shown. */
	const run = React.useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (err) {
			if (mounted.current) setError(ipcErrorMessage(err));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}, []);

	const act = (action: SketchRoomAction) =>
		run(() => {
			const { op, ...input } = action;
			return window.maestro.sketch.roomAction(sketchId, op, input);
		});

	const dim = { color: theme.colors.textDim };
	const now = Date.now();

	return (
		<aside
			className="w-80 shrink-0 flex flex-col min-h-0 select-none"
			aria-label="Room"
			data-sketch-room-panel=""
			style={{
				borderLeft: `1px solid ${theme.colors.border}`,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			<div
				className="px-3 py-2 flex items-center justify-between text-xs font-medium"
				style={{ ...dim, borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<span className="flex items-center gap-2">
					Room
					<SketchScreeningBadge screening={stats?.screening ?? null} theme={theme} />
				</span>
				<button
					type="button"
					aria-label="Close the Room panel"
					className="p-0.5 rounded hover:bg-white/10"
					onClick={onClose}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>
			<SketchScreenOutageBanner stats={stats} theme={theme} />

			<div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 text-xs">
				{!stats && (
					<div style={dim}>
						{room && room.connection !== 'stopped'
							? 'Waiting for the room to report who is in it.'
							: 'The room is not connected, so it cannot report who is in it.'}
					</div>
				)}

				{stats && (
					<>
						{stats.guestEdited && (
							<div style={dim}>
								A guest has edited the board, so your @bot turns run restricted.
							</div>
						)}

						<Section title="Members" theme={theme}>
							<div style={dim}>{SKETCH_KICK_NOTE}</div>
							{stats.actors.length === 0 && <div style={dim}>No one has joined yet.</div>}
							{stats.actors.map((actor) => (
								<div
									key={actor.actorId}
									className="flex flex-col gap-1 py-1"
									data-sketch-room-actor={actor.actorId}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate" style={{ color: theme.colors.textMain }}>
											{describeRoomStatsActor(actor)}
										</span>
										{actor.lockedOut && (
											<MiniBadge label="Locked out" theme={theme} color={theme.colors.error} />
										)}
									</div>
									<div style={dim}>
										{actor.online ? 'Online' : `Last seen ${formatRelativeTime(actor.lastSeen)}`}
										{` · ${actor.ops} ops · ${actor.toBot} @bot · deny streak ${actor.denyStreak} · rejected ${actor.guardrailTotal}`}
										{actor.unavailableTotal > 0 ? ` · screen failed ${actor.unavailableTotal}` : ''}
									</div>
									{(canUnlockRoomActor(actor) || canKickRoomActor(actor)) && (
										<div className="flex gap-2">
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
									)}
								</div>
							))}
						</Section>

						<Section title="Links" theme={theme}>
							{stats.caps.length === 0 && <div style={dim}>No links.</div>}
							{stats.caps.map((cap) => (
								<div
									key={cap.capId}
									className="flex flex-col gap-1 py-1"
									data-sketch-room-cap={cap.capId}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate" style={{ color: theme.colors.textMain }}>
											{cap.label || (cap.role === 'rw' ? 'Edit link' : 'View link')}
										</span>
										{cap.botSuspended && !cap.revoked && (
											<MiniBadge
												label="@bot suspended"
												theme={theme}
												color={theme.colors.warning}
											/>
										)}
									</div>
									<div style={dim}>
										{cap.role === 'rw' ? 'Can edit' : 'Can view'} · {describeRoomStatsCap(cap, now)}
										{!cap.revoked && cap.expiresAt !== null && cap.expiresAt > now
											? ` · expires ${formatFutureTime(cap.expiresAt)}`
											: ''}
										{` · ${cap.online} online · rejected ${cap.guardrailTotal}`}
									</div>
									{!cap.revoked && (
										<div className="flex gap-2">
											{cap.botSuspended && (
												<HeaderActionButton
													theme={theme}
													disabled={busy}
													onClick={() => void act({ op: 'unsuspend', capId: cap.capId })}
												>
													Unsuspend
												</HeaderActionButton>
											)}
											<HeaderActionButton
												theme={theme}
												variant="ghost"
												disabled={busy}
												onClick={() =>
													void run(() => window.maestro.sketch.revokeLink(sketchId, cap.capId))
												}
											>
												Revoke
											</HeaderActionButton>
										</div>
									)}
								</div>
							))}
						</Section>
					</>
				)}

				<Section title="Flagged elements" theme={theme}>
					{liveFlagged.length === 0 && (
						<div style={dim}>The screen has withheld nothing on the board.</div>
					)}
					{liveFlagged.map((entry) => (
						<div
							key={entry.elementId}
							className="flex items-center justify-between gap-2 py-1"
							data-sketch-flagged-element={entry.elementId}
						>
							<div className="min-w-0">
								<div style={{ color: theme.colors.textMain }}>
									{entry.type} by{' '}
									{entry.actor ? `${entry.actor.kind} ${entry.actor.id}` : 'an unknown author'}
								</div>
								<div style={dim}>
									{describeSketchAuditDecision({ ...entry, status: 'flagged' })},{' '}
									{formatRelativeTime(entry.ts)}
								</div>
							</div>
							<HeaderActionButton
								theme={theme}
								variant="ghost"
								icon={<Trash2 />}
								ariaLabel={`Delete the flagged ${entry.type}`}
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await deleteSketchElementsAsConductor(sketchId, [entry.elementId]);
									})
								}
							>
								Delete
							</HeaderActionButton>
						</div>
					))}
				</Section>

				<Section title="Access" theme={theme}>
					{!armedReset && (
						<HeaderActionButton
							theme={theme}
							variant="ghost"
							icon={<RotateCcw />}
							disabled={busy}
							onClick={() => setArmedReset(true)}
						>
							Reset all access
						</HeaderActionButton>
					)}
					{armedReset && (
						<div className="flex flex-col gap-2">
							<div style={{ color: theme.colors.warning }}>
								Every link stops working and every guest is disconnected. The room history is
								cleared and the sketch is uploaded again under a new key.
							</div>
							<div className="flex gap-2">
								<HeaderActionButton
									theme={theme}
									disabled={busy}
									onClick={() => {
										setArmedReset(false);
										void run(() => window.maestro.sketch.rotate(sketchId));
									}}
								>
									Reset all access
								</HeaderActionButton>
								<HeaderActionButton
									theme={theme}
									variant="ghost"
									onClick={() => setArmedReset(false)}
								>
									Cancel
								</HeaderActionButton>
							</div>
						</div>
					)}
				</Section>

				{busy && <Spinner size={16} color={theme.colors.accent} />}
				{error && (
					<div className="select-text" role="alert" style={{ color: theme.colors.error }}>
						{error}
					</div>
				)}
			</div>
		</aside>
	);
}
