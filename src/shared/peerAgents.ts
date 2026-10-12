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
 *   3. `resolvePeerRoster` - who an agent's peers are right now. The one place
 *      the precedence between explicit rows, the group grant, and the worktree
 *      grant lives.
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

/** A peer as it will actually be presented to the agent. */
export interface ResolvedPeer extends PeerAccess {
	sessionId: string;
	/** Live display name, resolved now rather than persisted. */
	name: string;
	description?: string;
	/** Which grant produced this peer, for UI provenance and logging. */
	source: 'explicit' | 'group' | 'worktree';
}

/**
 * The fields of an agent that roster resolution reads. A minimal shape, so the
 * CLI can pass its own session records and the renderer its `Session`s.
 */
export interface PeerRosterInput {
	id: string;
	name: string;
	groupId?: string;
	parentSessionId?: string;
	peerAgents?: PeerAgent[];
	groupPeerAccess?: PeerAccess;
	worktreePeerAccess?: PeerAccess;
}

/**
 * Resolve the peers an agent may reach right now, from its three stored
 * sources and the live agent list. Nothing here is persisted: the roster is
 * rebuilt each time, so moving an agent into a group, renaming it, or deleting
 * it reshapes the roster with no further configuration.
 *
 * Precedence, in this order:
 *
 *   1. The group grant adds every other agent in the agent's own group.
 *   2. The worktree grant adds the worktree family: the agent's worktree
 *      parent, its sibling worktree children, and its own worktree children.
 *      A peer both grants cover gets the UNION of the two access pairs and
 *      keeps `source: 'group'`.
 *   3. An explicit row REPLACES whatever the grants gave that peer. It does
 *      not union with them. That is what lets a row lower a peer's access, and
 *      what makes a row with neither bit set an exclusion.
 *   4. A peer left with no access is dropped, and so is the agent itself.
 *
 * A row whose session id matches no live agent is dropped instead of rendered
 * as a dead name. The result is sorted by name so the prompt table is stable.
 *
 * The group grant covers the agent's OWN `groupId` only. A group can sit
 * inside another (`Group.parentGroupId`), and this deliberately reaches
 * neither the parent group nor a child group: "peers in my group" means the
 * agents listed beside this one, and a nested group is a separate team.
 */
export function resolvePeerRoster(
	session: PeerRosterInput,
	allSessions: readonly PeerRosterInput[]
): ResolvedPeer[] {
	const roster = new Map<string, ResolvedPeer>();
	const others = allSessions.filter((other) => other.id !== session.id);

	const { groupId, groupPeerAccess, worktreePeerAccess, parentSessionId } = session;

	if (groupPeerAccess && groupId) {
		for (const other of others) {
			if (other.groupId !== groupId) continue;
			roster.set(other.id, {
				sessionId: other.id,
				name: other.name,
				read: groupPeerAccess.read,
				write: groupPeerAccess.write,
				source: 'group',
			});
		}
	}

	if (worktreePeerAccess) {
		for (const other of others) {
			// The parent, then the siblings (guarded: two agents with no parent at
			// all are not siblings), then this agent's own worktree children.
			const isFamily =
				(!!parentSessionId &&
					(other.id === parentSessionId || other.parentSessionId === parentSessionId)) ||
				other.parentSessionId === session.id;
			if (!isFamily) continue;
			const fromGroup = roster.get(other.id);
			roster.set(
				other.id,
				fromGroup
					? { ...fromGroup, ...mergePeerAccess(fromGroup, worktreePeerAccess) }
					: {
							sessionId: other.id,
							name: other.name,
							read: worktreePeerAccess.read,
							write: worktreePeerAccess.write,
							source: 'worktree',
						}
			);
		}
	}

	// Explicit rows go last and replace the whole entry. Normalized first, so a
	// list that was never cleaned resolves the way its persisted form would.
	const liveById = new Map(others.map((other) => [other.id, other]));
	for (const row of normalizePeerAgents(session.peerAgents) ?? []) {
		const live = liveById.get(row.sessionId);
		if (!live) continue;
		roster.set(live.id, {
			sessionId: live.id,
			name: live.name,
			read: row.read,
			write: row.write,
			...(row.description ? { description: row.description } : {}),
			source: 'explicit',
		});
	}

	return [...roster.values()]
		.filter(hasAnyPeerAccess)
		.sort((a, b) => a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId));
}
