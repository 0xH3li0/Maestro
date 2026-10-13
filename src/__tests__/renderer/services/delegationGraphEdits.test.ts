/**
 * Tests for delegationGraphEdits - the Delegation Graph's writes to a roster.
 *
 * An edge from A to B is a row for B in A's `peerAgents`. What is pinned here
 * is that the write touches A and nothing else, that it edits a row in place,
 * and that a refusal writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DELEGATION_EDGE_NEEDS_ACCESS,
	writeDelegationEdge,
} from '../../../renderer/services/delegationGraphEdits';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { buildDelegationGraph, edgeBetween, isMutual } from '../../../shared/delegationGraph';
import { SELF_PEER_ERROR } from '../../../shared/peerAgents';
import { createMockSession } from '../../helpers/mockSession';

const GROUP_ID = 'g-1';

/**
 * Alpha holds a row for Gamma, with a note. Beta reaches its group (Alpha)
 * through the group grant only. Gamma reaches nobody.
 */
function fleet(): Session[] {
	return [
		createMockSession({
			id: 'a',
			name: 'Alpha',
			groupId: GROUP_ID,
			peerAgents: [{ sessionId: 'c', read: true, write: false, description: 'Owns the docs' }],
		}),
		createMockSession({
			id: 'b',
			name: 'Beta',
			groupId: GROUP_ID,
			groupPeerAccess: { read: true, write: false },
		}),
		createMockSession({ id: 'c', name: 'Gamma' }),
	];
}

function sessionOf(id: string): Session {
	const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === id);
	if (!session) throw new Error(`no agent ${id}`);
	return session;
}

function model() {
	return buildDelegationGraph({ kind: 'all' }, useSessionStore.getState().sessions);
}

describe('writeDelegationEdge', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: fleet(), groups: [], activeSessionId: 'a' });
		vi.clearAllMocks();
	});

	it('writes exactly one row, into the source only', () => {
		const betaBefore = sessionOf('b');
		const gammaBefore = sessionOf('c');

		const result = writeDelegationEdge('c', 'b', { read: true, write: true, description: '' });

		expect(result).toEqual({
			ok: true,
			peerAgents: [{ sessionId: 'b', read: true, write: true }],
		});
		expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'b', read: true, write: true }]);
		// The agent the edge ends on is the same object: nothing was written to it.
		expect(sessionOf('b')).toBe(betaBefore);
		expect(sessionOf('c')).not.toBe(gammaBefore);
	});

	it('keeps the note, trimmed, and leaves the field absent for a blank one', () => {
		writeDelegationEdge('c', 'a', { read: true, write: false, description: '  Reviews  ' });
		writeDelegationEdge('c', 'b', { read: true, write: false, description: '   ' });

		expect(sessionOf('c').peerAgents).toEqual([
			{ sessionId: 'a', read: true, write: false, description: 'Reviews' },
			{ sessionId: 'b', read: true, write: false },
		]);
	});

	it('leaves the first edge intact when the reverse one is drawn', () => {
		const alphaBefore = sessionOf('a');

		writeDelegationEdge('c', 'a', { read: false, write: true, description: '' });

		expect(sessionOf('a')).toBe(alphaBefore);
		expect(edgeBetween(model(), 'a', 'c')).toMatchObject({ read: true, write: false });
		expect(edgeBetween(model(), 'c', 'a')).toMatchObject({ read: false, write: true });
		expect(isMutual(model(), 'a', 'c')).toBe(true);
	});

	it('edits a row in place when the direction is drawn again', () => {
		writeDelegationEdge('a', 'c', { read: true, write: true, description: 'Owns the docs' });

		expect(sessionOf('a').peerAgents).toEqual([
			{ sessionId: 'c', read: true, write: true, description: 'Owns the docs' },
		]);
	});

	it('clears the note of a row when the note is emptied', () => {
		writeDelegationEdge('a', 'c', { read: true, write: false, description: '' });

		expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'c', read: true, write: false }]);
	});

	it('turns a derived edge into a row, and leaves the grant as it was', () => {
		expect(edgeBetween(model(), 'b', 'a')).toMatchObject({ source: 'group' });

		writeDelegationEdge('b', 'a', { read: true, write: true, description: '' });

		expect(sessionOf('b').peerAgents).toEqual([{ sessionId: 'a', read: true, write: true }]);
		expect(sessionOf('b').groupPeerAccess).toEqual({ read: true, write: false });
		expect(edgeBetween(model(), 'b', 'a')).toMatchObject({
			source: 'explicit',
			read: true,
			write: true,
		});
	});

	it('sends the source, and no other agent, to the main-process store at once', () => {
		writeDelegationEdge('c', 'b', { read: true, write: false, description: '' });

		const calls = vi.mocked(window.maestro.sessions.setMany).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toHaveLength(1);
		expect(calls[0][0][0]).toMatchObject({
			id: 'c',
			peerAgents: [{ sessionId: 'b', read: true, write: false }],
		});
	});

	describe('refusals', () => {
		function expectNothingWritten(before: Session[]): void {
			expect(useSessionStore.getState().sessions).toBe(before);
			expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
		}

		it('refuses an edge with neither bit', () => {
			const before = useSessionStore.getState().sessions;

			expect(writeDelegationEdge('c', 'b', { read: false, write: false, description: '' })).toEqual(
				{ ok: false, error: DELEGATION_EDGE_NEEDS_ACCESS }
			);
			expectNothingWritten(before);
		});

		it('refuses an agent as its own peer', () => {
			const before = useSessionStore.getState().sessions;

			expect(writeDelegationEdge('a', 'a', { read: true, write: false, description: '' })).toEqual({
				ok: false,
				error: SELF_PEER_ERROR,
			});
			expectNothingWritten(before);
		});

		it('refuses a target that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(
				writeDelegationEdge('a', 'gone', { read: true, write: false, description: '' })
			).toEqual({ ok: false, error: 'Peer "gone" is not an agent.' });
			expectNothingWritten(before);
		});

		it('refuses a source that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(
				writeDelegationEdge('gone', 'a', { read: true, write: false, description: '' })
			).toEqual({ ok: false, error: 'Agent not found' });
			expectNothingWritten(before);
		});
	});
});
