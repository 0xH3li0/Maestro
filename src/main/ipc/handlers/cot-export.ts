/**
 * Chain of thought export: the IPC handlers of its one control.
 *
 * WHO MAY CALL THESE
 * A person at the desktop app, through the section in the Edit Agent dialog.
 * Nobody else. That is the whole reason this file registers its channels by
 * hand: the web bridge (`web-server/handlers/bridgeHandlers.ts`) dispatches
 * ANY registered `ipcMain` handler to whoever holds its token, and an agent's
 * shell can read that token. So every handler here first proves that the call
 * came from a window of the desktop app (`assertDesktopSender`), and that
 * proof needs the IPC event.
 *
 * `createIpcHandler`, `createHandler`, and `withIpcErrorLogging` all drop the
 * event before they call the handler. Do not move these channels onto them: a
 * handler behind one of them cannot tell the desktop window from the bridge.
 *
 * WHAT THIS FILE NEVER DOES
 * - It sends nothing to the renderer. A value leaves only as the answer to
 *   the desktop window that asked. An event pushed with `safeSend` also fans
 *   out to every web client.
 * - It writes nothing to Maestro's logs, and reports nothing to Sentry.
 *   Agents can read the logs.
 * - It touches no agent (`Session`) object, no settings, no agent config.
 *
 * The one thing it raises by its own choice is a native OS notification, when
 * a log starts to fail. That goes to the person's screen and nowhere else.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 * Do not add these channels to any guide.
 */

import { BrowserWindow, Notification, ipcMain, webContents } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { COT_EXPORT_CHANNELS } from '../../../shared/cotExport/channels';
import type { CotExportChannelName } from '../../../shared/cotExport/channels';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainVerifyResult,
	CotFolderValidation,
	CotSetResult,
} from '../../../shared/cotExport/types';
import { DURATION_MS } from '../../../shared/duration';
import { getCotConfigStore, setCotFailureListener } from '../../cot-export/config-store';
import type { CotFailureListener } from '../../cot-export/config-store';
import { getCotWriter } from '../../cot-export/runtime';
import { verifyAgentChain } from '../../cot-export/verify';

// ============================================================================
// The sender check
// ============================================================================

/**
 * The whole answer to a caller that is not the desktop app. It says nothing
 * more on purpose: not which check failed, and not what the channel is for.
 */
const NOT_AVAILABLE = 'Not available';

/**
 * Whether an IPC call came from a window of the desktop app.
 *
 * Three things must hold, and any doubt is a no:
 * - The event has a sender, and it is the `WebContents` Electron itself keeps
 *   under that id. The bridge's synthetic event has no sender at all, and an
 *   object that only looks like a `WebContents` is not the one Electron has.
 * - The sender is a window. A `<webview>` guest (an embedded browser tab) is
 *   owned by a window too, so the owner alone does not tell them apart.
 * - A `BrowserWindow` owns it.
 */
function isDesktopSender(event: IpcMainInvokeEvent | undefined): boolean {
	try {
		const sender = event?.sender;
		if (!sender || typeof sender.id !== 'number') return false;
		if (webContents.fromId(sender.id) !== sender) return false;
		if (sender.getType() !== 'window') return false;
		return BrowserWindow.fromWebContents(sender) !== null;
	} catch {
		return false;
	}
}

/**
 * Throws unless the call came from a window of the desktop app. Every handler
 * in this file runs it before anything else, and before it reads an argument.
 *
 * The limit, stated plainly: this stops a caller that reaches the handlers
 * from outside the desktop window, which is what the web bridge and the CLI
 * are. It does not stop a process that drives the desktop window itself.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent): void {
	if (!isDesktopSender(event)) throw new Error(NOT_AVAILABLE);
}

// ============================================================================
// The failure notice
// ============================================================================

/** How long an agent's failures stay quiet after the person was told of one. */
export const COT_FAILURE_NOTICE_INTERVAL_MS = DURATION_MS.hour;

/** The longest reason a notice carries. A notice is a line or two on screen. */
const MAX_NOTICE_REASON_CHARS = 120;

/**
 * The part of a failure's message that fits a notice: its first line, cut to
 * length. A file system error from Node ends in the call and the path it
 * failed on (`, open '/a/b.jsonl'`). That tail is dropped, because the path is
 * long and it is the log folder.
 */
