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
 * shared `TabBar` fed with only this window's tabs, and `TabWindowContent`.
 * Which tabs, and which one is shown, come from this window's registry record
 * (`useTabWindowInfo`). The agent's `Session` comes from the renderer
 * `sessionStore`, which the owner's patches fill (phase 5).
 */

import { useCallback, useEffect, useMemo } from 'react';
import { LayerStackProvider } from '../../contexts/LayerStackContext';
import { useWindowSettingsSync } from '../../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../../hooks/ui/useResolvedTheme';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyToast } from '../../stores/notificationStore';
import { buildTabWindowUnifiedTabs, focusFieldsForRef } from '../../utils/tabHelpers';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { isSessionRemote } from '../../utils/sessionHelpers';
import { captureException } from '../../utils/sentry';
import { formatTabWindowTitle, type TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { isSameTabRef, type SingleTabType } from '../../../shared/unifiedTabRef';
import type { Session, Theme, UnifiedTab } from '../../types';
import { ToastContainer } from '../Toast';
import { CenterFlash } from '../CenterFlash';
import { ImageContextMenuHost } from '../ImageContextMenuHost';
import { ZoomViewerHost } from '../ZoomViewer';
import { TabBar } from '../TabBar';
import { TabWindowHeader } from './TabWindowHeader';
import { TabWindowContent } from './TabWindowContent';
import { useTabWindowInfo } from './useTabWindowInfo';

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
		const ref = activeTabRef ?? tabRefs[0] ?? null;
		return ref ? (unifiedTabs.find((tab) => isSameTabRef(tab, ref)) ?? null) : null;
	}, [activeTabRef, tabRefs, unifiedTabs]);

	// The agent as this window sees it: its active pointers name this window's
	// tab, never the owner's (the owner's active AI tab is not in this strip).
	const viewSession = useMemo<Session>(() => {
		const focused = activeTab ? { ...session, ...focusFieldsForRef(session, activeTab) } : session;
		const activeAiInStrip = aiTabs.some((tab) => tab.id === focused.activeTabId);
		return activeAiInStrip ? focused : { ...focused, activeTabId: aiTabs[0]?.id ?? '' };
	}, [session, activeTab, aiTabs]);

	const tabWindows = window.maestro.tabWindows;
	const agentId = session.id;

	// Show a tab of this window. Main records it as the window's active tab and
	// broadcasts `tab-window-changed`, which re-reads this window's record.
	const selectTab = useCallback(
		(type: SingleTabType, id: string) => {
			void runTabWindowCall(
				'focus',
				() => tabWindows.focus(agentId, { type, id }),
				(result) => (result.focused ? null : result.error)
			);
		},
		[tabWindows, agentId]
	);
	// Closing is a real close through the owner's close path (D7). The intent is
	// handled by the owner's dispatcher (phase 5).
	const closeTab = useCallback(
		(type: SingleTabType, id: string) => {
			tabWindows.sendIntent({ kind: 'closeTab', agentId, tabRef: { type, id } });
		},
		[tabWindows, agentId]
	);
	const activeRef = activeTab && activeTab.type !== 'group' ? activeTab : null;
	const dockActiveTab = useCallback(() => {
		if (!activeRef) return;
		const tabRef: TabWindowTabRef = { type: activeRef.type, id: activeRef.id };
		void runTabWindowCall(
			'dock',
			() => tabWindows.dock(agentId, tabRef),
			(result) => (result.docked ? null : result.error)
		);
	}, [tabWindows, agentId, activeRef]);

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
				colorBlindMode={colorBlindMode}
				sshRemote={isSessionRemote(session)}
			/>
			<div className="flex-1 min-h-0 flex flex-col">
				<TabWindowContent theme={theme} session={viewSession} activeTab={activeTab} />
			</div>
		</>
	);
}

/**
 * Run one `tabWindows:*` call. A refusal (the call answered with an error) is
 * expected and shown as a toast. A rejection is not: it is shown the same way
 * and also reported to Sentry.
 */
async function runTabWindowCall<T>(
	operation: string,
	call: () => Promise<T>,
	refusal: (result: T) => string | null
): Promise<void> {
	try {
		const error = refusal(await call());
		if (error) notifyToast({ color: 'red', title: 'Tab Window', message: error });
	} catch (error) {
		notifyToast({ color: 'red', title: 'Tab Window', message: ipcErrorMessage(error) });
		captureException(error instanceof Error ? error : new Error(String(error)), {
			extra: { operation: `tabWindows.${operation}` },
		});
	}
}
