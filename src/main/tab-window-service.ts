/**
 * Tab Windows: the main-process operations behind the `tabWindows:*` IPC
 * channels and the two relay channels (`tabWindow:sessionPatch`,
 * `tabWindow:intent`).
 *
 * One implementation. The IPC handlers (`ipc/handlers/tab-windows.ts`) and the
 * `maestro-cli tab pop-out` / `tab dock` path call these functions, so the UI
 * and the CLI reach the same code (CLI-UI parity).
 *
 * The {@link WindowRegistry} holds the truth of which tab is in which tab
 * window (D3). The relay never caches an owner: it asks the registry for the
 * agent's CURRENT owner on every message, so an agent moved with Move to Window
 * keeps working (D7).
 */

import type { BrowserWindow } from 'electron';
import type Store from 'electron-store';
import type { WindowManager } from './app-lifecycle/window-manager';
import { summonAppWindow } from './global-hotkey-manager';
import type { SessionsData } from './stores/types';
import { isWebContentsAvailable } from './utils/safe-send';
import { toTabWindowInfo, type WindowRegistry } from './window-registry';
import { isSingleTabRef } from '../shared/unifiedTabRef';
import {
	TAB_WINDOW_CHANNELS,
	isTabWindowIntent,
	isTabWindowSessionPatch,
	type TabWindowDockResult,
	type TabWindowInfo,
	type TabWindowPopOutOptions,
	type TabWindowPopOutResult,
	type TabWindowTabRef,
} from '../shared/tabWindowTypes';

export interface TabWindowServiceDeps {
	registry: WindowRegistry;
	manager: Pick<WindowManager, 'createTabWindow'>;
	/** True when the tab is a hidden consult tab, which never pops out (TW-14). */
	isHiddenTab: (agentId: string, tabRef: TabWindowTabRef) => boolean;
}

/** Outcome of one relay message. `reason` says why it was dropped. */
export type TabWindowRelayResult = { relayed: true } | { relayed: false; reason: string };

/**
 * True when the sessions store holds `tabRef` as a hidden consult AI tab
 * (`isAiTabHidden` in the renderer reads the same `hidden` flag). The store can
 * lag the renderer by one debounced write, so a tab it does not know yet reads
 * as not hidden; the renderer offers no pop-out for a hidden tab either.
 */
export function isStoredAiTabHidden(
	sessionsStore: Pick<Store<SessionsData>, 'get'>,
	agentId: string,
	tabRef: TabWindowTabRef
): boolean {
	if (tabRef.type !== 'ai') return false;
	const sessions = sessionsStore.get('sessions', []) as unknown;
	if (!Array.isArray(sessions)) return false;
	const session = (sessions as Array<{ id?: unknown; aiTabs?: unknown }>).find(
		(candidate) => candidate?.id === agentId
	);
	if (!session || !Array.isArray(session.aiTabs)) return false;
	const tab = (session.aiTabs as Array<{ id?: unknown; hidden?: unknown }>).find(
		(candidate) => candidate?.id === tabRef.id
	);
	return tab?.hidden === true;
}

/**
 * Pop one of `agentId`'s tabs out into the agent's tab window. Reuses the
 * agent's window when it has one (TW-4), else opens it. The window is raised
 * and the tab shown unless `background` is set, in which case the tab joins
 * the strip and nothing on screen moves.
 */
export function popOutTab(
	deps: TabWindowServiceDeps,
	agentId: unknown,
	tabRef: unknown,
	options: TabWindowPopOutOptions = {}
): TabWindowPopOutResult {
	if (typeof agentId !== 'string' || agentId.length === 0) {
		return { poppedOut: false, error: 'An agent id is required' };
	}
	if (!isSingleTabRef(tabRef)) {
		return { poppedOut: false, error: 'A tab ref ({ type, id }) of one tab is required' };
	}
	if (deps.isHiddenTab(agentId, tabRef)) {
		return { poppedOut: false, error: 'A hidden consult tab cannot be popped out' };
	}
	const background = options.background === true;
	const { registry } = deps;

	const existing = registry.getTabWindowForAgent(agentId);
	if (existing) {
		registry.addTabToTabWindow(existing.id, agentId, tabRef, { activate: !background });
		if (!background) summonAppWindow(existing.browserWindow);
		return { poppedOut: true, windowId: existing.id, created: false };
	}

	const browserWindow = deps.manager.createTabWindow({ agentId, tabRefs: [tabRef], background });
	const created = registry.getTabWindowForAgent(agentId);
	if (!created || created.browserWindow !== browserWindow) {
		// createTabWindow registers the window itself, so this means it opened
		// untracked. Say so rather than invent an id.
		return { poppedOut: false, error: 'The tab window is not tracked by the registry' };
	}
	return { poppedOut: true, windowId: created.id, created: true };
}

