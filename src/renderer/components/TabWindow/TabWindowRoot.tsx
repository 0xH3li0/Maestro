/**
 * TabWindowRoot - render entry for a tab window.
 *
 * The main process loads the main renderer bundle into an ordinary OS window
 * with `?tabWindow=<windowId>`, and main.tsx mounts this instead of the full
 * app. A tab window holds one agent's popped-out tabs and nothing else: no Left
 * Bar, no Right Bar (TW-2). It is a view. The app window that owns the agent
 * stays its only writer (D1); this window renders what that owner publishes and
 * sends every action back as an intent (D2).
 *
 * So this root mounts only the providers and app-level hosts the tab UI needs,
 * NOT `App.tsx`: no `WindowProvider` (it would believe it is the primary
 * window), no `process:*` listeners, no persistence, no remote integration.
 * The full list and the reason for each is in
 * `docs/agent-guides/TAB-WINDOWS.md` ("Tab window providers and hosts").
 *
 * Layout, top to bottom: `TabWindowHeader` (status dot, agent name, Dock), the
 * shared `TabBar` fed with only this window's tabs, `TabWindowContent`, and,
 * under an AI tab, the thinking pill. Which tabs, and which one is shown, come
 * from this window's registry record (`useTabWindowInfo`). The agent's
 * `Session` comes from the renderer `sessionStore`, which holds only this agent,
 * applied from the owner's patches (`useTabWindowMirror`). Tab shortcuts and
 * chip menus work as in the main window (TW-6, `useTabWindowKeyboard`).
 */

import { useCallback, useEffect, useMemo } from 'react';
import { LayerStackProvider } from '../../contexts/LayerStackContext';
import { useWindowSettingsSync } from '../../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../../hooks/ui/useResolvedTheme';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	buildTabWindowStripSession,
	buildTabWindowUnifiedTabs,
	focusFieldsForRef,
	moveUnifiedTabToTarget,
} from '../../utils/tabHelpers';
import {
	excludePreservedRefs,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
} from '../../hooks/tabs/internal/unifiedCloseHelpers';
import { isSessionRemote } from '../../utils/sessionHelpers';
import { formatTabWindowTitle, type TabWindowTabRef } from '../../../shared/tabWindowTypes';
import {
	isSameTabRef,
	isSingleTabRef,
	type SingleTabType,
	type UnifiedTabRef,
} from '../../../shared/unifiedTabRef';
import type { Session, Theme, UnifiedTab } from '../../types';
import { ToastContainer } from '../Toast';
import { CenterFlash } from '../CenterFlash';
import { ImageContextMenuHost } from '../ImageContextMenuHost';
import { ZoomViewerHost } from '../ZoomViewer';
import { TabBar } from '../TabBar';
import { TabWindowHeader } from './TabWindowHeader';
import { TabWindowContent } from './TabWindowContent';
import { TabWindowThinkingPill } from './TabWindowThinkingPill';
import { useTabWindowInfo } from './useTabWindowInfo';
import { useTabWindowKeyboard } from './useTabWindowKeyboard';
import { useTabWindowMirror } from './useTabWindowMirror';
import { useTabWindowSelection } from './useTabWindowSelection';
import { runTabWindowCall } from './runTabWindowCall';

export interface TabWindowRootProps {
	/** Registry id of this tab window (the `?tabWindow=<id>` query value). */
	windowId: string;
}

const NO_TAB_REFS: TabWindowTabRef[] = [];

export function TabWindowRoot({ windowId }: TabWindowRootProps) {
	return (
		<LayerStackProvider>
			<TabWindowShell windowId={windowId} />
		</LayerStackProvider>
	);
}

