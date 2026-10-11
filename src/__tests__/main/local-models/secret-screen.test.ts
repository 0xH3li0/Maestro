/**
 * @file secret-screen.test.ts
 * @description The secret screen every publishing path calls: the pattern scan
 * always runs, the `secret-screen` model is extra coverage only, and no state
 * of the model stack can hide a pattern finding or block a publish by itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runClassifierTask: vi.fn(),
}));

const stores = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	configs: {} as Record<string, unknown>,
	sessions: [] as unknown[],
	ready: true,
}));

vi.mock('../../../main/stores/getters', () => {
	const guard = () => {
		if (!stores.ready) throw new Error('Stores not initialized. Call initializeStores() first.');
	};
	return {
		getSettingsStore: () => {
			guard();
			return { get: (key: string) => stores.settings[key] };
		},
		getAgentConfigsStore: () => {
			guard();
			return { get: () => stores.configs };
		},
		getSessionsStore: () => {
			guard();
			return { get: () => stores.sessions };
		},
	};
});

import {
	knownSecretEnv,
	screenForSecrets,
	SECRET_SCREEN_MODEL_TIMEOUT_MS,
} from '../../../main/local-models/secret-screen';
import { runClassifierTask } from '../../../main/local-models/task-router';
import { logger } from '../../../main/utils/logger';
import { PROMPT_GUARD_2_22M_ID } from '../../../shared/local-models/model-catalog';

// Assembled at runtime so no token literal sits in the repository.
const GITHUB_TOKEN = ['ghp', 'a1B2c3D4e5'.repeat(4).slice(0, 36)].join('_');
const SLACK_TOKEN = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhAbCdEfGhAbCdEfGh'].join('-');
const SOURCE = { type: 'local', modelId: PROMPT_GUARD_2_22M_ID } as const;

const modelOff = () => vi.mocked(runClassifierTask).mockResolvedValue({ status: 'off' });

describe('screenForSecrets', () => {
	beforeEach(() => {
		vi.mocked(runClassifierTask).mockReset();
		vi.mocked(logger.warn).mockReset();
		stores.settings = {};
		stores.configs = {};
		stores.sessions = [];
		stores.ready = true;
	});

	it('returns no findings for clean content', async () => {
		modelOff();
		expect(await screenForSecrets([{ source: 'notes.md', text: 'Nothing to see here.' }])).toEqual({
			findings: [],
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('scans every part and names the part each finding is in', async () => {
		modelOff();
		const result = await screenForSecrets([
			{ source: 'Summary', text: 'it broke' },
			{ source: 'Actual', text: `first\nit printed ${GITHUB_TOKEN}` },
			{ source: 'logs.json', text: `{\n  "line": "${SLACK_TOKEN}"\n}` },
		]);
		expect(result.findings.map((f) => [f.kind, f.source, f.line])).toEqual([
			['github-token', 'Actual', 2],
			['slack-token', 'logs.json', 2],
		]);
		expect(result.note).toBeUndefined();
	});

	it('logs kinds and counts, never a preview', async () => {
		modelOff();
		await screenForSecrets([{ text: GITHUB_TOKEN }]);
		const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
		expect(logged).toContain('github-token');
		expect(logged).not.toContain(GITHUB_TOKEN.slice(-4));
	});

	it('skips blank parts and does not ask the model about nothing', async () => {
		modelOff();
		expect(await screenForSecrets([{ source: 'description', text: '   ' }])).toEqual({
			findings: [],
		});
		expect(runClassifierTask).not.toHaveBeenCalled();
	});

	describe('the optional model pass', () => {
		it('asks the secret-screen task with all the text and a timeout', async () => {
			modelOff();
			await screenForSecrets([{ text: 'part one' }, { text: 'part two' }]);
			const [taskId, input] = vi.mocked(runClassifierTask).mock.calls[0];
			expect(taskId).toBe('secret-screen');
			expect(input.text).toBe('part one\n\npart two');
			expect(input.signal).toBeInstanceOf(AbortSignal);
			expect(SECRET_SCREEN_MODEL_TIMEOUT_MS).toBeGreaterThan(0);
		});

		it('adds a finding that names the model and its score when the model flags', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'MALICIOUS',
				score: 0.974,
				flagged: true,
				chunks: 1,
				source: SOURCE,
				durationMs: 20,
			});
			const result = await screenForSecrets([{ text: 'plain words' }]);
			expect(result.findings).toEqual([
				{
					kind: 'model-flagged',
					line: 0,
					preview: 'MALICIOUS 0.97',
					name: 'Llama Prompt Guard 2 22M',
				},
			]);
		});

		it('adds nothing when the model does not flag', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'BENIGN',
				score: 0.02,
				flagged: false,
				chunks: 1,
				source: SOURCE,
				durationMs: 20,
			});
			expect(await screenForSecrets([{ text: 'plain words' }])).toEqual({ findings: [] });
		});

		it('keeps the pattern findings beside a model finding', async () => {
			vi.mocked(runClassifierTask).mockResolvedValue({
				status: 'ok',
				label: 'MALICIOUS',
				score: 0.9,
				flagged: true,
				chunks: 2,
				source: SOURCE,
				durationMs: 20,
			});
			const result = await screenForSecrets([{ text: GITHUB_TOKEN }]);
			expect(result.findings.map((f) => f.kind)).toEqual(['github-token', 'model-flagged']);
		});

		// The model is extra coverage. A model that cannot run must neither block
		// a clean publish nor hide what the patterns found.
		it.each([
			[
				'unavailable',
				{
					status: 'unavailable',
					source: SOURCE,
					code: 'model-not-installed',
					reason: 'Not installed.',
				},
				'Not installed.',
			],
			['timed out', { status: 'cancelled', source: SOURCE }, 'it took too long to answer.'],
		])(
			'reports a note and still returns pattern findings when the model is %s',
			async (_n, verdict, reason) => {
				vi.mocked(runClassifierTask).mockResolvedValue(verdict as never);

				const clean = await screenForSecrets([{ text: 'plain words' }]);
				expect(clean.findings).toEqual([]);
				expect(clean.note).toBe(
					`Secret screen model did not run: ${reason} Pattern detection still ran.`
				);

				const dirty = await screenForSecrets([{ text: GITHUB_TOKEN }]);
				expect(dirty.findings.map((f) => f.kind)).toEqual(['github-token']);
				expect(dirty.note).toContain('did not run');
			}
		);

		it('never throws when the model stack does', async () => {
			vi.mocked(runClassifierTask).mockRejectedValue(new Error('onnx exploded'));
			const result = await screenForSecrets([{ text: GITHUB_TOKEN }]);
			expect(result.findings.map((f) => f.kind)).toEqual(['github-token']);
			expect(result.note).toBe(
				'Secret screen model did not run: it failed to run. Pattern detection still ran.'
			);
		});
	});

	describe('configured environment values', () => {
		const value = 'correct-horse-battery-staple';

		it('matches a value passed as env', async () => {
			modelOff();
			const result = await screenForSecrets([{ text: `oops ${value}` }], {
				env: { DB_PASSWORD: value },
			});
			expect(result.findings).toEqual([
				expect.objectContaining({ kind: 'env-var-value', name: 'DB_PASSWORD' }),
			]);
		});

		it('matches values from every layer Maestro is configured with by default', async () => {
			modelOff();
			stores.settings = { shellEnvVars: { GLOBAL_API_TOKEN: 'global-layer-value-0001' } };
			stores.configs = {
				'claude-code': { customEnvVars: { PROVIDER_SECRET: 'provider-layer-value-0002' } },
				codex: {},
			};
			stores.sessions = [
				{ id: 'a', customEnvVars: { AGENT_PASSWORD: 'agent-layer-value-0003' } },
				{ id: 'b' },
			];
			const result = await screenForSecrets([
				{
					text: 'global-layer-value-0001\nprovider-layer-value-0002\nagent-layer-value-0003',
				},
			]);
			expect(result.findings.map((f) => f.name)).toEqual([
				'GLOBAL_API_TOKEN',
				'PROVIDER_SECRET',
				'AGENT_PASSWORD',
			]);
		});
	});
});

describe('knownSecretEnv', () => {
	const original = process.env.SECRET_SCREEN_TEST_TOKEN;

	beforeEach(() => {
		stores.settings = {};
		stores.configs = {};
		stores.sessions = [];
		stores.ready = true;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.SECRET_SCREEN_TEST_TOKEN;
		else process.env.SECRET_SCREEN_TEST_TOKEN = original;
	});

	it('includes the process environment', () => {
		process.env.SECRET_SCREEN_TEST_TOKEN = 'process-layer-value';
		expect(knownSecretEnv()).toContainEqual(['SECRET_SCREEN_TEST_TOKEN', 'process-layer-value']);
	});

	it('keeps two agents holding the same variable name as two entries', () => {
		stores.sessions = [
			{ customEnvVars: { ANTHROPIC_API_KEY: 'first-agent-key' } },
			{ customEnvVars: { ANTHROPIC_API_KEY: 'second-agent-key' } },
		];
		const entries = knownSecretEnv().filter(([name]) => name === 'ANTHROPIC_API_KEY');
		expect(entries.map(([, value]) => value)).toEqual(
			expect.arrayContaining(['first-agent-key', 'second-agent-key'])
		);
	});

	it('still answers from the process environment when the stores are not ready', () => {
		stores.ready = false;
		process.env.SECRET_SCREEN_TEST_TOKEN = 'process-layer-value';
		expect(knownSecretEnv()).toContainEqual(['SECRET_SCREEN_TEST_TOKEN', 'process-layer-value']);
	});
});
