// `maestro-cli models list|install|pause|cancel|remove|verify` - the local
// model catalog and what is on disk.
//
// Every verb runs in the desktop over the WS bridge, through the same service
// functions (`src/main/local-models/service.ts`) as the `localModels:*` IPC
// channels the Settings > Models rows call, so the CLI and the app read
// the same model store, write through the same downloader (a download started
// in one is joined by the other, never duplicated), and hash with the same
// verifier. The CLI only decides what the Settings row decides before it calls:
// which ids are real, that a pending model is never offered for download, and
// that removing a model a task runs on is named first.

import { withMaestroClient } from '../services/maestro-client';
import { readLocalModelAssignments } from '../services/storage';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import {
	formatLocalModels,
	formatSuccess,
	formatWarning,
	type LocalModelDisplayStatus,
} from '../output/formatter';
import { formatSize } from '../../shared/formatters';
import {
	getLocalModel,
	groupByLocalModelKind,
	LOCAL_MODEL_KIND_LABELS,
	LOCAL_MODEL_KIND_ORDER,
} from '../../shared/local-models/model-catalog';
import { tasksUsingLocalModel } from '../../shared/local-models/tasks';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import type { LocalModelEntry, LocalModelKind } from '../../shared/local-models/types';
import { voiceModelUsageLabel } from '../../shared/acappella/voice-models';
import type { LocalModelListing, LocalRuntimeEnsureResult } from '../../main/local-models/service';
import type { DownloadResult } from '../../main/local-models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../../main/local-models/model-store';

/**
 * A model can be gigabytes, and the reply only comes when the job settles. If
 * this runs out the download keeps going in the app; only the wait ends.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Verify re-hashes every file, which takes a while for a multi-gigabyte model. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

interface JsonOption {
	json?: boolean;
}

interface ListOptions extends JsonOption {
	kind?: string;
}

interface RemoveOptions extends JsonOption {
	force?: boolean;
}

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

/** The catalog entry for an id, or a usage error naming how to find one. */
function requireModel(modelId: string, json: boolean | undefined): LocalModelEntry {
	const entry = getLocalModel(modelId);
	if (!entry) {
		fail(
			`Unknown model "${modelId}". See maestro-cli models list for model ids.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return entry;
}

/** One bridge round trip; a transport failure or a refused request exits. */
async function send<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs?: number
): Promise<T> {
	let reply: T;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<T>(payload, responseType, timeoutMs)
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), json, exitCodeForError(error));
	}
	if (!reply.success) fail(reply.error || 'Request failed', json);
	return reply;
}

/**
 * Who runs a model: the tasks whose effective assignment is it, then the voice
 * capability that uses it. The same list the Settings row's "In use by" line
 * shows.
 */
function usedBy(modelId: string): string[] {
	const tasks = tasksUsingLocalModel(readLocalModelAssignments(), modelId).map(
		(task) => task.label
	);
	const voice = voiceModelUsageLabel(modelId);
	return voice ? [...tasks, voice] : tasks;
}

function displayStatus(listing: LocalModelListing): LocalModelDisplayStatus {
	if (listing.status.status === 'not-installed' && listing.entry.pending) return 'pending';
	return listing.status.status;
}

export async function modelsList(options: ListOptions): Promise<void> {
	let kind: LocalModelKind | undefined;
	if (options.kind !== undefined) {
		const wanted = options.kind.trim();
		if (!LOCAL_MODEL_KIND_ORDER.includes(wanted as LocalModelKind)) {
			fail(
				`--kind must be one of: ${LOCAL_MODEL_KIND_ORDER.join(', ')}`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		kind = wanted as LocalModelKind;
	}

	const reply = await send<{
		success: boolean;
		error?: string;
		listings?: LocalModelListing[];
		footprint?: ModelFootprint;
	}>({ type: 'local_models_list' }, 'local_models_list_result', options.json);
	const listings = (reply.listings ?? []).filter(
		(listing) => kind === undefined || listing.entry.kind === kind
	);
	const footprintBytes = reply.footprint?.bytes ?? 0;

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				footprintBytes,
				models: listings.map((listing) => ({
					id: listing.entry.id,
					displayName: listing.entry.displayName,
					kind: listing.entry.kind,
					status: displayStatus(listing),
					bytes: listing.entry.bytes,
					bytesOnDisk: listing.status.bytesOnDisk,
					license: listing.entry.license,
					runtime: listing.entry.runtime,
					usedBy: usedBy(listing.entry.id),
					...(listing.entry.pending ? { pending: listing.entry.pending } : {}),
					...(listing.status.detail ? { detail: listing.status.detail } : {}),
				})),
			})
		);
		return;
	}

	const groups = groupByLocalModelKind(listings, (listing) => listing.entry.kind);
	console.log(
		formatLocalModels(
			groups.map((group) => ({
				kindLabel: LOCAL_MODEL_KIND_LABELS[group.kind],
				models: group.items.map((listing) => {
					const status = displayStatus(listing);
					return {
						id: listing.entry.id,
						displayName: listing.entry.displayName,
						status,
						size: formatSize(listing.entry.bytes),
						usedBy: usedBy(listing.entry.id),
						detail: status === 'pending' ? listing.entry.pending : listing.status.detail,
					};
				}),
			})),
			formatSize(footprintBytes)
		)
	);
}

export async function modelsInstall(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);
	if (entry.pending) {
		// The one download the catalog must never invite: weights nothing here can read.
		fail(
			`${entry.displayName} cannot run in this build, so it is not offered for download: ${entry.pending}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	if (!options.json) {
		console.log(
			`Downloading ${entry.displayName} (${formatSize(entry.bytes)}), and its engine if that is missing. Progress shows in ${modelsSettingsLocation('library')}.`
		);
	}
	const reply = await send<{
		success: boolean;
		error?: string;
		result?: DownloadResult & { runtime?: LocalRuntimeEnsureResult };
	}>(
		{ type: 'local_models_download', modelId },
		'local_models_download_result',
		options.json,
		INSTALL_TIMEOUT_MS
	);
	const result = reply.result;
	if (!result) fail('Download failed', options.json);

	if (result.status !== 'complete') {
		const why =
			result.status === 'error'
				? (result.error ?? 'Download failed')
				: `Download was ${result.status} in the app`;
		const mismatch = result.mismatch
			? ` (${result.mismatch.path}: expected ${result.mismatch.expected}, got ${result.mismatch.actual})`
			: '';
		if (options.json) {
			console.log(JSON.stringify({ ...result, success: false }));
			exitWith(ExitCode.GeneralError);
		}
		fail(`${why}${mismatch}`, false);
	}

	// The model arrived. Whether it can RUN also depends on its engine, which the
	// same call installs; a model reported as installed while its engine is
	// missing would send the caller to `models status` to find out why nothing works.
	const runtime = result.runtime;
	const runtimeFailed = runtime?.status === 'failed' || runtime?.status === 'unavailable';
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				modelId,
				status: result.status,
				...(runtime ? { runtime } : {}),
			})
		);
		return;
	}
	console.log(formatSuccess(`Installed ${entry.displayName}`));
	if (runtime?.status === 'installed') {
		console.log(`  Installed its engine too (${runtime.runtimeId}).`);
	}
	if (runtimeFailed && runtime) {
		console.log(
			formatWarning(
				runtime.status === 'unavailable'
					? `Its engine (${runtime.runtimeId}) has no build for this platform, so the model cannot run here.`
					: `Its engine (${runtime.runtimeId}) did not install: ${runtime.error ?? 'unknown error'}. Retry: maestro-cli models runtimes install ${runtime.runtimeId}`
			)
		);
	}
}

