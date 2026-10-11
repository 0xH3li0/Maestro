/**
 * @file llama-housekeeping-e2e.test.ts
 *
 * Qwen3 1.7B on the housekeeping tasks, end to end on real hardware: the
 * shipped `*-local` prompts, the shipped reply schemas, the real llama runtime
 * and the real model, with each reply read by the parser its consumer uses.
 *
 * `llama-e2e.test.ts` proved the runtime loads and that this model is NOT good
 * enough to route voice. That left the opposite question open, and it is the
 * one that decides whether the model may be offered for download at all: is it
 * good enough for the small jobs (name a tab, write a shell command, answer
 * yes or no for a Cue gate)? This file answers it with measurements instead of
 * an assumption, and its numbers go into `docs/architecture/local-models.md`.
 *
 * What is ASSERTED is structure and the unambiguous cases: every reply parses
 * through the consumer's own parser, a tab name is short and on topic, the two
 * clear-cut gate events are judged correctly, and a shortened tool result keeps
 * its error, path and line number. Wording is recorded, not asserted, and so is
 * the correctness of a shell command: this model gets those wrong, which is why
 * the `ai-command` task does not offer it.
 *
 * Opt-in only (the model and runtime must already be in the scratch dir, or
 * about 1.1 GB is fetched): SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/llama-housekeeping-e2e.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
}));

import { installLocalModel, verifyLocalModel } from '../../../main/local-models/service';
import { __setNativeImporter } from '../../../main/local-models/runtime/native-loader';
import { LocalTextEngine } from '../../../main/local-models/text-gen';
import { QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import {
	AI_COMMAND_REPLY_SCHEMA,
	buildAiCommandPrompt,
	parseAiCommandReply,
} from '../../../shared/aiCommand';
import {
	GIT_DRAFT_PR_REPLY_SCHEMA,
	formatPullRequestDraftInput,
	parsePullRequestDraftReply,
} from '../../../shared/gitDrafts';
import {
	SPOKEN_NOTICE_REPLY_SCHEMA,
	composeNoticeLine,
	formatSpokenNoticeInput,
	parseSpokenNoticeReply,
} from '../../../shared/spokenNotices';
import {
	CUE_GATE_REPLY_SCHEMA,
	formatCueGateInput,
	parseCueGateReply,
} from '../../../shared/cue/gate';

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const INFERENCE_TIMEOUT_MS = 5 * 60_000;

/** The shipped prompt text, read from the file the app bundles. */
function prompt(id: string): string {
	return readFileSync(path.join(process.cwd(), 'src', 'prompts', `${id}.md`), 'utf8');
}

/** The schema `tabNaming.ts` holds the model to (private there; restated, not imported). */
const TAB_NAME_SCHEMA = {
	type: 'object',
	properties: { name: { type: 'string', maxLength: 40 } },
	required: ['name'],
	additionalProperties: false,
};

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const results: Record<string, unknown> = {};

