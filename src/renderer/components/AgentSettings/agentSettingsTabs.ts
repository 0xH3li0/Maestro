/**
 * agentSettingsTabs - the tab set of the agent settings form (New Agent, Edit
 * Agent, and the Group Chat moderator config), and the map from a validation
 * field to the tab that holds it.
 *
 * The strip renders a dot on every tab whose panel holds an error, and a Save
 * attempt with errors jumps to `firstTabWithError()`, so a user on the SSH tab
 * with an empty name is never left facing a dead Save button.
 */

import { BrainCircuit, Cpu, Server, SlidersHorizontal, Terminal, Users } from 'lucide-react';
import type { ModalTab } from '../ui/ModalTabStrip';

export type AgentSettingsTabId =
	| 'general'
	| 'provider'
	| 'models'
	| 'peers'
	| 'environment'
	| 'ssh';

/** Every tab, in strip order. A surface shows the subset it supports. */
export const AGENT_SETTINGS_TABS: readonly ModalTab<AgentSettingsTabId>[] = [
	{ id: 'general', label: 'General', icon: SlidersHorizontal },
	{ id: 'provider', label: 'Provider', icon: Cpu },
	{ id: 'models', label: 'Models', icon: BrainCircuit },
	{ id: 'environment', label: 'Environment', icon: Terminal },
	{ id: 'peers', label: 'Peers', icon: Users },
	{ id: 'ssh', label: 'SSH', icon: Server },
];

/** New Agent and Edit Agent show every tab. */
export const AGENT_FORM_TAB_IDS: readonly AgentSettingsTabId[] = AGENT_SETTINGS_TABS.map(
	(tab) => tab.id
);

/** The moderator has no gateway (no Models tab) and a group chat has no peers. */
export const MODERATOR_TAB_IDS: readonly AgentSettingsTabId[] = [
	'general',
	'provider',
	'environment',
	'ssh',
];

/**
 * The tab each validation field lives on. Keys are the field ids the modals
 * report (`SessionValidationResult.errorField` uses `name` and `directory`).
 * A field missing from this map is ignored by `firstTabWithError()`.
 */
export const AGENT_SETTINGS_FIELD_TAB: Readonly<Record<string, AgentSettingsTabId>> = {
	name: 'general',
	group: 'general',
	// The Group Chat moderator picker sits on General, beside the chat name.
	moderator: 'general',
	directory: 'general',
	workingDir: 'general',
	additionalDirectories: 'general',
	newSessionMessage: 'general',
	nudgeMessage: 'general',
	provider: 'provider',
	customPath: 'provider',
	customArgs: 'provider',
	model: 'provider',
	effort: 'provider',
	contextWindow: 'provider',
	gateway: 'models',
	gatewayUrl: 'models',
	tokenProxyMode: 'models',
	runOn: 'models',
	tierTargets: 'models',
	backgroundRequests: 'models',
	systemOne: 'models',
	envVars: 'environment',
	peers: 'peers',
	sshRemote: 'ssh',
	remoteWorkingDir: 'ssh',
};

/** The tabs, out of `visibleTabs`, whose panels hold at least one of `errorFields`. */
export function tabsWithErrors(
	errorFields: readonly string[],
	visibleTabs: readonly AgentSettingsTabId[]
): Set<AgentSettingsTabId> {
	const visible = new Set(visibleTabs);
	const result = new Set<AgentSettingsTabId>();
	for (const field of errorFields) {
		const tab = AGENT_SETTINGS_FIELD_TAB[field];
		if (tab && visible.has(tab)) result.add(tab);
	}
	return result;
}

/**
 * The first tab, in `visibleTabs` order, that holds an error, or `null` when
 * none does. A Save attempt switches here before showing the error.
 */
export function firstTabWithError(
	errorFields: readonly string[],
	visibleTabs: readonly AgentSettingsTabId[]
): AgentSettingsTabId | null {
	const withErrors = tabsWithErrors(errorFields, visibleTabs);
	return visibleTabs.find((tab) => withErrors.has(tab)) ?? null;
}

/** The strip's tabs for one surface, in strip order, with `hasError` set from `errorFields`. */
export function buildAgentSettingsTabs(
	visibleTabs: readonly AgentSettingsTabId[],
	errorFields: readonly string[] = []
): ModalTab<AgentSettingsTabId>[] {
	const visible = new Set(visibleTabs);
	const withErrors = tabsWithErrors(errorFields, visibleTabs);
	return AGENT_SETTINGS_TABS.filter((tab) => visible.has(tab.id)).map((tab) => ({
		...tab,
		hasError: withErrors.has(tab.id),
	}));
}
