/**
 * Main-process builder for the Maestro system prompt.
 *
 * The desktop tab spawn builds its system prompt in the renderer
 * (`prepareMaestroSystemPrompt`), and the CLI builds its own
 * (`prepareMaestroSystemPromptCli`). Spawns that start in the main process (Cue
 * runs, Group Chat participants, cross-agent consults) had none, so those agents
 * knew nothing about Maestro. This resolves the same inputs from the persisted
 * stores and hands them to the shared assembler, so all three agree.
 *
 * Never throws: a prompt that cannot be loaded is logged and the spawn goes
 * ahead without it, the same stance `process:spawn` takes.
 */

import { app } from 'electron';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { computerHistoryDir } from '../../shared/computer-history/paths';
import type { SystemOneAgentAccess } from '../../shared/local-models/system-one-agent';
import {
	assembleMaestroSystemPrompt,
	coreSystemPromptContext,
	coreSystemPromptSectionsFor,
	systemPromptSectionsFor,
	type CoreSystemPromptInput,
} from '../../shared/maestroSystemPrompt';
import type { TemplateContext } from '../../shared/templateVariables';
import type { StoredSession } from '../stores/types';
import { getPrompt } from '../prompt-manager';
import { getSessionsStore, getSettingsStore } from '../stores/getters';
import { getHistoryManager } from '../history-manager';
import { getSystemOneAgentAccess } from '../local-models/system-one/agent-service';
import { getMaestroRunService } from '../maestro-run';
import { resolveBundledCliPathSync } from '../maestro-cli-manager';
import { execFileNoThrow } from './execFile';
import { logger } from './logger';

const LOG_CONTEXT = '[MaestroSystemPrompt]';

export interface BuildMaestroSystemPromptOptions {
	/** The AI tab the spawn belongs to ({{TAB_ID}}). Headless spawns leave it empty. */
	activeTabId?: string;
}

