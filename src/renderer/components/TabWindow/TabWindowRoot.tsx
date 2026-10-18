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
 */

import { LayerStackProvider } from '../../contexts/LayerStackContext';
import { useWindowSettingsSync } from '../../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../../hooks/ui/useResolvedTheme';
import { ToastContainer } from '../Toast';
import { CenterFlash } from '../CenterFlash';
import { ImageContextMenuHost } from '../ImageContextMenuHost';
import { ZoomViewerHost } from '../ZoomViewer';

export interface TabWindowRootProps {
	/** Registry id of this tab window (the `?tabWindow=<id>` query value). */
	windowId: string;
}

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

	return (
		<div
			className="flex flex-col h-screen w-screen overflow-hidden"
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
			data-testid="tab-window-root"
			data-tab-window-id={windowId}
		>
			<ToastContainer theme={theme} />
			<CenterFlash theme={theme} />
			<ImageContextMenuHost theme={theme} />
			<ZoomViewerHost theme={theme} />
		</div>
	);
}
