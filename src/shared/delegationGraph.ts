/**
 * Delegation Graph - the fleet's peer relationships as one directed graph.
 *
 * `./peerAgents` answers "who may THIS agent reach". That view is authored one
 * agent at a time, so the shape of the whole team is never visible: nothing
 * says that one agent is reachable by nobody, or that two delegate to each
 * other. This module is the second view over the same data: every agent is a
 * node, and every resolved peer is an edge.
 *
 * It owns no persistence and no precedence. An edge is a `ResolvedPeer` seen
 * from the outside, so the rules about explicit rows, the group grant, the
 * worktree grant and exclusions stay in `resolvePeerRoster` and are never
 * restated here.
 *
 * The edge model:
 *
 *   - An edge is DIRECTED and carries the same two independent bits as a peer
 *     row. READ = the source may consult the target (`maestro-cli ask`).
 *     WRITE = the source may delegate to the target (`maestro-cli dispatch`).
 *   - There is ONE edge per ordered pair, not one per bit. An agent that may
 *     both consult and delegate to a peer is one edge with both bits lit.
 *   - The reverse relationship is a SEPARATE edge, because it is a separate
 *     statement in a separate agent's settings. "Bidirectional" is two edges
 *     existing, never a flag on one.
 *
 * Not the Document Graph: that one graphs documents and their links.
 *
 * This module is bundled into the renderer, so it imports nothing that reaches
 * `fs`, `os`, or Electron.
 */

import type { ResolvedPeer } from './peerAgents';
import type { PeerAccess } from './types';

/** Why an agent appears on the graph at all. */
export type DelegationNodeScope = 'in-scope' | 'spill';

export interface DelegationGraphNode {
	sessionId: string;
	name: string;
	groupId?: string;
	/** 'spill' means: outside the requested scope, drawn only because an edge reaches it. */
	scope: DelegationNodeScope;
}

/**
 * One directed relationship. `source` may consult `target` when `read` is set, and
 * delegate to `target` when `write` is set. The reverse relationship, if any, is a
 * SEPARATE edge; there is no bidirectional flag.
 */
export interface DelegationGraphEdge extends PeerAccess {
	/** Stable id: `${sourceId}->${targetId}`. Used by reactflow and by the tests. */
	id: string;
	sourceId: string;
	targetId: string;
	description?: string;
	/** Which grant produced this edge, straight from ResolvedPeer.source. */
	source: ResolvedPeer['source'];
}

/**
 * Which agents the graph is about. A group scope matches on `groupId` equality,
 * the same way the group grant does: it reaches neither a parent group nor a
 * child group.
 */
export type DelegationGraphScope = { kind: 'all' } | { kind: 'group'; groupId: string };

export interface DelegationGraphModel {
	nodes: DelegationGraphNode[];
	edges: DelegationGraphEdge[];
}
