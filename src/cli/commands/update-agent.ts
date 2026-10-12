// Update agent command - mutate fields on an existing agent in the Maestro
// desktop app (group assignment, working directory, and SSH execution config).
//
// `--group <id>` reuses the existing `move_session_to_group` WS message; pass
// `--group none` (or `--group ""`) to ungroup. `--cwd <path>` resolves to an
// absolute path and routes through the `update_session_cwd` WS message.
//
// `--ssh-remote`, `--ssh-cwd`, and `--sync-history-to-remote` build a partial
// patch sent via the `update_session_ssh` WS message, which merges the patch
// onto the agent's existing `sessionSshRemoteConfig` and flushes it to disk.
// Use `--ssh-remote none` to revert the agent to local execution. All of these
// (like `--cwd`) are refused by the renderer while the agent process is alive.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { toClaudeTokenModeSource, type ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { AGENT_IDS } from '../../shared/agentIds';
import { CODEX_TRANSPORTS, isCodexTransport } from '../../shared/codexTransport';
import { parseCliBool } from '../utils/parse';
import { parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import { asTokenProxyMode, TOKEN_PROXY_MODES } from '../../shared/local-models/token-proxy';
import {
	formatRunOnSpec,
	RUN_ON_PROVIDER_SPEC,
	runOnGatewayEditProblem,
	type RunOnSourceTarget,
} from '../../shared/local-models/run-on';
import { readRunOnFlags } from '../services/run-on';
import {
	formatBackgroundRequestsSpec,
	parseBackgroundRequestsEdit,
	parseBackgroundRequestsSpec,
	type BackgroundRequests,
} from '../../shared/local-models/background-requests';
import {
	formatTierTargetSpec,
	parseTierAssignment,
	parseTierTargetsEdit,
	TIER_LEVELS,
	type TierTarget,
} from '../../shared/modelTiers';
import { readHarnessTierDefaults, readLocalModelEndpoints } from '../services/storage';
import { AUTO_MODEL, isAutoModel } from '../../shared/autoModel';
import { autoModelProblem } from '../../shared/autoTurn';
import { SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS } from '../../shared/local-models/system-one-agent';

// Provider types a user can switch an agent to. Mirrors create-agent's set
// (the internal `terminal` type is not user-selectable).
const VALID_PROVIDER_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

interface UpdateAgentOptions {
	group?: string;
	cwd?: string;
	sshRemote?: string;
	sshCwd?: string;
	syncHistoryToRemote?: string;
	provider?: string;
	force?: boolean;
	// Editable per-session config (the Edit Agent modal fields, plus the Left Bar
	// bookmark). Empty-string values clear the field; see buildConfigPatch.
	nudge?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	env?: string[];
	clearEnv?: boolean;
	gatewayUrl?: string;
	proxyMode?: string;
	runOn?: string;
	runOnContext?: string;
	tier?: string[];
	backgroundRequests?: string;
	systemOne?: string;
	model?: string;
	effort?: string;
	contextWindow?: string;
	tokenSource?: string;
	maestroPPath?: string;
	codexTransport?: string;
	bookmark?: string;
	json?: boolean;
}

function emitError(message: string, options: UpdateAgentOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

// Parse repeatable `--env KEY=VALUE` flags into a map. The provided set REPLACES
// the agent's customEnvVars (matching create-agent semantics); use --clear-env to
// empty it. Throws on a malformed entry.
function parseEnvVars(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new Error(`Invalid --env "${entry}". Use KEY=VALUE (e.g. FOO=bar).`);
		}
		out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
	}
	return out;
}

