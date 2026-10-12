/**
 * @file presets.test.ts
 *
 * What the model server is started with: the presets file (one section per
 * installed text model, named by its catalog id, with its context and the
 * model's own template), the command line (a key in both bind modes, refused
 * without one), and the environment (no `LLAMA_*` variable but its own cache).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

const store = vi.hoisted(() => ({ installed: new Set<string>() }));
vi.mock('../../../../main/local-models/model-store', async (importOriginal) => ({
	...(await importOriginal<object>()),
	isInstalled: async (id: string) => store.installed.has(id),
}));

import {
	getLocalModel,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
} from '../../../../shared/local-models/model-catalog';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from '../../../../shared/local-models/model-server';
import type { LocalModelEntry } from '../../../../shared/local-models/types';
import { ModelServerError } from '../../../../main/local-models/errors';
import {
	buildModelServerArgs,
	collectServerModels,
	isServerModel,
	modelServerEnvironment,
	renderModelServerPresets,
	serverContextSize,
	type ServerModelPreset,
} from '../../../../main/local-models/server/presets';

beforeEach(async () => {
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-server-presets-'));
	vi.stubEnv('MAESTRO_USER_DATA', tempRoot.dir);
	store.installed.clear();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

const qwen = getLocalModel(QWEN3_1_7B_ID) as LocalModelEntry;

function preset(over: Partial<ServerModelPreset> = {}): ServerModelPreset {
	return {
		id: 'small-model',
		modelPath: '/models/small-model/Small-Q4_K_M.gguf',
		contextSize: 40_960,
		...over,
	};
}

function refusal(run: () => unknown): ModelServerError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ModelServerError);
		return error as ModelServerError;
	}
	throw new Error('expected a refusal');
}

describe('renderModelServerPresets', () => {
	it('writes one section per model, named by its id, with its file, context and template', () => {
		const text = renderModelServerPresets([
			preset(),
			preset({ id: 'big-model', modelPath: 'C:\\Users\\Some One\\Big.gguf', contextSize: 131_072 }),
		]);

		expect(text).toBe(
			[
				'; Written by Maestro each time the model server starts. Edits are replaced.',
				'version = 1',
				'',
				'[small-model]',
				'model = /models/small-model/Small-Q4_K_M.gguf',
				'c = 40960',
				'jinja = true',
				'',
				'[big-model]',
				// No quoting in this dialect: spaces and backslashes are carried as they are.
				'model = C:\\Users\\Some One\\Big.gguf',
				'c = 131072',
				'jinja = true',
				'',
			].join('\n')
		);
	});

	it('writes a file with no models when there are none', () => {
		expect(renderModelServerPresets([])).toMatch(/^; .*\nversion = 1\n$/);
	});

	it.each([
		['a semicolon', '/models/a;b/model.gguf'],
		['a "#"', '/models/C#/model.gguf'],
		['a line break', '/models/a\nb/model.gguf'],
		['a line break', '/models/a\rb/model.gguf'],
		['leading or trailing spaces', '/models/model.gguf '],
	])('refuses a model path with %s, by name', (reason, modelPath) => {
		const error = refusal(() => renderModelServerPresets([preset({ modelPath })]));
		expect(error.code).toBe('preset-invalid');
		expect(error.message).toContain('small-model');
		expect(error.message).toContain(reason);
	});

	it.each(['bad]id', 'bad[id', 'bad;id', '*', ''])('refuses the model id %j', (id) => {
		expect(refusal(() => renderModelServerPresets([preset({ id })])).code).toBe('preset-invalid');
	});

	it.each([0, -1, 1.5, Number.NaN])('refuses a context size of %s', (contextSize) => {
		expect(refusal(() => renderModelServerPresets([preset({ contextSize })])).code).toBe(
			'preset-invalid'
		);
	});
});

describe('buildModelServerArgs', () => {
	const base = {
		port: 41234,
		presetsPath: '/data/model-server/presets.ini',
		maxModels: 1,
		apiKeyFile: '/data/model-server/api-key',
	};

	it('listens on loopback for Local only, with the key, the presets and the model count', () => {
		expect(buildModelServerArgs({ ...base, bind: 'local' })).toEqual([
			'--host',
			'127.0.0.1',
			'--port',
			'41234',
			'--models-preset',
			'/data/model-server/presets.ini',
			'--models-max',
			'1',
			'--api-key-file',
			'/data/model-server/api-key',
			'--no-webui',
			'--offline',
		]);
	});

	it('listens on every interface for Network, still with the key', () => {
		const args = buildModelServerArgs({ ...base, bind: 'network', maxModels: 3 });
		expect(args.slice(0, 2)).toEqual(['--host', '0.0.0.0']);
		expect(args).toContain('--api-key-file');
		expect(args[args.indexOf('--models-max') + 1]).toBe('3');
	});

	it('refuses a network bind without a key, naming the address', () => {
		for (const apiKeyFile of ['', '   ', undefined as unknown as string]) {
			const error = refusal(() => buildModelServerArgs({ ...base, bind: 'network', apiKeyFile }));
			expect(error.code).toBe('key-required');
			expect(error.message).toContain('0.0.0.0');
			expect(error.message).toContain('without an API key');
		}
	});

	it('refuses a Local only start without a key too', () => {
		expect(
			refusal(() => buildModelServerArgs({ ...base, bind: 'local', apiKeyFile: '' })).code
		).toBe('key-required');
	});
});

describe('modelServerEnvironment', () => {
	it('drops every LLAMA_ variable, in any case, and points the cache at its own folder', () => {
		const env = modelServerEnvironment(
			{
				PATH: '/usr/bin',
				HOME: '/home/someone',
				LLAMA_ARG_MODEL: '/elsewhere/model.gguf',
				LLAMA_API_KEY: 'someone-elses-key',
				llama_arg_models_dir: '/elsewhere/models',
				LLAMA_CACHE: '/home/someone/.cache/llama.cpp',
				GGML_METAL_PATH_RESOURCES: '/opt/metal',
				UNSET: undefined,
			},
			'/data/model-server/cache'
		);

		expect(env).toEqual({
			PATH: '/usr/bin',
			HOME: '/home/someone',
			GGML_METAL_PATH_RESOURCES: '/opt/metal',
			LLAMA_CACHE: '/data/model-server/cache',
		});
	});
});

describe('serverContextSize and isServerModel', () => {
	it('runs the catalog text model at its verified context', () => {
		expect(serverContextSize(qwen)).toBe(40_960);
	});

	it('runs a model with no row at the agent floor', () => {
		expect(serverContextSize({ ...qwen, id: 'some-new-model' })).toBe(
			MODEL_SERVER_AGENT_MIN_CONTEXT
		);
	});

	it('serves text models llama.cpp opens, and nothing else', () => {
		expect(isServerModel(qwen)).toBe(true);
		expect(isServerModel(getLocalModel(PARAKEET_TDT_V2_ID) as LocalModelEntry)).toBe(false);
	});
});

describe('collectServerModels', () => {
	it('offers only the installed text models, by absolute path in the model store', async () => {
		expect(await collectServerModels()).toEqual([]);

		store.installed.add(QWEN3_1_7B_ID);
		store.installed.add(PARAKEET_TDT_V2_ID);
		const models = await collectServerModels();

		expect(models).toEqual([
			{
				id: QWEN3_1_7B_ID,
				modelPath: path.join(tempRoot.dir, 'models', QWEN3_1_7B_ID, 'Qwen3-1.7B-Q4_K_M.gguf'),
				contextSize: 40_960,
			},
		]);
		expect(path.isAbsolute(models[0].modelPath)).toBe(true);
	});
});
