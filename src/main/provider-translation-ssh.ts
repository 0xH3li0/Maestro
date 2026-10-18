import * as path from 'node:path';
import { canonicalJson } from '../shared/canonicalJson';
import { expandTilde } from '../shared/pathUtils';
import { stripBlankEnvVars } from '../shared/agentEnvironment';
import { resolveAgentAccountKey } from '../shared/providerProfiles';
import { providerOverridesFor } from '../shared/maestro-lib/agents/providerSwap';
import { applyAgentConfigOverrides } from '../shared/maestro-lib/launch/agent-args';
import { resolveAgentEnvVars } from '../shared/maestro-lib/launch/env';
import { findCodexSessionFile } from '../shared/maestro-lib/codex/session-files';
import {
	discoverClaudeMemoryRoot,
	resolveMemoryRepositoryRoot,
} from '../shared/maestro-lib/translation/memory';
import { translationHash } from '../shared/maestro-lib/translation/identity';
import type {
	TranslationNativeHost,
	TranslationServiceHost,
	TranslationServiceSession,
} from '../shared/maestro-lib/translation/service';
import type { TranslationIdentity } from '../shared/maestro-lib/translation/types';
import { createSshTranslationFs } from './provider-translation-fs';
import { execFileNoThrow } from './utils/execFile';
import { execGitReadOnly, execShellRemote } from './utils/remote-git';
import { resolveSshLaunchTarget, type SshRemoteSettingsStore } from './utils/ssh-remote-resolver';
import { sshUnresolvedRemoteMessage, wrapSpawnWithSsh } from './utils/ssh-spawn-wrapper';

