/**
 * @file task-router.test.ts
 *
 * The Local Models task router, with `generateText` and the stats database
 * mocked. Properties worth protecting:
 *
 *   - **Every assignment branch answers as itself.** `off` and `utility-agent`
 *     never touch a model; `local` and `endpoint` call `generateText` with the
 *     source the user picked.
 *   - **No fallback.** A source that cannot run is reported `unavailable`,
 *     naming it, and nothing else is tried.
 *   - **Every call that reaches a model is recorded**, success or failure, and a
 *     stats failure never turns a good run into a bad one.
 *   - **Untrusted requests are checked once**, for IPC and the CLI bridge alike.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const stats = vi.hoisted(() => ({
	ready: true,
	recordLocalModelRun: vi.fn((_run: unknown) => 'id'),
}));
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));
const embed = vi.hoisted(() => ({ embedTexts: vi.fn() }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({
		isReady: () => stats.ready,
		recordLocalModelRun: stats.recordLocalModelRun,
	}),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
}));

vi.mock('../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/text-gen')>()),
	generateText: generate.generateText,
}));

vi.mock('../../../main/local-models/embeddings', () => ({
	embedTexts: embed.embedTexts,
}));

import {
	DEFAULT_TASK_MAX_TOKENS,
	parseLocalTaskInput,
	runEmbeddingTask,
	runLocalTask,
	runLocalTaskRequest,
} from '../../../main/local-models/task-router';
import { LocalModelEndpointError, LocalModelError } from '../../../main/local-models/errors';
import { captureException } from '../../../main/utils/sentry';
import { BGE_SMALL_EN_ID, QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';

const LOCAL = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' } as const;

function assign(taskId: string, assignment: unknown): void {
	settings.set('localModelAssignments', { [taskId]: assignment });
}

function okReply(source: unknown, extra: Record<string, unknown> = {}) {
	return { text: 'Fix login timeout', source, durationMs: 420, ...extra };
}

function recorded(): Record<string, unknown> {
	expect(stats.recordLocalModelRun).toHaveBeenCalledTimes(1);
	return stats.recordLocalModelRun.mock.calls[0][0] as Record<string, unknown>;
}

describe('runLocalTask', () => {
	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		generate.generateText.mockReset();
		vi.mocked(captureException).mockClear();
	});

	describe('assignments that run no model', () => {
		it('answers off for a new task on its default, and records nothing', async () => {
			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'off',
			});
			expect(generate.generateText).not.toHaveBeenCalled();
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('answers off when the user switched a Utility Agent task off', async () => {
			assign('tab-naming', { type: 'off' });
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'off',
			});
		});

		it('hands a Utility Agent task back to its caller without spawning anything', async () => {
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'use-utility-agent',
			});
			expect(generate.generateText).not.toHaveBeenCalled();
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('refuses a task that is not text generation (a caller bug)', async () => {
			await expect(runLocalTask('semantic-search', { prompt: 'x' })).rejects.toThrow(
				/embedding task/
			);
		});
	});

	describe('a local assignment', () => {
		beforeEach(() => assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID }));

		it('generates on the assigned model with the default budget and records the run', async () => {
			generate.generateText.mockResolvedValue(okReply(LOCAL, { tokensIn: 40, tokensOut: 6 }));

			const result = await runLocalTask('tab-naming', { prompt: 'hi' });

			expect(generate.generateText).toHaveBeenCalledWith({
				source: LOCAL,
				prompt: 'hi',
				maxTokens: DEFAULT_TASK_MAX_TOKENS,
			});
			expect(result).toEqual({
				status: 'ok',
				text: 'Fix login timeout',
				source: LOCAL,
				durationMs: 420,
				tokensIn: 40,
				tokensOut: 6,
			});
			expect(recorded()).toMatchObject({
				taskId: 'tab-naming',
				sourceType: 'local',
				modelId: QWEN3_1_7B_ID,
				durationMs: 420,
				outcome: 'ok',
				tokensIn: 40,
				tokensOut: 6,
			});
			expect(recorded()).not.toHaveProperty('endpointId');
		});

		it('reports a model that is not downloaded as unavailable, naming it, and tries nothing else', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelError('Qwen3 1.7B is not downloaded.', {
					code: 'model-not-installed',
					recovery: 'Download it in Settings -> Local Models.',
					consumerId: 'text-gen',
				})
			);

			const result = await runLocalTask('tab-naming', { prompt: 'hi' });

			expect(result).toEqual({
				status: 'unavailable',
				source: LOCAL,
				reason: 'Qwen3 1.7B is not downloaded. Download it in Settings -> Local Models.',
				code: 'model-not-installed',
			});
			expect(generate.generateText).toHaveBeenCalledTimes(1);
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'model-not-installed' });
		});

		it('reports a cancellation as cancelled, not as a failure', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelError('The request was cancelled.', {
					code: 'cancelled',
					recovery: 'Nothing to do.',
					consumerId: 'text-gen',
				})
			);

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'cancelled',
				source: LOCAL,
			});
			expect(recorded()).toMatchObject({ outcome: 'cancelled', errorCode: 'cancelled' });
		});

		it('rethrows an unclassified failure (a bug) after recording it', async () => {
			generate.generateText.mockRejectedValue(new TypeError('boom'));

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).rejects.toThrow('boom');
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'unexpected' });
		});
	});

	describe('an endpoint assignment', () => {
		beforeEach(() =>
			assign('git-drafts', { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' })
		);

		it('passes the caller options through and returns the parsed JSON', async () => {
			const schema = { type: 'object' };
			generate.generateText.mockResolvedValue(okReply(ENDPOINT, { json: { title: 't' } }));

			const result = await runLocalTask('git-drafts', {
				prompt: 'diff',
				system: 'Write a commit message.',
				maxTokens: 64,
				temperature: 0.2,
				jsonSchema: schema,
			});

			expect(generate.generateText).toHaveBeenCalledWith({
				source: ENDPOINT,
				prompt: 'diff',
				system: 'Write a commit message.',
				maxTokens: 64,
				temperature: 0.2,
				jsonSchema: schema,
			});
			expect(result).toMatchObject({ status: 'ok', json: { title: 't' }, source: ENDPOINT });
			expect(recorded()).toMatchObject({
				sourceType: 'endpoint',
				modelId: 'llama3.2',
				endpointId: 'ep-1',
				outcome: 'ok',
			});
		});

		it('reports a server that is down as unavailable with its kind', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelEndpointError('Ollama is not reachable at http://127.0.0.1:11434.', {
					kind: 'network',
					endpointId: 'ep-1',
					endpointName: 'Ollama',
					url: 'http://127.0.0.1:11434',
				})
			);

			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'unavailable',
				source: ENDPOINT,
				reason: 'Ollama is not reachable at http://127.0.0.1:11434.',
				code: 'network',
			});
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'network' });
		});

		it('treats an endpoint abort as a cancellation', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelEndpointError('Cancelled.', {
					kind: 'cancelled',
					endpointId: 'ep-1',
					endpointName: 'Ollama',
					url: '',
				})
			);

			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'cancelled',
				source: ENDPOINT,
			});
		});
	});

	describe('recording', () => {
		beforeEach(() => {
			assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID });
			generate.generateText.mockResolvedValue(okReply(LOCAL));
		});

		it('records nothing when usage statistics are switched off', async () => {
			settings.set('statsCollectionEnabled', false);
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
			});
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('skips quietly when the stats database is not ready', async () => {
			stats.ready = false;
			await runLocalTask('tab-naming', { prompt: 'hi' });
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('never lets a stats failure fail the task, and reports it', async () => {
			stats.recordLocalModelRun.mockImplementation(() => {
				throw new Error('disk I/O error');
			});

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
			});
			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});

describe('runEmbeddingTask', () => {
	const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;
	const NOMIC = { type: 'endpoint', endpointId: 'ep-1', model: 'nomic-embed-text' } as const;

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		embed.embedTexts.mockReset();
	});

	it('answers off on the default assignment and embeds nothing', async () => {
		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'query' })
		).resolves.toEqual({ status: 'off' });
		expect(embed.embedTexts).not.toHaveBeenCalled();
		expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
	});

	it('embeds on the assigned local model with the mode, and records the run', async () => {
		assign('semantic-search', { type: 'local', modelId: BGE_SMALL_EN_ID });
		const vectors = [new Float32Array([1, 0])];
		embed.embedTexts.mockResolvedValue(vectors);

		const result = await runEmbeddingTask('semantic-search', {
			texts: ['how do I rename a tab'],
			mode: 'query',
		});

		expect(embed.embedTexts).toHaveBeenCalledWith(BGE, ['how do I rename a tab'], {
			mode: 'query',
		});
		expect(result).toMatchObject({ status: 'ok', vectors, source: BGE });
		expect(recorded()).toMatchObject({
			taskId: 'semantic-search',
			sourceType: 'local',
			modelId: BGE_SMALL_EN_ID,
			outcome: 'ok',
		});
	});

	it('embeds on an endpoint and reports a down server as unavailable, trying nothing else', async () => {
		assign('semantic-search', NOMIC);
		embed.embedTexts.mockRejectedValue(
			new LocalModelEndpointError('Ollama is not reachable.', {
				kind: 'network',
				endpointId: 'ep-1',
				endpointName: 'Ollama',
				url: 'http://127.0.0.1:11434',
			})
		);

		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'document' })
		).resolves.toEqual({
			status: 'unavailable',
			source: NOMIC,
			reason: 'Ollama is not reachable.',
			code: 'network',
		});
		expect(embed.embedTexts).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'network' });
	});

	it('reports a cancellation as cancelled', async () => {
		assign('semantic-search', { type: 'local', modelId: BGE_SMALL_EN_ID });
		embed.embedTexts.mockRejectedValue(
			new LocalModelError('The request was cancelled.', {
				code: 'cancelled',
				recovery: 'Nothing to do.',
				consumerId: 'embeddings',
			})
		);

		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'query' })
		).resolves.toEqual({ status: 'cancelled', source: BGE });
	});

	it('refuses a task that is not an embedding task (a caller bug)', async () => {
		await expect(runEmbeddingTask('tab-naming', { texts: ['a'], mode: 'query' })).rejects.toThrow(
			/text-gen task/
		);
	});
});

describe('runLocalTaskRequest / parseLocalTaskInput', () => {
	beforeEach(() => {
		settings.clear();
		generate.generateText.mockReset();
	});

	it('refuses an unknown task id', async () => {
		await expect(runLocalTaskRequest('tab-nameing', { prompt: 'x' })).rejects.toThrow(
			'Unknown task "tab-nameing".'
		);
	});

	it('runs a valid request through the router', async () => {
		await expect(runLocalTaskRequest('tab-naming', { prompt: 'x' })).resolves.toEqual({
			status: 'use-utility-agent',
		});
	});

	it('accepts the full input shape', () => {
		expect(
			parseLocalTaskInput({
				prompt: 'p',
				system: 's',
				maxTokens: 10,
				temperature: 0,
				jsonSchema: { type: 'object' },
				ignored: true,
			})
		).toEqual({
			prompt: 'p',
			system: 's',
			maxTokens: 10,
			temperature: 0,
			jsonSchema: { type: 'object' },
		});
	});

	it.each([
		[null, /object with a prompt/],
		[{ prompt: '  ' }, /non-empty prompt/],
		[{ prompt: 'p', system: 3 }, /system/],
		[{ prompt: 'p', maxTokens: 0 }, /maxTokens/],
		[{ prompt: 'p', maxTokens: 1.5 }, /maxTokens/],
		[{ prompt: 'p', maxTokens: 100_000 }, /maxTokens/],
		[{ prompt: 'p', temperature: 3 }, /temperature/],
		[{ prompt: 'p', temperature: Number.NaN }, /temperature/],
		[{ prompt: 'p', jsonSchema: [] }, /jsonSchema/],
	])('refuses %j', (input, message) => {
		expect(() => parseLocalTaskInput(input)).toThrow(message);
	});
});
