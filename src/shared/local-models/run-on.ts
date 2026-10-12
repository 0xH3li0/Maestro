/**
 * Run on: the model an agent's harness talks to.
 *
 * An agent keeps its provider's CLI (Claude Code's tool loop, permissions and
 * transcripts, Maestro's parsers and session storage) and only the model behind
 * it changes. Its target is the provider's own cloud model (the default), or a
 * model on a Local Models source: the Maestro model server, a server the user
 * runs (Ollama, LM Studio), or a cloud endpoint from Sources.
 *
 * "How is this harness pointed at another model server" is a per-provider fact
 * and "may this launch do it" is a per-launch decision. Both live here, pure,
 * so the launch plan, the settings picker, the CLI and the turn pills cannot
 * disagree about them.
 *
 * Four rules every caller inherits:
 *
 * 1. A target that cannot run refuses the launch by name. It is never dropped
 *    so the turn can go to the provider's cloud model: that would spend money
 *    the user chose not to spend, and send the conversation where they chose
 *    not to send it.
 * 2. Only recipes checked against the real CLI are mapped. A guessed variable
 *    is ignored by the CLI, so the agent would run on the provider's model
 *    while every surface says it runs elsewhere.
 * 3. A variable the agent sets in its own environment wins, one variable at a
 *    time (the gateway's rule). The source's key is the exception in one
 *    direction: it is withheld when the agent sets the base URL itself, because
 *    a key belongs to the server it was issued for and must not be sent to an
 *    address the source does not own.
 * 4. The model is not in `args`. It is handed back as `model` and goes through
 *    the provider's own `modelArgs` builder, in the position that builder is
 *    known to work in (Codex reads `-m` after `exec`), and so that it REPLACES
 *    the agent's stored model instead of sitting beside it.
 */

import { isEnvVarSet } from '../agentEnvironment';
import type { AgentId } from '../agentIds';
import { getAgentDisplayName } from '../agentMetadata';
import type { LocalModelEndpoint } from './endpoints';
import { isLoopbackGatewayUrl } from './gateway';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from './model-server';
import { localModelAssignmentSourceLabel } from './tasks';

/** A model on a Local Models source, named the way an assignment names one. */
export interface RunOnSourceTarget {
	type: 'source';
	/** A configured endpoint's id, or `maestro-server` for the Maestro model server. */
	endpointId: string;
	/** The model name the source serves it under (a catalog id on the Maestro server). */
	model: string;
	/** The context the harness is told it has. Absent means {@link RUN_ON_DEFAULT_CONTEXT_TOKENS}. */
	contextTokens?: number;
}

/** Where an agent's model runs. Absent on the agent record means `provider`. */
export type RunOnTarget = { type: 'provider' } | RunOnSourceTarget;

/**
 * The context a harness is given when the target names none: the smallest
 * window an agent harness was measured to work in.
 */
export const RUN_ON_DEFAULT_CONTEXT_TOKENS = MODEL_SERVER_AGENT_MIN_CONTEXT;

/**
 * Sent as the key to a source that has none. Claude Code refuses to start with
 * a base URL and no credential ("Not logged in"), and Codex refuses a provider
 * whose `env_key` variable is unset, so a keyless server still needs some text.
 */
export const RUN_ON_PLACEHOLDER_KEY = 'maestro-run-on';

/** The variable Codex reads its Run on key from (the provider's `env_key`). */
export const RUN_ON_CODEX_KEY_ENV_VAR = 'MAESTRO_RUN_ON_KEY';

/** The id of the model provider Maestro defines for Codex on the command line. */
const CODEX_PROVIDER_ID = 'maestro';

/**
 * Claude Code's own output reservation. It holds this many tokens back from the
 * window before it decides to compact.
 */
const CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * The output budget Claude Code is given for a window: a fifth of it, up to its
 * own default. Measured 2026-10-12 at 40,960 tokens: with the default 32,000
 * held back about 9K is left, under Claude Code's own system prompt, so it
 * compacted on every turn and gave up ("Autocompact is thrashing"); 8,192 (a
 * fifth) worked for every model that qualified.
 */
export function claudeCodeRunOnOutputTokens(contextTokens: number): number {
	return Math.min(CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextTokens / 5));
}

/** What a recipe is built from: a source the launch may use, already checked. */
export interface RunOnRecipeInput {
	/** The source's base URL: its root, with no `/v1` and no trailing slash. */
	baseUrl: string;
	/** The source's key, or {@link RUN_ON_PLACEHOLDER_KEY} when it has none. */
	key: string;
	model: string;
	contextTokens: number;
}

