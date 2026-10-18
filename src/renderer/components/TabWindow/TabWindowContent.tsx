/**
 * TabWindowContent - the active tab's content in a tab window (TW-2).
 *
 * Reuses the single-tab views the main panel's tiled panes render, never a
 * fork: `TiledAiPane` (the transcript, `TerminalOutput`) for an AI tab and
 * `TiledFilePane` (`FilePreview`) for a file tab. Both take a session and a tab
 * id, so they render a tab that is not the session's active one.
 *
 * The AI transcript's controls come in `chatActions`, the same bundle a tiled
 * pane gets, built by `useTabWindowChatActions`: each one that writes the agent
 * is an intent to the owner (D2). The file pane's bundle is still null (file
 * tabs land in phase 6). Terminal tabs render nothing here: `TabWindowTerminals`
 * keeps every terminal of the strip mounted above this content (D5). Browser
 * tabs open a new webview (D5) and land in phase 6; until then they show a
 * notice instead of an empty pane.
 */

import type { Session, Theme, UnifiedTab } from '../../types';
import {
	PaneMissingTab,
	TiledAiPane,
	TiledFilePane,
	type PaneChatActions,
} from '../MainPanel/TiledLayout';

export interface TabWindowContentProps {
	theme: Theme;
	session: Session;
	/** The tab this window shows, or null when its record names no live tab. */
	activeTab: UnifiedTab | null;
	/** The AI transcript's controls (each one that writes the agent is an intent). */
	chatActions: PaneChatActions | null;
}

export function TabWindowContent({
	theme,
	session,
	activeTab,
	chatActions,
}: TabWindowContentProps) {
	if (!activeTab) return <PaneMissingTab theme={theme} />;
	switch (activeTab.type) {
		case 'ai':
			return (
				<TiledAiPane
					// One transcript view per tab, as the main panel keys its own.
					key={activeTab.id}
					aiTabId={activeTab.id}
					session={session}
					theme={theme}
					isFocused
					actions={chatActions}
				/>
			);
		case 'file':
			return (
				<TiledFilePane
					key={activeTab.id}
					fileTabId={activeTab.id}
					session={session}
					theme={theme}
					actions={null}
				/>
			);
		case 'terminal':
			// Drawn by TabWindowTerminals, which keeps the xterm alive across tab switches.
			return null;
		default:
			// Browser tabs, until phase 6 mounts their own view here (D5).
			return (
				<PaneMissingTab
					theme={theme}
					message="This tab cannot show in a tab window yet. Dock it to see it in the main window."
				/>
			);
	}
}
