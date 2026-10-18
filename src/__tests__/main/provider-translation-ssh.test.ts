// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../helpers/mockSession';
import { remapTranslationFs } from '../helpers/translationFs';
import { createSshTranslationFs } from '../../main/provider-translation-fs';
import { resolveSshTranslationHost } from '../../main/provider-translation-ssh';
import { execGitReadOnly, execShellRemote } from '../../main/utils/remote-git';
import { execFileNoThrow } from '../../main/utils/execFile';
import { wrapSpawnWithSsh } from '../../main/utils/ssh-spawn-wrapper';
import { collectTranslationResources } from '../../shared/maestro-lib/translation/resources';
import type { TranslationServiceHost } from '../../shared/maestro-lib/translation/service';
import type { SshRemoteConfig } from '../../shared/types';

vi.mock('../../main/provider-translation-fs', () => ({ createSshTranslationFs: vi.fn() }));
vi.mock('../../main/utils/remote-git', () => ({
	execGitReadOnly: vi.fn(),
	execShellRemote: vi.fn(),
}));
vi.mock('../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../main/utils/ssh-spawn-wrapper', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../main/utils/ssh-spawn-wrapper')>()),
	wrapSpawnWithSsh: vi.fn(),
}));

describe('remote translation identity', () => {
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'example.invalid',
		port: 22,
		username: 'tester',
		privateKeyPath: '',
		enabled: true,
	};
	const store = { getSshRemotes: () => [remote] };
	const session = createMockSession({
		id: 'ssh-agent',
		toolType: 'claude-code',
		cwd: '/remote/worktree',
		projectRoot: '/remote/worktree',
		sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		customPath: '~/bin/custom claude',
		customArgs: '--setting "with spaces"',
		customEnvVars: { CLAUDE_CONFIG_DIR: '~/account', USER_OVERRIDE: 'yes' },
	});
	let root: string;
	let port: ReturnType<typeof remapTranslationFs>;
	const providers: Pick<TranslationServiceHost, 'getProvider' | 'providerConfig' | 'globalEnv'> = {
		getProvider: vi.fn(async (provider) => ({
			path: '/local/never-run',
			binaryName: provider === 'codex' ? 'codex' : 'claude',
			defaultEnvVars: { DEFAULT_FLAG: '1' },
		})),
		providerConfig: () => ({
			customEnvVars: { PROVIDER_ONLY: 'yes' },
			customArgs: '--provider-flag',
		}),
		globalEnv: () => ({ GLOBAL_FLAG: 'yes' }),
	};
	beforeEach(async () => {
		vi.clearAllMocks();
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-ssh-identity-'));
		port = remapTranslationFs('/remote', root);
		port.nativeFs.paths = path.posix;
		for (const directory of [
			'worktree/.claude',
			'account',
			'repo/.git',
			'home',
			'codex',
			'home/memory',
		])
			await fs.mkdir(path.join(root, directory), { recursive: true });
		port.nativeFs.realpath.mockImplementation(async (file) => {
			await fs.stat(port.backingPath(file));
			return file;
		});
		vi.mocked(createSshTranslationFs).mockReturnValue(port.nativeFs);
		vi.mocked(execShellRemote).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/home\0/remote/account\0/remote/codex\0',
			stderr: '',
		});
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: 'claude 2.1.296',
			stderr: '',
		});
		vi.mocked(execGitReadOnly).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/repo/.git\n',
			stderr: '',
		});
		vi.mocked(wrapSpawnWithSsh).mockResolvedValue({
			command: 'ssh',
			args: ['remote', 'probe'],
			cwd: '/local/home',
			sshRemoteUsed: remote,
		});
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('uses remote account, worktree git identity, memory and custom invocation without local env inheritance', async () => {
		await fs.writeFile(
			path.join(root, 'account/settings.json'),
			JSON.stringify({ autoMemoryDirectory: '~/memory' })
		);
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'claude-code', true);
		expect(identity).toMatchObject({
			accountRoot: '/remote/account',
			projectRoot: '/remote/worktree',
			memoryProjectRoot: '/remote/repo',
			remoteHome: '/remote/home',
		});
		expect(identity.userResourceRoots).toContainEqual({
			path: '/remote/home/memory',
			kind: 'memory',
		});
		expect(identity.remoteHost).toMatch(/^[0-9a-f]{64}$/);
		expect(execGitReadOnly).toHaveBeenCalledWith(
			['rev-parse', '--git-common-dir'],
			'',
			remote,
			'/remote/worktree'
		);
		expect(wrapSpawnWithSsh).toHaveBeenCalledWith(
			expect.objectContaining({
				command: '/remote/home/bin/custom claude',
				agentBinaryName: '/remote/home/bin/custom claude',
				args: ['--version', '--setting', 'with spaces'],
				customEnvVars: {
					GLOBAL_FLAG: 'yes',
					DEFAULT_FLAG: '1',
					CLAUDE_CONFIG_DIR: '~/account',
					USER_OVERRIDE: 'yes',
				},
			}),
			session.sessionSshRemoteConfig,
			expect.anything()
		);
		expect(execFileNoThrow).toHaveBeenCalledWith('ssh', ['remote', 'probe'], '/local/home', {
			timeout: 30_000,
		});
	});

	it('uses remote HOME for unset accounts and project memory tilde overrides', async () => {
		vi.mocked(execShellRemote).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/home\0\0\0',
			stderr: '',
		});
		await fs.writeFile(
			path.join(root, 'worktree/.claude/settings.json'),
			JSON.stringify({ autoMemoryDirectory: '~/memory' })
		);
		await fs.writeFile(path.join(root, 'home/memory/fact.md'), 'Remote fact');
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'claude-code', true);
		expect(identity.accountRoot).toBe('/remote/home/.claude');
		const resources = await collectTranslationResources(
			identity,
			{ projectKnowledge: true, selectedUserResources: [] },
			undefined,
			port.nativeFs
		);
		expect(
			resources.artifacts
				.find((artifact) => artifact.relativePath === 'memory/fact.md')
				?.sourcePath.replaceAll('\\', '/')
		).toBe('/remote/home/memory/fact.md');
	});

	it('uses the destination binary name and account instead of source overrides', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: 'codex 0.162.1',
			stderr: '',
		});
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'codex', false);
		expect(identity.accountRoot).toBe('/remote/codex');
		expect(wrapSpawnWithSsh).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'codex',
				args: ['--version', '--provider-flag'],
				customEnvVars: { GLOBAL_FLAG: 'yes', DEFAULT_FLAG: '1', PROVIDER_ONLY: 'yes' },
			}),
			expect.anything(),
			expect.anything()
		);
		expect(() => host.assertCanApply!()).toThrow('remote Codex import channel');
	});

	it('finds Codex rollouts through the selected native port and propagates failed discovery', async () => {
		const directory = path.join(root, 'codex/sessions/2026/10/17');
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, 'rollout.jsonl'),
			JSON.stringify({ payload: { id: 'native-id' } }) + '\n'
		);
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		expect(await host.findCodexSessionFile('native-id', '/remote/codex')).toBe(
			'/remote/codex/sessions/2026/10/17/rollout.jsonl'
		);
		port.nativeFs.readdir.mockRejectedValueOnce(new Error('SSH connection lost'));
		await expect(host.findCodexSessionFile('native-id', '/remote/codex')).rejects.toThrow(
			'SSH connection lost'
		);
	});

	it('resolves the pre-spawn SSH setting and the stored SSH identity, and leaves local agents local', async () => {
		expect(
			await resolveSshTranslationHost(
				{ ...session, sessionSshRemoteConfig: undefined, sshRemoteId: remote.id },
				store,
				providers
			)
		).toBeDefined();
		expect(
			await resolveSshTranslationHost(
				{ ...session, sessionSshRemoteConfig: undefined, sshRemoteId: undefined },
				store,
				providers
			)
		).toBeUndefined();
	});

	it.each(['base64', 'realpath or readlink -f'])(
		'names a missing remote prerequisite: %s',
		async (piece) => {
			vi.mocked(execShellRemote).mockResolvedValue({
				exitCode: 127,
				stdout: '',
				stderr: `SSH translation requires ${piece}`,
			});
			const host = (await resolveSshTranslationHost(session, store, providers))!;
			await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(piece);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(port.nativeFs.realpath).not.toHaveBeenCalled();
		}
	);

	it('names a missing provider binary and rejects a wrapper that falls back locally', async () => {
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		vi.mocked(execFileNoThrow).mockResolvedValueOnce({
			exitCode: 127,
			stdout: '',
			stderr: 'command not found',
		});
		await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(
			'working codex binary'
		);
		vi.mocked(execFileNoThrow).mockClear();
		vi.mocked(wrapSpawnWithSsh).mockResolvedValueOnce({
			command: '/local/never-run',
			args: [],
			cwd: '/remote',
			sshRemoteUsed: null,
		});
		await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(
			'could not be resolved'
		);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it.each([{ remotes: [] }, { remotes: [{ ...remote, enabled: false }] }])(
		'rejects unresolved targets before probing providers or files',
		async ({ remotes }) => {
			await expect(
				resolveSshTranslationHost(session, { getSshRemotes: () => remotes }, providers)
			).rejects.toThrow('could not be resolved');
			expect(providers.getProvider).not.toHaveBeenCalled();
			expect(createSshTranslationFs).not.toHaveBeenCalled();
			expect(execShellRemote).not.toHaveBeenCalled();
		}
	);
});
