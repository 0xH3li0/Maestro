import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentDisplayName, PICKABLE_AGENT_IDS } from '../../../../shared/agentMetadata';
import { getDeclaredTranslationDirection } from '../../../../shared/maestro-lib/translation/support';
import type { AgentConfig, Session, ToolType } from '../../../types';
import { useTabStore } from '../../../stores/tabStore';
import { getSessionSshRemoteId } from '../../../utils/sessionHelpers';
import {
	filterToAvailableProviders,
	tabProviderSwitchProblem,
} from '../../../utils/providerAvailability';
import { resolveTabNativeProvider, resolveTabProvider } from '../../../utils/providerTabSessions';

/** One choice model for the desktop pill and the phone accordion. */
export function useTabProviderChoice(session: Session, enabled: boolean) {
	const tab = session.aiTabs.find((item) => item.id === session.activeTabId);
	const tabId = tab?.id;
	const current = resolveTabProvider(tab, session);
	const host = getSessionSshRemoteId(session);
	const scope = `${session.id}:${tabId}:${host ?? ''}`;
	const activeScope = useRef(scope);
	activeScope.current = scope;
	const [detected, setDetected] = useState<{
		scope: string;
		agents: AgentConfig[];
		error?: string;
	}>();
	const [failure, setFailure] = useState<{ scope: string; message: string }>();
	const [pending, setPending] = useState<string>();
	const switching = useRef(false);
	const [showAll, setShowAll] = useState(false);

	useEffect(() => {
		if (!enabled || !tabId || host || session.sessionSshRemoteConfig?.enabled) return;
		let stale = false;
		void window.maestro.agents.detect().then(
			(agents) => {
				if (!stale) setDetected({ scope, agents });
			},
			(error: unknown) => {
				if (!stale)
					setDetected({
						scope,
						agents: [],
						error: error instanceof Error ? error.message : String(error),
					});
			}
		);
		return () => {
			stale = true;
		};
	}, [enabled, scope, host, tabId, session.sessionSshRemoteConfig?.enabled]);

	const select = useCallback(
		async (provider: ToolType | undefined) => {
			if (!enabled || !tabId || switching.current) return false;
			switching.current = true;
			setPending(scope);
			setFailure(undefined);
			try {
				await useTabStore.getState().setTabProvider(session.id, tabId, provider);
				return true;
			} catch (error) {
				if (activeScope.current === scope)
					setFailure({ scope, message: error instanceof Error ? error.message : String(error) });
				return false;
			} finally {
				switching.current = false;
				setPending(undefined);
			}
		},
		[enabled, session.id, tabId, scope]
	);

	const agents = detected?.scope === scope ? detected.agents : [];
	const loading = detected?.scope !== scope;
	const problemFor = (destination: ToolType) => {
		if (!tab) return 'No conversation selected.';
		const problem = tabProviderSwitchProblem(session, tab, destination, enabled);
		if (problem) return problem;
		if (destination !== current && loading) return 'Checking providers on this host...';
		if (destination !== current && detected?.error)
			return `Could not detect providers on this host: ${detected.error}`;
		return (
			tabProviderSwitchProblem(
				session,
				tab,
				destination,
				enabled,
				agents.some((agent) => agent.id === destination && agent.available)
			) ?? (pending === scope ? 'Changing provider...' : undefined)
		);
	};
	const source = resolveTabNativeProvider(tab, session);
	const options = [
		{
			provider: undefined,
			label: `Use agent default (${getAgentDisplayName(session.toolType)})`,
			selected: !tab?.tabProvider,
			problem: problemFor(session.toolType),
			description: undefined,
		},
		...filterToAvailableProviders(
			[...PICKABLE_AGENT_IDS],
			(id) => agents.some((agent) => agent.id === id && agent.available),
			showAll,
			(id) => id === current
		).map((id) => ({
			provider: id as ToolType,
			label: getAgentDisplayName(id),
			selected: current === id,
			problem: problemFor(id as ToolType),
			description:
				id !== current &&
				id !== source &&
				getDeclaredTranslationDirection(source, id)?.verification === 'unverified'
					? 'Context translation is unverified; review required before sending.'
					: undefined,
		})),
	];
	return {
		current,
		label: getAgentDisplayName(current),
		options,
		select,
		showAll,
		setShowAll,
		problem: !tab
			? 'No conversation selected.'
			: tabProviderSwitchProblem(session, tab, current, enabled),
		error: failure?.scope === scope ? failure.message : undefined,
		loading,
		pending: pending === scope,
	};
}

export type TabProviderChoice = ReturnType<typeof useTabProviderChoice>;
