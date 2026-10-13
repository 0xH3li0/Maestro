/**
 * Delegation Graph - the fleet's peer rosters as nodes and directed edges.
 *
 * The graph owns no precedence: every edge is a `ResolvedPeer` from
 * `resolvePeerRoster`, whose rules are asserted in `peerAgents.test.ts`. These
 * tests cover what the graph adds on top: direction, scope, and the queries a
 * canvas asks of the model.
 */

import { describe, it, expect } from 'vitest';

import {
	buildDelegationGraph,
	connectedAgentIds,
	delegationEdgeId,
	delegationGraphStats,
	edgeBetween,
	isMutual,
} from '../../shared/delegationGraph';
import type { DelegationGraphModel } from '../../shared/delegationGraph';
import type { PeerRosterInput } from '../../shared/peerAgents';
import type { PeerAccess, PeerAgent } from '../../shared/types';

const R: PeerAccess = { read: true, write: false };
const W: PeerAccess = { read: false, write: true };
const RW: PeerAccess = { read: true, write: true };

function agent(id: string, name: string, extra: Partial<PeerRosterInput> = {}): PeerRosterInput {
	return { id, name, ...extra };
}

function row(sessionId: string, access: PeerAccess): PeerAgent {
	return { sessionId, ...access };
}

const NONE: PeerAccess = { read: false, write: false };

const ALL = { kind: 'all' } as const;
const G1 = { kind: 'group', groupId: 'g1' } as const;

// The canvas builds one Set of edge ids and asks for the reverse of each edge.
describe('delegationEdgeId', () => {
	it('is the id the builder gives the edge between the same two agents', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alpha', { peerAgents: [row('b', R)] }),
			agent('b', 'Beta'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual([delegationEdgeId('a', 'b')]);
	});

	it('is directed: the reverse edge has another id', () => {
		expect(delegationEdgeId('a', 'b')).not.toBe(delegationEdgeId('b', 'a'));
	});
});

describe('buildDelegationGraph', () => {
	it('draws a manager and an employee as two edges, each with its own bits', () => {
		const model = buildDelegationGraph(ALL, [
			agent('m', 'Manager', { peerAgents: [row('e', RW)] }),
			agent('e', 'Employee', { peerAgents: [row('m', R)] }),
		]);

		expect(model.edges).toEqual([
			{ id: 'e->m', sourceId: 'e', targetId: 'm', read: true, write: false, source: 'explicit' },
			{ id: 'm->e', sourceId: 'm', targetId: 'e', read: true, write: true, source: 'explicit' },
		]);
		expect(isMutual(model, 'm', 'e')).toBe(true);
		expect(edgeBetween(model, 'e', 'm')?.write).toBe(false);
	});

	it('draws one edge when only one agent lists the other, and still gives the target a node', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->b']);
		expect(isMutual(model, 'a', 'b')).toBe(false);
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', scope: 'in-scope' },
			{ sessionId: 'b', name: 'Bob', scope: 'in-scope' },
		]);
	});

	it('copies the description and the grant source from the resolved peer', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [{ ...row('b', R), description: 'Owns the docs' }] }),
			agent('b', 'Bob'),
			agent('p', 'Parent', { worktreePeerAccess: W }),
			agent('w', 'Worktree', { parentSessionId: 'p' }),
		]);

		expect(edgeBetween(model, 'a', 'b')).toMatchObject({
			description: 'Owns the docs',
			source: 'explicit',
		});
		expect(edgeBetween(model, 'p', 'w')).toEqual({
			id: 'p->w',
			sourceId: 'p',
			targetId: 'w',
			read: false,
			write: true,
			source: 'worktree',
		});
	});

	it('never marks an agent as spill when the scope is every agent', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
			agent('z', 'Zed'),
		]);

		expect(model.nodes.map((node) => node.scope)).toEqual(['in-scope', 'in-scope', 'in-scope']);
	});

	it('keeps an edge that leaves the group, and marks its target as spill', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->x']);
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'x', name: 'Xavier', groupId: 'g2', scope: 'spill' },
		]);
	});

	it('keeps an edge that reaches into the group from outside, pointing in', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1' }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('a', W)] }),
		]);

		expect(model.edges).toEqual([
			{ id: 'y->a', sourceId: 'y', targetId: 'a', read: false, write: true, source: 'explicit' },
		]);
		expect(edgeBetween(model, 'a', 'y')).toBeUndefined();
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'y', name: 'Yara', groupId: 'g2', scope: 'spill' },
		]);
	});

	it('drops an edge between two agents that are both outside the group, and gives neither a node', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2', peerAgents: [row('y', RW)] }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('x', RW)] }),
		]);

		expect(model.edges).toEqual([]);
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a']);
	});

	it('treats a nested group as outside the scope: groups match on id only', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('n', R)] }),
			agent('n', 'Nested', { groupId: 'g1-child' }),
			agent('o', 'Other', { groupId: 'g1-child' }),
		]);

		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'n', name: 'Nested', groupId: 'g1-child', scope: 'spill' },
		]);
	});

	it('draws no edge for an exclusion row over a group grant', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [row('b', NONE)],
			}),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('c', 'Carol', { groupId: 'g1' }),
		]);

		expect(edgeBetween(model, 'a', 'b')).toBeUndefined();
		expect(model.edges).toEqual([
			{ id: 'a->c', sourceId: 'a', targetId: 'c', read: true, write: true, source: 'group' },
		]);
		// Bob is excluded, not removed: he is still an agent of the group.
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
	});

	it('gives an in-scope agent a node when no edge touches it', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('b', R)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('i', 'Isolde', { groupId: 'g1' }),
		]);

		expect(model.nodes).toContainEqual({
			sessionId: 'i',
			name: 'Isolde',
			groupId: 'g1',
			scope: 'in-scope',
		});
		expect(model.edges.some((edge) => edge.sourceId === 'i' || edge.targetId === 'i')).toBe(false);
	});

	it('draws no node and no edge for a row that points at a deleted agent', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('gone', RW), row('b', R)] }),
			agent('b', 'Bob'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->b']);
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a', 'b']);
	});

	it('returns an empty graph for a group with no agents', () => {
		const model = buildDelegationGraph({ kind: 'group', groupId: 'empty' }, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('b', R)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
		]);

		expect(model).toEqual({ nodes: [], edges: [] });
	});

	it('gives the same order for the same input, in whatever order the agents arrive', () => {
		const sessions = [
			agent('c', 'Carol', { groupId: 'g1', peerAgents: [row('a', R), row('x', W)] }),
			agent('a2', 'Alice', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2', peerAgents: [row('a', RW)] }),
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('c', RW)] }),
		];

		const first = buildDelegationGraph(G1, sessions);

		expect(buildDelegationGraph(G1, sessions)).toEqual(first);
		expect(buildDelegationGraph(G1, [...sessions].reverse())).toEqual(first);
		// Two agents share a name, so the id breaks the tie.
		expect(first.nodes.map((node) => node.sessionId)).toEqual(['a', 'a2', 'c', 'x']);
		expect(first.edges.map((edge) => edge.id)).toEqual(['a->c', 'c->a', 'c->x', 'x->a']);
	});
});

