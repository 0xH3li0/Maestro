// `maestro-cli s1 status|set|key|test` - the System One engine from the command
// line: which engine answers typed questions, where its key comes from, and
// whether it answers.
//
// Every verb runs in the desktop over the WS bridge, through the same service
// functions the System One card in Settings > Models calls, so an engine chosen
// here is the one the card shows and the other way around.
//
//   status            the report: the engine, its address, model and budget,
//                     where each key comes from, and the fail policies
//   set engine        off | jev-cloud | openjev | local-judge, with --url (the
//                     OpenJev server) and --model (a pinned model; for the
//                     local judge, the source it answers on)
//   set timeout       the request budget for Jev and OpenJev, in milliseconds
//   set fail-policy   what one task does when the engine gives no answer
//   key set           store a key, read from STANDARD INPUT. It is never an
//                     argument, so it is never in shell history or a process list
//   key clear         forget the stored key
//   test              ask one fixed question; print the answer, latency, engine
//
// No verb prints a key, and no reply from the app carries one.
//
// Exit codes, for scripts: `status` exits non-zero when the engine in force
// cannot answer as it is set up (no key, no URL, no model); `off` is not a
// failure. `test` exits non-zero when the engine gave no answer.

import * as fs from 'fs';

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import {
	formatSuccess,
	formatSystemOneReport,
	formatSystemOneTestResult,
	formatWarning,
} from '../output/formatter';
import {
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	type SystemOneRemoteEngineId,
} from '../../shared/local-models/system-one';
import {
	SYSTEM_ONE_ENGINE_CHOICES,
	SYSTEM_ONE_REMOTE_ENGINE_IDS,
	isSystemOneEngineChoice,
	isSystemOneRemoteEngineId,
	systemOneFailPolicyProblem,
	systemOneKeyProblem,
	systemOneModelProblem,
	systemOneTimeoutProblem,
	systemOneUrlProblem,
	type SystemOneReport,
	type SystemOneSettingsPatch,
	type SystemOneTestResult,
} from '../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID, localModelAssignmentCaution } from '../../shared/local-models/tasks';
import { resolveAssignmentSpec, storeTaskAssignment } from './models-assign';

/** A status read or a settings write: one small file and no network. */
const STATUS_TIMEOUT_MS = 15_000;
/** A test waits for the engine. The local judge may load a model first. */
const TEST_TIMEOUT_MS = LOCAL_JUDGE_DEFAULT_TIMEOUT_MS + 15_000;

/** The word that removes a pin or a choice, as `--tier <tier>=default` spells it. */
const DEFAULT_WORD = 'default';

interface JsonOption {
	json?: boolean;
}

type ReportReply = { success: boolean; error?: string; report?: SystemOneReport };

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

async function send<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs = STATUS_TIMEOUT_MS
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

function requireReport(reply: ReportReply, json: boolean | undefined): SystemOneReport {
	if (!reply.report) fail('The desktop app sent no System One report.', json);
	return reply.report;
}

async function readStatus(json: boolean | undefined): Promise<SystemOneReport> {
	return requireReport(
		await send<ReportReply>({ type: 'system_one_status' }, 'system_one_status_result', json),
		json
	);
}

async function applyPatch(
	patch: SystemOneSettingsPatch,
	json: boolean | undefined
): Promise<SystemOneReport> {
	return requireReport(
		await send<ReportReply>({ type: 'system_one_set', patch }, 'system_one_set_result', json),
		json
	);
}

/** Print a report: the whole record as JSON, or the formatted block. */
function printReport(report: SystemOneReport, json: boolean | undefined): void {
	if (json) console.log(JSON.stringify({ success: report.problem === null, ...report }));
	else console.log(formatSystemOneReport(report));
}

export async function systemOneStatus(options: JsonOption): Promise<void> {
	const report = await readStatus(options.json);
	printReport(report, options.json);
	if (report.problem !== null) exitWith(ExitCode.GeneralError);
}

interface SetEngineOptions extends JsonOption {
	url?: string;
	model?: string;
}

