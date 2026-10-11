/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep applyClaudeSpawnDecision + buildRemoteInteractiveSpawn REAL (they own the
// actual `--max-wait` arg injection, which is what we want to assert lands in
// the spawn). Only stub resolveClaudeSpawnMode so it deterministically resolves
// to the local interactive (maestro-p) path without needing a real binary or a
// usage snapshot.
const mockResolve = vi.fn();
vi.mock('../../../main/agents/resolveClaudeSpawnMode', async () => {
	const actual = await vi.importActual<
		typeof import('../../../main/agents/resolveClaudeSpawnMode')
	>('../../../main/agents/resolveClaudeSpawnMode');
	return {
		...actual,
		resolveClaudeSpawnMode: (...args: unknown[]) => mockResolve(...args),
	};
});

// SSH: stub the wrapper so we can hand back either a resolved remote or the
// silent local-fallback shape it produces when the remote can't be found.
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', async () => {
	const actual = await vi.importActual<
		typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
	>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
	return {
		...actual,
		wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	};
});
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../main/utils/ssh-remote-resolver', () => ({
	getSshRemoteConfig: vi.fn(() => ({ config: null, source: 'session' })),
}));

// The agent's Local Models gateway: stubbed so these tests say what the helper
// does with the answer, not how the answer is reached (service.test.ts).
const mockApplyGateway = vi.fn();
vi.mock('../../../main/local-models/proxy/service', () => ({
	applyAgentGatewayToSpawn: (...args: unknown[]) => mockApplyGateway(...args),
}));

import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';

function makeAgent(): AgentConfig {
	return {
		id: 'claude-code',
		command: 'claude',
		interactiveCommand: 'claude',
		interactiveModeArgs: ['--dangerously-skip-permissions'],
	} as unknown as AgentConfig;
}

describe('spawnGroupChatAgent', () => {
	let processManager: IProcessManager;
	let spawnSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		spawnSpy = vi.fn().mockReturnValue({ pid: 4242, success: true });
		processManager = {
			spawn: spawnSpy,
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		} as unknown as IProcessManager;
	});

	it('forwards maxWaitSeconds as --max-wait on the interactive maestro-p spawn', async () => {
		// Decision: local interactive, with a resolved maestro-p script path.
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			maxWaitSeconds: 600,
			processManager,
			debugLabel: 'participant: Test',
		});

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		// process.execPath drives the maestro-p script under ELECTRON_RUN_AS_NODE.
		expect(spawned.command).toBe(process.execPath);
		// --max-wait must land after the script but before the batch args/prompt.
		const i = spawned.args.indexOf('--max-wait');
		expect(i).toBeGreaterThan(-1);
		expect(spawned.args[i + 1]).toBe('600');
		expect(spawned.args.indexOf('--max-wait')).toBeLessThan(spawned.args.indexOf('--'));
	});

	it('omits --max-wait when maxWaitSeconds is not provided', async () => {
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-2',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
		expect(spawned.args).not.toContain('--max-wait');
	});

	it('does not inject --max-wait on the API path (no maestro-p)', async () => {
		mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });

		await spawnGroupChatAgent({
			sessionId: 'sess-3',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'api',
			maxWaitSeconds: 600,
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		expect(spawned.command).toBe('/usr/local/bin/claude');
		expect(spawned.args).not.toContain('--max-wait');
	});

	describe('SSH remote resolution', () => {
		const sshRemoteConfig = { enabled: true, remoteId: 'jennifer-box' };
		const sshStore = {} as never;

		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });
		});

		it('fails loudly instead of silently spawning locally when the remote cannot be resolved', async () => {
			// The shape wrapSpawnWithSsh returns on its local-fallback path: the
			// original command, unchanged, with no remote recorded.
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				customEnvVars: undefined,
				sshRemoteUsed: null,
			});

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-ssh-1',
					agentId: 'claude-code',
					agent: makeAgent(),
					command: '/usr/local/bin/claude',
					args: ['--print', '--', 'hello'],
					cwd: '/remote/only/path',
					prompt: 'hello',
					sshRemoteConfig,
					sshStore,
					processManager,
				})
			).rejects.toThrow(/jennifer-box/);

			// The whole point: nothing ran on this machine.
			expect(spawnSpy).not.toHaveBeenCalled();
		});

		it('spawns normally when the remote resolves', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host', 'claude --print'],
				cwd: '/Users/local/home',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'jennifer-box', name: 'Jennifer', host: 'host' },
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-ssh-2',
				agentId: 'claude-code',
				agent: makeAgent(),
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				sshRemoteConfig,
				sshStore,
				processManager,
			});

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const spawned = spawnSpy.mock.calls[0][0] as { command: string };
			expect(spawned.command).toBe('ssh');
		});
	});
	describe("the agent's Local Models gateway", () => {
		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
		});

		it("is not looked up for a process that is nobody's agent", async () => {
			await spawnGroupChatAgent({
				sessionId: 'sess-mod',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				processManager,
				debugLabel: 'moderator',
			});

			expect(mockApplyGateway).not.toHaveBeenCalled();
			expect(spawnSpy).toHaveBeenCalledTimes(1);
		});

		it('spawns with the arguments and env the gateway gives back', async () => {
			mockApplyGateway.mockResolvedValue({
				ok: true,
				args: ['-c', 'openai_base_url="https://gw.example.com"', 'exec'],
				customEnvVars: { FOO: '1', OPENAI_BASE_URL: 'https://gw.example.com' },
				gateway: { envVar: 'OPENAI_BASE_URL', url: 'https://gw.example.com' },
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-p',
				agentId: 'codex',
				agent: { id: 'codex', command: 'codex' } as unknown as AgentConfig,
				args: ['exec'],
				cwd: '/tmp/work',
				customEnvVars: { FOO: '1' },
				maestroAgentId: 'agent-7',
				processManager,
			});

			expect(mockApplyGateway).toHaveBeenCalledWith({
				agentId: 'agent-7',
				toolType: 'codex',
				args: ['exec'],
				customEnvVars: { FOO: '1' },
				remote: null,
			});
			const spawned = spawnSpy.mock.calls[0][0] as {
				args: string[];
				customEnvVars: Record<string, string>;
			};
			expect(spawned.args).toEqual(['-c', 'openai_base_url="https://gw.example.com"', 'exec']);
			expect(spawned.customEnvVars).toEqual({
				FOO: '1',
				OPENAI_BASE_URL: 'https://gw.example.com',
			});
		});

		it('refuses the turn rather than connect direct when the gateway cannot be used', async () => {
			mockApplyGateway.mockResolvedValue({ ok: false, error: 'The turn was not sent.' });

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-p',
					agentId: 'claude-code',
					agent: makeAgent(),
					args: ['--print'],
					cwd: '/tmp/work',
					maestroAgentId: 'agent-7',
					processManager,
				})
			).rejects.toThrow('The turn was not sent.');
			expect(spawnSpy).not.toHaveBeenCalled();
		});
	});
});
