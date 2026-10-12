/**
 * Peer Agents - normalization, access labelling, and roster resolution.
 *
 * The roster is never persisted: it is rebuilt from an agent's three stored
 * sources (explicit rows, the group grant, the worktree grant) and the live
 * agent list. The precedence between those sources is the feature, so each
 * rule is asserted on directly.
 */

import { describe, it, expect } from 'vitest';

import {
	normalizePeerAgents,
	peerAccessLabel,
	hasAnyPeerAccess,
	mergePeerAccess,
	resolvePeerRoster,
} from '../../shared/peerAgents';
import type { PeerRosterInput } from '../../shared/peerAgents';
import type { PeerAccess, PeerAgent } from '../../shared/types';

const R: PeerAccess = { read: true, write: false };
const W: PeerAccess = { read: false, write: true };
const RW: PeerAccess = { read: true, write: true };
const NONE: PeerAccess = { read: false, write: false };

function agent(id: string, name: string, extra: Partial<PeerRosterInput> = {}): PeerRosterInput {
	return { id, name, ...extra };
}

describe('normalizePeerAgents', () => {
	it('returns undefined for an empty or missing list', () => {
		expect(normalizePeerAgents(undefined)).toBeUndefined();
		expect(normalizePeerAgents([])).toBeUndefined();
	});

	it('trims session ids and drops rows with a blank id', () => {
		const result = normalizePeerAgents([
			{ sessionId: '  agent-2  ', read: true, write: false },
			{ sessionId: '   ', read: true, write: true },
			{ sessionId: '', read: true, write: true },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: false }]);
	});

	it('returns undefined when every row is blank', () => {
		expect(normalizePeerAgents([{ sessionId: '  ', read: true, write: true }])).toBeUndefined();
	});

	it("collapses duplicate session ids, keeping the last row's access", () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false },
			{ sessionId: 'agent-3', read: true, write: true },
			{ sessionId: 'agent-2', read: false, write: true },
		]);
		expect(result).toEqual([
			{ sessionId: 'agent-2', read: false, write: true },
			{ sessionId: 'agent-3', read: true, write: true },
		]);
	});

	it('treats ids that match only after trimming as duplicates', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false },
			{ sessionId: ' agent-2 ', read: true, write: true },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: true }]);
	});

	it('keeps a row with neither bit set, because it is an exclusion', () => {
		const result = normalizePeerAgents([{ sessionId: 'agent-2', read: false, write: false }]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: false, write: false }]);
	});

	it('carries a trimmed description through', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false, description: '  Owns the docs  ' },
		]);
		expect(result).toEqual([
			{ sessionId: 'agent-2', read: true, write: false, description: 'Owns the docs' },
		]);
	});

	it('omits the description field when it is blank', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false, description: '   ' },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: false }]);
		expect(result?.[0]).not.toHaveProperty('description');
	});

	it('coerces missing access bits to false', () => {
		const result = normalizePeerAgents([{ sessionId: 'agent-2' } as unknown as PeerAgent]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: false, write: false }]);
	});

	it('does not mutate the rows it was given', () => {
		const rows: PeerAgent[] = [
			{ sessionId: '  agent-2  ', read: true, write: false, description: '  hint  ' },
		];
		normalizePeerAgents(rows);
		expect(rows).toEqual([
			{ sessionId: '  agent-2  ', read: true, write: false, description: '  hint  ' },
		]);
	});
});

describe('peerAccessLabel', () => {
	it('names each of the four access pairs', () => {
		expect(peerAccessLabel(RW)).toBe('Consult + Delegate');
		expect(peerAccessLabel(R)).toBe('Consult only');
		expect(peerAccessLabel(W)).toBe('Delegate only');
		expect(peerAccessLabel(NONE)).toBe('No access');
	});
});

describe('hasAnyPeerAccess', () => {
	it('is true when either bit is set and false when neither is', () => {
		expect(hasAnyPeerAccess(RW)).toBe(true);
		expect(hasAnyPeerAccess(R)).toBe(true);
		expect(hasAnyPeerAccess(W)).toBe(true);
		expect(hasAnyPeerAccess(NONE)).toBe(false);
	});
});

