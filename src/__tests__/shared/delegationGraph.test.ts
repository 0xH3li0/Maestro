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

const ALL = { kind: 'all' } as const;

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
		const model = buildDelegationGraph({ kind: 'group', groupId: 'g1' }, [
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
