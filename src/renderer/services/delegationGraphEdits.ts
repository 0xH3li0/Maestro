/**
 * Writing a relationship from the Delegation Graph.
 *
 * The canvas owns no store of relationships. An edge from A to B IS a row for
 * B in A's `peerAgents`, so drawing or changing one is an edit to A's roster
 * and to nothing else. B is never written: the edge the other way is B's own
 * statement, in B's own settings.
 *
 * The write is the one `maestro-cli update-agent --peer` makes: the same patch
 * (`PeerAgentEdits`), the same check (`peerAgentEditsProblem`) and the same
 * apply (`applyPeerAgentEdits`, whose result is already through
 * `normalizePeerAgents`). So the graph and the CLI cannot store different rows
 * for one gesture, and a row is replaced in place and never doubled.
 *
 * The agent is flushed to the main-process store at once. The renderer's own
 * persistence is debounced, and the next turn builds its `## Peer Agents`
 * block, and `show-agent` its report, from what main holds.
 */

import {
	applyPeerAgentEdits,
	hasAnyPeerAccess,
	peerAgentEditsProblem,
	type PeerAgentEditsResult,
} from '../../shared/peerAgents';
import type { PeerAccess } from '../../shared/types';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { flushAgentToStore } from './agentGateway';

/** What an edge editor hands over: the two bits, and the note as typed. */
export interface DelegationEdgeDraft extends PeerAccess {
	/** Blank clears the note of the row. */
	description: string;
}

/** Refused by `writeDelegationEdge`: an edge with neither bit is not a relationship. */
export const DELEGATION_EDGE_NEEDS_ACCESS = 'Pick Consult, Delegate or both.';

/**
 * Write the edge from `sourceId` to `targetId`: upsert the row for the target
 * in the SOURCE's roster. A row the source already holds is replaced, so
 * re-drawing a direction edits it. A row that a group or worktree grant only
 * derived becomes an explicit one, which then overrides the grant for that one
 * peer.
 *
 * Refused, by name, with nothing written: an edge with neither bit, an agent
 * as its own peer, and an end that is not a live agent.
 */
export function writeDelegationEdge(
	sourceId: string,
	targetId: string,
	draft: DelegationEdgeDraft
): PeerAgentEditsResult {
	if (!hasAnyPeerAccess(draft)) return { ok: false, error: DELEGATION_EDGE_NEEDS_ACCESS };

	const { sessions } = useSessionStore.getState();
	const source = sessions.find((session) => session.id === sourceId);
	if (!source) return { ok: false, error: 'Agent not found' };

	const edits = {
		upsert: [{ sessionId: targetId, read: draft.read, write: draft.write }],
		notes: [{ sessionId: targetId, description: draft.description }],
	};
	const problem = peerAgentEditsProblem(
		edits,
		new Set(sessions.map((session) => session.id)),
		sourceId
	);
	if (problem) return { ok: false, error: problem };

	const applied = applyPeerAgentEdits(source.peerAgents, edits);
	if (!applied.ok) return applied;

	updateSessionWith(sourceId, (session) => ({ ...session, peerAgents: applied.peerAgents }));
	void flushAgentToStore(sourceId);
	return applied;
}
