/**
 * The Room panel's rules (spec sections 6, 8.8 and 9, hosted spec §8): what
 * the conductor may do to a shared sketch's room, and how its `room.stats`
 * and audit log read. One copy for the Room panel in the Sketch tab and
 * `maestro-cli sketch stats|kick|unlock|unsuspend|audit`, so both say the
 * same words and refuse the same input.
 *
 * - Kick, Unlock and Unsuspend are conductor frames (`kick`, `actor.unlock`,
 *   `cap.unsuspend`) sent on the room socket ({@link sketchRoomAdminFrame}).
 *   Kick is temporary: it blocks the device for a while ({@link SKETCH_KICK_NOTE}).
 *   Revoking the link is the real fix.
 * - From an agent caller, Unlock and Unsuspend wait on the desktop
 *   confirmation (A1): each lets a guest ask the agent again. Kick only ever
 *   takes access away, so it runs ({@link sketchRoomAdminNeedsConfirmation}).
 * - The audit log (spec section 8.8) holds one line per gate decision and
 *   never the text. {@link flaggedSketchElements} reads the elements whose
 *   newest decision is `flagged`, for the panel's one-click delete.
 *
 * Pure. Bundled into the renderer and the CLI: no Electron or Node imports.
 */

import { describeSketchActor } from './attribution';
import type { ClientFrame, RoomStatsActor, RoomStatsCap } from './protocol';
import type { SketchRoomStats } from './room-stats';
import {
	SKETCH_ACTOR_KINDS,
	type SketchActorKind,
	type SketchScreenLocality,
	type SketchScreenStatus,
} from './types';

/** What the conductor can do to a room member or a link, and `stats` to read the room. */
export const SKETCH_ROOM_ADMIN_OPS = ['stats', 'kick', 'unlock', 'unsuspend'] as const;
export type SketchRoomAdminOp = (typeof SKETCH_ROOM_ADMIN_OPS)[number];
/** Every op that changes the room. */
export type SketchRoomActionOp = Exclude<SketchRoomAdminOp, 'stats'>;

export function isSketchRoomAdminOp(value: unknown): value is SketchRoomAdminOp {
	return typeof value === 'string' && (SKETCH_ROOM_ADMIN_OPS as readonly string[]).includes(value);
}

export function isSketchRoomActionOp(value: unknown): value is SketchRoomActionOp {
	return isSketchRoomAdminOp(value) && value !== 'stats';
}

/**
 * A1: Unlock clears a guest's lockout and Unsuspend gives a link back its
 * `@bot` access, so from an agent caller each waits on the conductor. Kick
 * only takes access away, so it runs.
 */
export function sketchRoomAdminNeedsConfirmation(op: SketchRoomActionOp): boolean {
	return op === 'unlock' || op === 'unsuspend';
}

/** Wire contract section 4: the server blocks a kicked device for 60 minutes unless told otherwise. */
export const SKETCH_KICK_DEFAULT_MINUTES = 60;
/** The longest kick a request may name: one day. Longer is what Revoke is for. */
export const SKETCH_KICK_MAX_MINUTES = 24 * 60;

/** The panel's word on Kick (spec section 6). */
export const SKETCH_KICK_NOTE =
	'Kick is temporary: it disconnects the guest and blocks that device for an hour, and the link still works. Revoke the link to keep someone out.';

/** Where a room socket stands. */
export type SketchRoomConnection =
	| 'connecting'
	| 'catching-up'
	| 'live'
	| 'reconnecting'
	| 'stopped';

/**
 * A room as the window that runs it reports it: the socket state (null when
 * no room client runs for the sketch) and the newest `room.stats` (null
 * before the server sent one).
 */
export interface SketchRoomStatsReading {
	sketchId: string;
	connection: SketchRoomConnection | null;
	stats: SketchRoomStats | null;
}

/** `maestro-cli sketch audit`: every decision, and the elements whose newest one is `flagged`. */
export interface SketchRoomAudit {
	sketchId: string;
	entries: SketchAuditEntry[];
	flagged: SketchFlaggedElement[];
}

