/**
 * useDelegationGraphModel - the Delegation Graph of one scope, from the live
 * agent list.
 *
 * `buildDelegationGraph` resolves every agent's roster, so it must not run on
 * every render, and the session store replaces its `sessions` array on every
 * batch of streamed output. The subscription therefore compares only the
 * fields the graph is built from (`delegationRosterEquality`): the model is
 * rebuilt when an agent is added, removed, renamed, moved to another group, or
 * has a peer field edited, and at no other time.
 *
 * The group list is not an input. A group scope matches on `groupId`, which is
 * a field of the agent.
 */

import { useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
	buildDelegationGraph,
	type DelegationGraphModel,
	type DelegationGraphScope,
} from '../../../shared/delegationGraph';
import { delegationRosterEquality } from '../../stores/sessionEquality';
import { useSessionStore } from '../../stores/sessionStore';

export function useDelegationGraphModel(scope: DelegationGraphScope): DelegationGraphModel {
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(store) => store.sessions,
		delegationRosterEquality
	);
	// The scope is keyed by its one varying field, so a caller that builds a new
	// scope object on every render does not rebuild the model.
	const groupId = scope.kind === 'group' ? scope.groupId : undefined;
	return useMemo(
		() =>
			buildDelegationGraph(
				groupId === undefined ? { kind: 'all' } : { kind: 'group', groupId },
				sessions
			),
		[groupId, sessions]
	);
}
