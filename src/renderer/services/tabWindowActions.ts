/**
 * tabWindowActions - the one renderer path that pops a tab out into its agent's
 * tab window and docks it back (Tab Windows, TW-11, TW-12).
 *
 * Every entry point calls this module and nothing else: the chip menu item, the
 * Cmd+K commands, the shortcut, the tab window's Dock button, and the
 * `maestro-cli tab pop-out` / `tab dock` handlers. The rules live here once:
 *
 * - The web-desktop build has no OS windows, so nothing is offered or run
 *   there (TW-13).
 * - A hidden consult tab never pops out (TW-14). Main refuses it too, but its
 *   store can lag one debounced write, so the renderer checks first.
 * - A tab tiled into a group leaves the group first, as a standalone tab at
 *   the group's place (D6, `promotePaneToStandalone`). Its new strip slot is
 *   where it docks back to (TW-8).
 *
 * Pop-out writes the agent's `Session` (the group detach), so it runs only in
 * the window that owns the agent, never in a tab window (D1). Dock writes
 * nothing here and runs from either side.
 *
 * Refusals come back as the result's `error`; nothing here shows a toast, so
 * the CLI path can report the same words. An IPC rejection is reported to
 * Sentry and returned the same way.
 */

import type { Session } from '../types';
import type {
	TabWindowDockResult,
	TabWindowPopOutOptions,
	TabWindowPopOutResult,
	TabWindowTabRef,
} from '../../shared/tabWindowTypes';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { promotePaneToStandalone } from '../utils/panelLayout';
import { findGroupPaneForTab } from '../utils/tabHelpers/groupFocus';
import { isAiTabHidden } from '../utils/unifiedTabOrderUtils';
import { isTabWindow, isWebDesktop } from '../utils/runtimeContext';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { captureException } from '../utils/sentry';
import { sessionHasTab } from './tabWindowNavigation';

/** Why tab windows do not exist in this renderer (TW-13). */
const UNAVAILABLE_ERROR = 'Tab windows are only available in the desktop app';

/**
 * Whether this renderer can pop tabs out at all: the desktop build, with the
 * tab windows API, and not itself a tab window. Entry points hide their item
 * when this is false.
 */
export function canUseTabWindows(): boolean {
	return !isWebDesktop() && !isTabWindow() && !!window.maestro?.tabWindows;
}

/**
 * Why `ref` of `session` cannot pop out, or null when it can. Covers the tab
 * itself only; {@link canUseTabWindows} covers the renderer. Entry points use
 * it to hide their item, and {@link popOutTab} refuses with the same words.
 */
export function popOutRefusal(session: Session, ref: TabWindowTabRef): string | null {
	if (!sessionHasTab(session, ref)) return 'The agent has no such tab';
	if (ref.type === 'ai') {
		const tab = session.aiTabs.find((t) => t.id === ref.id);
		if (tab && isAiTabHidden(tab)) return 'A hidden consult tab cannot be popped out';
	}
	return null;
}

/**
 * Detach `ref` from the tiled group that holds it, placing it right after the
 * group in the strip (D6). A no-op for a standalone tab.
 */
function detachFromGroup(agentId: string, ref: TabWindowTabRef): void {
	const session = selectSessionById(agentId)(useSessionStore.getState());
	if (!session || !findGroupPaneForTab(session, ref.type, ref.id)) return;
	updateSessionWith(agentId, (s) => {
		const pane = findGroupPaneForTab(s, ref.type, ref.id);
		if (!pane) return s;
		const order = s.unifiedTabOrder ?? [];
		const groupIndex = order.findIndex((r) => r.type === 'group' && r.id === pane.groupId);
		const insertIndex = groupIndex < 0 ? order.length : groupIndex + 1;
		return promotePaneToStandalone(s, pane.groupId, pane.leafId, insertIndex);
	});
}

function reportRejection(error: unknown, operation: string, ref: TabWindowTabRef): string {
	captureException(error instanceof Error ? error : new Error(String(error)), {
		extra: { operation: `tabWindows.${operation}`, tabType: ref.type },
	});
	return ipcErrorMessage(error);
}

/**
 * Pop one of `agentId`'s tabs out into the agent's tab window, opening it when
 * the agent has none (TW-4). The window is raised and the tab shown unless
 * `background` is set. Resolves with main's answer, or a refusal.
 */
export async function popOutTab(
	agentId: string,
	ref: TabWindowTabRef,
	options: TabWindowPopOutOptions = {}
): Promise<TabWindowPopOutResult> {
	if (!canUseTabWindows()) return { poppedOut: false, error: UNAVAILABLE_ERROR };
	const session = selectSessionById(agentId)(useSessionStore.getState());
	if (!session) return { poppedOut: false, error: 'Agent not found' };
	const refusal = popOutRefusal(session, ref);
	if (refusal) return { poppedOut: false, error: refusal };

	detachFromGroup(agentId, ref);
	try {
		return await window.maestro.tabWindows.popOut(agentId, ref, {
			background: options.background === true,
		});
	} catch (error) {
		return { poppedOut: false, error: reportRejection(error, 'popOut', ref) };
	}
}

/**
 * Return a popped tab to its owner window's strip, at the slot it left (TW-8).
 * Main closes the tab window when this was its last tab. Resolves with main's
 * answer, or a refusal.
 */
export async function dockTab(agentId: string, ref: TabWindowTabRef): Promise<TabWindowDockResult> {
	const api = window.maestro?.tabWindows;
	if (isWebDesktop() || !api) return { docked: false, error: UNAVAILABLE_ERROR };
	try {
		return await api.dock(agentId, ref);
	} catch (error) {
		return { docked: false, error: reportRejection(error, 'dock', ref) };
	}
}