/** One change to a room: who or what it acts on. */
export type SketchRoomAction =
	| { op: 'kick'; actorId: string; minutes?: number }
	| { op: 'unlock'; actorId: string }
	| { op: 'unsuspend'; capId: string };

/** Why a kick length is refused, or null when it is a whole number of minutes in range. */
export function sketchKickMinutesProblem(minutes: unknown): string | null {
	if (minutes === undefined) return null;
	if (
		typeof minutes !== 'number' ||
		!Number.isSafeInteger(minutes) ||
		minutes < 1 ||
		minutes > SKETCH_KICK_MAX_MINUTES
	) {
		return `A kick lasts a whole number of minutes from 1 to ${SKETCH_KICK_MAX_MINUTES}. Revoke the link to keep someone out for good.`;
	}
	return null;
}

/** The conductor frame for one action (wire contract section 4). Throws on a bad kick length. */
export function sketchRoomAdminFrame(action: SketchRoomAction): ClientFrame {
	switch (action.op) {
		case 'kick': {
			const problem = sketchKickMinutesProblem(action.minutes);
			if (problem) throw new Error(problem);
			return action.minutes === undefined
				? { t: 'kick', actorId: action.actorId }
				: { t: 'kick', actorId: action.actorId, minutes: action.minutes };
		}
		case 'unlock':
			return { t: 'actor.unlock', actorId: action.actorId };
		case 'unsuspend':
			return { t: 'cap.unsuspend', capId: action.capId };
	}
}

/** The id an action names: an actor for kick and unlock, a link for unsuspend. */
export function sketchRoomActionTarget(action: SketchRoomAction): string {
	return action.op === 'unsuspend' ? action.capId : action.actorId;
}

/** A room member as the panel and the CLI name it ("Sam" · guest, read-write link #3, not verified). */
export function describeRoomStatsActor(actor: RoomStatsActor): string {
	return describeSketchActor({
		id: actor.actorId,
		name: actor.name,
		kind: actor.kind,
		role: actor.role,
		...(actor.capId ? { capId: actor.capId } : {}),
		...(actor.capLabel ? { capLabel: actor.capLabel } : {}),
	});
}

/** Only a guest can be kicked: the conductor and the bot are this desktop. */
export function canKickRoomActor(actor: Pick<RoomStatsActor, 'kind'>): boolean {
	return actor.kind === 'guest';
}

/** Unlock clears `locked_out` and `deny_streak`, so it is offered while either is set. */
export function canUnlockRoomActor(
	actor: Pick<RoomStatsActor, 'kind' | 'lockedOut' | 'denyStreak'>
): boolean {
	return actor.kind === 'guest' && (actor.lockedOut || actor.denyStreak > 0);
}

/** A link's state in one phrase: revoked, expired, or how long it has left and whether `@bot` is suspended. */
export function describeRoomStatsCap(
	cap: Pick<RoomStatsCap, 'revoked' | 'expiresAt' | 'botSuspended'>,
	now: number
): string {
	if (cap.revoked) return 'revoked';
	if (cap.expiresAt !== null && cap.expiresAt <= now) return 'expired';
	const parts = [cap.botSuspended ? '@bot suspended' : '@bot allowed'];
	if (cap.expiresAt === null) parts.unshift('never expires');
	return parts.join(', ');
}

// ---------------------------------------------------------------- audit log (spec section 8.8)

/** One audit line (spec section 8.8). Never the text, never an excerpt. */
export interface SketchAuditEntry {
	ts: number;
	sketchId: string;
	subject: { replyTo: string } | { elementId: string; version: number };
	actor: { id: string; kind: SketchActorKind; capId?: string } | null;
	status: SketchScreenStatus;
	score?: number;
	source: string;
	locality: SketchScreenLocality;
	reported: boolean;
}