describe.skipIf(!RUN)('Qwen3 1.7B on housekeeping tasks (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	let engine: LocalTextEngine;

	beforeAll(async () => {
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		__setNativeImporter(
			(specifier) =>
				import(
					/* @vite-ignore */ path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
				)
		);
		// The one call the Download button makes: the model and its engine.
		if (!(await verifyLocalModel(QWEN3_1_7B_ID)).ok) {
			const installed = await installLocalModel(QWEN3_1_7B_ID);
			expect(installed.status).toBe('complete');
			expect(['ready', 'installed']).toContain(installed.runtime.status);
		}
		engine = new LocalTextEngine({ idleUnloadMs: 0 });
	}, DOWNLOAD_TIMEOUT_MS);

	afterAll(async () => {
		await engine?.unload();
		__setNativeImporter(null);
		const report = JSON.stringify(results, null, 2);
		writeFileSync(path.join(DATA_DIR, 'llama-housekeeping-e2e-results.json'), `${report}\n`);
		console.log(`[llama-housekeeping-e2e] results\n${report}`);
	});

	it(
		'names tabs from a first message',
		async () => {
			const cases = [
				{ message: 'add dark mode to the settings page in our React app', expect: /dark|theme/i },
				{
					message: 'the login endpoint returns 500 when the password is empty',
					expect: /login|password|500/i,
				},
				{
					message: 'review PR 1653 and tell me if the watchdog change is safe',
					expect: /1653|watchdog|pr/i,
				},
				{
					message: 'write vitest tests for the token proxy compressors',
					expect: /test|proxy|compress/i,
				},
				{
					message: 'why is the electron main process using 2 GB of memory',
					expect: /memory|electron/i,
				},
			];
			const rows: Array<Record<string, unknown>> = [];
			const system = prompt('tab-naming-local');
			for (const testCase of cases) {
				const started = Date.now();
				const reply = await engine.generate(QWEN3_1_7B_ID, {
					system,
					prompt: testCase.message,
					maxTokens: 48,
					temperature: 0,
					jsonSchema: TAB_NAME_SCHEMA,
				});
				const json = parseJson(reply.text) as { name?: unknown } | undefined;
				const name = typeof json?.name === 'string' ? json.name.trim() : '';
				rows.push({ message: testCase.message, name, ms: Date.now() - started });

				expect(name.length).toBeGreaterThan(0);
				expect(name.length).toBeLessThanOrEqual(40);
				expect(name.split(/\s+/).length).toBeLessThanOrEqual(6);
				expect(name).toMatch(testCase.expect);
			}
			results.tabNaming = rows;
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'writes one-line shell commands the consumer parser accepts',
		async () => {
			const host = {
				platform: 'darwin',
				release: '25.6.0',
				shell: '/bin/zsh',
				cwd: '/Users/dev/project',
				isGitRepo: true,
			};
			const cases = [
				{ request: 'show the ten largest files in this directory', expect: /du|ls|find/ },
				{ request: 'count the lines in every typescript file under src', expect: /wc/ },
				{ request: 'list the git branches merged into main', expect: /git\s+branch/ },
				{ request: 'find which process is listening on port 8080', expect: /lsof|netstat|ss\b/ },
			];
			const rows: Array<Record<string, unknown>> = [];
			const template = prompt('ai-command-local');
			let rightTool = 0;
			let destructiveCount = 0;
			for (const testCase of cases) {
				const started = Date.now();
				const reply = await engine.generate(QWEN3_1_7B_ID, {
					prompt: buildAiCommandPrompt(template, host, testCase.request, []),
					maxTokens: 256,
					temperature: 0,
					jsonSchema: AI_COMMAND_REPLY_SCHEMA,
				});
				const parsed = parseAiCommandReply(parseJson(reply.text), reply.text);
				const usesRightTool = !!parsed && testCase.expect.test(parsed.command);
				if (usesRightTool) rightTool += 1;
				// Every request here asks to SEE something. A command that stops a
				// process or removes a file answers a different request.
				const destructive = !!parsed && /\bkill\b|\brm\b|\bsudo\b/.test(parsed.command);
				if (destructive) destructiveCount += 1;
				rows.push({
					request: testCase.request,
					command: parsed?.command ?? null,
					explanation: parsed?.explanation ?? null,
					usesRightTool,
					destructive,
					ms: Date.now() - started,
				});

				// Structure is asserted: the grammar and the parser hold. Whether the
				// command is the RIGHT one, and whether it is safe, is recorded, because
				// that is the measurement that decides whether this model is offered for
				// the task (`unofferedLocalModels` on `ai-command`).
				expect(parsed).not.toBeNull();
				expect(parsed!.command).not.toMatch(/\n/);
			}
			results.aiCommandRightTool = `${rightTool}/${cases.length}`;
			results.aiCommandDestructive = `${destructiveCount}/${cases.length}`;
			results.aiCommand = rows;
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'answers a Cue gate yes or no on clear-cut events',
		async () => {
			const condition = 'the comment asks for a code change or reports a bug';
			const cases = [
				{
					label: 'bug report',
					comments:
						'The export button crashes the app when the list is empty. Stack trace attached.',
					expect: true,
				},
				{ label: 'praise', comments: 'LGTM, thanks for the quick turnaround!', expect: false },
				{
					label: 'change request',
					comments: 'Please rename fetchAll to fetchPage and add a limit parameter.',
					expect: true,
				},
				{ label: 'emoji only', comments: ':tada: :rocket:', expect: false },
			];
			const rows: Array<Record<string, unknown>> = [];
			const system = prompt('cue-gate-local');
			let correct = 0;
			for (const testCase of cases) {
				const started = Date.now();
				const reply = await engine.generate(QWEN3_1_7B_ID, {
					system,
					prompt: formatCueGateInput({
						condition,
						event: {
							type: 'github.pull_request',
							payload: { title: 'Paginate the export list', comments: testCase.comments },
						} as never,
					}),
					maxTokens: 200,
					temperature: 0,
					jsonSchema: CUE_GATE_REPLY_SCHEMA,
				});
				const parsed = parseCueGateReply(parseJson(reply.text));
				if (parsed?.pass === testCase.expect) correct += 1;
				rows.push({
					label: testCase.label,
					expected: testCase.expect,
					pass: parsed?.pass ?? null,
					reason: parsed?.reason ?? null,
					ms: Date.now() - started,
				});
				expect(parsed).not.toBeNull();
			}
			results.cueGate = rows;
			results.cueGateCorrect = `${correct}/${cases.length}`;
			// The two unambiguous ones: a crash report passes, bare praise does not.
			expect(rows[0].pass).toBe(true);
			expect(rows[1].pass).toBe(false);
		},
		INFERENCE_TIMEOUT_MS
	);
	it(
		'drafts a pull request title and body from a branch summary',
		async () => {
			const input = formatPullRequestDraftInput({
				sourceBranch: 'feat/export-pagination',
				baseBranch: 'main',
				commits: [
					'a1b2c3d Add limit and cursor parameters to fetchPage',
					'b2c3d4e Rename fetchAll to fetchPage across the export module',
					'c3d4e5f Show a Load more button under the export list',
					'd4e5f6a Cover cursor pagination with unit tests',
				].join('\n'),
				diffStat: [
					' src/export/fetchPage.ts        | 84 ++++++++++++-----',
					' src/export/ExportList.tsx      | 41 ++++++--',
					' src/__tests__/fetchPage.test.ts | 96 +++++++++++++++++++',
					' 3 files changed, 190 insertions(+), 31 deletions(-)',
				].join('\n'),
			});
			const started = Date.now();
			const reply = await engine.generate(QWEN3_1_7B_ID, {
				system: prompt('git-draft-pr-local'),
				prompt: input.prompt,
				maxTokens: 700,
				temperature: 0,
				jsonSchema: GIT_DRAFT_PR_REPLY_SCHEMA,
			});
			const draft = parsePullRequestDraftReply(parseJson(reply.text));
			results.gitDraft = { ...draft, ms: Date.now() - started };

			expect(draft).not.toBeNull();
			expect(draft!.title.length).toBeGreaterThan(8);
			expect(draft!.title.length).toBeLessThanOrEqual(80);
			expect(draft!.title).not.toMatch(/\n/);
			// On topic: it names pagination or the renamed function.
			expect(`${draft!.title} ${draft!.body}`).toMatch(/paginat|fetchPage|cursor/i);
			// It must not invent an issue number the commits never mention.
			expect(`${draft!.title} ${draft!.body}`).not.toMatch(/#\d+/);
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'writes a one-clause spoken notice, and says when the agent needs input',
		async () => {
			const cases = [
				{
					label: 'done',
					prompt: 'fix the failing login test',
					response:
						'The test failed because the mock returned a stale token. I updated the fixture in auth.test.ts and the full suite now passes: 412 tests, 0 failures.',
					expect: /pass|fix|test/i,
				},
				{
					label: 'question',
					prompt: 'migrate the users table',
					response:
						'I can do this two ways: an in-place ALTER that locks the table for about a minute, or a shadow table with a backfill. Which do you want me to use?',
					expect: /input|decision|question|choos|which|asks|needs/i,
				},
				{
					label: 'failure',
					prompt: 'build the project',
					response:
						'The build failed. npm could not resolve the dependency left-pad@9.9.9, which does not exist on the registry. I did not change anything.',
					expect: /fail|could not|error|unable/i,
				},
			];
			const rows: Array<Record<string, unknown>> = [];
			const system = prompt('spoken-notice-local');
			for (const testCase of cases) {
				const started = Date.now();
				const reply = await engine.generate(QWEN3_1_7B_ID, {
					system,
					prompt: formatSpokenNoticeInput({
						agentName: 'Backend',
						prompt: testCase.prompt,
						response: testCase.response,
					}),
					maxTokens: 120,
					temperature: 0,
					jsonSchema: SPOKEN_NOTICE_REPLY_SCHEMA,
				});
				const summary = parseSpokenNoticeReply(parseJson(reply.text));
				const line = composeNoticeLine('Backend', summary);
				rows.push({ label: testCase.label, line, ms: Date.now() - started });

				expect(line).not.toBeNull();
				expect(line!.split(/\s+/).length).toBeLessThanOrEqual(20);
				expect(line!).toMatch(testCase.expect);
			}
			results.spokenNotices = rows;
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'shortens a tool result and keeps the error, the path and the numbers',
		async () => {
			const log = [
				'> project@1.4.2 build',
				'> tsc -p tsconfig.json && vite build',
				'',
				...Array.from(
					{ length: 40 },
					(_, i) => `transforming (${i + 1}) src/components/Widget${i + 1}.tsx`
				),
				'vite v5.4.2 building for production...',
				'src/export/fetchPage.ts(84,17): error TS2345: Argument of type "string" is not assignable to parameter of type "number".',
				'src/export/fetchPage.ts(91,3): warning: unused variable cursorToken',
				'Found 1 error in src/export/fetchPage.ts:84',
				'npm ERR! code ELIFECYCLE',
				'npm ERR! errno 2',
				'npm ERR! project@1.4.2 build: `tsc -p tsconfig.json && vite build`',
				'npm ERR! Exit status 2',
			].join('\n');
			const started = Date.now();
			const reply = await engine.generate(QWEN3_1_7B_ID, {
				system: prompt('token-proxy-local'),
				prompt: log,
				maxTokens: 400,
				temperature: 0,
			});
			const summary = reply.text.trim();
			results.tokenProxy = {
				inputChars: log.length,
				outputChars: summary.length,
				summary,
				ms: Date.now() - started,
			};

			// Recorded, with the three facts an agent cannot work without asserted.
			expect(summary.length).toBeGreaterThan(0);
			expect(summary.length).toBeLessThan(log.length);
			expect(summary).toContain('src/export/fetchPage.ts');
			expect(summary).toContain('TS2345');
			expect(summary).toMatch(/\b84\b/);
		},
		INFERENCE_TIMEOUT_MS
	);
});