function TabWindowShell({ windowId }: TabWindowRootProps) {
	// This renderer does not run `useSettings`: load the settings, follow
	// changes made in other windows, and publish the typography here.
	useWindowSettingsSync();
	const theme = useResolvedTheme();

	const { info } = useTabWindowInfo();
	// The owner's patches are this window's only source of the agent (D2).
	useTabWindowMirror(info);
	const agentId = info?.agentId ?? null;
	const session = useSessionStore((s) =>
		agentId ? (s.sessions.find((x) => x.id === agentId) ?? null) : null
	);
	useTabWindowTitle(session?.name);

	return (
		<div
			className="flex flex-col h-screen w-screen overflow-hidden"
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
			data-testid="tab-window-root"
			data-tab-window-id={windowId}
		>
			{session && info ? (
				<TabWindowBody
					theme={theme}
					session={session}
					tabRefs={info.tabRefs ?? NO_TAB_REFS}
					activeTabRef={info.activeTabRef}
				/>
			) : (
				<TabWindowHeader theme={theme} session={session} />
			)}
			<ToastContainer theme={theme} />
			<CenterFlash theme={theme} />
			<ImageContextMenuHost theme={theme} />
			<ZoomViewerHost theme={theme} />
		</div>
	);
}

/** Keep the OS title on `<agent name> - Tab Window`, through renames (TW-3). */
function useTabWindowTitle(agentName: string | undefined): void {
	useEffect(() => {
		document.title = formatTabWindowTitle(agentName);
	}, [agentName]);
}

interface TabWindowBodyProps {
	theme: Theme;
	session: Session;
	/** This window's tabs, in its own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The tab main says this window shows; null falls back to the first tab. */
	activeTabRef: TabWindowTabRef | null;
}