export function shortFailureReason(message: string): string {
	const firstLine = message.split('\n', 1)[0].trim();
	const reason = firstLine.replace(/, \w+ ['"].*$/, '').trim();
	if (reason === '') return 'unknown error';
	return reason.length > MAX_NOTICE_REASON_CHARS
		? `${reason.slice(0, MAX_NOTICE_REASON_CHARS - 3).trimEnd()}...`
		: reason;
}

/**
 * Tells the person, with a native OS notification, that an agent's log is
 * failing: at most once per agent per `COT_FAILURE_NOTICE_INTERVAL_MS`.
 *
 * The store hands over every failure, and a disk that is full fails every
 * record of every turn, so the limit is kept here. The dialog shows the last
 * failure in full at any time. The notice is only what gets the person to
 * open it.
 *
 * The wording fits both things a failure can be: a record that could not be
 * written, and a head that could not be checked against the disk.
 */
export function createCotFailureNotifier(
	getAgentName: (agentId: string) => string | undefined
): CotFailureListener {
	/**
	 * The last notice of each agent, and when it was shown. The notice itself
	 * is kept because the OS can withdraw one whose object was collected.
	 */
	const shown = new Map<string, { at: number; notice: Notification }>();

	return (agentId, error) => {
		const last = shown.get(agentId);
		if (last && error.at - last.at < COT_FAILURE_NOTICE_INTERVAL_MS) return;
		if (!Notification.isSupported()) return;
		const name = getAgentName(agentId)?.trim() || 'an agent';
		const notice = new Notification({
			title: 'Maestro',
			body: `Chain of thought export for ${name} is failing: ${shortFailureReason(error.message)}`,
		});
		notice.show();
		shown.set(agentId, { at: error.at, notice });
	};
}

// ============================================================================
// The handlers
// ============================================================================

/**
 * How many times a verify walks a chain that the agent wrote to during the
 * walk, before it gives the verdict it has.
 */
const VERIFY_ATTEMPTS = 3;

function requireAgentId(value: unknown): string {
	if (typeof value !== 'string' || value === '') throw new TypeError('An agent id is required.');
	return value;
}

/**
 * What the person chose, as the dialog sends it. A change is made only from a
 * well-formed choice: a value of the wrong type must not read as "off".
 */
function requireChoice(value: unknown): { enabled: boolean; folder: string | null } {
	const choice = (typeof value === 'object' && value !== null ? value : {}) as {
		enabled?: unknown;
		folder?: unknown;
	};
	if (
		typeof choice.enabled !== 'boolean' ||
		(choice.folder !== null && typeof choice.folder !== 'string')
	) {
		throw new TypeError('A change needs `enabled` (a boolean) and `folder` (a path or null).');
	}
	return { enabled: choice.enabled, folder: choice.folder };
}

/**
 * Checks the agent's chain in `folder` against the head Maestro holds for it.
 *
 * `recover` goes first, for two reasons. After a hard stop the stored head can
 * be behind the disk, and a verify then would report an intact log as missing
 * its newest records. And `recover` waits its turn behind the agent's writes,
 * so the head read after it belongs to a chain with no write under way.
 *
 * An agent can still write while the walk runs, and the walk then sees a
 * record the head it was given does not know. So a walk that fails while the
 * head moved is run again, a few times. A walk that passes needs no second
 * look: it saw every record up to the head it was given, in order.
 */
async function verifyChain(agentId: string, folder: string): Promise<CotChainVerifyResult> {
	const store = getCotConfigStore();
	const writer = getCotWriter();
	const storedHead = (): string | null => store.getChainState(agentId, folder)?.head ?? null;

	for (let attempt = 1; ; attempt++) {
		await writer.recover(agentId, folder);
		const head = storedHead();
		const result = { folder, ...(await verifyAgentChain(folder, head)) };
		if (result.ok || attempt === VERIFY_ATTEMPTS) return result;
		await writer.recover(agentId, folder);
		if (storedHead() === head) return result;
	}
}

/**
 * One handler per channel, keyed by the channel's name, so a channel added to
 * `COT_EXPORT_CHANNELS` does not compile until it has a handler here. The
 * arguments arrive untyped, as IPC delivers them.
 */
const HANDLERS: Record<CotExportChannelName, (...args: unknown[]) => unknown> = {
	get: (agentId): CotAgentConfig => getCotConfigStore().getAgentConfig(requireAgentId(agentId)),

	set: async (agentId, choice): Promise<CotSetResult> => {
		const id = requireAgentId(agentId);
		const store = getCotConfigStore();
		const result = store.setAgentConfig(id, requireChoice(choice));
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, status: await store.getStatus(id) };
	},

	status: (agentId): Promise<CotAgentStatus> =>
		getCotConfigStore().getStatus(requireAgentId(agentId)),

	// The store's own check, never a rebuilt one: it also knows that no two
	// agents may share a folder. A folder that is not a path is refused there
	// the way an empty one is, with a reason for the person.
	validateFolder: (agentId, folder): CotFolderValidation =>
		getCotConfigStore().validateFolder(
			requireAgentId(agentId),
			typeof folder === 'string' ? folder : ''
		),

	verify: async (agentId): Promise<CotChainVerifyResult[]> => {
		const id = requireAgentId(agentId);
		const { current, past } = getCotConfigStore().getChains(id);
		const results: CotChainVerifyResult[] = [];
		// One after the other: the folders of one agent often share a disk, and
		// a verify is not worth a burst of reads on the main process.
		for (const chain of current ? [current, ...past] : past) {
			results.push(await verifyChain(id, chain.folder));
		}
		return results;
	},
};

/**
 * Everything the handlers need from the app. The store and the writer are not
 * here: they are the app's own (`getCotConfigStore`, `getCotWriter`), because
 * a chain has one head and a second writer would fork it.
 */
export interface CotExportHandlerDependencies {
	/** The name the person gave an agent, for the failure notice. */
	getAgentName: (agentId: string) => string | undefined;
}

/**
 * Registers the channels, each behind the sender check, and starts telling
 * the person when a log fails. Call it once: Electron refuses a second handler
 * for a channel.
 *
 * The loop is what keeps the check in front of every handler: a channel
 * cannot be registered here without it.
 */
export function registerCotExportHandlers(deps: CotExportHandlerDependencies): void {
	for (const name of Object.keys(HANDLERS) as CotExportChannelName[]) {
		const handler = HANDLERS[name];
		ipcMain.handle(COT_EXPORT_CHANNELS[name], async (event, ...args: unknown[]) => {
			assertDesktopSender(event);
			return handler(...args);
		});
	}
	setCotFailureListener(createCotFailureNotifier(deps.getAgentName));
}
