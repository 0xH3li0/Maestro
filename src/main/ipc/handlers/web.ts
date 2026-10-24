/**
 * Web/Live IPC Handlers
 *
 * This module handles IPC calls for web interface and live session operations:
 * - web:broadcastUserInput: Broadcast user input to web clients
 * - web:broadcastAutoRunState: Broadcast AutoRun state to web clients
 * - web:claimAutoRunStart / web:releaseAutoRunStartClaim: Serialize Auto Run starts across clients
 * - web:takeOrphanedAutoRuns / web:abandonAutoRunReclaim: Hand a reloaded client back its runs
 * - web:broadcastTabsChange: Broadcast tab changes to web clients
 * - web:broadcastSessionState: Broadcast session state changes to web clients
 * - live:toggle: Toggle live mode for a session
 * - live:getStatus: Get live status for a session
 * - live:getDashboardUrl: Get the dashboard URL
 * - live:getLiveSessions: Get all live sessions
 * - live:broadcastActiveSession: Broadcast active session change
 * - live:startServer: Start the web server
 * - live:stopServer: Stop the web server
 * - live:persistCurrentToken: Persist the running server's token and enable persistent web link
 * - live:clearPersistentToken: Clear the persisted token and disable persistent web link
 * - live:disableAll: Disable all live sessions and stop server
 * - webserver:getUrl: Get the web server URL
 * - webserver:getConnectedClients: Get connected client count
 *
 * Extracted from main/index.ts to improve code organization.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import type { AITabData } from '../../web-server/services/broadcastService';
import { getAutoRunStateTracker, type AutoRunOwner } from '../../autorun/autorun-state-tracker';
import type { AutoRunBroadcastState } from '../../../shared/autoRunBroadcast';
import type { BatchRunConfig } from '../../../shared/types';
import type { AutoRunRemoteControl } from '../../../shared/autoRunRemote';
import {
	startLiveServer,
	stopLiveServer,
	disableAllLive,
	isLiveModeOn,
	type LiveModeDependencies,
} from '../../web-server/live-mode';

// The CLI server lifecycle lives in the Live Mode service; re-exported here
// because startup and the quit handler have always imported it from this module.
export {
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
} from '../../web-server/live-mode';

/**
 * Timeout for waiting for web server to become active (ms)
 */
const SERVER_STARTUP_TIMEOUT_MS = 5000;

/**
 * Polling interval when waiting for server startup (ms)
 */
const SERVER_STARTUP_POLL_INTERVAL_MS = 100;

/**
 * Dependencies required for web handlers. Same shape as the Live Mode
 * service's deps, since most of what these handlers do is call it.
 */
export type WebHandlerDependencies = LiveModeDependencies;

/**
 * Accept a run owner only when it has the shape a reload needs to hand the run
 * back. A malformed one is dropped rather than refused: the run still starts,
 * it just cannot be resumed after a reload, which is today's behaviour.
 */
function asAutoRunOwner(owner: unknown): AutoRunOwner | undefined {
	if (!owner || typeof owner !== 'object') return undefined;
	const { instanceId, config, folderPath } = owner as Partial<AutoRunOwner>;
	if (typeof instanceId !== 'string' || instanceId === '') return undefined;
	if (typeof folderPath !== 'string' || !config || typeof config !== 'object') return undefined;
	return { instanceId, config, folderPath };
}

/**
 * Register all web/live-related IPC handlers.
 */
