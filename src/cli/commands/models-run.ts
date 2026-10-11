// `maestro-cli models run <task-id> --input <text>` - run one Local Models
// text-generation task through the user's assignment for it.
//
// It runs in the desktop over the WS bridge, through the same task router as
// the `localModels:runTask` IPC channel, so the CLI and an in-app caller read
// the same assignment, call the same model, and record the same stats row. The
// CLI never picks a source itself: a task that is off or assigned to the
// Utility Agent reports that and produces no text.
//
// Only `ok` exits 0, with the generated text alone on stdout, so
// `name=$(maestro-cli models run tab-naming --input "...")` captures text or
// fails. Every other verdict exits non-zero with the reason on stderr.
//
// `maestro-cli models run git-drafts --cwd <path> [--base <branch>]` is the
// one task that takes a repository instead of a prompt: it is the CLI path to
// the Create Pull Request form's "Draft with local model" button, through the
// same main-process function, so an agent gets the same title and body the
// form would be filled with. It prints the title, a blank line, then the body.
// Nothing is pushed or created.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { resolveCliPath } from '../utils/parse';
import {
	isLocalModelTaskId,
	LOCAL_MODEL_TASK_IDS,
	LOCAL_MODEL_TASKS,
} from '../../shared/local-models/tasks';
import type { PullRequestDraftResult } from '../../shared/gitDrafts';
import type { LocalTaskInput, LocalTaskResult } from '../../main/local-models/task-router';

/**
 * Above the app's endpoint chat budget (120s), so a slow server comes back as
 * the app's own timeout verdict rather than the CLI giving up first.
 */
const RUN_TIMEOUT_MS = 150_000;

interface RunOptions {
	input?: string;
	/** git-drafts only: the repository to draft a pull request for. */
	cwd?: string;
	/** git-drafts only: the branch the pull request targets. */
	base?: string;
	system?: string;
	maxTokens?: string;
	json?: boolean;
}

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

/** Why a non-`ok` verdict produced no text, for a person. */
function describeVerdict(
	taskId: string,
	result: Exclude<LocalTaskResult, { status: 'ok' }>
): string {
	const label = isLocalModelTaskId(taskId) ? LOCAL_MODEL_TASKS[taskId].label : taskId;
	switch (result.status) {
		case 'off':
			return `${label} is off. Assign it a local model or an endpoint in Settings -> Local Models.`;
		case 'use-utility-agent':
			return `${label} is assigned to the Utility Agent, which runs inside the app, not through models run.`;
		case 'unavailable':
			return `${result.reason} [${result.code}]`;
		case 'cancelled':
			return `${label} was cancelled.`;
	}
}

export async function modelsRun(taskId: string, options: RunOptions): Promise<void> {
	if (!isLocalModelTaskId(taskId)) {
		fail(
			`Unknown task "${taskId}". Tasks: ${LOCAL_MODEL_TASK_IDS.join(', ')}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const task = LOCAL_MODEL_TASKS[taskId];
	if (task.needs !== 'text-gen') {
		fail(
			`${task.label} is a ${task.needs} task; models run runs text-generation tasks only.`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	if (options.cwd !== undefined || options.base !== undefined) {
		if (taskId !== 'git-drafts') {
			fail(
				'--cwd and --base draft a pull request, which only the git-drafts task does.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		if (options.cwd === undefined || options.cwd.trim() === '') {
			fail('--base needs --cwd <path> to name the repository', options.json, ExitCode.InvalidUsage);
		}
		if (
			options.input !== undefined ||
			options.system !== undefined ||
			options.maxTokens !== undefined
		) {
			fail(
				'--cwd drafts from the repository; it does not combine with --input, --system, or --max-tokens.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		return runPullRequestDraft(options.cwd, options.base, options.json);
	}

	if (options.input === undefined || options.input.trim() === '') {
		fail(
			taskId === 'git-drafts'
				? 'Pass --cwd <path> to draft a pull request for that repository, or --input <text> to send your own prompt.'
				: '--input must not be empty',
			options.json,
			ExitCode.InvalidUsage
		);
	}

	const input: Omit<LocalTaskInput, 'signal'> = { prompt: options.input };
	if (options.system !== undefined) input.system = options.system;
	if (options.maxTokens !== undefined) {
		const maxTokens = Number(options.maxTokens);
		if (!Number.isInteger(maxTokens) || maxTokens < 1) {
			fail('--max-tokens must be a positive integer', options.json, ExitCode.InvalidUsage);
		}
		input.maxTokens = maxTokens;
	}

	let reply: { success: boolean; result?: LocalTaskResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_run_task', taskId, input },
				'local_models_run_task_result',
				RUN_TIMEOUT_MS
			)
		);
	} catch (error) {
		fail(
			error instanceof Error ? error.message : String(error),
			options.json,
			exitCodeForError(error)
		);
	}

	if (!reply.success || !reply.result) {
		fail(reply.error || 'Task run failed', options.json);
	}
	const result = reply.result;

	if (options.json) {
		console.log(JSON.stringify({ success: result.status === 'ok', taskId, ...result }));
		if (result.status !== 'ok') exitWith(ExitCode.GeneralError);
		return;
	}
	if (result.status !== 'ok') {
		console.error(`Error: ${describeVerdict(taskId, result)}`);
		exitWith(ExitCode.GeneralError);
	}
	console.log(result.text);
}

/**
 * Draft a pull request title and body for the branch checked out at `cwd`.
 * Only a draft exits 0. Every refusal (the task is off, the model is
 * unavailable, the branch has nothing new) exits non-zero with the reason.
 */
async function runPullRequestDraft(
	cwd: string,
	base: string | undefined,
	json: boolean | undefined
): Promise<void> {
	let reply: { success: boolean; result?: PullRequestDraftResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{
					type: 'local_models_git_draft',
					cwd: resolveCliPath(cwd),
					...(base !== undefined && base.trim() !== '' ? { baseBranch: base.trim() } : {}),
				},
				'local_models_git_draft_result',
				RUN_TIMEOUT_MS
			)
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), json, exitCodeForError(error));
	}

	if (!reply.success || !reply.result) {
		fail(reply.error || 'Draft failed', json);
	}
	const result = reply.result;

	if (json) {
		console.log(JSON.stringify({ taskId: 'git-drafts', ...result }));
		if (!result.success) exitWith(ExitCode.GeneralError);
		return;
	}
	if (!result.success) {
		console.error(`Error: ${result.error}`);
		exitWith(ExitCode.GeneralError);
	}
	console.log(result.body ? `${result.title}\n\n${result.body}` : result.title);
}
