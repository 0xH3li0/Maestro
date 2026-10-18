/**
 * Shared rules for "show only the providers this machine can actually run".
 *
 * Most of the providers Maestro supports are not installed on any given machine,
 * so listing all of them buries the two or three a user can pick behind a wall of
 * dimmed rows. Both provider pickers (the wizard's tile strip and the New Agent
 * modal's list) hide the rest by default and offer one toggle to bring them back.
 *
 * The rules live here rather than in either picker so the two cannot drift on the
 * part that matters: what the count means, and when filtering is unsafe.
 */

import { getAgentDisplayName, getAgentPickerMeta } from '../../shared/agentMetadata';
import { getDeclaredTranslationDirection } from '../../shared/maestro-lib/translation/support';
import { migrationHoldsTurns } from '../../shared/maestro-lib/translation/session';
import type { AITab, Session, ToolType } from '../types';
import { resolveTabNativeProvider, resolveTabProvider } from './providerTabSessions';

/** Shared refusal for the composer and the CLI's authoritative switch action. */
export function tabProviderSwitchProblem(
	session: Session,
	tab: AITab,
	destination: ToolType,
	ensemble: boolean,
	available?: boolean
): string | undefined {
	if (!ensemble) return 'Ensemble is disabled. Enable Ensemble in Encore Features.';
	if (!getAgentPickerMeta(destination))
		return `Provider cannot run an Ensemble tab: ${destination}`;
	if (migrationHoldsTurns(session.providerMigration))
		return 'Finish the current provider translation before changing providers.';
	if (session.sessionSshRemoteConfig?.enabled || session.sshRemoteId)
		return 'Ensemble SSH switching is disabled: provider switching over SSH is unverified; live SSH acceptance was skipped.';
	const current = resolveTabProvider(tab, session);
	const source = resolveTabNativeProvider(tab, session);
	if (destination !== current && destination !== source) {
		if (!getDeclaredTranslationDirection(source, destination))
			return `Context translation from ${getAgentDisplayName(source)} to ${getAgentDisplayName(destination)} is not available.`;
	}
	if (destination !== current && available === false)
		return `${getAgentDisplayName(destination)} is not installed on this host.`;
	return undefined;
}

/**
 * Narrow a provider list to the ones that are installed.
 *
 * Returns everything when `showAll` is set, and ALSO when nothing is installed:
 * filtering there leaves a picker with no rows, which means no way to reach the
 * per-provider settings that would point Maestro at a binary in a non-standard
 * place, and no way to proceed. An empty picker is a dead end, so the full list
 * stands in for it.
 *
 * The fallback keys on DETECTION alone, never on a pinned row: a pinned
 * selection on a machine with nothing installed still gets the full list. That
 * keeps "nothing detected" and "showing everything" the same statement, which is
 * what lets `ProviderAvailabilityBar` say so from `availableCount === 0` alone.
 */
export function filterToAvailableProviders<T>(
	providers: T[],
	isAvailable: (provider: T) => boolean,
	showAll: boolean,
	/**
	 * Keep this provider regardless. The SELECTED provider must survive the
	 * filter even when it is not installed - duplicating an agent whose provider
	 * is missing from this machine would otherwise hide the very row that shows
	 * what is selected, and the picker would look like it has no selection.
	 */
	isPinned?: (provider: T) => boolean
): T[] {
	if (showAll || !providers.some(isAvailable)) return providers;
	return providers.filter((provider) => isAvailable(provider) || isPinned?.(provider) === true);
}

/**
 * Where detection ran, as a phrase that can follow "available".
 *
 * Both pickers can point at an SSH remote, so "locally" is a claim about the
 * wrong machine whenever one is selected - the counts describe whatever host was
 * probed, not this one.
 */
export function providerLocationLabel(remoteHost?: string | null): string {
	return remoteHost ? `on ${remoteHost}` : 'locally';
}