export function registerWebHandlers(deps: WebHandlerDependencies): void {
	const { getWebServer, settingsStore } = deps;
	ipcMain.handle(
		'web:startAutoRun',
		async (_, sessionId: string, config: BatchRunConfig, folderPath: string) => {
			const server = getWebServer();
			if (!server) return { success: false, error: 'Host Auto Run owner is unavailable' };
			return server.requestStartAutoRun(sessionId, config, folderPath);
		}
	);
	ipcMain.handle(
		'web:controlAutoRun',
		async (_, sessionId: string, control: AutoRunRemoteControl) => {
			const server = getWebServer();
			if (!server) return { success: false, error: 'Host Auto Run owner is unavailable' };
			return server.requestControlAutoRun(sessionId, control);
		}
	);

	// Broadcast user input to web clients (called when desktop sends a message)
	ipcMain.handle(
		'web:broadcastUserInput',
		async (_, sessionId: string, command: string, inputMode: 'ai' | 'terminal') => {
			const webServer = getWebServer();
			const clientCount = webServer?.getWebClientCount() ?? 0;
			logger.debug(
				`web:broadcastUserInput called - webServer: ${webServer ? 'exists' : 'null'}, clientCount: ${clientCount}`,
				'WebBroadcast'
			);
			if (webServer && clientCount > 0) {
				webServer.broadcastUserInput(sessionId, command, inputMode);
				return true;
			}
			return false;
		}
	);

	// Broadcast AutoRun state to web clients (called when batch processing state changes)
	// Always store state even if no clients are connected, so new clients get initial state
	ipcMain.handle('web:claimAutoRunStart', async (_, sessionId: string, owner?: AutoRunOwner) => {
		return getAutoRunStateTracker().tryClaimStart(sessionId, asAutoRunOwner(owner));
	});
	ipcMain.handle('web:releaseAutoRunStartClaim', async (_, sessionId: string) => {
		return getAutoRunStateTracker().releaseStartClaim(sessionId);
	});
	// A reloaded client asking for the runs its previous page left running
	// (#1470). Main answers only with runs that same client started.
	ipcMain.handle('web:takeOrphanedAutoRuns', async (_, instanceId: string) => {
		if (typeof instanceId !== 'string' || instanceId === '') return [];
		return getAutoRunStateTracker().takeOrphanedRuns(instanceId);
	});
	ipcMain.handle('web:abandonAutoRunReclaim', async (_, sessionId: string, instanceId: string) => {
		return getAutoRunStateTracker().abandonReclaim(sessionId, instanceId);
	});

	ipcMain.handle(
		'web:broadcastAutoRunState',
		async (_, sessionId: string, state: AutoRunBroadcastState | null) => {
			// Feed the first-party main-process tracker FIRST, unconditionally.
			// The web-server branch below returns early when Live Mode is off, so
			// anything downstream of it (dispatch callbacks, and later Cue's
			// agent.completed) would otherwise never learn that an Auto Run batch
			// finished. Auto Run finality is main-process state now, not a
			// web-broadcast side effect.
			getAutoRunStateTracker().update(sessionId, state);

			const webServer = getWebServer();
			if (webServer) {
				// Always call broadcastAutoRunState - it stores the state for new clients
				// and broadcasts to any currently connected clients
				webServer.broadcastAutoRunState(sessionId, state);
				return true;
			}
			return false;
		}
	);

	// Broadcast tab changes to web clients
	ipcMain.handle('web:requestNewTab', async (_, sessionId: string, background = false) => {
		const webServer = getWebServer();
		return webServer?.requestNewTab(sessionId, background) ?? null;
	});
	ipcMain.handle('web:requestCloseTab', async (_, sessionId: string, tabId: string) => {
		if (typeof sessionId !== 'string' || !sessionId || typeof tabId !== 'string' || !tabId)
			return false;
		return getWebServer()?.requestCloseTab(sessionId, tabId) ?? false;
	});

	ipcMain.handle('web:requestReopenTab', async (_, sessionId: string, tabId: string) => {
		if (typeof sessionId !== 'string' || !sessionId || typeof tabId !== 'string' || !tabId)
			return null;
		return getWebServer()?.requestReopenTab(sessionId, tabId) ?? null;
	});

	ipcMain.handle(
		'web:broadcastTabsChange',
		async (
			_,
			sessionId: string,
			aiTabs: AITabData[],
			activeTabId: string,
			activeTabChanged = false
		) => {
			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				webServer.broadcastTabsChange(sessionId, aiTabs, activeTabId, activeTabChanged);
				return true;
			}
			return false;
		}
	);

	// Broadcast session state change to web clients (for real-time busy/idle updates)
	// This is called directly from the renderer to bypass debounced persistence
	// which resets state to 'idle' before saving
	ipcMain.handle(
		'web:broadcastSessionState',
		async (
			_,
			sessionId: string,
			state: string,
			additionalData?: {
				name?: string;
				toolType?: string;
				inputMode?: string;
				cwd?: string;
			}
		) => {
			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				webServer.broadcastSessionStateChange(sessionId, state, additionalData);
				return true;
			}
			return false;
		}
	);

	// Live session management - toggle sessions as live/offline in web interface
	ipcMain.handle('live:toggle', async (_, sessionId: string, agentSessionId?: string) => {
		const webServer = getWebServer();
		if (!webServer) {
			throw new Error('Web server not initialized');
		}

		// Ensure web server is running before allowing live toggle
		if (!webServer.isActive()) {
			logger.warn('Web server not yet started, waiting...', 'Live');
			// Wait for server to start (with timeout)
			const startTime = Date.now();
			while (!webServer.isActive() && Date.now() - startTime < SERVER_STARTUP_TIMEOUT_MS) {
				await new Promise((resolve) => setTimeout(resolve, SERVER_STARTUP_POLL_INTERVAL_MS));
			}
			if (!webServer.isActive()) {
				throw new Error('Web server failed to start');
			}
		}

		const isLive = webServer.isSessionLive(sessionId);

		if (isLive) {
			// Turn off live mode
			webServer.setSessionOffline(sessionId);
			logger.info(`Session ${sessionId} is now offline`, 'Live');
			return { live: false, url: null };
		} else {
			// Turn on live mode
			logger.info(
				`Enabling live mode for session ${sessionId} (claude: ${agentSessionId || 'none'})`,
				'Live'
			);
			webServer.setSessionLive(sessionId, agentSessionId);
			const url = webServer.getSessionUrl(sessionId);
			logger.info(`Session ${sessionId} is now live at ${url}`, 'Live');
			return { live: true, url };
		}
	});

	ipcMain.handle('live:getStatus', async (_, sessionId: string) => {
		const webServer = getWebServer();
		if (!webServer) {
			return { live: false, url: null };
		}
		const isLive = webServer.isSessionLive(sessionId);
		return {
			live: isLive,
			url: isLive ? webServer.getSessionUrl(sessionId) : null,
		};
	});

	// Only a Live Mode (LAN) server has a dashboard. The loopback CLI server's
	// URL is not one: auto-start reads a non-null answer as "Live is already
	// on" and would never open the server to the LAN.
	ipcMain.handle('live:getDashboardUrl', async () => {
		const webServer = getWebServer();
		return isLiveModeOn(webServer) ? webServer.getSecureUrl() : null;
	});

	ipcMain.handle('live:getLiveSessions', async () => {
		const webServer = getWebServer();
		if (!webServer) {
			return [];
		}
		return webServer.getLiveSessions();
	});

	ipcMain.handle('live:broadcastActiveSession', async (_, sessionId: string) => {
		const webServer = getWebServer();
		if (webServer) {
			webServer.broadcastActiveSessionChange(sessionId);
		}
	});

	// Start web server (creates if needed, starts if not running). Shared with
	// `maestro-cli live on` through the Live Mode service.
	ipcMain.handle('live:startServer', async () => startLiveServer(deps));

	// Stop web server and clean up
	ipcMain.handle('live:stopServer', async () => stopLiveServer(deps));

	// Persist the current web server's security token and enable persistent web link.
	// Flag is written first: a crash between the two writes leaves
	// persistentWebLink=true with a missing/stale token, which the factory
	// handles by generating and persisting a fresh UUID on next startup.
	ipcMain.handle('live:persistCurrentToken', async () => {
		const webServer = getWebServer();
		if (!webServer || !webServer.isActive()) {
			return { success: false, message: 'Web server is not running.' };
		}
		try {
			const currentToken = webServer.getSecurityToken();
			settingsStore.set('persistentWebLink', true);
			settingsStore.set('webAuthToken', currentToken);
			logger.info(
				'Persisted current web server token and enabled persistent web link',
				'WebServer'
			);
			return { success: true };
		} catch (error: any) {
			// Rollback the flag so the factory doesn't read persistentWebLink=true
			// with a missing token on next startup, which would silently change the URL.
			try {
				settingsStore.set('persistentWebLink', false);
			} catch {
				// Best-effort rollback - disk may be completely unavailable
			}
			logger.error(`Failed to persist web server token: ${error.message}`, 'WebServer');
			return { success: false, message: error.message };
		}
	});

	// Clear persistent web link token and disable the flag on the main side.
	// Flag is cleared first: a crash between the two writes leaves
	// persistentWebLink=false with a stale token, which the factory ignores.
	ipcMain.handle('live:clearPersistentToken', async () => {
		try {
			settingsStore.set('persistentWebLink', false);
			settingsStore.set('webAuthToken', null);
			logger.info('Cleared persistent web link token and disabled flag', 'WebServer');
			return { success: true };
		} catch (error: any) {
			// Rollback the flag so disk state stays consistent - prevents
			// persistentWebLink=false with a stale token on next startup.
			try {
				settingsStore.set('persistentWebLink', true);
			} catch {
				// Best-effort rollback - disk may be completely unavailable
			}
			logger.error(`Failed to clear persistent token: ${error.message}`, 'WebServer');
			return { success: false, message: error.message };
		}
	});

	// Disable all live sessions and stop the server
	ipcMain.handle('live:disableAll', async () => disableAllLive(deps));

	// Web server management
	ipcMain.handle('webserver:openLitePairing', async (event) => {
		const parent = BrowserWindow.fromWebContents(event.sender);
		if (!parent || event.senderFrame !== event.sender.mainFrame)
			throw new Error('Host-local window required');
		const server = getWebServer();
		if (!server?.isActive()) throw new Error('Existing Maestro server is not running');
		await server.openLitePairing(parent);
	});
	ipcMain.handle('webserver:getUrl', async () => {
		return getWebServer()?.getSecureUrl();
	});

	ipcMain.handle('webserver:getConnectedClients', async () => {
		return getWebServer()?.getWebClientCount() || 0;
	});
}