/** A core prompt by id, or undefined (logged) when it is missing or prompts are not loaded. */
function loadPrompt(id: string): string | undefined {
	try {
		return getPrompt(id);
	} catch (err) {
		logger.warn(`System prompt section "${id}" unavailable; skipping`, LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

function readSettings(): { encoreFeatures: unknown; conductorProfile: string | undefined } {
	try {
		const store = getSettingsStore() as unknown as { get: (key: string) => unknown };
		const conductorProfile = store.get('conductorProfile');
		return {
			encoreFeatures: store.get('encoreFeatures'),
			conductorProfile:
				typeof conductorProfile === 'string' && conductorProfile ? conductorProfile : undefined,
		};
	} catch (err) {
		logger.warn('Settings unavailable while building system prompt', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
		return { encoreFeatures: undefined, conductorProfile: undefined };
	}
}

/** `<userData>/computer-history`, or undefined when Electron cannot say (tests, early boot). */
function localComputerHistoryDir(): string | undefined {
	try {
		return computerHistoryDir(app.getPath('userData'));
	} catch {
		return undefined;
	}
}

/**
 * The CLI the app actually ships or built, for `{{MAESTRO_CLI_PATH}}`. Without
 * it the shared resolver falls back to the default install location, which is
 * wrong in a development build and in any install elsewhere, so a Cue run or
 * Group Chat turn was told to run a `maestro-cli.js` that is not there.
 */
function resolvedCliPath(): string | undefined {
	try {
		return resolveBundledCliPathSync() ?? undefined;
	} catch {
		return undefined;
	}
}

function isSshRecord(record: StoredSession): boolean {
	return !!record.sessionSshRemoteConfig?.enabled || !!record.sshRemoteId;
}

function findStoredSession(sessionId: string): StoredSession | undefined {
	try {
		const sessions = getSessionsStore().get('sessions', []) as StoredSession[];
		return sessions.find((s) => s.id === sessionId);
	} catch (err) {
		logger.warn('Sessions store unavailable while building system prompt', LOG_CONTEXT, {
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

async function localGitBranch(cwd: string): Promise<string | undefined> {
	try {
		const result = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		const branch = result.exitCode === 0 ? result.stdout.trim() : '';
		return branch || undefined;
	} catch {
		return undefined;
	}
}

async function localHistoryFilePath(sessionId: string): Promise<string | undefined> {
	try {
		return (await getHistoryManager().getHistoryFilePath(sessionId)) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The MaestroRun launcher while it is installed, verified, and granted on this
 * Mac, else undefined. Never throws: a failed check reads as "not ready", which
 * leaves the section out rather than advertising a tool that may not work.
 */
async function localMaestroRunPath(): Promise<string | undefined> {
	try {
		return await getMaestroRunService()?.readyBinaryPath();
	} catch (err) {
		logger.warn('MaestroRun readiness check failed; leaving its section out', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

/**
 * Whether a System One request from this agent would be answered right now, or
 * undefined when that cannot be read. Never throws: no answer leaves the
 * section out rather than advertising a tool that may refuse. Reads the
 * settings and the day's count; sends nothing to an engine.
 *
 * Exported for the one other builder that runs in this process: the CLI's
 * (`prepareMaestroSystemPromptCli`), which the plugin headless runner calls.
 */
export async function localSystemOneAccess(
	agentId: string
): Promise<SystemOneAgentAccess | undefined> {
	try {
		return await getSystemOneAgentAccess(agentId);
	} catch (err) {
		logger.warn('System One access check failed; leaving its section out', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

/** Load the core section texts that apply to this agent (blank or missing ones dropped). */
function loadCoreSections(core: CoreSystemPromptInput): string[] {
	return coreSystemPromptSectionsFor(core)
		.map((ref) => loadPrompt(ref.promptId))
		.filter((text): text is string => !!text && !!text.trim());
}

/** Load the plugin section texts that apply right now (blank or missing ones dropped). */
function loadPluginSections(
	encoreFeatures: unknown,
	isSsh: boolean,
	maestroRunPath: string | undefined
): string[] {
	return systemPromptSectionsFor(encoreFeatures, {
		isSsh,
		readyFlags: maestroRunPath ? ['maestroRun'] : [],
	})
		.map((ref) => loadPrompt(ref.promptId))
		.filter((text): text is string => !!text && !!text.trim());
}

/**
 * The full Maestro system prompt for one persisted agent: the base template
 * with that agent's identity, git branch (local only), history file (local
 * only), conductor profile, the Pianola role section when it is the Pianola
 * agent, the core sections that are ready for it (System One, local agents
 * only), and every enabled plugin section (`localOnly` ones skipped over SSH).
 *
 * Accepts the session id or the already-loaded stored record. Returns undefined
 * when the agent is unknown or the base template cannot be loaded.
 */
export async function buildMaestroSystemPromptForSession(
	sessionOrId: string | StoredSession,
	opts: BuildMaestroSystemPromptOptions = {}
): Promise<string | undefined> {
	const record = typeof sessionOrId === 'string' ? findStoredSession(sessionOrId) : sessionOrId;
	if (!record) {
		logger.warn('Agent not found; spawning without the Maestro system prompt', LOG_CONTEXT, {
			sessionId: sessionOrId,
		});
		return undefined;
	}

	const template = loadPrompt(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT);
	if (!template) return undefined;

	const isSsh = isSshRecord(record);
	const cwd: string = record.cwd || record.projectRoot || record.fullPath || '';
	const { encoreFeatures, conductorProfile } = readSettings();

	// Branch and history file are read from this machine, so an SSH agent gets
	// neither: the values would describe the wrong host.
	const gitBranch = !isSsh && record.isGitRepo && cwd ? await localGitBranch(cwd) : undefined;
	const historyFilePath = isSsh ? undefined : await localHistoryFilePath(record.id);
	// The launcher is on this Mac, so an SSH agent is never told about it.
	const maestroRunPath = isSsh ? undefined : await localMaestroRunPath();
	// `maestro-cli s1` reaches this desktop, so an SSH agent is never asked about.
	const core: CoreSystemPromptInput = {
		isSsh,
		systemOne: isSsh ? undefined : await localSystemOneAccess(record.id),
	};

	const context: TemplateContext = {
		session: {
			id: record.id,
			name: record.name,
			toolType: record.toolType,
			cwd,
			projectRoot: record.projectRoot,
			fullPath: record.fullPath,
			autoRunFolderPath: record.autoRunFolderPath,
			isGitRepo: record.isGitRepo,
			additionalDirectories: record.additionalDirectories,
			worktreeConfig: record.worktreeConfig,
		},
		gitBranch,
		groupId: record.groupId,
		activeTabId: opts.activeTabId,
		historyFilePath,
		conductorProfile,
		computerHistoryDir: isSsh ? undefined : localComputerHistoryDir(),
		maestroRunPath,
		maestroCliPath: resolvedCliPath(),
		...coreSystemPromptContext(core),
	};

	const roleSections = record.isPianola ? [loadPrompt(PROMPT_IDS.PIANOLA_SYSTEM)] : [];

	return assembleMaestroSystemPrompt({
		template,
		context,
		roleSections,
		coreSections: loadCoreSections(core),
		pluginSections: loadPluginSections(encoreFeatures, isSsh, maestroRunPath),
	});
}

/**
 * Just the enabled plugin sections, joined, for a spawn with no Maestro agent
 * behind it (the Group Chat moderator and its synthesis turn). Substituted with
 * a minimal context: agent-specific variables render empty. Returns undefined
 * when no section applies, so the caller passes nothing at all.
 *
 * Core sections are not included. System One is told to an agent: its requests
 * are counted, capped and switched off per agent, and a spawn with no agent
 * behind it has none of the three.
 */
export function buildPluginSystemPromptSections(opts: { isSsh: boolean }): string | undefined {
	const { encoreFeatures, conductorProfile } = readSettings();
	// Synchronous by contract, so this reads the last inspection as it stands.
	const maestroRunPath = opts.isSsh ? undefined : getMaestroRunService()?.readyBinaryPathCached();
	const sections = loadPluginSections(encoreFeatures, opts.isSsh, maestroRunPath);
	if (sections.length === 0) return undefined;
	const [first, ...rest] = sections;
	return assembleMaestroSystemPrompt({
		template: first,
		context: {
			session: { id: '', name: '', toolType: '', cwd: '' },
			conductorProfile,
			computerHistoryDir: opts.isSsh ? undefined : localComputerHistoryDir(),
			maestroRunPath,
			maestroCliPath: resolvedCliPath(),
		},
		pluginSections: rest,
	});
}