/** Resolve before probing anything. Never borrow a local provider binary, home or filesystem. */
export async function resolveSshTranslationHost(
	session: TranslationServiceSession,
	store: SshRemoteSettingsStore,
	providers: Pick<TranslationServiceHost, 'getProvider' | 'providerConfig' | 'globalEnv'>
): Promise<TranslationNativeHost | undefined> {
	const sshConfig = session.sessionSshRemoteConfig?.enabled
		? session.sessionSshRemoteConfig
		: session.sshRemoteId
			? { enabled: true, remoteId: session.sshRemoteId }
			: undefined;
	const target = resolveSshLaunchTarget(store, sshConfig);
	if (target.kind === 'local') return undefined;
	if (target.kind === 'unresolved') throw new Error(sshUnresolvedRemoteMessage(sshConfig!));
	const remote = target.remote;
	const nativeFs = createSshTranslationFs(remote);
	const execGit: TranslationServiceHost['execGit'] = (args, cwd) =>
		execGitReadOnly(args, '', remote, cwd);
	return {
		nativeFs,
		execGit,
		findCodexSessionFile: (id, root) => findCodexSessionFile(id, root, nativeFs),
		assertCanApply: () => {
			// The next playbook tasks supply these transaction transports. Keep this
			// boundary explicit so enabling remote planning cannot launch local Codex.
			throw new Error(
				'SSH translation apply requires the remote Codex import channel and remote managed knowledge location.'
			);
		},
		resolveIdentity: async (agent, provider, source, checkpoint) => {
			const detected = await providers.getProvider(provider);
			const providerConfig = providers.providerConfig(provider);
			const overrides = providerOverridesFor({ ...agent, aiTabs: undefined }, provider);
			const env = stripBlankEnvVars({
				...providers.globalEnv(),
				...resolveAgentEnvVars({
					defaultEnvVars: detected?.defaultEnvVars,
					agentCustomEnvVars: providerConfig.customEnvVars,
					sessionCustomEnvVars: source ? overrides.customEnvVars : undefined,
				}),
			});
			// Read only the account identity fields, never dump the remote environment.
			const probe = await execShellRemote(
				`command -v base64 >/dev/null 2>&1 || { printf '%s' 'SSH translation requires base64' >&2; exit 127; }; ` +
					`if ! command -v realpath >/dev/null 2>&1 && ! readlink -f / >/dev/null 2>&1; then ` +
					`printf '%s' 'SSH translation requires realpath or readlink -f' >&2; exit 127; fi; ` +
					`printf '%s\\0' "$HOME" "\${CLAUDE_CONFIG_DIR-}" "\${CODEX_HOME-}"`,
				remote,
				{ env, timeoutMs: 30_000 }
			);
			if (probe.exitCode !== 0)
				throw new Error(probe.stderr || 'Cannot probe SSH translation prerequisites');
			const values = probe.stdout.split('\0');
			const [home, claudeRoot, codexRoot] = values;
			if (values.length !== 4 || values[3] !== '' || !path.posix.isAbsolute(home))
				throw new Error('SSH translation requires an absolute remote HOME');
			const cwd = expandTilde(sshConfig?.workingDirOverride || agent.cwd, home);
			if (!path.posix.isAbsolute(cwd))
				throw new Error('SSH translation requires an absolute remote working directory');
			const projectRoot = await nativeFs.realpath(
				expandTilde(sshConfig?.workingDirOverride || agent.projectRoot || agent.cwd, home)
			);
			const selectedRoot =
				!source || provider !== agent.toolType
					? checkpoint?.providerRoots[provider]?.accountRoot
					: undefined;
			const account =
				selectedRoot ??
				resolveAgentAccountKey(
					provider,
					stripBlankEnvVars({ CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexRoot }),
					home
				);
			if (!account) throw new Error(`Cannot resolve remote ${provider} account`);
			let accountRoot = path.posix.resolve(cwd, expandTilde(account, home));
			try {
				// GNU realpath accepts a missing final component; stat preserves the port contract.
				await nativeFs.stat(accountRoot);
				accountRoot = await nativeFs.realpath(accountRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			const customPath = source ? overrides.customPath : undefined;
			const binary = customPath || providerConfig.customPath || detected?.binaryName;
			if (!binary) throw new Error(`SSH translation requires the ${provider} binary`);
			const { args } = applyAgentConfigOverrides(undefined, ['--version'], {
				agentConfigValues: { customArgs: providerConfig.customArgs },
				sessionCustomArgs: source ? overrides.customArgs : undefined,
			});
			const wrapped = await wrapSpawnWithSsh(
				{
					command: expandTilde(binary, home),
					agentBinaryName: expandTilde(binary, home),
					args,
					cwd,
					customEnvVars: env,
				},
				sshConfig,
				{ getSshRemotes: () => [remote] }
			);
			if (!wrapped.sshRemoteUsed) throw new Error(sshUnresolvedRemoteMessage(sshConfig!));
			const versionProbe = await execFileNoThrow(wrapped.command, wrapped.args, wrapped.cwd, {
				timeout: 30_000,
			});
			if (versionProbe.exitCode !== 0)
				throw new Error(
					`SSH translation requires a working ${binary} binary (--version failed): ${versionProbe.stderr}`
				);
			const version = /\d+\.\d+\.\d+/.exec(versionProbe.stdout)?.[0] ?? '';
			const common = await execGit(['rev-parse', '--git-common-dir'], projectRoot);
			if (common.exitCode !== 0 && !/not a git repository/i.test(common.stderr))
				throw new Error(`Cannot resolve remote git common directory: ${common.stderr}`);
			const commonDirectory =
				common.exitCode === 0
					? await nativeFs.realpath(path.posix.resolve(projectRoot, common.stdout.trim()))
					: undefined;
			const memoryProjectRoot = await resolveMemoryRepositoryRoot(
				projectRoot,
				async () => commonDirectory,
				path.posix
			);
			const userResourceRoots: NonNullable<TranslationIdentity['userResourceRoots']> = [
				{ path: path.posix.join(home, '.agents', 'skills'), kind: 'skill' },
			];
			if (provider === 'claude-code') {
				const memory = await discoverClaudeMemoryRoot(
					projectRoot,
					accountRoot,
					memoryProjectRoot,
					nativeFs,
					home
				);
				if (memory.source === 'account')
					userResourceRoots.push({ path: memory.path, kind: 'memory' });
			}
			return {
				provider,
				version,
				accountRoot,
				projectRoot,
				memoryProjectRoot,
				userResourceRoots,
				remoteHome: home,
				remoteHost: translationHash(canonicalJson(remote)),
			};
		},
	};
}
