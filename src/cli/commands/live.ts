// Live mode commands - the CLI half of the Left Bar LIVE pill (the web
// interface switch). `live on|off` reach the same main-process switch the pill
// does, over the CLI-only `live_command` message; `live status` reads it back.
//
// A switch replaces the server this CLI is connected to, so the app answers
// first and switches after. The CLI then reconnects (the discovery file names
// the new server) and polls `status` until the switch has finished. Any other
// maestro-cli call in flight at that moment drops, as it does for the pill.

import { withMaestroClient } from '../services/maestro-client';
import { failCommand, failFromError } from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import {
	LIVE_COMMAND,
	LIVE_COMMAND_RESULT,
	type LiveCommandAction,
	type LiveCommandResult,
	type LiveModeStatus,
} from '../../shared/liveMode';

export interface LiveOptions {
	json?: boolean;
	/**
	 * Accepted and intentionally ignored on `on` / `off`: a Live switch moves no
	 * view, so there is nothing for the flag to suppress. See
	 * `ALREADY_QUIET_VERBS` in `shared/focusPlacement.ts`.
	 */
	background?: boolean;
}

/** How long a switch may take: a Windows tunnel kill plus a failed start's retries. */
export const LIVE_SWITCH_TIMEOUT_MS = 20_000;
/** Pause between status reads while a switch finishes. */
export const LIVE_POLL_INTERVAL_MS = 250;

async function sendLiveCommand(action: LiveCommandAction): Promise<LiveCommandResult> {
	return withMaestroClient((client) =>
		client.sendCommand<LiveCommandResult & { type: string }>(
			{ type: LIVE_COMMAND, action },
			LIVE_COMMAND_RESULT
		)
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read status until the switch the app promised has finished. While it runs
 * the old server goes away and the discovery file is briefly missing, so a
 * failed connect means "not yet", not "the app quit".
 */
async function awaitSwitch(revision: number): Promise<LiveModeStatus> {
	const deadline = Date.now() + LIVE_SWITCH_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		await sleep(LIVE_POLL_INTERVAL_MS);
		try {
			const reply = await sendLiveCommand('status');
			if (reply.success && reply.status && reply.status.revision >= revision) return reply.status;
		} catch (error) {
			lastError = error;
		}
	}
	const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
	throw new Error(
		`Live mode did not finish switching within ${LIVE_SWITCH_TIMEOUT_MS / 1000}s${detail}. Check it with \`maestro-cli live status\`.`
	);
}

function printStatus(status: LiveModeStatus): void {
	console.log(`Live: ${status.live ? 'on' : 'off'}`);
	if (status.url) console.log(`  URL: ${status.url}`);
	console.log(`  Remote Control: ${status.remoteControl ? 'on' : 'off'}`);
	if (status.lastError) console.log(`  Last error: ${status.lastError}`);
}

function statusJson(status: LiveModeStatus, extra: Record<string, unknown> = {}) {
	return JSON.stringify({ success: true, ...extra, ...status });
}

export async function liveStatus(options: LiveOptions): Promise<void> {
	let reply: LiveCommandResult;
	try {
		reply = await sendLiveCommand('status');
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.status) {
		failCommand(reply.error || 'Could not read Live mode', options.json);
	}
	if (options.json) {
		console.log(statusJson(reply.status));
		return;
	}
	printStatus(reply.status);
}

async function liveSet(live: boolean, options: LiveOptions): Promise<void> {
	const json = options.json;
	const word = live ? 'on' : 'off';

	// Only the bridge calls sit inside the try blocks, so a failCommand exit
	// below is never caught and reported a second time.
	let reply: LiveCommandResult;
	try {
		reply = await sendLiveCommand(word);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success || !reply.status) {
		failCommand(reply.error || `Could not turn Live mode ${word}`, json);
	}

	let status = reply.status;
	const changed = reply.changed === true;
	if (changed) {
		try {
			status = await awaitSwitch(reply.awaitRevision ?? status.revision + 1);
		} catch (error) {
			failFromError(error, json);
		}
		if (status.live !== live) {
			failCommand(status.lastError || `Live mode did not turn ${word}`, json);
		}
	}

	if (json) {
		console.log(statusJson(status, { changed }));
		return;
	}
	console.log(formatSuccess(changed ? `Live mode is ${word}` : `Live mode was already ${word}`));
	printStatus(status);
}

export async function liveOn(options: LiveOptions): Promise<void> {
	await liveSet(true, options);
}

export async function liveOff(options: LiveOptions): Promise<void> {
	await liveSet(false, options);
}