const SCREEN_STATUSES: readonly SketchScreenStatus[] = ['clean', 'flagged', 'unscreened'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSubject(value: unknown): SketchAuditEntry['subject'] | null {
	if (!isRecord(value)) return null;
	if (typeof value.replyTo === 'string' && value.replyTo) return { replyTo: value.replyTo };
	if (typeof value.elementId === 'string' && value.elementId && isWholeNumber(value.version)) {
		return { elementId: value.elementId, version: value.version };
	}
	return null;
}

function parseActor(value: unknown): SketchAuditEntry['actor'] | undefined {
	if (value === null) return null;
	if (!isRecord(value) || typeof value.id !== 'string') return undefined;
	if (!(SKETCH_ACTOR_KINDS as readonly unknown[]).includes(value.kind)) return undefined;
	return {
		id: value.id,
		kind: value.kind as SketchActorKind,
		...(typeof value.capId === 'string' ? { capId: value.capId } : {}),
	};
}

/**
 * One audit line as a reader may trust it, or null. Only the known fields are
 * copied, so a line written by hand cannot carry anything else (text, an
 * excerpt) into the panel or the CLI.
 */
export function parseSketchAuditLine(line: string): SketchAuditEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(raw)) return null;
	const subject = parseSubject(raw.subject);
	const actor = parseActor(raw.actor);
	if (
		!isWholeNumber(raw.ts) ||
		typeof raw.sketchId !== 'string' ||
		!subject ||
		actor === undefined ||
		!(SCREEN_STATUSES as readonly unknown[]).includes(raw.status) ||
		typeof raw.source !== 'string' ||
		(raw.locality !== 'local' && raw.locality !== 'cloud')
	) {
		return null;
	}
	const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : undefined;
	return {
		ts: raw.ts,
		sketchId: raw.sketchId,
		subject,
		actor,
		status: raw.status as SketchScreenStatus,
		...(score !== undefined ? { score } : {}),
		source: raw.source,
		locality: raw.locality,
		reported: raw.reported === true,
	};
}

/** Every line of an audit file that parses, in file order. */
export function parseSketchAuditLog(text: string): SketchAuditEntry[] {
	const entries: SketchAuditEntry[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const entry = parseSketchAuditLine(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

/** An element whose newest audited version was flagged: the panel offers to delete it. */
export interface SketchFlaggedElement {
	elementId: string;
	version: number;
	actor: SketchAuditEntry['actor'];
	score?: number;
	source: string;
	locality: SketchScreenLocality;
	ts: number;
}

/**
 * The canvas elements whose newest decision is `flagged`, newest first. The
 * newest decision is the one on the highest version (the latest line on a
 * tie), so an element a guest rewrote into clean text drops off the list.
 */
export function flaggedSketchElements(
	entries: readonly SketchAuditEntry[]
): SketchFlaggedElement[] {
	const newest = new Map<string, { entry: SketchAuditEntry; version: number }>();
	for (const entry of entries) {
		if (!('elementId' in entry.subject)) continue;
		const { elementId, version } = entry.subject;
		const current = newest.get(elementId);
		if (
			!current ||
			version > current.version ||
			(version === current.version && entry.ts >= current.entry.ts)
		) {
			newest.set(elementId, { entry, version });
		}
	}
	const flagged: SketchFlaggedElement[] = [];
	for (const [elementId, { entry, version }] of newest) {
		if (entry.status !== 'flagged') continue;
		flagged.push({
			elementId,
			version,
			actor: entry.actor,
			...(entry.score !== undefined ? { score: entry.score } : {}),
			source: entry.source,
			locality: entry.locality,
			ts: entry.ts,
		});
	}
	return flagged.sort((a, b) => b.ts - a.ts);
}

/**
 * A decision as one line: "Flagged by Prompt Guard 2 22M, 0.97 (on this
 * computer)", or "Not screened: Screen off (on this computer)".
 */
export function describeSketchAuditDecision(
	decision: Pick<SketchAuditEntry, 'status' | 'source' | 'locality' | 'score'>
): string {
	const where = decision.locality === 'cloud' ? 'by a cloud service' : 'on this computer';
	if (decision.status === 'unscreened') return `Not screened: ${decision.source} (${where})`;
	const status = decision.status === 'flagged' ? 'Flagged' : 'Clean';
	const score = typeof decision.score === 'number' ? `, ${decision.score.toFixed(2)}` : '';
	return `${status} by ${decision.source}${score} (${where})`;
}