/** Whether a provider's harness can run on another model server, and how. */
export type AgentRunOnSupport =
	| {
			supported: true;
			/**
			 * The variable that carries the source's base URL, for a harness that
			 * reads it from the environment. Rule 3 reads it: when the agent sets it,
			 * `keyEnvVar` is withheld.
			 */
			baseUrlEnvVar?: string;
			/** The variable that carries the source's key. */
			keyEnvVar: string;
			/**
			 * The variables and the ROOT arguments that point the harness at the
			 * source. The arguments go before the agent's own (ahead of any
			 * subcommand), which is where a CLI reads a global option. The model flag
			 * is not among them (rule 4).
			 */
			recipe: (input: RunOnRecipeInput) => { envVars: Record<string, string>; args: string[] };
	  }
	| {
			supported: false;
			/** One sentence for the user, shown beside the disabled picker. */
			reason: string;
	  };

/**
 * Keyed by `AgentId`, so a new provider fails to compile until it is given a
 * recipe or a reason. Both recipes were run against the real CLIs on
 * 2026-10-11 and 2026-10-12: Claude Code 2.1.296 on the Maestro model server
 * and on Ollama, Codex CLI 0.162.1 on the Maestro model server.
 */
const RUN_ON_SUPPORT: Record<AgentId, AgentRunOnSupport> = {
	// The base URL alone fails with "Not logged in": the token is what makes
	// Claude Code skip its own login. Every tier variable is set because Claude
	// Code sends background work (titles, summaries, subagents) to its haiku
	// tier, and an unset tier names a model the source does not serve.
	'claude-code': {
		supported: true,
		baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
		keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
		recipe: ({ baseUrl, key, model, contextTokens }) => ({
			envVars: {
				ANTHROPIC_BASE_URL: baseUrl,
				ANTHROPIC_AUTH_TOKEN: key,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
				ANTHROPIC_DEFAULT_SONNET_MODEL: model,
				ANTHROPIC_DEFAULT_OPUS_MODEL: model,
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens),
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(claudeCodeRunOnOutputTokens(contextTokens)),
			},
			args: [],
		}),
	},
	// A provider of its own, on the Responses route. With a ChatGPT login,
	// `-c openai_base_url=...` alone sends the ChatGPT token to the source; a
	// custom provider with its own `env_key` sends the source's key and nothing
	// else. The values are parsed as TOML, and a JSON string literal is a valid
	// TOML basic string for any URL an endpoint record accepts.
	codex: {
		supported: true,
		keyEnvVar: RUN_ON_CODEX_KEY_ENV_VAR,
		recipe: ({ baseUrl, key, contextTokens }) => ({
			envVars: { [RUN_ON_CODEX_KEY_ENV_VAR]: key },
			args: [
				'-c',
				`model_providers.${CODEX_PROVIDER_ID}={name="Maestro", base_url=${JSON.stringify(`${baseUrl}/v1`)}, env_key="${RUN_ON_CODEX_KEY_ENV_VAR}", wire_api="responses"}`,
				'-c',
				`model_provider="${CODEX_PROVIDER_ID}"`,
				'-c',
				`model_context_window=${contextTokens}`,
			],
		}),
	},
	'copilot-cli': notVerified('copilot-cli'),
	opencode: notVerified('opencode'),
	'factory-droid': notVerified('factory-droid'),
	antigravity: notVerified('antigravity'),
	'gemini-cli': notVerified('gemini-cli'),
	'qwen3-coder': notVerified('qwen3-coder'),
	hermes: notVerified('hermes'),
	pi: notVerified('pi'),
	omp: notVerified('omp'),
	grok: notVerified('grok'),
	terminal: { supported: false, reason: 'A terminal is a shell, not an agent.' },
};

function notVerified(agentId: AgentId): AgentRunOnSupport {
	return {
		supported: false,
		reason: `Maestro has not verified a way to point ${getAgentDisplayName(agentId)} at another model server, so it runs on its provider's model only.`,
	};
}

/** Whether (and by which recipe) a provider's harness can run on another model server. */
export function agentRunOnSupport(toolType: string): AgentRunOnSupport {
	return (
		(RUN_ON_SUPPORT as Record<string, AgentRunOnSupport | undefined>)[toolType] ?? {
			supported: false,
			reason: `Maestro has not verified a way to point "${toolType}" at another model server.`,
		}
	);
}

/** Whether a stored target sends the agent's model somewhere other than its provider. */
export function isRunOnSourceTarget(
	target: RunOnTarget | null | undefined
): target is RunOnSourceTarget {
	return target?.type === 'source';
}

export type RunOnTargetParse = { ok: true; target: RunOnTarget } | { ok: false; error: string };

