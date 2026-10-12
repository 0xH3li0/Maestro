/**
 * Tests for shared/local-models/run-on - which harnesses can run on another
 * model server, what a stored target may be, and what one launch does with it.
 */

import { describe, it, expect } from 'vitest';
import { AGENT_IDS } from '../../../shared/agentIds';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { GPT_OSS_20B_ID } from '../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_AGENT_MIN_CONTEXT,
	MODEL_SERVER_ENDPOINT_ID,
	modelServerEndpoint,
} from '../../../shared/local-models/model-server';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import {
	OPENCODE_CONFIG_ENV_VAR,
	RUN_ON_KEY_ENV_VAR,
	RUN_ON_DEFAULT_CONTEXT_TOKENS,
	RUN_ON_PLACEHOLDER_KEY,
	agentRunOnSupport,
	runOnOutputTokens,
	isRunOnSourceTarget,
	parseRunOnTarget,
	resolveRunOnLaunch,
	runOnHarnessMode,
	runOnTargetLabel,
	runOnUnavailable,
	storedRunOnNamesSource,
	type RunOnLaunchInput,
	type RunOnSourceTarget,
	type RunOnTarget,
} from '../../../shared/local-models/run-on';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'Workstation',
	kind: 'openai-compatible',
	baseUrl: 'https://models.example.com/api',
	apiKeyEnvVar: 'WORKSTATION_KEY',
	enabled: true,
};