export async function systemOneSetEngine(engine: string, options: SetEngineOptions): Promise<void> {
	const { json } = options;
	if (!isSystemOneEngineChoice(engine)) {
		fail(
			`"${engine}" is not an engine. Use ${SYSTEM_ONE_ENGINE_CHOICES.join(', ')}.`,
			json,
			ExitCode.InvalidUsage
		);
	}

	const patch: SystemOneSettingsPatch = { engine };
	if (options.url !== undefined) {
		if (engine !== 'openjev') {
			fail(
				'--url is the address of an OpenJev server. Use it with: s1 set engine openjev',
				json,
				ExitCode.InvalidUsage
			);
		}
		const problem = systemOneUrlProblem(options.url);
		if (problem) fail(problem, json, ExitCode.InvalidUsage);
		patch.openJevUrl = options.url;
	}

	// The local judge has no pin: its model is the Local judge task's
	// assignment, so `--model` is an assignment spelling and is stored the way
	// `models assign local-judge <source>` stores it.
	let judge: ReturnType<typeof resolveAssignmentSpec> | null = null;
	if (options.model !== undefined) {
		if (engine === 'off') {
			fail('--model needs an engine. Off answers nothing.', json, ExitCode.InvalidUsage);
		}
		if (engine === 'local-judge') {
			judge = resolveAssignmentSpec(LOCAL_JUDGE_TASK_ID, options.model);
			if (!judge.ok) fail(judge.message, json, ExitCode.InvalidUsage);
			if (judge.assignment.type !== 'local' && judge.assignment.type !== 'endpoint') {
				fail(
					'The local judge needs a model: local:<model-id> or endpoint:<endpoint>:<model>.',
					json,
					ExitCode.InvalidUsage
				);
			}
		} else if (options.model === DEFAULT_WORD) {
			patch.model = null;
		} else {
			const problem = systemOneModelProblem(options.model);
			if (problem) fail(problem, json, ExitCode.InvalidUsage);
			patch.model = options.model;
		}
	}

	if (engine === 'openjev' && options.url === undefined) {
		const current = await readStatus(json);
		if (!current.settings.openJevUrl) {
			fail('OpenJev needs the URL of your server. Pass --url <url>.', json, ExitCode.InvalidUsage);
		}
	}

	if (judge?.ok) {
		// The assignment lives in the settings file, which this process writes
		// and the app reads at each use. Ask the app for its status first, so an
		// app that is not running fails here, before anything is stored; then
		// store the model, so the report that comes back with the engine names it.
		await readStatus(json);
		storeTaskAssignment(LOCAL_JUDGE_TASK_ID, judge.assignment);
	}
	const report = await applyPatch(patch, json);

	if (json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`System One engine: ${report.engineLabel}`));
	if (engine !== 'off') console.log(`  ${report.disclosure}`);
	if (judge?.ok) {
		const caution = localModelAssignmentCaution(LOCAL_JUDGE_TASK_ID, judge.assignment);
		if (caution) console.log(formatWarning(`Not recommended for this task: ${caution}`));
		if (!judge.endpointEnabled) {
			console.log(
				formatWarning('That endpoint is disabled. Enable it before the judge can answer.')
			);
		}
	}
	if (report.problem) console.log(formatWarning(report.problem));
	else if (engine !== 'off') console.log('  Check that it answers: maestro-cli s1 test');
}

export async function systemOneSetTimeout(value: string, options: JsonOption): Promise<void> {
	const timeoutMs = Number(value);
	const problem = systemOneTimeoutProblem(timeoutMs);
	if (problem) fail(problem, options.json, ExitCode.InvalidUsage);
	const report = await applyPatch({ timeoutMs }, options.json);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess(`Jev and OpenJev requests get ${report.settings.timeoutMs} ms`));
	if (report.settings.engine === 'local-judge') {
		console.log(
			`  The local judge keeps its own budget (${LOCAL_JUDGE_DEFAULT_TIMEOUT_MS} ms): its first answer after an idle spell loads the model.`
		);
	}
}