/**
 * Return a popped tab to its owner window's strip (TW-8). The registry emits
 * `tab-window-changed`; when the tab window is left empty, the window manager
 * closes it.
 */
export function dockTab(
	registry: WindowRegistry,
	agentId: unknown,
	tabRef: unknown
): TabWindowDockResult {
	if (typeof agentId !== 'string' || agentId.length === 0) {
		return { docked: false, error: 'An agent id is required' };
	}
	if (!isSingleTabRef(tabRef)) {
		return { docked: false, error: 'A tab ref ({ type, id }) of one tab is required' };
	}
	const entry = registry.getTabWindowForAgent(agentId);
	if (!entry) return { docked: false, error: 'The agent has no tab window' };
	if (!registry.removeTabFromTabWindow(entry.id, tabRef)) {
		return { docked: false, error: "The tab is not in the agent's tab window" };
	}
	return { docked: true, windowId: entry.id };
}

/** Every tab window, in the order they were opened. */
export function listTabWindows(registry: WindowRegistry): TabWindowInfo[] {
	const infos: TabWindowInfo[] = [];
	for (const entry of registry.getTabWindows()) {
		const info = toTabWindowInfo(entry);
		if (info) infos.push(info);
	}
	return infos;
}

/**
 * Relay a session patch from the agent's owner window to its tab window (D2).
 * Only the agent's CURRENT owner may publish (D1): a window the agent was just
 * moved out of is refused, so two windows never write one tab window.
 */
export function relayTabWindowPatch(
	registry: WindowRegistry,
	sender: BrowserWindow | null,
	patch: unknown
): TabWindowRelayResult {
	if (!isTabWindowSessionPatch(patch)) return { relayed: false, reason: 'malformed patch' };
	const owner = registry.getOwnerWindowForAgent(patch.agentId);
	if (!owner || !sender || owner.browserWindow !== sender) {
		return { relayed: false, reason: 'sender is not the owner window of the agent' };
	}
	const target = registry.getTabWindowForAgent(patch.agentId);
	if (!target) return { relayed: false, reason: 'the agent has no tab window' };
	if (!isWebContentsAvailable(target.browserWindow)) {
		return { relayed: false, reason: 'the tab window is gone' };
	}
	target.browserWindow.webContents.send(TAB_WINDOW_CHANNELS.sessionPatch, patch);
	return { relayed: true };
}

/**
 * Relay an intent from a tab window to the agent's owner window (D2). Only
 * the agent's own tab window may speak for it (TW-5). The tab ref is not
 * checked against the window's strip: a draft flush sent while the tab docks
 * can arrive after its ref left the registry, and the owner re-resolves the
 * tab from its own store anyway.
 */
export function relayTabWindowIntent(
	registry: WindowRegistry,
	sender: BrowserWindow | null,
	intent: unknown
): TabWindowRelayResult {
	if (!isTabWindowIntent(intent)) return { relayed: false, reason: 'malformed intent' };
	const source = registry.getTabWindowForAgent(intent.agentId);
	if (!source || !sender || source.browserWindow !== sender) {
		return { relayed: false, reason: 'sender is not the tab window of the agent' };
	}
	const owner = registry.getOwnerWindowForAgent(intent.agentId);
	if (!owner || !isWebContentsAvailable(owner.browserWindow)) {
		return { relayed: false, reason: 'the agent has no owner window' };
	}
	owner.browserWindow.webContents.send(TAB_WINDOW_CHANNELS.intent, intent);
	return { relayed: true };
}