const QWEN: RunOnSourceTarget = { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' };

function resolve(overrides: Partial<RunOnLaunchInput> = {}) {
	return resolveRunOnLaunch({
		toolType: 'claude-code',
		target: QWEN,
		endpoint: OLLAMA,
		...overrides,
	});
}

function injected(overrides: Partial<RunOnLaunchInput> = {}) {
	const resolution = resolve(overrides);
	if (resolution.kind !== 'inject') {
		throw new Error(`expected inject, got ${JSON.stringify(resolution)}`);
	}
	return resolution;
}

function refused(overrides: Partial<RunOnLaunchInput> = {}) {
	const resolution = resolve(overrides);
	if (resolution.kind !== 'refused') {
		throw new Error(`expected refused, got ${JSON.stringify(resolution)}`);
	}
	return resolution;
}

/** The harnesses whose recipe was run against the real CLI. */
const MEASURED = ['claude-code', 'codex', 'copilot-cli', 'opencode'];

/** The inline config a merge produced, read back as OpenCode would read it. */
function openCodeConfig(
	resolution: ReturnType<typeof injected>,
	current?: string
): Record<string, any> {
	return JSON.parse(resolution.envVarMerges[OPENCODE_CONFIG_ENV_VAR](current));
}

describe('agentRunOnSupport', () => {
	it.each(MEASURED)('%s has a recipe', (toolType) => {
		expect(agentRunOnSupport(toolType).supported).toBe(true);
	});

	it('answers for every agent id, with a reason wherever it refuses', () => {
		for (const id of AGENT_IDS) {
			const support = agentRunOnSupport(id);
			if (!support.supported) expect(support.reason.length).toBeGreaterThan(0);
		}
	});

	it.each(AGENT_IDS.filter((id) => !MEASURED.includes(id) && id !== 'terminal').map((id) => [id]))(
		'%s has no measured recipe, and says why instead of guessing one',
		(toolType) => {
			const support = agentRunOnSupport(toolType);

			expect(support.supported).toBe(false);
			if (support.supported) throw new Error('expected unsupported');
			expect(support.reason).toContain(getAgentDisplayName(toolType));
			expect(support.reason).toContain("runs on its provider's model only");
		}
	);

	it.each([
		['qwen3-coder', '--auth-type openai with --openai-base-url'],
		['hermes', '--provider openai-api with OPENAI_BASE_URL'],
		['omp', 'LM_STUDIO_BASE_URL'],
	])('%s names the documented way that has not been run yet', (toolType, way) => {
		const support = agentRunOnSupport(toolType);

		if (support.supported) throw new Error('expected unsupported');
		expect(support.reason).toContain(way);
		expect(support.reason).toContain('has not checked it against the real CLI');
	});

	it.each(['antigravity', 'gemini-cli'])('%s speaks a wire no source serves', (toolType) => {
		const support = agentRunOnSupport(toolType);

		if (support.supported) throw new Error('expected unsupported');
		expect(support.reason).toContain('speaks only the Gemini API');
	});

	it.each(['factory-droid', 'pi'])('%s needs a file Maestro does not write', (toolType) => {
		const support = agentRunOnSupport(toolType);

		if (support.supported) throw new Error('expected unsupported');
		expect(support.reason).toContain('Maestro does not write one for a launch');
	});

	it('refuses Grok CLI because the credential it would send is not known', () => {
		const support = agentRunOnSupport('grok');

		if (support.supported) throw new Error('expected unsupported');
		expect(support.reason).toContain('cannot tell which credential');
	});

	it('refuses a terminal, which is not an agent', () => {
		const support = agentRunOnSupport('terminal');

		expect(support).toEqual({ supported: false, reason: 'A terminal is a shell, not an agent.' });
	});

	it('refuses an id it has never heard of rather than guessing a recipe', () => {
		expect(agentRunOnSupport('not-a-provider').supported).toBe(false);
	});
});

describe('runOnOutputTokens', () => {
	it('gives the measured 8,192 at the smallest agent window', () => {
		expect(runOnOutputTokens(MODEL_SERVER_AGENT_MIN_CONTEXT)).toBe(8192);
	});

	it("never goes past Claude Code's own default reservation", () => {
		expect(runOnOutputTokens(131_072)).toBe(26_214);
		expect(runOnOutputTokens(262_144)).toBe(32_000);
	});
});

describe('parseRunOnTarget', () => {
	it.each([[undefined], [null], [{ type: 'provider' }], [{ type: 'provider', model: 'stale' }]])(
		'reads %j as the provider',
		(value) => {
			expect(parseRunOnTarget(value)).toEqual({ ok: true, target: { type: 'provider' } });
		}
	);

	it('trims a source target and drops keys it does not know', () => {
		expect(
			parseRunOnTarget({
				type: 'source',
				endpointId: ' ep-ollama ',
				model: ' qwen3:latest ',
				contextTokens: 65_536,
				extra: true,
			})
		).toEqual({
			ok: true,
			target: {
				type: 'source',
				endpointId: 'ep-ollama',
				model: 'qwen3:latest',
				contextTokens: 65_536,
			},
		});
	});

	it('leaves the context size out when the target names none', () => {
		const parsed = parseRunOnTarget({ ...QWEN, contextTokens: null });

		expect(parsed).toEqual({ ok: true, target: QWEN });
	});

	it.each([
		['a string', 'provider', 'an object'],
		['a list', [QWEN], 'an object'],
		['an unknown type', { type: 'cloud' }, '"provider" or a source'],
		['a blank source', { type: 'source', endpointId: ' ', model: 'm' }, 'names a source'],
		['a missing model', { type: 'source', endpointId: 'ep' }, 'names a model'],
		['a zero context', { ...QWEN, contextTokens: 0 }, 'whole number'],
		['a fractional context', { ...QWEN, contextTokens: 4096.5 }, 'whole number'],
		['a text context', { ...QWEN, contextTokens: '40960' }, 'whole number'],
	])('refuses %s', (_name, value, expected) => {
		const parsed = parseRunOnTarget(value);

		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error('expected a refusal');
		expect(parsed.error).toContain(expected);
	});
});

describe('isRunOnSourceTarget', () => {
	it('is true only for a source', () => {
		expect(isRunOnSourceTarget(QWEN)).toBe(true);
		expect(isRunOnSourceTarget({ type: 'provider' })).toBe(false);
		expect(isRunOnSourceTarget(undefined)).toBe(false);
		expect(isRunOnSourceTarget(null)).toBe(false);
	});
});

describe('storedRunOnNamesSource', () => {
	it.each([[undefined], [null], [{ type: 'provider' }]])('is false for %j', (value) => {
		expect(storedRunOnNamesSource(value)).toBe(false);
	});

	it('is true for a source', () => {
		expect(storedRunOnNamesSource(QWEN)).toBe(true);
	});

	it('is true for a malformed target, which is refused and never read as the provider', () => {
		expect(storedRunOnNamesSource({ type: 'source', endpointId: 'ep' })).toBe(true);
		expect(storedRunOnNamesSource('qwen3')).toBe(true);
	});
});

describe('runOnHarnessMode', () => {
	it('keeps the mode the launch chose for an agent on its provider', () => {
		expect(runOnHarnessMode(undefined, 'interactive', 'api')).toBe('interactive');
		expect(runOnHarnessMode({ type: 'provider' }, 'app-server', 'exec')).toBe('app-server');
	});

	it('pins a launch on a source to the mode its recipe was measured in', () => {
		expect(runOnHarnessMode(QWEN, 'interactive', 'api')).toBe('api');
		expect(runOnHarnessMode(QWEN, 'dynamic', 'api')).toBe('api');
		expect(runOnHarnessMode(QWEN, 'app-server', 'exec')).toBe('exec');
	});
});

describe('runOnTargetLabel', () => {
	it('names a model on a configured source', () => {
		expect(runOnTargetLabel(QWEN, [OLLAMA])).toBe('qwen3:latest on Ollama');
	});

	it('uses the catalog name on the Maestro model server, which no saved list carries', () => {
		expect(
			runOnTargetLabel(
				{ type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: GPT_OSS_20B_ID },
				[]
			)
		).toBe('gpt-oss 20B (MXFP4) on Maestro model server');
	});

	it('names a source that is gone by the model alone', () => {
		expect(runOnTargetLabel(QWEN, [])).toBe('qwen3:latest');
	});
});

describe('resolveRunOnLaunch: no target', () => {
	it.each<[string, RunOnTarget | null | undefined]>([
		['absent', undefined],
		['null', null],
		['provider', { type: 'provider' }],
	])('does nothing for a target that is %s', (_name, target) => {
		expect(resolve({ target })).toEqual({ kind: 'none' });
	});

	it('does nothing for a provider target even on a harness with no recipe', () => {
		expect(resolve({ toolType: 'factory-droid', target: { type: 'provider' } })).toEqual({
			kind: 'none',
		});
	});
});

describe('resolveRunOnLaunch: Claude Code', () => {
	it('points every tier at the model, on the source root, with the default window', () => {
		expect(injected()).toEqual({
			kind: 'inject',
			envVars: {
				// Blank: Claude Code's own key is not the source's to see.
				ANTHROPIC_API_KEY: '',
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
				ANTHROPIC_AUTH_TOKEN: RUN_ON_PLACEHOLDER_KEY,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:latest',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3:latest',
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3:latest',
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(RUN_ON_DEFAULT_CONTEXT_TOKENS),
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
			},
			args: [],
			subcommandArgs: [],
			model: 'qwen3:latest',
			harnessModel: 'qwen3:latest',
			envVarMerges: {},
			contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS,
			userOverrides: [],
			clearedEnvVars: ['ANTHROPIC_API_KEY'],
		});
	});

	it("blanks the provider's own key even when the agent sets it, so it never reaches the source", () => {
		const resolution = injected({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model' },
			endpoint: CLOUD,
			key: 'sk-workstation',
			userEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-the-users-own' },
		});

		// Claude Code sends this variable as `x-api-key` to whatever its base URL
		// is. A blank is what stops it, and the user's value is not an override.
		expect(resolution.envVars.ANTHROPIC_API_KEY).toBe('');
		expect(resolution.clearedEnvVars).toEqual(['ANTHROPIC_API_KEY']);
		expect(resolution.userOverrides).toEqual([]);
		expect(JSON.stringify(resolution)).not.toContain('sk-ant-the-users-own');
	});

	it("leaves the agent's own key alone when the agent routes itself", () => {
		const resolution = injected({
			userEnvVars: {
				ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
				ANTHROPIC_API_KEY: 'sk-ant-the-users-own',
			},
		});

		// The request goes where the agent's own variables send it, not to the source.
		expect(resolution.envVars).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(resolution.clearedEnvVars).toEqual([]);
	});

	it('sends the key of a source that has one, and the context the target carries', () => {
		const resolution = injected({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model', contextTokens: 200_000 },
			endpoint: CLOUD,
			key: ' sk-workstation ',
		});

		expect(resolution.envVars).toMatchObject({
			// A path prefix on the source stays; Claude Code appends `/v1/messages`.
			ANTHROPIC_BASE_URL: 'https://models.example.com/api',
			ANTHROPIC_AUTH_TOKEN: 'sk-workstation',
			CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
		});
		expect(resolution.contextTokens).toBe(200_000);
	});

	it('keeps the model out of the arguments, for the provider model flag to carry', () => {
		const resolution = injected();

		expect(resolution.args).not.toContain('--model');
		expect(resolution.model).toBe('qwen3:latest');
	});

	it('leaves a variable the agent sets itself alone, and reports which ones', () => {
		const resolution = injected({
			userEnvVars: {
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100000',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:1.7b',
				// Blank is unset everywhere in Maestro, so it is not an override.
				ANTHROPIC_DEFAULT_OPUS_MODEL: '  ',
			},
		});

		expect(resolution.userOverrides).toEqual([
			'ANTHROPIC_DEFAULT_HAIKU_MODEL',
			'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
		]);
		expect(resolution.envVars).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
		expect(resolution.envVars).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
		expect(resolution.envVars).toMatchObject({
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
			ANTHROPIC_AUTH_TOKEN: RUN_ON_PLACEHOLDER_KEY,
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3:latest',
		});
	});

	it("withholds the source's key when the agent sets the base URL itself", () => {
		const resolution = injected({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model' },
			endpoint: CLOUD,
			key: 'sk-workstation',
			userEnvVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' },
		});

		// The key was issued for the source, not for wherever the agent points.
		expect(resolution.envVars).not.toHaveProperty('ANTHROPIC_BASE_URL');
		expect(resolution.envVars).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
		expect(JSON.stringify(resolution)).not.toContain('sk-workstation');
		expect(resolution.userOverrides).toEqual(['ANTHROPIC_BASE_URL']);
		expect(resolution.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('big-model');
	});
});

describe('resolveRunOnLaunch: Codex', () => {
	const server = modelServerEndpoint('http://127.0.0.1:52100');
	const target: RunOnSourceTarget = {
		type: 'source',
		endpointId: MODEL_SERVER_ENDPOINT_ID,
		model: GPT_OSS_20B_ID,
	};

	it('defines a provider of its own on the Responses route, at the root of the command line', () => {
		expect(injected({ toolType: 'codex', target, endpoint: server, key: 'server-key' })).toEqual({
			kind: 'inject',
			envVars: { [RUN_ON_KEY_ENV_VAR]: 'server-key' },
			args: [
				'-c',
				'model_providers.maestro={name="Maestro", base_url="http://127.0.0.1:52100/v1", env_key="MAESTRO_RUN_ON_KEY", wire_api="responses"}',
				'-c',
				'model_provider="maestro"',
				'-c',
				`model_context_window=${RUN_ON_DEFAULT_CONTEXT_TOKENS}`,
			],
			subcommandArgs: [],
			model: GPT_OSS_20B_ID,
			harnessModel: GPT_OSS_20B_ID,
			envVarMerges: {},
			contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS,
			userOverrides: [],
			// A provider of its own with its own `env_key` sends that key and no other.
			clearedEnvVars: [],
		});
	});

	it('never sets the base-URL variable a ChatGPT login would answer with its own token', () => {
		const resolution = injected({ toolType: 'codex', target, endpoint: server });

		expect(resolution.envVars).not.toHaveProperty('OPENAI_BASE_URL');
		expect(resolution.args.join(' ')).not.toContain('openai_base_url');
	});

	it('gives a keyless source some text, because Codex refuses an unset env_key', () => {
		const resolution = injected({ toolType: 'codex', target: QWEN, endpoint: OLLAMA });

		expect(resolution.envVars).toEqual({ [RUN_ON_KEY_ENV_VAR]: RUN_ON_PLACEHOLDER_KEY });
		expect(resolution.args[1]).toContain('base_url="http://127.0.0.1:11434/v1"');
	});

	it('leaves the key variable alone when the agent sets it', () => {
		const resolution = injected({
			toolType: 'codex',
			target,
			endpoint: server,
			key: 'server-key',
			userEnvVars: { [RUN_ON_KEY_ENV_VAR]: 'my-own-key' },
		});

		expect(resolution.envVars).toEqual({});
		expect(resolution.userOverrides).toEqual([RUN_ON_KEY_ENV_VAR]);
	});

	it('carries the context the target names', () => {
		const resolution = injected({
			toolType: 'codex',
			target: { ...target, contextTokens: 131_072 },
			endpoint: server,
		});

		expect(resolution.args).toContain('model_context_window=131072');
	});
});

describe('resolveRunOnLaunch: Copilot CLI', () => {
	const copilot = (overrides: Partial<RunOnLaunchInput> = {}) =>
		injected({ toolType: 'copilot-cli', ...overrides });

	it('takes the launch off GitHub routing with its own provider variables, and nothing else', () => {
		expect(copilot()).toEqual({
			kind: 'inject',
			envVars: {
				// Blank: credentials for some other custom provider, which Copilot CLI
				// would send to the source in place of the source's key.
				COPILOT_PROVIDER_BEARER_TOKEN: '',
				COPILOT_PROVIDER_API_KEY_COMMAND: '',
				COPILOT_PROVIDER_HEADERS: '',
				// Copilot CLI calls `/chat/completions` under the URL it is given.
				COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
				COPILOT_PROVIDER_TYPE: 'openai',
				COPILOT_PROVIDER_WIRE_API: 'completions',
				COPILOT_PROVIDER_API_KEY: RUN_ON_PLACEHOLDER_KEY,
				COPILOT_PROVIDER_WIRE_MODEL: 'qwen3:latest',
				// The window, split into what the prompt and the reply may use.
				COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(RUN_ON_DEFAULT_CONTEXT_TOKENS - 8192),
				COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '8192',
			},
			args: [],
			subcommandArgs: [],
			model: 'qwen3:latest',
			harnessModel: 'qwen3:latest',
			envVarMerges: {},
			contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS,
			userOverrides: [],
			clearedEnvVars: [
				'COPILOT_PROVIDER_BEARER_TOKEN',
				'COPILOT_PROVIDER_API_KEY_COMMAND',
				'COPILOT_PROVIDER_HEADERS',
			],
		});
	});

	it('sends the key of a source that has one, under the path the source is served on', () => {
		const resolution = copilot({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model', contextTokens: 200_000 },
			endpoint: CLOUD,
			key: 'sk-workstation',
		});

		expect(resolution.envVars).toMatchObject({
			COPILOT_PROVIDER_BASE_URL: 'https://models.example.com/api/v1',
			COPILOT_PROVIDER_API_KEY: 'sk-workstation',
			COPILOT_PROVIDER_WIRE_MODEL: 'big-model',
			COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '168000',
			COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '32000',
		});
	});

	it('blanks a bearer token even when the agent sets it, so it never reaches the source', () => {
		const resolution = copilot({
			userEnvVars: { COPILOT_PROVIDER_BEARER_TOKEN: 'another-providers-token' },
		});

		expect(resolution.envVars.COPILOT_PROVIDER_BEARER_TOKEN).toBe('');
		expect(resolution.userOverrides).toEqual([]);
	});

	it("withholds the source's key, and leaves the agent's own credentials, when the agent routes itself", () => {
		const resolution = copilot({
			endpoint: CLOUD,
			key: 'sk-workstation',
			userEnvVars: { COPILOT_PROVIDER_BASE_URL: 'https://proxy.example.com/v1' },
		});

		expect(resolution.envVars).not.toHaveProperty('COPILOT_PROVIDER_BASE_URL');
		expect(resolution.envVars).not.toHaveProperty('COPILOT_PROVIDER_API_KEY');
		expect(resolution.envVars).not.toHaveProperty('COPILOT_PROVIDER_BEARER_TOKEN');
		expect(JSON.stringify(resolution)).not.toContain('sk-workstation');
		expect(resolution.clearedEnvVars).toEqual([]);
	});
});

describe('resolveRunOnLaunch: OpenCode', () => {
	const openCode = (overrides: Partial<RunOnLaunchInput> = {}) =>
		injected({ toolType: 'opencode', ...overrides });
	const defaults = getAgentDefinition('opencode')?.defaultEnvVars?.[OPENCODE_CONFIG_ENV_VAR];

	it('runs a private server, names the model under its own provider, and keeps the key in a variable', () => {
		const resolution = openCode();

		expect(resolution).toMatchObject({
			envVars: { [RUN_ON_KEY_ENV_VAR]: RUN_ON_PLACEHOLDER_KEY },
			// Nothing at the root: OpenCode rejects `--standalone` ahead of `run`.
			args: [],
			subcommandArgs: ['--standalone'],
			model: 'qwen3:latest',
			harnessModel: 'maestro/qwen3:latest',
			userOverrides: [],
			clearedEnvVars: [],
		});
		expect(Object.keys(resolution.envVarMerges)).toEqual([OPENCODE_CONFIG_ENV_VAR]);
	});

	it('defines the provider on the Chat Completions route, with the window and its output share', () => {
		expect(openCodeConfig(openCode())).toEqual({
			provider: {
				maestro: {
					npm: '@ai-sdk/openai-compatible',
					name: 'Maestro',
					options: {
						baseURL: 'http://127.0.0.1:11434/v1',
						apiKey: `{env:${RUN_ON_KEY_ENV_VAR}}`,
					},
					models: {
						'qwen3:latest': {
							name: 'qwen3:latest',
							limit: { context: RUN_ON_DEFAULT_CONTEXT_TOKENS, output: 8192 },
						},
					},
				},
			},
		});
	});

	it("adds the provider to Maestro's own inline config and keeps every key of it", () => {
		expect(defaults).toBeTruthy();
		const config = openCodeConfig(openCode(), defaults);

		expect(config).toMatchObject(JSON.parse(defaults ?? '{}'));
		expect(config.provider.maestro.models).toHaveProperty(['qwen3:latest']);
	});

	it("keeps the user's own providers, and takes the place of a stale one of its own", () => {
		const mine = JSON.stringify({
			theme: 'mine',
			provider: {
				ollama: { npm: '@ai-sdk/openai-compatible', models: { 'gemma4:latest': {} } },
				maestro: { options: { baseURL: 'http://stale.example.com/v1' } },
			},
		});
		const config = openCodeConfig(openCode(), mine);

		expect(config.theme).toBe('mine');
		expect(config.provider.ollama.models).toHaveProperty(['gemma4:latest']);
		expect(config.provider.maestro.options.baseURL).toBe('http://127.0.0.1:11434/v1');
	});

	it.each([['not json'], ['[1, 2]'], ['"text"'], ['']])(
		'makes the provider the whole document when the value it would add to is %j',
		(current) => {
			expect(Object.keys(openCodeConfig(openCode(), current))).toEqual(['provider']);
		}
	);

	it('never writes the key into the document', () => {
		const resolution = openCode({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model', contextTokens: 200_000 },
			endpoint: CLOUD,
			key: 'sk-workstation',
		});
		const text = resolution.envVarMerges[OPENCODE_CONFIG_ENV_VAR](defaults);

		expect(text).not.toContain('sk-workstation');
		expect(resolution.envVars).toEqual({ [RUN_ON_KEY_ENV_VAR]: 'sk-workstation' });
		expect(JSON.parse(text).provider.maestro).toMatchObject({
			options: { baseURL: 'https://models.example.com/api/v1' },
			models: { 'big-model': { limit: { context: 200_000, output: 32_000 } } },
		});
		expect(resolution.harnessModel).toBe('maestro/big-model');
	});

	it('refuses a loopback source for an SSH remote: its address is in the document, not a variable', () => {
		const resolution = resolve({ toolType: 'opencode', remote: { name: 'Build Box' } });

		expect(resolution).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
	});
});

describe('resolveRunOnLaunch: refusals', () => {
	it.each(AGENT_IDS.filter((id) => !MEASURED.includes(id)).map((id) => [id]))(
		'refuses %s, which has no recipe, and never runs it on the provider',
		(toolType) => {
			const resolution = refused({ toolType });

			expect(resolution.code).toBe('run-on-unsupported-provider');
			expect(resolution.message).toContain('qwen3:latest on Ollama');
			expect(resolution.message).toContain('Set Run on to Provider');
		}
	);

	it('refuses a provider it has never heard of', () => {
		expect(refused({ toolType: 'not-a-provider' }).code).toBe('run-on-unsupported-provider');
	});

	it.each([
		['an unknown type', { type: 'cloud' }],
		['a blank model', { type: 'source', endpointId: OLLAMA.id, model: ' ' }],
		['a bad context', { ...QWEN, contextTokens: -1 }],
	])('refuses a stored target with %s', (_name, target) => {
		const resolution = refused({ target: target as unknown as RunOnTarget });

		expect(resolution.code).toBe('run-on-invalid-target');
		expect(resolution.message).toContain('set Run on to Provider');
	});

	it.each<[string, LocalModelEndpoint | null | undefined]>([
		['null', null],
		['absent', undefined],
	])('refuses a source that is no longer configured (%s)', (_name, endpoint) => {
		const resolution = refused({ endpoint });

		expect(resolution.code).toBe('run-on-source-missing');
		expect(resolution.message).toContain('qwen3:latest');
		expect(resolution.message).toContain(OLLAMA.id);
	});

	it('refuses a disabled source by name', () => {
		const resolution = refused({ endpoint: { ...OLLAMA, enabled: false } });

		expect(resolution.code).toBe('run-on-source-disabled');
		expect(resolution.message).toContain('"Ollama" is disabled');
	});

	it.each([
		['http://127.0.0.1:11434'],
		['http://localhost:11434'],
		['http://[::1]:11434'],
		['http://0.0.0.0:11434'],
	])('refuses the loopback source %s for an SSH remote, naming both', (baseUrl) => {
		const resolution = refused({
			endpoint: { ...OLLAMA, baseUrl },
			remote: { name: 'build-box' },
		});

		expect(resolution.code).toBe('run-on-loopback-on-remote');
		expect(resolution.message).toContain(baseUrl);
		expect(resolution.message).toContain('SSH remote "build-box" cannot reach');
	});

	it('refuses the Maestro model server for an SSH remote: it is reached on loopback', () => {
		const resolution = refused({
			target: { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: GPT_OSS_20B_ID },
			endpoint: modelServerEndpoint('http://127.0.0.1:52100'),
			remote: { name: 'build-box' },
		});

		expect(resolution.code).toBe('run-on-loopback-on-remote');
	});

	it('lets an SSH remote use a source it can reach', () => {
		const resolution = resolve({
			target: { type: 'source', endpointId: CLOUD.id, model: 'big-model' },
			endpoint: CLOUD,
			remote: { name: 'build-box' },
		});

		expect(resolution.kind).toBe('inject');
	});

	it('does not refuse a loopback source on a remote when the agent sets the base URL itself', () => {
		// The same order as the gateway: the agent is not sent to the source's
		// address, so that address being loopback is not what the launch needs.
		const resolution = injected({
			remote: { name: 'build-box' },
			userEnvVars: { ANTHROPIC_BASE_URL: 'http://10.0.0.5:11434' },
		});

		expect(resolution.userOverrides).toEqual(['ANTHROPIC_BASE_URL']);
		expect(resolution.envVars).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
	});

	it('still refuses it for Codex, whose base URL is an argument no variable overrides', () => {
		const resolution = refused({
			toolType: 'codex',
			remote: { name: 'build-box' },
			userEnvVars: { OPENAI_BASE_URL: 'http://10.0.0.5:11434/v1' },
		});

		expect(resolution.code).toBe('run-on-loopback-on-remote');
	});
});

describe('runOnUnavailable', () => {
	it.each([
		[
			'run-on-source-unreachable' as const,
			'connect ECONNREFUSED 127.0.0.1:11434.',
			'the source "Ollama" did not answer (connect ECONNREFUSED 127.0.0.1:11434)',
		],
		[
			'run-on-model-not-served' as const,
			undefined,
			'the source "Ollama" does not serve "qwen3:latest"',
		],
	])('words %s in one place', (code, detail, expected) => {
		const refusal = runOnUnavailable(code, QWEN, OLLAMA, detail);

		expect(refusal).toMatchObject({ kind: 'refused', code });
		expect(refusal.message).toContain('This agent is set to run on qwen3:latest on Ollama, but ');
		expect(refusal.message).toContain(expected);
		expect(refusal.message).toContain('set Run on to Provider');
	});

	it('names the Maestro model server and what it said when it cannot serve the model', () => {
		const refusal = runOnUnavailable(
			'run-on-server-failed',
			{ type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: GPT_OSS_20B_ID },
			modelServerEndpoint('http://127.0.0.1:52100'),
			'The llama-server engine is not installed.'
		);

		expect(refusal.code).toBe('run-on-server-failed');
		expect(refusal.message).toBe(
			'This agent is set to run on gpt-oss 20B (MXFP4) on Maestro model server, but the Maestro model server could not serve it (The llama-server engine is not installed). Fix the source, or set Run on to Provider.'
		);
	});
});
