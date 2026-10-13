/**
 * Tests for useDelegationGraphModel - the graph of one scope from the live
 * agent list.
 *
 * `buildDelegationGraph` itself is covered in `shared/delegationGraph.test.ts`.
 * These cases cover what the hook adds: WHEN the model is rebuilt. The session
 * store replaces its array on every batch of streamed output, and the graph
 * must not be rebuilt for that.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDelegationGraphModel } from '../../../../renderer/components/DelegationGraph/useDelegationGraphModel';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';
import type { DelegationGraphScope } from '../../../../shared/delegationGraph';
import { createMockSession } from '../../../helpers/mockSession';

const ALL: DelegationGraphScope = { kind: 'all' };

function patchSession(id: string, patch: Partial<Session>): void {
	act(() => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) =>
				session.id === id ? { ...session, ...patch } : session
			),
		}));
	});
}

describe('useDelegationGraphModel', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'a',
					name: 'Alpha',
					groupId: 'g-1',
					peerAgents: [{ sessionId: 'b', read: true, write: false }],
				}),
				createMockSession({ id: 'b', name: 'Beta', groupId: 'g-2' }),
				createMockSession({ id: 'c', name: 'Gamma', groupId: 'g-2' }),
			],
		});
	});

	it('builds the graph of every agent for the all scope', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
		expect(result.current.edges.map((edge) => edge.id)).toEqual(['a->b']);
	});

	it('builds the graph of one group, with the agents its edges reach', () => {
		const { result } = renderHook(() => useDelegationGraphModel({ kind: 'group', groupId: 'g-1' }));

		expect(result.current.nodes).toEqual([
			{ sessionId: 'a', name: 'Alpha', groupId: 'g-1', scope: 'in-scope' },
			{ sessionId: 'b', name: 'Beta', groupId: 'g-2', scope: 'spill' },
		]);
	});

	// A busy fleet replaces every session object several times a second.
	it('keeps the same model when a field the graph does not read changes', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));
		const before = result.current;

		patchSession('a', { state: 'busy' });
		patchSession('b', { contextUsage: 42 });

		expect(result.current).toBe(before);
	});

	it('keeps the same model when the caller passes a new scope object for the same scope', () => {
		const { result, rerender } = renderHook(() =>
			useDelegationGraphModel({ kind: 'group', groupId: 'g-2' })
		);
		const before = result.current;

		rerender();

		expect(result.current).toBe(before);
	});

	it('rebuilds on a rename', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		patchSession('b', { name: 'Zeta' });

		expect(result.current.nodes.map((node) => node.name)).toEqual(['Alpha', 'Gamma', 'Zeta']);
	});

	it('rebuilds when a peer field is edited', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		patchSession('c', { peerAgents: [{ sessionId: 'a', read: false, write: true }] });

		expect(result.current.edges.map((edge) => edge.id)).toEqual(['a->b', 'c->a']);
	});

	it('rebuilds when an agent changes group', () => {
		const { result } = renderHook(() => useDelegationGraphModel({ kind: 'group', groupId: 'g-2' }));
		// Alpha is outside the group and is drawn because its edge reaches Beta.
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);

		patchSession('c', { groupId: 'g-1' });

		expect(result.current.nodes.find((node) => node.sessionId === 'c')).toBeUndefined();
	});

	it('rebuilds when an agent is added or removed', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		act(() => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.filter((session) => session.id !== 'b'),
			}));
		});

		// The edge to the agent that is gone goes with it.
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'c']);
		expect(result.current.edges).toEqual([]);
	});

	it('changes model when the scope changes', () => {
		const { result, rerender } = renderHook(
			({ scope }: { scope: DelegationGraphScope }) => useDelegationGraphModel(scope),
			{ initialProps: { scope: ALL } }
		);
		expect(result.current.nodes).toHaveLength(3);

		rerender({ scope: { kind: 'group', groupId: 'g-1' } });

		expect(result.current.nodes).toHaveLength(2);
	});
});