function TabWindowBody({ theme, session, tabRefs, activeTabRef }: TabWindowBodyProps) {
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const tabWindows = window.maestro.tabWindows;
	const agentId = session.id;

	// Which tab shows. A selection shows at once and the record catches up.
	const { activeTabRef: shownRef, selectTab } = useTabWindowSelection(agentId, activeTabRef);

	// Only this window's tabs, in its own order (never the owner's strip).
	const unifiedTabs = useMemo(
		() => buildTabWindowUnifiedTabs(session, tabRefs),
		[session, tabRefs]
	);
	const aiTabs = useMemo(
		() => unifiedTabs.flatMap((tab) => (tab.type === 'ai' ? [tab.data] : [])),
		[unifiedTabs]
	);
	const activeTab: UnifiedTab | null = useMemo(() => {
		const find = (ref: TabWindowTabRef | null) =>
			ref ? (unifiedTabs.find((tab) => isSameTabRef(tab, ref)) ?? null) : null;
		// A pending selection whose tab just left falls back to the record.
		return find(shownRef) ?? find(activeTabRef ?? tabRefs[0] ?? null);
	}, [shownRef, activeTabRef, tabRefs, unifiedTabs]);

	// The agent as this window sees it: its active pointers name this window's
	// tab, never the owner's (the owner's active AI tab is not in this strip).
	const viewSession = useMemo<Session>(() => {
		const focused = activeTab ? { ...session, ...focusFieldsForRef(session, activeTab) } : session;
		const activeAiInStrip = aiTabs.some((tab) => tab.id === focused.activeTabId);
		return activeAiInStrip ? focused : { ...focused, activeTabId: aiTabs[0]?.id ?? '' };
	}, [session, activeTab, aiTabs]);
	// The same agent narrowed to this strip: what the shared tab math (keyboard
	// navigation, reorder, bulk-close pickers) runs on, so it walks these chips only.
	const stripSession = useMemo(
		() => buildTabWindowStripSession(viewSession, tabRefs),
		[viewSession, tabRefs]
	);
	const refOf = useCallback(
		(id: string): TabWindowTabRef | null => {
			const tab = unifiedTabs.find((t) => t.id === id);
			return tab && tab.type !== 'group' ? { type: tab.type, id: tab.id } : null;
		},
		[unifiedTabs]
	);

	// Closing is a real close through the owner's close path (D7). The intent is
	// handled by the owner's dispatcher (phase 5).
	const closeTab = useCallback(
		(type: SingleTabType, id: string) => {
			tabWindows.sendIntent({ kind: 'closeTab', agentId, tabRef: { type, id } });
		},
		[tabWindows, agentId]
	);
	const activeRef: TabWindowTabRef | null =
		activeTab && activeTab.type !== 'group' ? { type: activeTab.type, id: activeTab.id } : null;
	const dockActiveTab = useCallback(() => {
		if (!activeRef) return;
		void runTabWindowCall(
			'dock',
			() => tabWindows.dock(agentId, activeRef),
			(result) => (result.docked ? null : result.error)
		);
	}, [tabWindows, agentId, activeRef]);

	// Tab shortcuts: the main window's entries, scoped to this strip (TW-6).
	useTabWindowKeyboard({
		stripSession,
		activeTabRef: activeRef,
		onSelectTab: selectTab,
		onCloseTab: closeTab,
	});

	// Chip menus. Each is the intent the owner runs with its own handler
	// (phase 5); the refs are picked here by the same helpers the owner strip
	// uses, on the narrowed session, so "Close Others" means this strip.
	const starTab = useCallback(
		(id: string, starred: boolean) => {
			tabWindows.sendIntent({ kind: 'starTab', agentId, tabRef: { type: 'ai', id }, starred });
		},
		[tabWindows, agentId]
	);
	const markTabUnread = useCallback(
		(id: string) => {
			tabWindows.sendIntent({ kind: 'markUnread', agentId, tabRef: { type: 'ai', id } });
		},
		[tabWindows, agentId]
	);
	const reorderTab = useCallback(
		(sourceTabId: string, targetTabId: string) => {
			const source = refOf(sourceTabId);
			const moved = moveUnifiedTabToTarget(stripSession, sourceTabId, targetTabId);
			if (!source || moved === stripSession) return;
			tabWindows.sendIntent({
				kind: 'reorderTabs',
				agentId,
				tabRef: source,
				tabRefs: moved.unifiedTabOrder.filter(isSingleTabRef),
			});
		},
		[tabWindows, agentId, refOf, stripSession]
	);
	const closeTabsBy = useCallback(
		(pick: (session: Session, pivotTabId?: string) => UnifiedTabRef[], pivotTabId?: string) => {
			const pivot = pivotTabId ? refOf(pivotTabId) : activeRef;
			const tabRefsToClose = excludePreservedRefs(
				stripSession,
				pick(stripSession, pivot?.id)
			).filter(isSingleTabRef);
			if (!pivot || tabRefsToClose.length === 0) return;
			tabWindows.sendIntent({ kind: 'closeTabs', agentId, tabRef: pivot, tabRefs: tabRefsToClose });
		},
		[tabWindows, agentId, refOf, activeRef, stripSession]
	);

	return (
		<>
			<TabWindowHeader
				theme={theme}
				session={session}
				onDock={activeRef ? dockActiveTab : undefined}
			/>
			<TabBar
				tabs={aiTabs}
				activeTabId={viewSession.activeTabId}
				theme={theme}
				sessionId={agentId}
				sessionAgentSessionId={session.agentSessionId}
				unifiedTabs={unifiedTabs}
				activeFileTabId={viewSession.activeFileTabId}
				activeBrowserTabId={viewSession.activeBrowserTabId}
				activeTerminalTabId={viewSession.activeTerminalTabId}
				inputMode={viewSession.inputMode}
				onTabSelect={(id) => selectTab('ai', id)}
				onFileTabSelect={(id) => selectTab('file', id)}
				onBrowserTabSelect={(id) => selectTab('browser', id)}
				onTerminalTabSelect={(id) => selectTab('terminal', id)}
				onTabClose={(id) => closeTab('ai', id)}
				onFileTabClose={(id) => closeTab('file', id)}
				onBrowserTabClose={(id) => closeTab('browser', id)}
				onTerminalTabClose={(id) => closeTab('terminal', id)}
				onTabStar={starTab}
				onTabMarkUnread={markTabUnread}
				onUnifiedTabReorder={reorderTab}
				onCloseOtherTabs={(pivot) => closeTabsBy(getRefsExceptActive, pivot)}
				onCloseTabsLeft={(pivot) => closeTabsBy(getRefsLeftOfActive, pivot)}
				onCloseTabsRight={(pivot) => closeTabsBy(getRefsRightOfActive, pivot)}
				colorBlindMode={colorBlindMode}
				sshRemote={isSessionRemote(session)}
			/>
			<div className="flex-1 min-h-0 flex flex-col">
				<TabWindowContent theme={theme} session={viewSession} activeTab={activeTab} />
			</div>
			{/* Where the composer sits in an app window, and like it, under an AI tab only. */}
			{activeTab?.type === 'ai' && (
				<TabWindowThinkingPill theme={theme} session={viewSession} tabRefs={tabRefs} />
			)}
		</>
	);
}
