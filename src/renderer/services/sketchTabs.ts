/**
 * Sketch Book tab actions on ANY agent, the way a click on the chip does them.
 *
 * The chip calls these directly instead of receiving a handler prop from App,
 * so the select, close and rename paths cannot drift between the tab strip and
 * the callers that come later (`maestro-cli sketch open`, the `sketch_create`
 * tool). Each is one store write through the pure helpers in
 * `utils/tabHelpers`, which own the focus and neighbor rules.
 *
 * "New Sketch Book" lives here too: the hotkey, the command palette, the
 * hamburger menu and the tab bar `+` menu all call `createSketchInSession()`,
 * so the four ways in create and open a sketch the same way.
 */

import type { SketchRecord } from '../../shared/sketch/types';
import { getModalActions } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { selectActiveSession, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { closeSketchTab, navigateToUnifiedTabById, openSketchTab } from '../utils/tabHelpers';

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

/**
 * Create a sketch owned by this agent and open it in a tab. The tab is focused
 * unless `background` is set (spec Q5: an agent's own sketch opens behind the
 * user). Resolves with the new record, or null when main refused (the Encore
 * flag is off, the agent is gone or runs over SSH); the refusal is shown as a
 * toast in main's own words.
 */
export async function createSketchInSession(
	sessionId: string,
	options: { name?: string; background?: boolean } = {}
): Promise<SketchRecord | null> {
	let record: SketchRecord;
	try {
		record = await window.maestro.sketch.create({ ownerAgentId: sessionId, name: options.name });
	} catch (error) {
		notifyToast({
			color: 'red',
			title: 'Sketch Book',
			message: ipcErrorMessage(error),
			sessionId,
		});
		return null;
	}
	updateSessionWith(
		sessionId,
		(s) =>
			openSketchTab(
				s,
				{ sketchId: record.sketchId, name: record.name },
				{ background: options.background }
			).session
	);
	return record;
}

/** "New Sketch Book" on the active agent. Null when no agent is active. */
export function newSketchBookInActiveAgent(): Promise<SketchRecord | null> {
	const session = selectActiveSession(useSessionStore.getState());
	if (!session) return Promise.resolve(null);
	return createSketchInSession(session.id);
}
