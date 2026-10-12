/**
 * @file spawnGroupChatAgent.ts
 * @description Centralized spawn helper for Group Chat agent processes.
 *
 * Every spawn site in the Group Chat router (moderator, participant, synthesis,
 * recovery) follows the same pattern: maybe SSH-wrap the command, apply
 * Windows-specific shell/stdin config, then call `processManager.spawn`. This
 * helper consolidates that sequence so each call site only needs to describe
 * the semantic spawn intent rather than repeat the mechanics.
 */

import { IProcessManager } from './group-chat-moderator';
import { getContextWindowValue } from '../utils/agent-args';
import { wrapSpawnWithSsh, sshUnresolvedRemoteMessage } from '../utils/ssh-spawn-wrapper';
import { getSshRemoteConfig, type SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { getWindowsSpawnConfig } from './group-chat-config';
import { beginGroupChatTurn } from './group-chat-turn-metrics';
import { applySystemPromptDelivery } from '../utils/system-prompt-delivery';
import type { AgentConfig } from '../agents/definitions';
import type { AgentSshRemoteConfig } from '../../shared/types';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
} from '../agents/resolveClaudeSpawnMode';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { resolveSshLaunchTarget } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { applyAgentGatewayToSpawn } from '../local-models/proxy/service';
import { applyAgentRunOnToSpawn, logRunOnLaunch, storedAgentRunOn } from '../local-models/run-on';
import { runOnHarnessMode } from '../../shared/local-models/run-on';

/** The remote's display name for a refusal message; its id when it cannot be resolved. */
function sshRemoteName(
	store: SshRemoteSettingsStore | null | undefined,
	config: AgentSshRemoteConfig
): string {
	const target = resolveSshLaunchTarget(store ?? undefined, config);
	return target.kind === 'remote' ? target.remote.name : (config.remoteId ?? 'unknown');
}

export interface SpawnGroupChatAgentConfig {
	/** Stable session id for the process manager */
	sessionId: string;
	/** Agent id (e.g. 'claude-code', 'codex') - used as `toolType` */
	agentId: string;
	/** Resolved agent definition */
	agent: AgentConfig;
	/** Base command - defaults to agent.path ?? agent.command */
	command?: string;
	/** Fully-formed args (after buildAgentArgs + any extras) */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Prompt to send (via CLI arg or stdin) */
	prompt?: string;
	/** Resolved custom env vars to inject */
	customEnvVars?: Record<string, string>;
	/**
	 * The Left Bar agent this process runs AS, when there is one (a participant,
	 * a cross-agent consult target). Its Run on target, or failing that its Local
	 * Models gateway, is applied to the spawn, so the turn runs on the same model
	 * by the same route as that agent's own tab. Omit for a process that is
	 * nobody's agent (the moderator, synthesis): both are per-agent settings and
	 * there is none to read.
	 */
	maestroAgentId?: string;
	/** Agent config values (used for context window resolution) */
	agentConfigValues?: Record<string, any>;
	/** SSH remote config (from chat moderator or matching session); null/undefined = local */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	/** SSH settings store (required when sshRemoteConfig is active) */
	sshStore?: SshRemoteSettingsStore | null;
	/**
	 * Claude token source for this agent (Claude Code only). Drives the
	 * maestro-p TUI vs `claude --print` choice. Ignored for non-Claude agents
	 * and SSH spawns (the TUI wrapper needs the local claude binary).
	 */
	tokenMode?: ClaudeTokenMode;
	/** Optional per-agent maestro-p script override. */
	maestroPPath?: string;
	/** Process manager to invoke */
	processManager: IProcessManager;
	/** Whether the spawned process is read-only (moderator / synthesis = true) */
	readOnlyMode?: boolean;
	/** Optional label for debug logs (e.g. 'moderator', 'participant: Alice') */
	debugLabel?: string;
	/**
	 * Overall idle budget for a maestro-p (interactive/dynamic) run, in seconds,
	 * forwarded as `--max-wait`. Group Chat is a background/orchestrated caller, so
	 * it MUST pass this to match the router's own supervising timeout - otherwise
	 * maestro-p falls back to its 300s idle default and silently kills a
	 * still-working moderator/participant whose JSONL output stalls past 300s
	 * (long tool runs or extended thinking), even though the router would wait the
	 * full 10 minutes. Same contract Cue follows. Ignored on the API path.
	 */
	maxWaitSeconds?: number;
	/**
	 * Maestro system prompt for this agent. Delivered by
	 * `applySystemPromptDelivery`, exactly like a tab spawn: the native flag
	 * (temp file on Windows local) when the agent supports it, otherwise embedded
	 * into `prompt`, and not re-embedded when `isResume`.
	 */
	appendSystemPrompt?: string;
	/** True when `args` resume an existing provider session. */
	isResume?: boolean;
}

