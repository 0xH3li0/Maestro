/**
 * TabWindowThinkingPill - the thinking pill of a tab window (TW-7).
 *
 * The same `ThinkingStatusPill` an app window shows above its composer, fed
 * with `buildTabWindowThinkingItems`: the busy tabs this window streams (and
 * the agent's closed tabs that are still thinking), never the agent's other
 * tabs, whose copy here is frozen at the last snapshot. It renders nothing
 * while none of them is busy.
 *
 * Its controls (Stop, the jump on a name) reach the owner as intents (table C
 * of "The intent union" in `docs/agent-guides/TAB-WINDOWS.md`) and are not
 * wired yet. Auto Run state does not ride the patch, so no Auto Run row shows.
 */

import { useMemo } from 'react';
import type { Session, Theme } from '../../types';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { buildTabWindowThinkingItems } from '../../utils/thinkingItems';
import { ThinkingStatusPill } from '../ThinkingStatusPill';

export interface TabWindowThinkingPillProps {
	theme: Theme;
	/** The agent as this window sees it (its active pointers name this window's tab). */
	session: Session;
	/** This window's tabs. */
	tabRefs: TabWindowTabRef[];
}

export function TabWindowThinkingPill({ theme, session, tabRefs }: TabWindowThinkingPillProps) {
	const thinkingItems = useMemo(
		() => buildTabWindowThinkingItems(session, tabRefs),
		[session, tabRefs]
	);
	if (thinkingItems.length === 0) return null;
	return (
		// The composer's own frame in an app window: a top border on the sidebar color.
		<div
			className="shrink-0 border-t pt-4"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			data-testid="tab-window-thinking"
		>
			<ThinkingStatusPill
				thinkingItems={thinkingItems}
				theme={theme}
				activeSessionId={session.id}
				activeTabId={session.activeTabId}
			/>
		</div>
	);
}