export async function systemOneSetFailPolicy(
	taskId: string,
	policy: string,
	options: JsonOption
): Promise<void> {
	const problem = systemOneFailPolicyProblem(taskId, policy);
	if (problem) fail(problem, options.json, ExitCode.InvalidUsage);
	const report = await applyPatch(
		{ failPolicy: { taskId, policy: policy as 'open' | 'closed' | 'default' } },
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const row = report.failPolicies.find((candidate) => candidate.taskId === taskId);
	if (!row) fail('The desktop app did not report that task.', options.json);
	console.log(
		formatSuccess(
			`${row.label} fails ${row.policy}${row.policy === row.defaultPolicy ? ' (its default)' : ''}`
		)
	);
}

interface KeyOptions extends JsonOption {
	engine?: string;
}

/** The engine a key verb names, checked. Absent means the engine in force. */
function keyEngine(options: KeyOptions): SystemOneRemoteEngineId | undefined {
	if (options.engine === undefined) return undefined;
	if (!isSystemOneRemoteEngineId(options.engine)) {
		fail(
			`"${options.engine}" has no key. A key belongs to ${SYSTEM_ONE_REMOTE_ENGINE_IDS.join(' or ')}.`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	return options.engine;
}

/**
 * Read the key from standard input. A terminal is refused: a key typed at a
 * prompt this command does not hide would be on the screen, and a key given as
 * an argument would be in shell history.
 */
function readKeyFromStdin(json: boolean | undefined): string {
	if (process.stdin.isTTY) {
		fail(
			'Pipe the key on standard input, for example: pbpaste | maestro-cli s1 key set',
			json,
			ExitCode.InvalidUsage
		);
	}
	let text: string;
	try {
		text = fs.readFileSync(0, 'utf-8');
	} catch {
		fail('Could not read the key from standard input.', json);
	}
	const key = text.trim();
	const problem = systemOneKeyProblem(key);
	if (problem) fail(problem, json, ExitCode.InvalidUsage);
	return key;
}

export async function systemOneKeySet(options: KeyOptions): Promise<void> {
	const engine = keyEngine(options);
	const key = readKeyFromStdin(options.json);
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'system_one_key_set', key, ...(engine ? { engine } : {}) },
			'system_one_key_set_result',
			options.json
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	const stored = SYSTEM_ONE_REMOTE_ENGINE_IDS.find(
		(id) => (engine ?? report.settings.engine) === id
	);
	const info = stored ? report.keys[stored] : undefined;
	console.log(formatSuccess(`Stored the key${stored ? ` for ${stored}` : ''}`));
	if (info?.source === 'stored' && info.storage === 'obscured') {
		console.log(
			formatWarning('This system has no key store, so the key is stored obscured, not encrypted.')
		);
	}
}

export async function systemOneKeyClear(options: KeyOptions): Promise<void> {
	const engine = keyEngine(options);
	const report = requireReport(
		await send<ReportReply>(
			{ type: 'system_one_key_clear', ...(engine ? { engine } : {}) },
			'system_one_key_clear_result',
			options.json
		),
		options.json
	);
	if (options.json) {
		printReport(report, true);
		return;
	}
	console.log(formatSuccess('Cleared the stored key'));
	const cleared = engine ?? report.settings.engine;
	const info = isSystemOneRemoteEngineId(cleared) ? report.keys[cleared] : undefined;
	if (info && info.source !== 'none' && info.source !== 'stored') {
		console.log(`  ${cleared} still has a key from another source. See: maestro-cli s1 status`);
	}
}

export async function systemOneTest(options: JsonOption): Promise<void> {
	const reply = await send<{ success: boolean; error?: string; result?: SystemOneTestResult }>(
		{ type: 'system_one_test' },
		'system_one_test_result',
		options.json,
		TEST_TIMEOUT_MS
	);
	const result = reply.result;
	if (!result) fail('The desktop app sent no test result.', options.json);
	if (options.json) console.log(JSON.stringify({ success: result.ok, ...result }));
	else console.log(formatSystemOneTestResult(result));
	if (!result.ok) exitWith(ExitCode.GeneralError);
}