/**
 * Read a target from anything that may hold one (the stored agent record, a
 * bridge message) and put it in the one form that is stored: trimmed, with no
 * unknown keys. A blank value reads as `provider`, which is what an agent with
 * no target runs on. Shared by every writer, so none can store a target the
 * launch would then refuse as malformed.
 */
export function parseRunOnTarget(value: unknown): RunOnTargetParse {
	if (value === undefined || value === null) return { ok: true, target: { type: 'provider' } };
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'A Run on target is an object with a type.' };
	}
	const record = value as Record<string, unknown>;
	if (record.type === 'provider') return { ok: true, target: { type: 'provider' } };
	if (record.type !== 'source') {
		return { ok: false, error: 'A Run on target is "provider" or a source and a model.' };
	}
	const endpointId = typeof record.endpointId === 'string' ? record.endpointId.trim() : '';
	if (endpointId === '') return { ok: false, error: 'A Run on target names a source.' };
	const model = typeof record.model === 'string' ? record.model.trim() : '';
	if (model === '') return { ok: false, error: 'A Run on target names a model.' };
	if (record.contextTokens === undefined || record.contextTokens === null) {
		return { ok: true, target: { type: 'source', endpointId, model } };
	}
	const contextTokens = record.contextTokens;
	if (typeof contextTokens !== 'number' || !Number.isInteger(contextTokens) || contextTokens <= 0) {
		return { ok: false, error: 'A Run on context size is a whole number of tokens above zero.' };
	}
	return { ok: true, target: { type: 'source', endpointId, model, contextTokens } };
}

/**
 * A target for a person: the catalog name on the Maestro model server, or
 * `<model> on <source name>`. A source that is gone is named by the model alone.
 */