describe('edgeBetween', () => {
	const model = buildDelegationGraph(ALL, [
		agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
		agent('b', 'Bob'),
	]);

	it('returns the edge from the source to the target', () => {
		expect(edgeBetween(model, 'a', 'b')).toEqual({
			id: 'a->b',
			sourceId: 'a',
			targetId: 'b',
			read: true,
			write: true,
			source: 'explicit',
		});
	});

	it('is directional: the edge back is a different edge, and here there is none', () => {
		expect(edgeBetween(model, 'b', 'a')).toBeUndefined();
	});

	it('returns undefined for an agent the graph does not hold', () => {
		expect(edgeBetween(model, 'a', 'gone')).toBeUndefined();
		expect(edgeBetween(model, 'gone', 'b')).toBeUndefined();
	});
});

describe('isMutual', () => {
	it('is true when an edge exists in each direction, whichever bits each carries', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', W)] }),
			agent('b', 'Bob', { peerAgents: [row('a', R)] }),
		]);

		expect(isMutual(model, 'a', 'b')).toBe(true);
		expect(isMutual(model, 'b', 'a')).toBe(true);
	});

	it('is false when only one direction exists', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
			agent('b', 'Bob'),
		]);

		expect(isMutual(model, 'a', 'b')).toBe(false);
		expect(isMutual(model, 'b', 'a')).toBe(false);
	});

	it('is false for an agent and itself, and for an agent the graph does not hold', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
			agent('b', 'Bob', { peerAgents: [row('a', RW)] }),
		]);

		expect(isMutual(model, 'a', 'a')).toBe(false);
		expect(isMutual(model, 'a', 'gone')).toBe(false);
	});
});

describe('connectedAgentIds', () => {
	it('is empty on a graph with no edges', () => {
		const model = buildDelegationGraph(ALL, [agent('a', 'Alice'), agent('b', 'Bob')]);

		expect(connectedAgentIds(model).size).toBe(0);
	});

	it('holds both ends of every edge and leaves out an agent no edge touches', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
			agent('c', 'Carol'),
		]);

		expect([...connectedAgentIds(model)].sort()).toEqual(['a', 'b']);
	});

	// A spill agent is on the graph only because an edge reaches it, so it is
	// always connected. The canvas relies on this: a node is spill OR isolated.
	it('always holds a spill agent', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
		]);
		const connected = connectedAgentIds(model);

		for (const node of model.nodes.filter((n) => n.scope === 'spill')) {
			expect(connected.has(node.sessionId)).toBe(true);
		}
		expect(connected.has('x')).toBe(true);
	});
});

describe('delegationGraphStats', () => {
	it('counts nothing on an empty graph', () => {
		const empty: DelegationGraphModel = { nodes: [], edges: [] };

		expect(delegationGraphStats(empty)).toEqual({
			agents: 0,
			edges: 0,
			mutual: 0,
			isolated: 0,
			spill: 0,
		});
	});

	it('counts a mutual pair once in `mutual` and twice in `edges`', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW), row('c', R)] }),
			agent('b', 'Bob', { peerAgents: [row('a', R)] }),
			agent('c', 'Carol'),
		]);

		expect(delegationGraphStats(model)).toEqual({
			agents: 3,
			edges: 3,
			mutual: 1,
			isolated: 0,
			spill: 0,
		});
	});

	it('counts an agent no edge touches as isolated', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
			agent('c', 'Carol'),
			agent('d', 'Dave'),
		]);

		expect(delegationGraphStats(model)).toMatchObject({ agents: 4, edges: 1, isolated: 2 });
	});

	it('counts spill agents inside `agents`, and never as isolated', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2' }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('a', R)] }),
			agent('z', 'Zed', { groupId: 'g2' }),
		]);

		expect(delegationGraphStats(model)).toEqual({
			agents: 4,
			edges: 2,
			mutual: 0,
			isolated: 1,
			spill: 2,
		});
	});
});
