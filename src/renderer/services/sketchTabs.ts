/**
 * Sketch Book tab actions on ANY agent, the way a click on the chip does them.
 *
 * The chip calls these directly instead of receiving a handler prop from App,
 * so the select, close and rename paths cannot drift between the tab strip and
 * the callers that come later (`maestro-cli sketch open`, the `sketch_create`
 * tool). Each is one store write through the pure helpers in
 * `utils/tabHelpers`, which own the focus and neighbor rules.
 */

import { getModalActions } from '../stores/modalStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { closeSketchTab, navigateToUnifiedTabById } from '../utils/tabHelpers';

function findSketchTab(sessionId: string, tabId: string) {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	return session?.sketchTabs?.find((tab) => tab.id === tabId);
}

/** Make a sketch tab the visible one. False when the agent or tab is gone. */
export function selectSketchTabInSession(sessionId: string, tabId: string): boolean {
	if (!findSketchTab(sessionId, tabId)) return false;
	updateSessionWith(sessionId, (s) => navigateToUnifiedTabById(s, 'sketch', tabId)?.session ?? s);
	return true;
}

/**
 * Close a sketch tab. The drawing and its live session stay; Reopen Closed Tab
 * brings the tab back. False when the agent or tab is gone.
 */
export function closeSketchTabInSession(sessionId: string, tabId: string): boolean {
	if (!findSketchTab(sessionId, tabId)) return false;
	updateSessionWith(sessionId, (s) => closeSketchTab(s, tabId)?.session ?? s);
	return true;
}

/**
 * Open the shared rename dialog on a sketch tab, seeded with its label. The
 * commit routes through `handleRenameTab`, which recognizes a sketch tab id.
 */
export function requestSketchTabRename(sessionId: string, tabId: string): boolean {
	const tab = findSketchTab(sessionId, tabId);
	if (!tab) return false;
	const actions = getModalActions();
	actions.setRenameTabId(tabId);
	actions.setRenameTabInitialName(tab.name);
	actions.setRenameTabModalOpen(true);
	return true;
}