describe('mergePeerAccess', () => {
	it('ORs the two pairs bit by bit', () => {
		expect(mergePeerAccess(R, W)).toEqual(RW);
		expect(mergePeerAccess(R, R)).toEqual(R);
		expect(mergePeerAccess(NONE, W)).toEqual(W);
		expect(mergePeerAccess(NONE, NONE)).toEqual(NONE);
	});

	it('returns only the two access bits, whatever else the inputs carry', () => {
		const merged = mergePeerAccess({ sessionId: 'agent-2', ...R } as PeerAccess, W);
		expect(merged).toEqual({ read: true, write: true });
	});
});

describe('resolvePeerRoster', () => {
	it('returns an empty roster when the agent has no peer source', () => {
		const me = agent('me', 'Me', { groupId: 'g1' });
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
		expect(resolvePeerRoster(me, all)).toEqual([]);
	});

	describe('group grant', () => {
		it('picks up the other members of the group and excludes the agent itself', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: R });
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
				agent('c', 'Charlie', { groupId: 'g2' }),
				agent('d', 'Delta'),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'group' },
				{ sessionId: 'b', name: 'Bravo', read: true, write: false, source: 'group' },
			]);
		});

		it('grants nothing when the agent is in no group', () => {
			const me = agent('me', 'Me', { groupPeerAccess: RW });
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo', { groupId: '' })];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});

		it('adds no peer when the grant is present with neither bit set', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: NONE });
			const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});
	});

	describe('worktree grant', () => {
		it('picks up the worktree parent and the sibling worktree children', () => {
			const me = agent('me', 'Me', { parentSessionId: 'parent', worktreePeerAccess: R });
			const all = [
				agent('parent', 'Parent'),
				me,
				agent('sib', 'Sibling', { parentSessionId: 'parent' }),
				agent('cousin', 'Cousin', { parentSessionId: 'other-parent' }),
				agent('loner', 'Loner'),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'parent', name: 'Parent', read: true, write: false, source: 'worktree' },
				{ sessionId: 'sib', name: 'Sibling', read: true, write: false, source: 'worktree' },
			]);
		});

		it("picks up the agent's own worktree children", () => {
			const me = agent('me', 'Me', { worktreePeerAccess: W });
			const all = [
				me,
				agent('kid-1', 'Kid One', { parentSessionId: 'me' }),
				agent('kid-2', 'Kid Two', { parentSessionId: 'me' }),
				agent('stranger', 'Stranger', { parentSessionId: 'someone-else' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'kid-1', name: 'Kid One', read: false, write: true, source: 'worktree' },
				{ sessionId: 'kid-2', name: 'Kid Two', read: false, write: true, source: 'worktree' },
			]);
		});

		it('does not treat two agents with no parent as siblings', () => {
			const me = agent('me', 'Me', { worktreePeerAccess: RW });
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo')];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});
	});

	describe('overlapping grants', () => {
		it('unions the access bits of a peer both grants cover and keeps the group source', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				parentSessionId: 'parent',
				groupPeerAccess: R,
				worktreePeerAccess: W,
			});
			const all = [
				me,
				agent('parent', 'Parent'),
				agent('both', 'Both', { groupId: 'g1', parentSessionId: 'parent' }),
				agent('group-only', 'Group Only', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'both', name: 'Both', read: true, write: true, source: 'group' },
				{ sessionId: 'group-only', name: 'Group Only', read: true, write: false, source: 'group' },
				{ sessionId: 'parent', name: 'Parent', read: false, write: true, source: 'worktree' },
			]);
		});
	});

	describe('explicit rows', () => {
		it('adds a peer no grant covers, with its description', () => {
			const me = agent('me', 'Me', {
				peerAgents: [{ sessionId: 'a', read: true, write: false, description: 'Owns the docs' }],
			});
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo')];
			expect(resolvePeerRoster(me, all)).toEqual([
				{
					sessionId: 'a',
					name: 'Alpha',
					read: true,
					write: false,
					description: 'Owns the docs',
					source: 'explicit',
				},
			]);
		});

		it('leaves the description field absent when the row has none', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'a', read: true, write: true }] });
			const [peer] = resolvePeerRoster(me, [me, agent('a', 'Alpha')]);
			expect(peer).not.toHaveProperty('description');
		});

		it('demotes a peer the group grant gave R+W down to R', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [{ sessionId: 'a', read: true, write: false }],
			});
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
				{ sessionId: 'b', name: 'Bravo', read: true, write: true, source: 'group' },
			]);
		});

		it('replaces the granted access instead of unioning with it', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: W,
				peerAgents: [{ sessionId: 'a', read: true, write: false }],
			});
			const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
			]);
		});

		it('removes a peer the group grant would have included when neither bit is set', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [{ sessionId: 'b', read: false, write: false }],
			});
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: true, source: 'group' },
			]);
		});

		it('removes a peer the worktree grant would have included when neither bit is set', () => {
			const me = agent('me', 'Me', {
				parentSessionId: 'parent',
				worktreePeerAccess: RW,
				peerAgents: [{ sessionId: 'sib', read: false, write: false }],
			});
			const all = [
				me,
				agent('parent', 'Parent'),
				agent('sib', 'Sibling', { parentSessionId: 'parent' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'parent', name: 'Parent', read: true, write: true, source: 'worktree' },
			]);
		});

		it('drops a row that points at a deleted agent', () => {
			const me = agent('me', 'Me', {
				peerAgents: [
					{ sessionId: 'gone', read: true, write: true, description: 'Deleted last week' },
					{ sessionId: 'a', read: true, write: false },
				],
			});
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
			]);
		});

		it('drops a row that names the agent itself', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'me', read: true, write: true }] });
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([]);
		});

		it('resolves a list that was never normalized the way its persisted form would', () => {
			const me = agent('me', 'Me', {
				peerAgents: [
					{ sessionId: ' a ', read: true, write: true },
					{ sessionId: 'a', read: true, write: false, description: '  Ask about the API  ' },
				],
			});
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([
				{
					sessionId: 'a',
					name: 'Alpha',
					read: true,
					write: false,
					description: 'Ask about the API',
					source: 'explicit',
				},
			]);
		});
	});

	describe('names and order', () => {
		it('takes the name from the live agent list, so a rename needs no edit to the row', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'a', read: true, write: false }] });
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])[0].name).toBe('Alpha');
			expect(resolvePeerRoster(me, [me, agent('a', 'Renamed')])[0].name).toBe('Renamed');
		});

		it('sorts the roster by name, whatever order the sources produced it in', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: R,
				peerAgents: [{ sessionId: 'x', read: true, write: true }],
			});
			const all = [
				agent('z', 'Zulu', { groupId: 'g1' }),
				me,
				agent('x', 'Bravo'),
				agent('c', 'Charlie', { groupId: 'g1' }),
				agent('a', 'Alpha', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all).map((peer) => peer.name)).toEqual([
				'Alpha',
				'Bravo',
				'Charlie',
				'Zulu',
			]);
		});

		it('breaks a tie between two agents of one name by session id', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: R });
			const all = [
				me,
				agent('b-2', 'Twin', { groupId: 'g1' }),
				agent('a-1', 'Twin', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all).map((peer) => peer.sessionId)).toEqual(['a-1', 'b-2']);
		});
	});

	it('does not mutate the agent or the agent list', () => {
		const me = agent('me', 'Me', {
			groupId: 'g1',
			groupPeerAccess: RW,
			peerAgents: [{ sessionId: ' a ', read: false, write: false }],
		});
		const all = [
			me,
			agent('a', 'Alpha', { groupId: 'g1' }),
			agent('b', 'Bravo', { groupId: 'g1' }),
		];
		const before = JSON.stringify(all);
		resolvePeerRoster(me, all);
		expect(JSON.stringify(all)).toBe(before);
	});
});
