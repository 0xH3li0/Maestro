/**
 * Consultation budget - how many peer consults and delegations one user
 * message may spend, counted across the WHOLE tree that descends from it.
 *
 * Peer rosters (`src/shared/peerAgents.ts`) let an agent reach another agent
 * without the user typing anything, and a group grant makes a five-agent group
 * a fully connected graph: A asks B, B asks C, C asks A. Each hop is a full
 * agent spawn. The budget is the one bound on that: a single number, spent by
 * every consult (`maestro-cli ask`, an agent's `@mention`) and every
 * delegation (`maestro-cli dispatch`) anywhere in the chain. It bounds fan-out
 * and chain length together, which a depth cap alone would not.
 *
 * This module is the setting's contract, shared by the three processes that
 * read it (the renderer's setter, the main process, and the CLI), so they
 * cannot disagree on the key, the default, or the range.
 */

/** The settings key. Read it through this constant, never a string literal. */
export const MAX_CONSULTATIONS_PER_TURN_SETTING = 'maxConsultationsPerTurn';

/** Generous for a real collaboration, fatal to a runaway. */
export const DEFAULT_MAX_CONSULTATIONS_PER_TURN = 25;

/**
 * The most the setting accepts. A budget is a safety bound, so "unlimited" is
 * deliberately not a value: a tree this size is already a runaway.
 */
export const MAX_CONSULTATIONS_PER_TURN_CEILING = 500;

/**
 * The budget a stored value means.
 *
 * `0` is a real value, not "unset": it turns peer consults and delegations off
 * entirely. A missing or malformed value (never written, or written by hand as
 * a string through `maestro-cli settings set`) is the default, and a number is
 * rounded down and clamped to `0..MAX_CONSULTATIONS_PER_TURN_CEILING`. Every
 * reader goes through this, because the CLI can store any JSON under the key.
 */
export function normalizeMaxConsultationsPerTurn(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return DEFAULT_MAX_CONSULTATIONS_PER_TURN;
	}
	return Math.min(MAX_CONSULTATIONS_PER_TURN_CEILING, Math.max(0, Math.floor(raw)));
}
