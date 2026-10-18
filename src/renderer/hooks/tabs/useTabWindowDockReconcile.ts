/**
 * useTabWindowDockReconcile - the owner window's half of docking a tab back
 * from a tab window (Tab Windows, TW-8, TW-10).
 *
 * Two jobs, both for agents this window owns (the single writer, D1):
 *   1. Dock-back. When a `tab-window-changed` read drops a ref, the tab is back
 *      in this window. It never left `unifiedTabOrder`, so it is already at its
 *      old slot; this makes it the owner's active tab.
 *   2. Stale refs after a restart. Main restores a tab window from the stored
 *      sessions, but the owner drops some tabs while it loads them (a terminal
 *      tab with no startup command). The first time an owned agent with a tab
 *      window is seen after the sessions loaded, every ref whose tab the agent
 *      no longer has is docked, so main drops it.
 *
 * Only an app window mounts this. A tab window shows the popped tabs, so it
 * must not (the same trap as `usePoppedOutTabGuard`).
 */

import { useEffect, useRef } from 'react';
import type { TabWindowInfo, TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { tabRefKey } from '../../../shared/unifiedTabRef';
import { sessionHasTab } from '../../services/tabWindowNavigation';
import { useSessionStore } from '../../stores/sessionStore';
import { isTabPoppedOut, useTabWindowStore } from '../../stores/tabWindowStore';
import { focusFieldsForRef } from '../../utils/tabHelpers';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

type OwnsSession = (sessionId: string) => boolean;

/**
 * agentId -> the docked tab to show, for every agent whose popped tabs shrank
 * between two registry reads. When several tabs docked at once (a tab window
 * closed), the one its tab window was showing wins, else the last in its strip.
 */
export function findDockedTabsToFocus(
	prev: TabWindowInfo[],
	next: TabWindowInfo[]
): Map<string, TabWindowTabRef> {
	const stillPopped = new Map<string, Set<string>>();
	for (const win of next) {
		let keys = stillPopped.get(win.agentId);
		if (!keys) {
			keys = new Set<string>();
			stillPopped.set(win.agentId, keys);
		}
		for (const ref of win.tabRefs) keys.add(tabRefKey(ref));
	}

	const docked = new Map<string, TabWindowTabRef>();
	for (const win of prev) {
		const keys = stillPopped.get(win.agentId);
		const removed = win.tabRefs.filter((ref) => !keys?.has(tabRefKey(ref)));
		if (removed.length === 0) continue;
		const shown = win.activeTabRef;
		const pick =
			shown && removed.some((ref) => tabRefKey(ref) === tabRefKey(shown))
				? shown
				: removed[removed.length - 1];
		docked.set(win.agentId, pick);
	}
	return docked;
}

/**
 * Make each docked tab the active tab of its owned agent. A tab that is gone
 * (closed from the tab window) or popped out again is skipped. Writes the
 * session store only when an agent changed.
 */
export function focusDockedTabs(
	prev: TabWindowInfo[],
	next: TabWindowInfo[],
	ownsSession?: OwnsSession
): void {
	const docked = findDockedTabsToFocus(prev, next);
	if (docked.size === 0) return;
	const { sessions, setSessions } = useSessionStore.getState();
	let changed = false;
	const updated = sessions.map((session) => {
		const ref = docked.get(session.id);
		if (!ref) return session;
		if (ownsSession && !ownsSession(session.id)) return session;
		if (!sessionHasTab(session, ref) || isTabPoppedOut(session.id, ref)) return session;
		changed = true;
		return { ...session, ...focusFieldsForRef(session, ref) };
	});
	if (changed) setSessions(updated);
}

/**
 * Dock the refs main restored for tabs the owner's session no longer has. Runs
 * once per agent: `checked` holds the agents already done and is updated in
 * place. An agent this window does not own (or has not loaded) is left for a
 * later pass. Does nothing until the sessions were read back successfully.
 */
export function dockStaleTabWindowRefs(checked: Set<string>, ownsSession?: OwnsSession): void {
	const api = window.maestro?.tabWindows;
	if (!api) return;
	const { sessions, sessionsLoaded, sessionsReadOk } = useSessionStore.getState();
	if (!sessionsLoaded || !sessionsReadOk) return;
	const windows = useTabWindowStore.getState().windows;
	for (const win of windows) {
		if (checked.has(win.agentId)) continue;
		const session = sessions.find((s) => s.id === win.agentId);
		if (!session) continue;
		if (ownsSession && !ownsSession(session.id)) continue;
		checked.add(win.agentId);
		for (const ref of win.tabRefs) {
			if (sessionHasTab(session, ref)) continue;
			api
				.dock(win.agentId, ref)
				.then((result) => {
					if (!result.docked) {
						logger.warn(`[TabWindows] Could not dock a stale tab: ${result.error}`, undefined, {
							agentId: win.agentId,
							ref,
						});
					}
				})
				.catch((error: unknown) => {
					logger.error('[TabWindows] Could not dock a stale tab', undefined, error);
					captureException(error instanceof Error ? error : new Error(String(error)), {
						extra: { operation: 'tabWindows.dock', agentId: win.agentId, tabType: ref.type },
					});
				});
		}
	}
}

/** Mount once in App.tsx, inside the WindowProvider, beside the popped-tab guard. */
export function useTabWindowDockReconcile(ownsSession?: OwnsSession): void {
	const ownsSessionRef = useRef(ownsSession);
	ownsSessionRef.current = ownsSession;
	const checkedRef = useRef(new Set<string>());

	useEffect(() => {
		const runStaleCheck = () => dockStaleTabWindowRefs(checkedRef.current, ownsSessionRef.current);
		const unsubscribeWindows = useTabWindowStore.subscribe((state, prev) => {
			if (state.windows === prev.windows) return;
			focusDockedTabs(prev.windows, state.windows, ownsSessionRef.current);
			runStaleCheck();
		});
		const unsubscribeSessions = useSessionStore.subscribe((state, prev) => {
			if (
				state.sessions !== prev.sessions ||
				state.sessionsLoaded !== prev.sessionsLoaded ||
				state.sessionsReadOk !== prev.sessionsReadOk
			) {
				runStaleCheck();
			}
		});
		runStaleCheck();
		return () => {
			unsubscribeWindows();
			unsubscribeSessions();
		};
	}, []);

	// An agent moved into this window may have a tab window still unchecked.
	useEffect(() => {
		dockStaleTabWindowRefs(checkedRef.current, ownsSession);
	}, [ownsSession]);
}
