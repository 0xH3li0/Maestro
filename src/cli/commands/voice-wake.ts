// `maestro-cli voice wake ...` - teach the wake word a phrase from recordings.
//
// The CLI path to Settings > Voice Controls > Train. Every verb crosses the WS
// bridge as one `voice_wake_enrollment` message and ends in the same
// main-process function the dialog's buttons call, so a recording started here
// and one started in Settings are the same recording, on the same microphone,
// under the same rules about who may borrow it.
//
// Two ways to supply recordings:
// - `record` opens the microphone on the computer running Maestro and keeps
//   each burst of speech as one recording until `stop`. That is the dialog's
//   Record button.
// - `add` takes WAV files instead. An agent has no microphone, and this is how
//   it brings audio. There is no dialog on this path: the files are named.
//
// A refusal the app gave on purpose (a voice session holds the microphone,
// there are too few recordings to train from) prints its reason and exits
// non-zero, so a script can tell "done" from "not done, and why".

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { resolveCliPath } from '../utils/parse';
import {
	WAKE_ENROLLMENT_BACKGROUND_MIN_MS,
	WAKE_ENROLLMENT_MIN_CLIPS,
	canTrainWakePhrase,
	describeWakeEnrollmentReport,
	type WakeEnrollmentReply,
	type WakeEnrollmentRequest,
	type WakeEnrollmentStatus,
} from '../../shared/acappella/wake-enrollment';

interface VoiceWakeOptions {
	json?: boolean;
	/** `record` and `add`: the recording is ordinary speech, not the phrase. */
	background?: boolean;
}

/** Enough for a status read or a recording to start. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Training runs every recording through the wake word's front end several
 * times. Sixty recordings take about a minute on a laptop; this leaves room.
 */
const TRAIN_TIMEOUT_MS = 300_000;

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

/** Send one request and return the app's reply, or exit with why the bridge failed. */
async function send(
	request: WakeEnrollmentRequest,
	options: VoiceWakeOptions,
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<WakeEnrollmentReply> {
	let response: { success: boolean; reply?: WakeEnrollmentReply; error?: string };
	try {
		response = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; reply?: WakeEnrollmentReply; error?: string }>(
				{ type: 'voice_wake_enrollment', request },
				'voice_wake_enrollment_result',
				timeoutMs
			)
		);
	} catch (error) {
		fail(
			error instanceof Error ? error.message : String(error),
			options.json,
			exitCodeForError(error)
		);
	}
	if (!response.success || !response.reply) {
		fail(response.error || 'Wake phrase request failed', options.json);
	}
	return response.reply;
}

/** The app's reply, or exit with the reason it refused. */
async function sendOrFail(
	request: WakeEnrollmentRequest,
	options: VoiceWakeOptions,
	timeoutMs?: number
): Promise<Extract<WakeEnrollmentReply, { ok: true }>> {
	const reply = await send(request, options, timeoutMs);
	if (!reply.ok) fail(reply.reason, options.json);
	return reply;
}

function requirePhrase(phrase: string, options: VoiceWakeOptions): string {
	const trimmed = phrase.trim();
	if (!trimmed) fail('phrase cannot be empty', options.json, ExitCode.InvalidUsage);
	return trimmed;
}

/** One phrase's enrollment as lines a person reads. */
export function formatWakeEnrollmentStatus(status: WakeEnrollmentStatus): string {
	const seconds = Math.round(status.backgroundMs / 1000);
	const lines = [
		`"${status.phrase}": ${status.clips} recording${status.clips === 1 ? '' : 's'}, ${seconds} s of other speech`,
	];
	if (status.recording) {
		lines.push(
			`  Recording ${status.recording === 'phrase' ? 'the phrase' : 'other speech'} now. Run "maestro-cli voice wake stop" to finish.`
		);
	}
	if (status.training) lines.push('  Training now.');
	if (status.model) {
		const { report } = status.model;
		lines.push(`  Trained (${report.quality}). ${describeWakeEnrollmentReport(report)}`);
		if (report.clipsUsed < report.clipsTotal) {
			lines.push(
				`  ${report.clipsTotal - report.clipsUsed} recording(s) were left out for sounding unlike the rest.`
			);
		}
		if (report.advice) lines.push(`  ${report.advice}`);
	} else if (canTrainWakePhrase(status)) {
		lines.push('  Not trained yet. Run "maestro-cli voice wake train" to train it.');
	} else {
		lines.push(
			`  Not trained. Training needs at least ${WAKE_ENROLLMENT_MIN_CLIPS} recordings and ${WAKE_ENROLLMENT_BACKGROUND_MIN_MS / 1000} s of other speech.`
		);
	}
	return lines.join('\n');
}