/**
 * Pause a running download and keep what arrived. There is no `resume` verb:
 * `models install` is the same call the row's Resume button makes, and it picks
 * the partial file back up.
 */
export async function modelsPause(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; paused?: boolean }>(
		{ type: 'local_models_pause', modelId },
		'local_models_pause_result',
		options.json
	);
	const paused = reply.paused === true;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, paused }));
		return;
	}
	if (!paused) {
		console.log(`${entry.displayName} is not downloading; nothing to pause.`);
		return;
	}
	console.log(formatSuccess(`Paused ${entry.displayName}`));
	console.log(`  Resume it: maestro-cli models install ${modelId}`);
}

/**
 * Cancel a download and delete everything it wrote, the partial file of a
 * paused one included. An installed model is not touched: that is `remove`.
 */
export async function modelsCancel(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; cancelled?: boolean }>(
		{ type: 'local_models_cancel', modelId },
		'local_models_cancel_result',
		options.json
	);
	const cancelled = reply.cancelled === true;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, cancelled }));
		return;
	}
	console.log(
		cancelled
			? formatSuccess(`Cancelled the download of ${entry.displayName}`)
			: `${entry.displayName} was not downloading; any partial file is cleared.`
	);
}

export async function modelsRemove(modelId: string, options: RemoveOptions): Promise<void> {
	const entry = requireModel(modelId, options.json);

	// Removing a model a task runs on turns that task unavailable. Settings names
	// the tasks and asks; here the ask is `--force`.
	const tasks = tasksUsingLocalModel(readLocalModelAssignments(), modelId).map(
		(task) => task.label
	);
	if (tasks.length > 0 && !options.force) {
		fail(
			`${entry.displayName} is assigned to ${tasks.join(', ')}. Removing it makes ${tasks.length === 1 ? 'that task' : 'those tasks'} unavailable. Re-run with --force to remove it anyway.`,
			options.json
		);
	}

	const reply = await send<{ success: boolean; error?: string; bytes?: number }>(
		{ type: 'local_models_remove', modelId },
		'local_models_remove_result',
		options.json
	);
	const bytes = reply.bytes ?? 0;

	if (options.json) {
		console.log(JSON.stringify({ success: true, modelId, bytesReclaimed: bytes, tasks }));
		return;
	}
	console.log(formatSuccess(`Removed ${entry.displayName} (${formatSize(bytes)} reclaimed)`));
	if (tasks.length > 0) {
		console.log(formatWarning(`Now unavailable: ${tasks.join(', ')}`));
	}
	const voice = voiceModelUsageLabel(modelId);
	if (voice) console.log(formatWarning(`${voice} used this model.`));
}

export async function modelsVerify(modelId: string, options: JsonOption): Promise<void> {
	const entry = requireModel(modelId, options.json);

	const reply = await send<{ success: boolean; error?: string; result?: VerifyResult }>(
		{ type: 'local_models_verify', modelId },
		'local_models_verify_result',
		options.json,
		VERIFY_TIMEOUT_MS
	);
	const result = reply.result;
	if (!result) fail('Verify failed', options.json);

	if (options.json) {
		console.log(JSON.stringify({ ...result, success: result.ok }));
		if (!result.ok) exitWith(ExitCode.GeneralError);
		return;
	}
	if (!result.ok) {
		// Verify never deletes or re-downloads: say what disagreed and leave the
		// choice to spend the bandwidth again with the user.
		const mismatch = result.mismatch
			? ` (${result.mismatch.path}: expected ${result.mismatch.expected}, got ${result.mismatch.actual})`
			: '';
		fail(
			`${entry.displayName} is ${result.status}: ${result.detail ?? 'verify failed'}${mismatch}`,
			false
		);
	}
	console.log(formatSuccess(`${entry.displayName} verified`));
}
