// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/update-agent.test.ts
//   - src/__tests__/cli/commands/create-agent.test.ts
//   - src/__tests__/cli/commands/session.test.ts

import { createAgent } from '../../../cli/commands/create-agent';
import { sessionList, sessionShow } from '../../../cli/commands/session';
import { updateAgent } from '../../../cli/commands/update-agent';
import { formatError, formatSuccess } from '../../../cli/output/formatter';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { getSessionById, resolveAgentId, resolveGroupId } from '../../../cli/services/storage';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	resolveGroupId: vi.fn(),
	getSessionById: vi.fn(),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// ===== from src/__tests__/cli/commands/update-agent.test.ts =====

describe('update-agent command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('errors when no mutable field is provided', async () => {
		await updateAgent('agent-1', {});

		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('Specify at least one field to update')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends move_session_to_group when --group is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp' });

		expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
		expect(resolveGroupId).toHaveBeenCalledWith('grp');
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'move_session_to_group',
				sessionId: 'full-session-id',
				groupId: 'full-group-id',
			}),
			'move_session_to_group_result'
		);
		expect(formatSuccess).toHaveBeenCalledWith('Updated agent full-session-id');
	});

	it('treats --group none as ungroup (null) without calling resolveGroupId', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'none' });

		expect(resolveGroupId).not.toHaveBeenCalled();
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'move_session_to_group', groupId: null }),
			'move_session_to_group_result'
		);
	});

	it('sends update_session_cwd with absolute resolved path', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_cwd_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/some/path' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_cwd',
				sessionId: 'full-session-id',
				newCwd: path.resolve('/tmp/some/path'),
			}),
			'update_session_cwd_result'
		);
	});

	it('sends update_session_ssh enabling a remote with --ssh-remote and --ssh-cwd', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'remote-7', sshCwd: '/srv/app' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sessionId: 'full-session-id',
				sshPatch: { enabled: true, remoteId: 'remote-7', workingDirOverride: '/srv/app' },
			}),
			'update_session_ssh_result'
		);
	});

	it('treats --ssh-remote none as reverting to local (enabled:false, remoteId:null)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'none' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { enabled: false, remoteId: null },
			}),
			'update_session_ssh_result'
		);
	});

	it('maps --sync-history-to-remote to a syncHistory-only patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { syncHistory: true },
			}),
			'update_session_ssh_result'
		);
	});

	it('sends update_session_config for editable settings (nudge, model, env)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', {
			nudge: 'stay focused',
			model: 'opus',
			env: ['FOO=bar', 'BAZ=qux'],
		});

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				sessionId: 'full-session-id',
				configPatch: {
					nudgeMessage: 'stay focused',
					customModel: 'opus',
					customEnvVars: { FOO: 'bar', BAZ: 'qux' },
				},
			}),
			'update_session_config_result'
		);
	});

	it('maps an empty-string text field to a null clear in the config patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { nudge: '' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { nudgeMessage: null },
			}),
			'update_session_config_result'
		);
	});

	it('encodes --token-source tui as the enableMaestroP/maestroPMode pair', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'tui' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { enableMaestroP: true, maestroPMode: 'interactive' },
			}),
			'update_session_config_result'
		);
	});

	it('sends bookmarked in the config patch for --bookmark', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { bookmarked: true },
			}),
			'update_session_config_result'
		);
	});

	it('sends bookmarked:false for --bookmark false rather than dropping the key', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'no' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ configPatch: { bookmarked: false } }),
			'update_session_config_result'
		);
	});

	it('rejects a non-boolean --bookmark value before contacting the app', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { bookmark: 'maybe' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--bookmark expects'));
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects an invalid --token-source value before contacting the app', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'bogus' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--token-source expects'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects --token-source on a non-Claude agent', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'codex',
		} as never);
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { tokenSource: 'tui' });

		// The guard fires before any send (in production process.exit terminates;
		// the test's exit mock is a no-op, so we assert the guard itself fired).
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('only applies to Claude Code agents')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('refuses --provider without --force', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--force to confirm'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends a toolType patch for --provider with --force', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex', force: true });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				sessionId: 'full-session-id',
				configPatch: { toolType: 'codex' },
			}),
			'update_session_config_result'
		);
	});

	it('rejects a non-boolean --sync-history-to-remote value', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand: vi.fn() } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'maybe' });

		expect(formatError).toHaveBeenCalledWith(
			'--sync-history-to-remote expects true or false, got "maybe"'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('fans out to both messages when --group and --cwd are both provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo' });

		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(sendCommand.mock.calls[0][0].type).toBe('move_session_to_group');
		expect(sendCommand.mock.calls[1][0].type).toBe('update_session_cwd');
	});

	it('surfaces the renderer error when cwd update is refused (agent running)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_cwd_result',
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/foo' });

		expect(formatError).toHaveBeenCalledWith(
			'Agent process is running; stop it before changing cwd'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('emits JSON on success when --json is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({
			success: true,
			agentId: 'full-session-id',
			group: 'full-group-id',
			cwd: path.resolve('/tmp/foo'),
		});
	});

	it('errors when agent ID cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: xyz');
		});

		await updateAgent('xyz', { group: 'grp' });

		expect(formatError).toHaveBeenCalledWith('Agent not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('errors when --json is set and command fails', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection lost'));

		await updateAgent('agent-1', { cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({ success: false, error: 'Connection lost' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

// ===== from src/__tests__/cli/commands/create-agent.test.ts =====

describe('create-agent command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('successful creation', () => {
		it('should create an agent with required options', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'new-id-123',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('My Agent', { cwd: '/tmp/project', type: 'claude-code' });

			expect(formatSuccess).toHaveBeenCalledWith('Created agent "My Agent" (claude-code)');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('new-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('does not record provenance when --context-window is not passed', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Agent', { cwd: '/tmp', type: 'codex', model: 'gpt-4' });

			// No window, so nothing to describe. A provenance marker with no value
			// would outrank the provider's report on whatever gets set later.
			expect(sentPayload.customContextWindow).toBeUndefined();
			expect(sentPayload.contextWindowSource).toBeUndefined();
		});

		it('should send config fields when provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'codex',
				model: 'gpt-4',
				effort: 'high',
				nudge: 'Be concise',
				newSessionMessage: 'Init context for every session',
				customPath: '/usr/local/bin/codex',
				customArgs: '--verbose',
				contextWindow: '128000',
				providerPath: '/custom/path',
				env: ['FOO=bar', 'BAZ=qux'],
			});

			expect(sentPayload.customModel).toBe('gpt-4');
			expect(sentPayload.customEffort).toBe('high');
			expect(sentPayload.nudgeMessage).toBe('Be concise');
			expect(sentPayload.newSessionMessage).toBe('Init context for every session');
			expect(sentPayload.customPath).toBe('/usr/local/bin/codex');
			expect(sentPayload.customArgs).toBe('--verbose');
			expect(sentPayload.customContextWindow).toBe(128000);
			// Typing the flag is a deliberate choice, so it must carry provenance or
			// the provider's reported window silently overrides it and the user has
			// to re-apply the same number with `update-agent` (finding AD1, review
			// of PR #1362). `update-agent` already did this; `create-agent` did not.
			expect(sentPayload.contextWindowSource).toBe('user-edited');
			expect(sentPayload.customProviderPath).toBe('/custom/path');
			expect(sentPayload.customEnvVars).toEqual({ FOO: 'bar', BAZ: 'qux' });
		});

		describe('placement', () => {
			function capture() {
				const sent: Record<string, unknown> = {};
				vi.mocked(withMaestroClient).mockImplementation(async (action) => {
					const mockClient = {
						sendCommand: vi.fn().mockImplementation((payload) => {
							Object.assign(sent, payload);
							return Promise.resolve({
								type: 'create_session_result',
								success: true,
								sessionId: 'id-1',
							});
						}),
					};
					return action(mockClient as never);
				});
				return sent;
			}

			it('selects the new agent by default, exactly as it always has', async () => {
				const sent = capture();
				await createAgent('Agent', { cwd: '/tmp', type: 'claude-code' });
				expect(sent.background).toBe(false);
			});

			it('leaves the Left Bar selection alone with --background', async () => {
				const sent = capture();
				await createAgent('Agent', { cwd: '/tmp', type: 'claude-code', background: true });
				expect(sent.background).toBe(true);
				// The agent still exists and is still addressable - "created but
				// invisible" would be a different bug, so the id is still reported.
				expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('in the background'));
				expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('id-1'));
			});

			it('reports the placement in JSON output', async () => {
				capture();
				await createAgent('Agent', {
					cwd: '/tmp',
					type: 'claude-code',
					background: true,
					json: true,
				});
				const printed = JSON.parse(vi.mocked(consoleSpy).mock.calls.at(-1)![0] as string);
				expect(printed).toMatchObject({ success: true, agentId: 'id-1', background: true });
			});

			it('lets --focus win over --background', async () => {
				const sent = capture();
				await createAgent('Agent', {
					cwd: '/tmp',
					type: 'claude-code',
					background: true,
					focus: true,
				});
				expect(sent.background).toBe(false);
			});
		});

		it('should send SSH config when ssh-remote is provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Remote Agent', {
				cwd: '/tmp',
				type: 'claude-code',
				sshRemote: 'remote-id-123',
				sshCwd: '/remote/path',
			});

			expect(sentPayload.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-id-123',
				workingDirOverride: '/remote/path',
			});
		});

		it('should output JSON when --json flag is set', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'json-id',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('JSON Agent', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.agentId).toBe('json-id');
			expect(parsed.name).toBe('JSON Agent');
		});
	});

	describe('validation errors', () => {
		it('should reject invalid agent type', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid agent type'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid agent type in JSON mode', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Invalid agent type');
		});

		it('should reject invalid context window', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', contextWindow: 'abc' });

			expect(formatError).toHaveBeenCalledWith('--context-window must be a positive integer');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid env format', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', env: ['NOEQUALS'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid --env format'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('error handling', () => {
		it('should handle server returning failure', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: false,
						error: 'Duplicate name',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Dupe', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('Duplicate name');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('App not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});

// ===== from src/__tests__/cli/commands/session.test.ts =====

describe('session list command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends list_desktop_sessions and emits JSON with the desktop-supplied entries', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: 'Refactor parser',
					agentSessionId: 'claude-uuid-1',
					state: 'idle',
					createdAt: 1714268000000,
					starred: false,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({ json: true });

		expect(mockSendCommand).toHaveBeenCalledWith(
			{ type: 'list_desktop_sessions' },
			'desktop_sessions_list'
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.sessions).toHaveLength(1);
		expect(output.sessions[0].tabId).toBe('tab-1');
		expect(output.sessions[0].agentId).toBe('agent-a');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('returns an empty array when the desktop reports no open tabs', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.sessions).toEqual([]);
	});

	it('renders a human-readable table when --json is omitted', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-1',
					sessionId: 'tab-1',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: null,
					agentSessionId: null,
					state: 'busy',
					createdAt: 1714268000000,
					starred: true,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({});

		// Default text mode includes state, star, tabId, agent name+id, and a
		// relative createdAt column. Asserting each surface independently catches
		// regressions where any column is dropped without freezing exact spacing.
		const line = consoleSpy.mock.calls[0][0] as string;
		expect(line).toContain('tab-1');
		expect(line).toContain('Backend');
		expect(line).toContain('busy');
		expect(line).toContain('★');
		// createdAt rendered via formatRelativeTime - the exact phrase depends on
		// `now`, but the column is non-empty for any finite epoch.
		expect(line.split('  ').filter(Boolean).length).toBeGreaterThanOrEqual(4);
	});

	it('preserves an unknown desktop state in human-readable output', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'desktop_sessions_list',
			success: true,
			sessions: [
				{
					tabId: 'tab-unknown',
					sessionId: 'tab-unknown',
					agentId: 'agent-a',
					agentName: 'Backend',
					toolType: 'claude-code',
					name: null,
					agentSessionId: null,
					state: 'unknown',
					createdAt: 1714268000000,
					starred: false,
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionList({});

		expect(consoleSpy.mock.calls[0][0]).toContain('unknown');
	});

	it('maps connection errors to MAESTRO_NOT_RUNNING (consistent with dispatch)', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it.each([
		['Maestro desktop app is not running'],
		['Maestro discovery file is stale (app may have crashed)'],
		['Not connected to Maestro'],
	])('maps MaestroClient error "%s" to MAESTRO_NOT_RUNNING', async (errorMessage) => {
		// Same three pre-WebSocket throws covered by dispatch.test - keeping the
		// mapping in sync means external scripts can branch on a single error
		// code regardless of which CLI verb they used.
		vi.mocked(withMaestroClient).mockRejectedValue(new Error(errorMessage));

		await sessionList({ json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

describe('session show command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends get_session_history with the tab id and prints JSON when --json is set', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user',
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
				{
					id: 'log-2',
					role: 'assistant',
					source: 'ai',
					content: 'Hi there',
					timestamp: '2026-04-28T10:00:01.000Z',
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { json: true });

		expect(mockSendCommand).toHaveBeenCalledWith(
			{ type: 'get_session_history', tabId: 'tab-1' },
			'session_history_result'
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.tabId).toBe('tab-1');
		expect(output.messages).toHaveLength(2);
		expect(output.messages[0].role).toBe('user');
		expect(output.messages[1].role).toBe('assistant');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('renders a formatted transcript by default (no --json flag)', async () => {
		// Default text mode prints a header line followed by one block per
		// message. ISO timestamps are emitted verbatim so callers can feed them
		// back into `--since` without re-parsing.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: 'claude-uuid-1',
			messages: [
				{
					id: 'log-1',
					role: 'user',
					source: 'user',
					content: 'Hello',
					timestamp: '2026-04-28T10:00:00.000Z',
				},
				{
					id: 'log-2',
					role: 'assistant',
					source: 'ai',
					content: 'Hi there',
					timestamp: '2026-04-28T10:00:01.000Z',
				},
			],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', {});

		const lines = consoleSpy.mock.calls.map((c) => c[0] as string);
		const joined = lines.join('\n');
		// Header
		expect(joined).toContain('Tab: tab-1');
		expect(joined).toContain('Agent: agent-a');
		expect(joined).toContain('Session: claude-uuid-1');
		expect(joined).toContain('Messages: 2');
		// Per-message blocks with verbatim ISO timestamps + roles + content
		expect(joined).toContain('[2026-04-28T10:00:00.000Z] user');
		expect(joined).toContain('Hello');
		expect(joined).toContain('[2026-04-28T10:00:01.000Z] assistant');
		expect(joined).toContain('Hi there');
		// Should not be a single JSON blob
		expect(() => JSON.parse(lines[0])).toThrow();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('prints a friendly placeholder when the conversation is empty (text mode)', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', {});

		const joined = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
		expect(joined).toContain('Messages: 0');
		expect(joined).toContain('(no messages)');
	});

	it('forwards --since as ms epoch when given an ISO timestamp', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '2026-04-28T10:00:00.000Z' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'get_session_history',
				tabId: 'tab-1',
				sinceMs: Date.parse('2026-04-28T10:00:00.000Z'),
			}),
			'session_history_result'
		);
	});

	it('treats a numeric --since below 1e12 as seconds (matches Date.now()/1000 cursors)', async () => {
		// Heuristic protection: a Discord bot pickling a `Math.floor(Date.now() /
		// 1000)` cursor would otherwise filter the entire transcript out (every
		// log timestamp is ms, so the seconds value would be ~1000x too small
		// and pass the > comparison trivially). Auto-scaling matches both
		// cursor styles without requiring explicit unit flags.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '1714268000' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ sinceMs: 1714268000 * 1000 }),
			'session_history_result'
		);
	});

	it('treats a numeric --since at or above 1e12 as ms', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { since: '1714268000000' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ sinceMs: 1714268000000 }),
			'session_history_result'
		);
	});

	it('rejects an unparseable --since with INVALID_OPTION', async () => {
		await sessionShow('tab-1', { since: 'not-a-date' });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_OPTION');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('forwards --tail as an integer to the desktop', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { tail: '5' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 5 }),
			'session_history_result'
		);
	});

	it('rejects a negative --tail with INVALID_OPTION', async () => {
		await sessionShow('tab-1', { tail: '-1' });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_OPTION');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it.each([['5abc'], ['1.9'], ['5e2'], ['  '], ['']])(
		'rejects partially-numeric --tail %p with INVALID_OPTION (no silent truncation)',
		async (raw) => {
			// `Number.parseInt('5abc', 10) === 5` and `parseInt('1.9', 10) === 1`
			// silently accept these as valid tails - the strict regex precheck
			// is the only thing keeping a typo from quietly capping history at
			// the wrong number.
			await sessionShow('tab-1', { tail: raw });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTION');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		}
	);

	it('forwards --tail 0 as numeric 0 (handler enforces empty-history semantics)', async () => {
		// `--tail 0` is a legitimate ask ("give me nothing yet, just confirm
		// the tab exists"). The CLI must propagate the literal zero - the
		// desktop side has its own slice-bug guard for the historical
		// `slice(-0)` foot-gun. Asserting the wire value here keeps the two
		// halves of the contract pinned down independently.
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: true,
			tabId: 'tab-1',
			sessionId: 'tab-1',
			agentId: 'agent-a',
			agentSessionId: null,
			messages: [],
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-1', { tail: '0' });

		expect(mockSendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'get_session_history', tabId: 'tab-1', tail: 0 }),
			'session_history_result'
		);
	});

	it('surfaces TAB_NOT_FOUND from the desktop response', async () => {
		const mockSendCommand = vi.fn().mockResolvedValue({
			type: 'session_history_result',
			success: false,
			error: 'Tab not found: tab-bogus',
			code: 'TAB_NOT_FOUND',
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = { sendCommand: mockSendCommand };
			return action(mockClient as never);
		});

		await sessionShow('tab-bogus', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('TAB_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('maps connection errors to MAESTRO_NOT_RUNNING', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

		await sessionShow('tab-1', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('MAESTRO_NOT_RUNNING');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