// Build the per-session config patch from the editable flags. Only keys the
// caller touched are included. A `null` value clears the field on the renderer
// side; for string fields an empty value (e.g. `--nudge ""`) maps to null.
// `--bookmark` rides along here because it goes through the same allowlisted
// `update_session_config` message, even though it is UI state rather than a
// spawn-time setting.
function buildConfigPatch(options: UpdateAgentOptions): Record<string, unknown> | undefined {
	const patch: Record<string, unknown> = {};
	const strField = (value: string | undefined, key: string) => {
		if (value === undefined) return;
		patch[key] = value.trim() === '' ? null : value;
	};

	strField(options.nudge, 'nudgeMessage');
	strField(options.newSessionMessage, 'newSessionMessage');
	strField(options.customPath, 'customPath');
	strField(options.customArgs, 'customArgs');
	strField(options.model, 'customModel');
	strField(options.effort, 'customEffort');
	strField(options.maestroPPath, 'maestroPPath');

	if (options.bookmark !== undefined) {
		patch.bookmarked = parseCliBool(options.bookmark, '--bookmark');
	}

	if (options.clearEnv) {
		patch.customEnvVars = {};
	} else if (options.env && options.env.length > 0) {
		patch.customEnvVars = parseEnvVars(options.env);
	}

	// `--gateway-url <url|none>`. Only the clear is decided here; a URL is
	// validated against the agent's provider once the agent has been read (see
	// updateAgent), because which providers can use a gateway is per provider.
	if (options.gatewayUrl !== undefined) {
		const raw = options.gatewayUrl.trim();
		patch.gatewayUrl = raw === '' || raw.toLowerCase() === 'none' ? null : raw;
	}

	// `--proxy-mode <off|passthrough|compress|compress-early>`: how the Maestro token proxy
	// carries this agent's requests. The app points the agent's gateway at the
	// proxy (or clears it for `off`), so the two flags cannot be combined.
	if (options.proxyMode !== undefined) {
		const mode = asTokenProxyMode(options.proxyMode.trim().toLowerCase());
		if (!mode) {
			throw new Error(
				`--proxy-mode expects ${TOKEN_PROXY_MODES.join(', ')}, got "${options.proxyMode}"`
			);
		}
		if (options.gatewayUrl !== undefined) {
			throw new Error(
				'Use --proxy-mode or --gateway-url, not both: the proxy mode chooses the gateway URL.'
			);
		}
		patch.tokenProxyMode = mode;
	}

	// `--tier <tier>=<target>` (repeatable): a patch with one entry per tier
	// named, `null` for `default`. Only the spelling is read here; each target
	// is checked against the agent's provider and the saved sources once the
	// agent has been read (see updateAgent), and the app merges the patch onto
	// the tiers the agent already holds.
	if (options.tier && options.tier.length > 0) {
		const tiers: Record<string, TierTarget | null> = {};
		for (const entry of options.tier) {
			const assignment = parseTierAssignment(entry);
			if (!assignment.ok) throw new Error(`--tier: ${assignment.error}`);
			if (assignment.tier in tiers) {
				throw new Error(`--tier: the "${assignment.tier}" tier is set more than once.`);
			}
			tiers[assignment.tier] = assignment.target ?? null;
		}
		patch.tierTargets = tiers;
	}

	// `--background-requests <source id>:<model>|none`: where the token proxy
	// sends this agent's side requests. `none` turns it off (`null` on the
	// wire). Checked against the agent once it has been read.
	if (options.backgroundRequests !== undefined) {
		const parsed = parseBackgroundRequestsSpec(options.backgroundRequests);
		if (!parsed.ok) throw new Error(`--background-requests: ${parsed.error}`);
		patch.backgroundRequests = parsed.backgroundRequests ?? null;
	}

	// `--system-one <on|off>`: the Models tab's System One switch. On is the
	// absence of the opt-out (`null` on the wire), so the agent follows "Let
	// agents use System One"; off stores the opt-out for this agent only.
	if (options.systemOne !== undefined) {
		const word = options.systemOne.trim().toLowerCase();
		if (word !== 'on' && word !== 'off') {
			throw new Error(`--system-one expects on or off, got "${options.systemOne}"`);
		}
		patch.systemOneOptOut = word === 'off' ? true : null;
	}

	if (options.contextWindow !== undefined) {
		const raw = options.contextWindow.trim().toLowerCase();
		if (raw === '' || raw === 'none' || raw === '0') {
			patch.customContextWindow = null;
			// Clearing the value clears its provenance with it.
			patch.contextWindowSource = null;
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n) || n < 0) {
				throw new Error(
					`--context-window expects a positive number, got "${options.contextWindow}"`
				);
			}
			patch.customContextWindow = Math.floor(n);
			// Typing `--context-window` is unambiguously a deliberate choice, so it
			// outranks a provider-reported window (finding AD1). No seed to compare
			// against here, unlike the edit modal.
			patch.contextWindowSource = 'user-edited';
		}
	}

	if (options.tokenSource !== undefined) {
		const mode = options.tokenSource.trim().toLowerCase();
		if (mode !== 'api' && mode !== 'tui' && mode !== 'dynamic') {
			throw new Error(`--token-source expects api, tui, or dynamic, got "${options.tokenSource}"`);
		}
		// Map the friendly tri-state to the stored (enableMaestroP, maestroPMode)
		// pair so every spawn surface reads it consistently. tui -> interactive.
		const canonical: ClaudeTokenMode = mode === 'tui' ? 'interactive' : mode;
		const encoded = toClaudeTokenModeSource(canonical);
		patch.enableMaestroP = encoded.enableMaestroP;
		patch.maestroPMode = encoded.maestroPMode;
	}

	if (options.codexTransport !== undefined) {
		const transport = options.codexTransport.trim().toLowerCase();
		if (!isCodexTransport(transport)) {
			throw new Error(
				`--codex-transport expects ${CODEX_TRANSPORTS.join(' or ')}, got "${options.codexTransport}"`
			);
		}
		// Only the opt-in is stored; `exec` clears the field, matching the Edit
		// Agent modal, where Standard leaves `codexTransport` unset.
		patch.codexTransport = transport === 'app-server' ? transport : null;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	const sshFlagsPresent =
		options.sshRemote !== undefined ||
		options.sshCwd !== undefined ||
		options.syncHistoryToRemote !== undefined;

	// Build the editable config patch up front so a malformed flag fails before
	// we touch the running app.
	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	// `--run-on` / `--run-on-context` are read once the agent is: the target is
	// checked against the agent's provider and builds on the target it has.
	const runOnFlagsPresent = options.runOn !== undefined || options.runOnContext !== undefined;

	if (
		options.group === undefined &&
		options.cwd === undefined &&
		!sshFlagsPresent &&
		configPatch === undefined &&
		!runOnFlagsPresent &&
		options.provider === undefined
	) {
		emitError(
			'Specify at least one field to update (e.g. --group, --cwd, --ssh-remote, --nudge, --model, --token-source, --codex-transport, --bookmark, --provider, --env, --gateway-url, --proxy-mode, --run-on, --tier, --background-requests, --system-one). Run "maestro-cli update-agent --help" for the full list.',
			options
		);
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	// Read the resolved agent so provider- and token-source-specific rules can
	// see its current toolType.
	const session = getSessionById(sessionId);
	const currentToolType = session?.toolType;

	// Guard: --token-source only carries meaning for Claude Code. Writing the
	// maestro-p fields on another provider would be inert and misleading, so
	// reject loudly rather than silently no-op.
	if (
		options.tokenSource !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'claude-code'
	) {
		emitError(
			`--token-source only applies to Claude Code agents; "${sessionId}" is a ${currentToolType} agent.`,
			options
		);
	}

	// Guard: --codex-transport only carries meaning for Codex, for the same reason.
	if (
		options.codexTransport !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'codex'
	) {
		emitError(
			`--codex-transport only applies to Codex agents; "${sessionId}" is a ${currentToolType} agent.`,
			options
		);
	}

	// Guard: a gateway is refused for a provider that cannot use one and for a
	// value that is not a URL, with the same function the desktop field uses, so
	// the CLI cannot store what the launch would then refuse. The stored form is
	// the normalized one. When the agent's record cannot be read here, the app
	// runs the same check before it writes.
	if (typeof configPatch?.gatewayUrl === 'string' && currentToolType !== undefined) {
		const edit = parseGatewayUrlEdit(currentToolType, configPatch.gatewayUrl);
		if (!edit.ok) {
			emitError(`--gateway-url: ${edit.error}`, options);
		}
		configPatch.gatewayUrl = edit.gatewayUrl;
	}

	// `--run-on provider|<source id>:<model>` and `--run-on-context <n>`: the
	// Models tab's Run on picker and its context field. Read into the target the
	// picker would store, with the provider and the saved sources checked, so the
	// CLI cannot store a target every launch would refuse. `provider` clears it
	// (`null` on the wire). The app runs the same check before it writes.
	if (runOnFlagsPresent) {
		if (!session) {
			emitError(`Agent "${sessionId}" could not be read from the agent store.`, options);
		}
		const runOnEdit = readRunOnFlags(options, session);
		if (runOnEdit.kind === 'refused') emitError(runOnEdit.error, options);
		if (runOnEdit.kind === 'set') {
			configPatch = { ...configPatch, runOn: runOnEdit.target ?? null };
		}
	}

	// A gateway is not applied to an agent on a source, and the dialog disables
	// both gateway controls for one. Refused here (and by the app) so the caller
	// is not told a gateway was set that no launch will use. Clearing is allowed.
	if (configPatch !== undefined) {
		const gatewayProblem = runOnGatewayEditProblem(
			'runOn' in configPatch ? configPatch.runOn : session?.runOn,
			configPatch
		);
		if (gatewayProblem) {
			emitError(
				`${configPatch.tokenProxyMode !== undefined ? '--proxy-mode' : '--gateway-url'}: ${gatewayProblem}`,
				options
			);
		}
	}

	// `--tier`: each target is checked with the function the Edit Agent dialog
	// saves with, against this agent's provider and the saved sources, so the CLI
	// cannot store a tier every launch on it would refuse. The patch is sent as
	// typed; the app runs the same check against the tiers it holds.
	let tierTargetsAfter = session?.tierTargets;
	if (configPatch?.tierTargets !== undefined && currentToolType !== undefined) {
		const edit = parseTierTargetsEdit(currentToolType, configPatch.tierTargets, {
			base: session?.tierTargets,
			endpoints: readLocalModelEndpoints(),
		});
		if (!edit.ok) emitError(`--tier ${edit.error}`, options);
		tierTargetsAfter = edit.tierTargets;
	}

	// `--model auto`: the Auto choice of the Provider tab's model picker. It is
	// stored as the word, and only for an agent Auto can act on, judged against
	// the tiers and the Run on target this same call leaves it with. The picker
	// does not offer an Auto that would change nothing; the CLI refuses it by
	// name. The app runs the same check before it writes.
	if (configPatch !== undefined && isAutoModel(configPatch.customModel)) {
		if (currentToolType !== undefined) {
			const problem = autoModelProblem(
				{
					toolType: currentToolType,
					tierTargets: tierTargetsAfter,
					runOn: 'runOn' in configPatch ? configPatch.runOn : session?.runOn,
				},
				readHarnessTierDefaults()
			);
			if (problem) emitError(`--model auto: ${problem}`, options);
		}
		configPatch.customModel = AUTO_MODEL;
	}

	// `--background-requests`: the provider, the saved sources and the route the
	// source serves are checked here. Whether the agent is on the token proxy
	// needs the proxy's port, which the app checks before it writes.
	if (
		configPatch?.backgroundRequests !== undefined &&
		configPatch.backgroundRequests !== null &&
		currentToolType !== undefined
	) {
		const edit = parseBackgroundRequestsEdit(
			currentToolType,
			configPatch.backgroundRequests,
			readLocalModelEndpoints()
		);
		if (!edit.ok) emitError(`--background-requests: ${edit.error}`, options);
		if (configPatch.tokenProxyMode === 'off' || configPatch.gatewayUrl !== undefined) {
			emitError(
				'--background-requests: background requests are routed by the token proxy, so a target cannot be set in the call that turns the proxy off or sets another gateway.',
				options
			);
		}
	}

	// Provider switch is destructive (resets tabs, clears provider config, kills
	// the running process), so it is gated and handled exclusively from the
	// settings patch.
	let providerType: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested)) {
			emitError(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options
			);
		}
		if (currentToolType !== undefined && requested === currentToolType) {
			emitError(`Agent "${sessionId}" is already a ${requested} agent.`, options);
		}
		if (!options.force) {
			emitError(
				'Switching provider resets the agent tabs, clears provider-specific config, and kills the running process. Re-run with --force to confirm.',
				options
			);
		}
		// A provider switch wipes provider-specific config anyway, so refuse to
		// combine it with those edits in the same call to avoid confusing order.
		if (configPatch !== undefined) {
			emitError(
				'--provider cannot be combined with other settings edits (it resets provider config). Run it on its own, then adjust settings.',
				options
			);
		}
		providerType = requested;
	}

	// Build the SSH patch from the SSH-related flags. Only keys the caller
	// touched are included so the renderer merges rather than clobbers.
	let sshPatch: Record<string, unknown> | undefined;
	if (sshFlagsPresent) {
		sshPatch = {};
		if (options.sshRemote !== undefined) {
			const raw = options.sshRemote.trim();
			if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
				// Revert to local execution; preserve other fields via the merge.
				sshPatch.enabled = false;
				sshPatch.remoteId = null;
			} else {
				sshPatch.enabled = true;
				sshPatch.remoteId = raw;
			}
		}
		if (options.sshCwd !== undefined) {
			sshPatch.workingDirOverride = options.sshCwd;
		}
		if (options.syncHistoryToRemote !== undefined) {
			try {
				sshPatch.syncHistory = parseCliBool(
					options.syncHistoryToRemote,
					'--sync-history-to-remote'
				);
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	let resolvedGroupId: string | null | undefined;
	if (options.group !== undefined) {
		const raw = options.group.trim();
		if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
			resolvedGroupId = null;
		} else {
			try {
				resolvedGroupId = resolveGroupId(raw);
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	const resolvedCwd = options.cwd !== undefined ? path.resolve(options.cwd) : undefined;

	const applied: {
		group?: string | null;
		cwd?: string;
		ssh?: Record<string, unknown>;
		config?: Record<string, unknown>;
		provider?: string;
	} = {};

	try {
		await withMaestroClient(async (client) => {
			if (resolvedGroupId !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'move_session_to_group',
						sessionId,
						groupId: resolvedGroupId,
					},
					'move_session_to_group_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to move agent to group');
				}
				applied.group = resolvedGroupId;
			}

			if (resolvedCwd !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_cwd',
						sessionId,
						newCwd: resolvedCwd,
					},
					'update_session_cwd_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent cwd');
				}
				applied.cwd = resolvedCwd;
			}

			if (sshPatch !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_ssh',
						sessionId,
						sshPatch,
					},
					'update_session_ssh_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent SSH config');
				}
				applied.ssh = sshPatch;
			}

			if (configPatch !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_config',
						sessionId,
						configPatch,
					},
					'update_session_config_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent config');
				}
				applied.config = configPatch;
			}

			// Provider switch routes through the same message but with a `toolType`
			// key, which the renderer special-cases (reset tabs, clear config, kill
			// process). Sent exclusively (guarded above), so it never mixes with a
			// settings patch in the same call.
			if (providerType !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_config',
						sessionId,
						configPatch: { toolType: providerType },
					},
					'update_session_config_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to switch agent provider');
				}
				applied.provider = providerType;
			}
		});
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: sessionId,
				...applied,
			})
		);
		return;
	}

	console.log(formatSuccess(`Updated agent ${sessionId}`));
	if (applied.provider !== undefined) {
		console.log(`  Provider: ${applied.provider} (tabs reset, provider config cleared)`);
	}
	if (applied.group !== undefined) {
		console.log(`  Group: ${applied.group ?? '(ungrouped)'}`);
	}
	if (applied.cwd !== undefined) {
		console.log(`  CWD: ${applied.cwd}`);
	}
	if (applied.ssh !== undefined) {
		if ('enabled' in applied.ssh) {
			console.log(
				`  SSH: ${applied.ssh.enabled ? `enabled (remote ${applied.ssh.remoteId})` : 'disabled (local)'}`
			);
		}
		if ('workingDirOverride' in applied.ssh) {
			console.log(`  SSH cwd: ${applied.ssh.workingDirOverride}`);
		}
		if ('syncHistory' in applied.ssh) {
			console.log(`  Sync history to remote: ${applied.ssh.syncHistory}`);
		}
	}
	if (applied.config !== undefined) {
		// Friendly labels for the editable config keys; `null` means "cleared".
		const labels: Record<string, string> = {
			nudgeMessage: 'Nudge message',
			newSessionMessage: 'New session message',
			customPath: 'Binary path',
			customArgs: 'Custom args',
			customEnvVars: 'Env vars',
			gatewayUrl: 'Gateway URL',
			tokenProxyMode: 'Token proxy mode',
			runOn: 'Run on',
			tierTargets: 'Tiers',
			backgroundRequests: 'Background requests',
			systemOneOptOut: 'System One',
			customModel: 'Model',
			customEffort: 'Effort',
			customContextWindow: 'Context window',
			enableMaestroP: 'Claude token source',
			maestroPMode: 'Token mode',
			maestroPPath: 'maestro-p path',
			codexTransport: 'Codex transport',
		};
		for (const [key, value] of Object.entries(applied.config)) {
			// Derived marker, not something the caller typed - it is implied by
			// `--context-window` and printing it just adds noise (finding AD1).
			if (key === 'contextWindowSource') continue;
			const label = labels[key] ?? key;
			// A cleared transport is not "unset", it is the default transport.
			if (key === 'codexTransport') {
				console.log(`  ${label}: ${value ?? 'exec'}`);
			} else if (key === 'runOn') {
				// A cleared target is not "unset", it is the provider's own model.
				const target = value as RunOnSourceTarget | null;
				console.log(
					`  ${label}: ${
						target
							? `${formatRunOnSpec(target)} (context ${target.contextTokens} tokens)`
							: RUN_ON_PROVIDER_SPEC
					}`
				);
			} else if (key === 'tierTargets') {
				// One line per tier named, in the spelling `--tier` takes.
				const tiers = value as Record<string, TierTarget | null>;
				for (const tier of TIER_LEVELS) {
					if (tier in tiers) console.log(`  Tier ${tier}: ${formatTierTargetSpec(tiers[tier])}`);
				}
			} else if (key === 'backgroundRequests') {
				// Off is not "unset", it is every request going to the provider.
				console.log(
					`  ${label}: ${formatBackgroundRequestsSpec(value as BackgroundRequests | null)}`
				);
			} else if (key === 'systemOneOptOut') {
				// On is not "cleared", it is the agent following the switch for all agents.
				const stored = value === true ? 'off' : 'on';
				console.log(`  ${label}: ${stored}. ${SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS[stored]}`);
			} else if (value === null) {
				console.log(`  ${label}: (cleared)`);
			} else if (key === 'customEnvVars' && value && typeof value === 'object') {
				const pairs = Object.keys(value as Record<string, string>);
				console.log(`  ${label}: ${pairs.length === 0 ? '(cleared)' : pairs.join(', ')}`);
			} else {
				console.log(`  ${label}: ${value}`);
			}
		}
	}
}
