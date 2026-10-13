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

import { resolvePeerRoster, type PeerRosterInput, type ResolvedPeer } from './peerAgents';
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

/** The counts the legend and the empty-state copy read. */
export interface DelegationGraphStats {
	/** Every agent on the graph, `spill` agents included. */
	agents: number;
	/** Directed edges. A pair that reaches each other counts as two. */
	edges: number;
	/** Pairs of agents with an edge in EACH direction. A pair counts once. */
	mutual: number;
	/**
	 * Agents no edge touches. Always in-scope agents: a `spill` agent is on the
	 * graph only because an edge reaches it.
	 */
	isolated: number;
	/** Agents outside the requested scope, a subset of `agents`. */
	spill: number;
}

/**
 * The id of the edge from one agent to another. The builder, the lookups below
 * and the canvas share it, so none of them can disagree about the spelling. A
 * caller that asks "does the reverse edge exist" for every edge builds one
 * `Set` of ids and tests `delegationEdgeId(target, source)`, which `isMutual`
 * answers with a walk of the edge list per call.
 */
export function delegationEdgeId(sourceId: string, targetId: string): string {
	return `${sourceId}->${targetId}`;
}

/**
 * Build the graph for a scope from the live agent list. It takes the same
 * minimal `PeerRosterInput` shape roster resolution does, so the renderer
 * passes its `Session`s and the CLI its own session records.
 *
 * Every agent's roster is resolved, in scope or not, and an edge is kept when
 * EITHER end is in scope. That one rule covers both directions of a group
 * scope: an edge that leaves the group (outbound) and an edge that reaches
 * into it from outside (inbound). Without the inbound half the graph shows
 * only arrows going out and reads as though nobody can reach the group. An
 * edge between two agents that are both outside the scope is not the scope's
 * business and is dropped.
 *
 * Nodes:
 *
 *   - Every in-scope agent gets one, with or without edges. An agent that
 *     nobody reaches and that reaches nobody is exactly what the graph exists
 *     to show.
 *   - An agent outside the scope gets one only when a kept edge names it, and
 *     it is marked `spill` so the canvas can draw it differently.
 *
 * `resolvePeerRoster` has already dropped the agent itself, a row whose agent
 * is gone, and a peer left with neither bit. So there is no self-edge, no
 * dangling edge and no dead edge to guard against here, and each `ResolvedPeer`
 * becomes exactly one edge.
 *
 * The output is sorted (nodes by name, then id; edges by id), so two calls with
 * the same input give the same order and a caller never has to sort.
 */
export function buildDelegationGraph(
	scope: DelegationGraphScope,
	sessions: readonly PeerRosterInput[]
): DelegationGraphModel {
	const inScopeIds = new Set<string>();
	for (const session of sessions) {
		if (scope.kind === 'all' || session.groupId === scope.groupId) inScopeIds.add(session.id);
	}

	const edges: DelegationGraphEdge[] = [];
	const reachedIds = new Set<string>();
	for (const session of sessions) {
		const sourceInScope = inScopeIds.has(session.id);
		for (const peer of resolvePeerRoster(session, sessions)) {
			if (!sourceInScope && !inScopeIds.has(peer.sessionId)) continue;
			edges.push({
				id: delegationEdgeId(session.id, peer.sessionId),
				sourceId: session.id,
				targetId: peer.sessionId,
				read: peer.read,
				write: peer.write,
				...(peer.description ? { description: peer.description } : {}),
				source: peer.source,
			});
			reachedIds.add(session.id);
			reachedIds.add(peer.sessionId);
		}
	}

	const nodes: DelegationGraphNode[] = [];
	for (const session of sessions) {
		const inScope = inScopeIds.has(session.id);
		if (!inScope && !reachedIds.has(session.id)) continue;
		nodes.push({
			sessionId: session.id,
			name: session.name,
			...(session.groupId ? { groupId: session.groupId } : {}),
			scope: inScope ? 'in-scope' : 'spill',
		});
	}

	return {
		nodes: nodes.sort(
			(a, b) => a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId)
		),
		// Code-unit order, not `localeCompare`: an edge id is built from agent ids,
		// which are not words, and this order is the same on every machine.
		edges: edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	};
}

/**
 * The edge from `sourceId` to `targetId`, when there is one. Direction matters:
 * the edge from `targetId` back to `sourceId` is a different edge.
 */
export function edgeBetween(
	model: DelegationGraphModel,
	sourceId: string,
	targetId: string
): DelegationGraphEdge | undefined {
	return model.edges.find((edge) => edge.sourceId === sourceId && edge.targetId === targetId);
}

/**
 * True when edges exist in BOTH directions between two agents, whichever bits
 * each one carries. This is the "bidirectional" question, answered from two
 * edges because it is stored on neither. A manager who may delegate to an
 * employee who may only consult back is mutual.
 */
export function isMutual(model: DelegationGraphModel, a: string, b: string): boolean {
	return edgeBetween(model, a, b) !== undefined && edgeBetween(model, b, a) !== undefined;
}

/**
 * Every agent at least one edge touches, at either end. An agent on the graph
 * that is NOT in this set is isolated: nobody reaches it and it reaches nobody.
 * `delegationGraphStats` counts those agents and the canvas marks them, and
 * both ask here so the two cannot disagree about which agents they are.
 */
export function connectedAgentIds(model: DelegationGraphModel): Set<string> {
	const connectedIds = new Set<string>();
	for (const edge of model.edges) {
		connectedIds.add(edge.sourceId);
		connectedIds.add(edge.targetId);
	}
	return connectedIds;
}

/**
 * Count what is on the graph. `agents` includes the `spill` agents, so the
 * in-scope count is `agents - spill`.
 */
export function delegationGraphStats(model: DelegationGraphModel): DelegationGraphStats {
	const edgeIds = new Set(model.edges.map((edge) => edge.id));
	const connectedIds = connectedAgentIds(model);

	// A mutual pair is two edges. Count it at the one whose source id sorts
	// first, so the pair counts once.
	let mutual = 0;
	for (const edge of model.edges) {
		if (
			edge.sourceId < edge.targetId &&
			edgeIds.has(delegationEdgeId(edge.targetId, edge.sourceId))
		) {
			mutual++;
		}
	}

	let isolated = 0;
	let spill = 0;
	for (const node of model.nodes) {
		if (!connectedIds.has(node.sessionId)) isolated++;
		if (node.scope === 'spill') spill++;
	}

	return { agents: model.nodes.length, edges: model.edges.length, mutual, isolated, spill };
}
