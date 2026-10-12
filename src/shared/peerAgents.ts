/**
 * Peer Agents - the other agents an agent may reach on its own, without the
 * user typing an `@mention`.
 *
 * A peer carries two independent access bits, and they are two different
 * mechanisms, not two strengths of one:
 *
 *   - READ  = may CONSULT: ask a question and get the answer back
 *     (`maestro-cli ask`). The peer's live tab is never touched.
 *   - WRITE = may DELEGATE: put work into the peer's live tab
 *     (`maestro-cli dispatch ... --notify-on-complete <me>`).
 *
 * Everything the desktop, the CLI, and the prompt renderer need to agree on
 * lives here, so the three cannot disagree on who an agent's peers are:
 *
 *   1. `normalizePeerAgents` - what gets persisted on the session (trimmed,
 *      de-duped by session id).
 *   2. `peerAccessLabel` / `hasAnyPeerAccess` / `mergePeerAccess` - the words
 *      and the bit arithmetic for one access pair, shared by explicit rows and
 *      by the group and worktree grants.
 *
 * Unlike an Additional Directory, an explicit row with NEITHER bit set is not
 * inert. It is an exclusion: it overrides a group or worktree grant that would
 * otherwise cover that peer. Nothing here may drop such a row.
 *
 * This module is bundled into the renderer, so it imports types only: no
 * `fs`, no `os`, nothing from Electron.
 */

import type { PeerAccess, PeerAgent } from './types';

/**
 * Clean a raw list from a form: trim, drop rows with a blank session id, and
 * collapse duplicate session ids (last write wins, so the most recently edited
 * row's squares survive).
 *
 * Rows with neither `read` nor `write` are KEPT. Here they are meaningful: an
 * explicit row with no access excludes that peer from a group or worktree
 * grant, so dropping it would silently hand the access back.
 *
 * Returns undefined when nothing survives, so the session field stays absent
 * rather than persisting an empty array on every agent.
 */
export function normalizePeerAgents(peers: PeerAgent[] | undefined): PeerAgent[] | undefined {
	if (!peers?.length) return undefined;

	const bySessionId = new Map<string, PeerAgent>();
	for (const peer of peers) {
		const sessionId = peer.sessionId.trim();
		if (!sessionId) continue;
		const description = peer.description?.trim();
		bySessionId.set(sessionId, {
			sessionId,
			read: !!peer.read,
			write: !!peer.write,
			// Keep the field absent (not an empty string) when unused so it doesn't
			// persist on every row.
			...(description ? { description } : {}),
		});
	}

	const normalized = [...bySessionId.values()];
	return normalized.length > 0 ? normalized : undefined;
}

/** Human-readable label for one access pair. */
export function peerAccessLabel(access: PeerAccess): string {
	if (access.read && access.write) return 'Consult + Delegate';
	if (access.read) return 'Consult only';
	if (access.write) return 'Delegate only';
	return 'No access';
}

/** Whether an access pair lets the agent reach the peer at all. */
export function hasAnyPeerAccess(access: PeerAccess): boolean {
	return access.read || access.write;
}

/**
 * Union two access pairs. Used where the group grant and the worktree grant
 * both cover one peer: each is an additive statement by the same user about
 * the same peer, so either one granting a bit grants it.
 */
export function mergePeerAccess(a: PeerAccess, b: PeerAccess): PeerAccess {
	return { read: a.read || b.read, write: a.write || b.write };
}