export function runOnTargetLabel(
	target: RunOnSourceTarget,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string {
	return (
		localModelAssignmentSourceLabel(
			{ type: 'endpoint', endpointId: target.endpointId, model: target.model },
			endpoints
		) ?? target.model
	);
}

/**
 * Why a launch was refused.
 *
 * The first five are decided here, from the stored target and the source's
 * record. The last three need the network or the model server, so the main
 * process decides them and words them with {@link runOnUnavailable}.
 *
 *   - `run-on-unsupported-provider`: the harness has no verified recipe.
 *   - `run-on-invalid-target`: the stored target is not a source and a model.
 *   - `run-on-source-missing`: the source is no longer configured.
 *   - `run-on-source-disabled`: the source is switched off.
 *   - `run-on-loopback-on-remote`: an SSH remote cannot reach a loopback source.
 *   - `run-on-source-unreachable`: the source did not answer.
 *   - `run-on-model-not-served`: the source answered, without this model.
 *   - `run-on-server-failed`: the Maestro model server could not serve it.
 */
export type RunOnRefusalCode =
	| 'run-on-unsupported-provider'
	| 'run-on-invalid-target'
	| 'run-on-source-missing'
	| 'run-on-source-disabled'
	| 'run-on-loopback-on-remote'
	| RunOnUnavailableCode;

export type RunOnUnavailableCode =
	| 'run-on-source-unreachable'
	| 'run-on-model-not-served'
	| 'run-on-server-failed';

export interface RunOnRefusal {
	kind: 'refused';
	code: RunOnRefusalCode;
	message: string;
}

export type RunOnLaunchResolution =
	/** The agent runs on its provider's own model. */
	| { kind: 'none' }
	/**
	 * Set these variables on the agent's process, put `args` ahead of its own
	 * arguments, and launch it with `model` through the provider's `modelArgs`
	 * builder in place of the agent's stored model.
	 */
	| {
			kind: 'inject';
			envVars: Record<string, string>;
			args: string[];
			model: string;
			contextTokens: number;
			/** Recipe variables the agent sets itself, which were left alone (rule 3). */
			userOverrides: string[];
	  }
	/** The launch must fail with this message (rule 1). */
	| RunOnRefusal;

export interface RunOnLaunchInput {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The agent's stored target. Absent, or `provider`, means its provider's model. */
	target?: RunOnTarget | null;
	/**
	 * The source the target names, looked up by the caller: a record from the
	 * saved list, or `modelServerEndpoint(baseUrl)` for the Maestro model server.
	 * Null or absent when no such source is configured.
	 */
	endpoint?: LocalModelEndpoint | null;
	/** The source's key, resolved by the caller. Absent when it has none. */
	key?: string;
	/**
	 * The agent's effective custom vars: its own, or the provider-level set when
	 * it has none (`effectiveAgentCustomEnvVars`). The layer rule 3 reads.
	 */
	userEnvVars?: Record<string, string>;
	/** The SSH remote the agent runs on, when it runs on one. */
	remote?: { name: string } | null;
}

const RECOVERY = 'Fix the source, or set Run on to Provider.';

/**
 * Decide what an agent's Run on target does to one launch. The single answer
 * behind every spawn surface.
 */
export function resolveRunOnLaunch(input: RunOnLaunchInput): RunOnLaunchResolution {
	// The stored record is read as data, not trusted as its type: a hand-edited
	// or half-written target must refuse the launch, not reach a recipe.
	const parsed = parseRunOnTarget(input.target);
	if (!parsed.ok) {
		return {
			kind: 'refused',
			code: 'run-on-invalid-target',
			message: `This agent's Run on target cannot be used: ${parsed.error} Pick a model again, or set Run on to Provider.`,
		};
	}
	if (parsed.target.type === 'provider') return { kind: 'none' };
	const target = parsed.target;
	const endpoint = input.endpoint ?? null;
	const label = runOnTargetLabel(target, endpoint ? [endpoint] : []);

	const support = agentRunOnSupport(input.toolType);
	if (!support.supported) {
		return {
			kind: 'refused',
			code: 'run-on-unsupported-provider',
			message: `This agent is set to run on ${label}, but ${lowerFirst(support.reason)} Set Run on to Provider to run the agent.`,
		};
	}

	if (!endpoint) {
		return {
			kind: 'refused',
			code: 'run-on-source-missing',
			message: `This agent is set to run on ${label}, but its source (${target.endpointId}) is no longer configured. Pick a model again, or set Run on to Provider.`,
		};
	}

	if (!endpoint.enabled) {
		return {
			kind: 'refused',
			code: 'run-on-source-disabled',
			message: `This agent is set to run on ${label}, but the source "${endpoint.name}" is disabled. Enable it, or set Run on to Provider.`,
		};
	}

	// An agent that sets the base URL itself is not sent to the source's address
	// (rule 3), so the address being loopback is not what its launch depends on.
	// The gateway checks in the same order.
	const userSetsBaseUrl =
		support.baseUrlEnvVar !== undefined && isEnvVarSet(input.userEnvVars, support.baseUrlEnvVar);
	if (input.remote && !userSetsBaseUrl && isLoopbackGatewayUrl(endpoint.baseUrl)) {
		return {
			kind: 'refused',
			code: 'run-on-loopback-on-remote',
			message: `This agent is set to run on ${label} (${endpoint.baseUrl}), which is a loopback address on this machine that SSH remote "${input.remote.name}" cannot reach. Pick a source the remote host can reach, or set Run on to Provider.`,
		};
	}

	const contextTokens = target.contextTokens ?? RUN_ON_DEFAULT_CONTEXT_TOKENS;
	const recipe = support.recipe({
		baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
		key: input.key?.trim() || RUN_ON_PLACEHOLDER_KEY,
		model: target.model,
		contextTokens,
	});

	const userOverrides = Object.keys(recipe.envVars).filter((name) =>
		isEnvVarSet(input.userEnvVars, name)
	);
	const withheld = new Set(userOverrides);
	if (userSetsBaseUrl) withheld.add(support.keyEnvVar);

	return {
		kind: 'inject',
		envVars: Object.fromEntries(
			Object.entries(recipe.envVars).filter(([name]) => !withheld.has(name))
		),
		args: recipe.args,
		model: target.model,
		contextTokens,
		userOverrides,
	};
}

/**
 * The refusal for a target whose source cannot serve the model right now. The
 * main process calls it after asking the source (or starting the Maestro model
 * server), so the three failures only it can see are worded in one place.
 * `detail` is what the source or the server said.
 */
export function runOnUnavailable(
	code: RunOnUnavailableCode,
	target: RunOnSourceTarget,
	endpoint: Pick<LocalModelEndpoint, 'id' | 'name'>,
	detail?: string
): RunOnRefusal {
	const label = runOnTargetLabel(target, [endpoint]);
	const said = detail?.trim() ? ` (${detail.trim().replace(/\.$/, '')})` : '';
	const what: Record<RunOnUnavailableCode, string> = {
		'run-on-source-unreachable': `the source "${endpoint.name}" did not answer${said}`,
		'run-on-model-not-served': `the source "${endpoint.name}" does not serve "${target.model}"${said}`,
		'run-on-server-failed': `the ${endpoint.name} could not serve it${said}`,
	};
	return {
		kind: 'refused',
		code,
		message: `This agent is set to run on ${label}, but ${what[code]}. ${RECOVERY}`,
	};
}

function lowerFirst(text: string): string {
	// A reason starts with "Maestro" or a provider's name; only an article is lowered.
	return /^(A|An|The) /.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