export interface SpawnGroupChatAgentResult {
	pid: number;
	success: boolean;
}

/**
 * Spawn a Group Chat agent process with SSH + Windows shell handling applied.
 *
 * The helper:
 * 1. Optionally wraps the command with SSH (when `sshRemoteConfig.enabled`)
 * 2. Applies Windows-specific shell/stdin config (skipped for SSH)
 * 3. Calls `processManager.spawn` with the resolved config
 *
 * All four legacy call sites (moderator, participant, synthesis, recovery) used
 * this exact sequence with only cosmetic differences - see git history for the
 * inline versions this replaces.
 */
export async function spawnGroupChatAgent(
	config: SpawnGroupChatAgentConfig
): Promise<SpawnGroupChatAgentResult> {
	const {
		sessionId,
		agentId,
		agent,
		args: rawArgs,
		cwd,
		prompt: rawPrompt,
		agentConfigValues,
		sshRemoteConfig,
		sshStore,
		processManager,
		readOnlyMode = false,
		debugLabel,
	} = config;

	const baseCommand = config.command ?? agent.path ?? agent.command;

	// System prompt first, so every later step (maestro-p rewrite, SSH wrap,
	// Windows stdin) sees the final args and prompt.
	const delivered = await applySystemPromptDelivery({
		args: rawArgs,
		prompt: rawPrompt,
		systemPrompt: config.appendSystemPrompt,
		supportsAppendSystemPrompt: !!agent.capabilities?.supportsAppendSystemPrompt,
		isResume: !!config.isResume,
		isSshSession: !!sshRemoteConfig?.enabled,
		sessionId,
		agentId,
		logContext: '[GroupChat:Spawn]',
	});
	const prompt = delivered.prompt;

	// Where the agent's model runs, applied before anything below reads the
	// arguments or the env, so the local, maestro-p and SSH paths all carry it:
	// its Run on target first, and its Local Models gateway only when it has
	// none (a Run on target takes the gateway's place, since the gateway routes
	// to the provider). Either one that cannot be used (a source that is down, a
	// loopback address for a remote host, a proxy that will not start) refuses
	// the turn by name rather than running it somewhere the user did not choose.
	let args = delivered.args;
	let customEnvVars = config.customEnvVars;
	if (config.maestroAgentId) {
		const remote = sshRemoteConfig?.enabled
			? { name: sshRemoteName(sshStore, sshRemoteConfig) }
			: null;
		const runOn = await applyAgentRunOnToSpawn({
			agentId: config.maestroAgentId,
			toolType: agentId,
			agent,
			args,
			customEnvVars,
			remote,
		});
		if (!runOn.ok) throw new Error(runOn.error);
		args = runOn.args;
		customEnvVars = runOn.customEnvVars;
		if (runOn.runOn) {
			logRunOnLaunch('[GroupChat:Spawn]', { sessionId, toolType: agentId }, runOn.runOn);
		} else {
			const gateway = await applyAgentGatewayToSpawn({
				agentId: config.maestroAgentId,
				toolType: agentId,
				args,
				customEnvVars,
				remote,
			});
			if (!gateway.ok) throw new Error(gateway.error);
			args = gateway.args;
			customEnvVars = gateway.customEnvVars;
		}
	}

	let spawnCommand = baseCommand;
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnPrompt: string | undefined = prompt;
	let spawnEnvVars = customEnvVars;
	let spawnSshStdinScript: string | undefined;
	let spawnSshRemoteCommand: string | undefined;

	// Over SSH, warm the remote maestro-p probe BEFORE resolving so a remote TUI
	// selection falls back to API instead of exiting 127 when maestro-p isn't
	// installed on the remote (the resolver reads this from the cache).
	if (sshRemoteConfig?.enabled && sshStore) {
		const sshRemote = getSshRemoteConfig(sshStore, {
			sessionSshConfig: sshRemoteConfig,
		}).config;
		if (sshRemote) {
			await ensureRemoteMaestroPProbed(sshRemote);
		}
	}

	// Resolve the Claude token source (maestro-p TUI vs `claude --print`) and,
	// for the interactive/dynamic case, rewrite the spawn to run maestro-p via
	// process.execPath. The resolver returns API for non-Claude agents and SSH
	// spawns, so this is a no-op outside the local Claude Code interactive path.
	// maestro-p reads the prompt the same way claude does (positional after the
	// args processManager appends), so prompt delivery is unchanged.
	const claudeDecision = resolveClaudeSpawnMode({
		agent,
		// An agent that runs on a source keeps to `claude --print`, the mode its
		// recipe was measured in.
		tokenMode: runOnHarnessMode(
			config.maestroAgentId ? storedAgentRunOn(config.maestroAgentId) : undefined,
			config.tokenMode ?? 'api',
			'api'
		),
		sshEnabled: !!sshRemoteConfig?.enabled,
		// Lets the resolver fall a remote TUI spawn back to API when the remote
		// has no maestro-p on its PATH (avoids exit 127).
		sshRemoteId: sshRemoteConfig?.remoteId ?? undefined,
		command: baseCommand,
		sessionCustomEnvVars: customEnvVars,
		maestroPPath: config.maestroPPath,
		now: new Date(),
	});
	if (claudeDecision.mode === 'interactive' && claudeDecision.maestroPBinPath) {
		const applied = applyClaudeSpawnDecision({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			command: baseCommand,
			args,
			customEnvVars,
			maxWaitSeconds: config.maxWaitSeconds,
		});
		spawnCommand = applied.command;
		spawnArgs = applied.args;
		spawnEnvVars = applied.customEnvVars;
		if (debugLabel) {
			console.log(
				`[GroupChat:Debug] ${debugLabel} resolved to maestro-p (tokenMode=${config.tokenMode})`
			);
		}
	}

	// Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && !sshStore) {
		throw new Error(
			`SSH remote is enabled but sshStore is not available for ${debugLabel ?? sessionId}`
		);
	}
	if (sshStore && sshRemoteConfig?.enabled) {
		if (debugLabel) {
			console.log(`[GroupChat:Debug] Applying SSH wrapping for ${debugLabel}...`);
		}
		// Claude interactive/dynamic over SSH runs maestro-p on the remote host
		// (must be on its PATH) to drive the remote TUI on the Max subscription.
		// Returns null for the API path, leaving the SSH config untouched.
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			remoteClaudeBin: claudeDecision.claudeRealBinPath,
			maxWaitSeconds: config.maxWaitSeconds,
		});
		if (remoteInteractive && debugLabel) {
			console.log(
				`[GroupChat:Debug] ${debugLabel} resolved to remote maestro-p over SSH (tokenMode=${config.tokenMode})`
			);
		}
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: baseCommand,
				args: remoteInteractive ? [...remoteInteractive.prependArgs, ...args] : args,
				cwd,
				prompt,
				customEnvVars: remoteInteractive
					? { ...(customEnvVars ?? {}), ...remoteInteractive.env }
					: customEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: remoteInteractive ? remoteInteractive.command : agent.binaryName,
			},
			sshRemoteConfig,
			sshStore
		);
		// wrapSpawnWithSsh quietly hands back the unmodified local config when the
		// remote cannot be resolved. Taking it would run this agent on the user's
		// own machine against the REMOTE's cwd - the participant would either fail
		// on a missing directory or, worse, succeed against the wrong files. The
		// user opted into a remote host, so fail loudly instead of degrading.
		if (!sshWrapped.sshRemoteUsed) {
			throw new Error(sshUnresolvedRemoteMessage(sshRemoteConfig));
		}
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnPrompt = sshWrapped.prompt;
		spawnEnvVars = sshWrapped.customEnvVars;
		spawnSshStdinScript = sshWrapped.sshStdinScript;
		spawnSshRemoteCommand = sshWrapped.sshRemoteCommand;
		if (sshWrapped.sshRemoteUsed && debugLabel) {
			console.log(
				`[GroupChat:Debug] SSH remote used for ${debugLabel}: ${sshWrapped.sshRemoteUsed.name}`
			);
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - skipped for SSH
	const winConfig = getWindowsSpawnConfig(agentId, sshRemoteConfig ?? undefined);
	if (winConfig.shell && debugLabel) {
		console.log(`[GroupChat:Debug] Windows shell config for ${debugLabel}: ${winConfig.shell}`);
	}

	// Start the clock at the single choke point every turn shape goes through
	// (moderator, participant, synthesis, recovery), so a new spawn site is
	// measured without having to remember to opt in.
	beginGroupChatTurn(sessionId);

	const spawnResult = processManager.spawn({
		sessionId,
		toolType: agentId,
		cwd: spawnCwd,
		command: spawnCommand,
		args: spawnArgs,
		readOnlyMode,
		prompt: spawnPrompt,
		contextWindow: getContextWindowValue(agent, agentConfigValues ?? {}),
		customEnvVars: spawnEnvVars,
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: winConfig.shell,
		runInShell: winConfig.runInShell,
		sendPromptViaStdin: winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		sshStdinScript: spawnSshStdinScript,
		sshRemoteCommand: spawnSshRemoteCommand,
	});

	return spawnResult;
}