function printStatus(status: WakeEnrollmentStatus | null, options: VoiceWakeOptions): void {
	if (options.json) console.log(JSON.stringify({ success: true, status }));
	else if (status) console.log(formatWakeEnrollmentStatus(status));
}

/** `voice wake list` - every phrase with recordings, and where each one stands. */
export async function voiceWakeList(options: VoiceWakeOptions): Promise<void> {
	const { phrases = [] } = await sendOrFail({ action: 'list' }, options);
	const statuses: WakeEnrollmentStatus[] = [];
	for (const phrase of phrases) {
		const { status } = await sendOrFail({ action: 'status', phrase }, options);
		if (status) statuses.push(status);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, phrases: statuses }));
	} else if (!statuses.length) {
		console.log('No wake phrases have been recorded.');
	} else {
		console.log(statuses.map(formatWakeEnrollmentStatus).join('\n'));
	}
}

/** `voice wake status <phrase>` - what is recorded and whether it is trained. */
export async function voiceWakeStatus(phrase: string, options: VoiceWakeOptions): Promise<void> {
	const { status } = await sendOrFail(
		{ action: 'status', phrase: requirePhrase(phrase, options) },
		options
	);
	printStatus(status, options);
}

/** `voice wake record <phrase> [--background]` - open the microphone and keep what it hears. */
export async function voiceWakeRecord(phrase: string, options: VoiceWakeOptions): Promise<void> {
	const { status } = await sendOrFail(
		{
			action: 'record',
			phrase: requirePhrase(phrase, options),
			kind: options.background ? 'background' : 'phrase',
		},
		options
	);
	printStatus(status, options);
}

/** `voice wake stop` - end the recording in progress and close the microphone. */
export async function voiceWakeStop(options: VoiceWakeOptions): Promise<void> {
	const { status } = await sendOrFail({ action: 'stop' }, options);
	if (!status && !options.json) console.log('Nothing was recording.');
	else printStatus(status, options);
}

/** `voice wake add <phrase> <file.wav...> [--background]` - recordings from files. */
export async function voiceWakeAdd(
	phrase: string,
	files: string[],
	options: VoiceWakeOptions
): Promise<void> {
	const wanted = requirePhrase(phrase, options);
	if (!files.length) fail('name at least one WAV file', options.json, ExitCode.InvalidUsage);

	let status: WakeEnrollmentStatus | null = null;
	const skipped: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		const reply = await send(
			{
				action: 'import',
				phrase: wanted,
				kind: options.background ? 'background' : 'phrase',
				path: resolveCliPath(file),
			},
			options
		);
		// One bad file must not cost the rest: a folder of takes usually has one.
		if (reply.ok) status = reply.status ?? status;
		else skipped.push({ file, reason: reply.reason });
	}

	const added = files.length - skipped.length;
	if (options.json) {
		console.log(JSON.stringify({ success: added > 0, added, skipped, status }));
	} else {
		for (const entry of skipped) console.error(`Skipped ${entry.file}: ${entry.reason}`);
		if (status) console.log(formatWakeEnrollmentStatus(status));
	}
	if (added === 0) exitWith(ExitCode.GeneralError);
}

/** `voice wake undo <phrase>` - drop the newest recording of the phrase. */
export async function voiceWakeUndo(phrase: string, options: VoiceWakeOptions): Promise<void> {
	const { status } = await sendOrFail(
		{ action: 'remove-last-clip', phrase: requirePhrase(phrase, options) },
		options
	);
	printStatus(status, options);
}

/** `voice wake clear-background <phrase>` - drop the other speech so it can be recorded again. */
export async function voiceWakeClearBackground(
	phrase: string,
	options: VoiceWakeOptions
): Promise<void> {
	const { status } = await sendOrFail(
		{ action: 'clear-background', phrase: requirePhrase(phrase, options) },
		options
	);
	printStatus(status, options);
}

/** `voice wake train <phrase>` - build the model from what is recorded; waits until it is done. */
export async function voiceWakeTrain(phrase: string, options: VoiceWakeOptions): Promise<void> {
	const { status } = await sendOrFail(
		{ action: 'train', phrase: requirePhrase(phrase, options) },
		options,
		TRAIN_TIMEOUT_MS
	);
	printStatus(status, options);
}

/** `voice wake remove <phrase>` - delete the model and every recording of the phrase. */
export async function voiceWakeRemove(phrase: string, options: VoiceWakeOptions): Promise<void> {
	const wanted = requirePhrase(phrase, options);
	await sendOrFail({ action: 'remove', phrase: wanted }, options);
	if (options.json) console.log(JSON.stringify({ success: true, removed: wanted }));
	else console.log(`Removed every recording of "${wanted}" and its model.`);
}
