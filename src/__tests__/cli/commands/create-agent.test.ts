/**
 * @file create-agent.test.ts
 * @description Tests for the create-agent CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// The saved sources `--run-on` is checked against. Mocked so the real settings
// file is never read.
vi.mock('../../../cli/services/storage', () => ({
	readLocalModelEndpoints: vi.fn(() => [
		{
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		},
	]),
	// The harness tier defaults `--model auto` is judged against.
	readHarnessTierDefaults: vi.fn(() => ({})),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createAgent } from '../../../cli/commands/create-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readHarnessTierDefaults } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

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

		it('refuses a --gateway-url that is not a URL, by name', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', gatewayUrl: 'not a url' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringMatching(/^--gateway-url: .*not a URL/)
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses a --gateway-url for a provider that cannot use one', async () => {
			await createAgent('Bad', {
				cwd: '/tmp',
				type: 'copilot-cli',
				gatewayUrl: 'http://127.0.0.1:8787',
				json: true,
			});

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Copilot CLI ignores base-URL variables');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('--gateway-url', () => {
		let sentPayload: Record<string, unknown>;

		beforeEach(() => {
			sentPayload = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'gw-1',
						});
					}),
				};
				return action(mockClient as never);
			});
		});

		it('sends the normalized gateway, as the New Agent Models tab stores it', async () => {
			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'claude-code',
				gatewayUrl: ' http://127.0.0.1:8787/ ',
			});

			expect(sentPayload.gatewayUrl).toBe('http://127.0.0.1:8787');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('sends no gateway for "none"', async () => {
			await createAgent('Agent', { cwd: '/tmp', type: 'codex', gatewayUrl: 'none' });

			expect(sentPayload).not.toHaveProperty('gatewayUrl');
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});

	describe('--run-on', () => {
		let sentPayload: Record<string, unknown>;
		const QWEN = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

		beforeEach(() => {
			sentPayload = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'ro-1',
						});
					}),
				};
				return action(mockClient as never);
			});
		});

		it('sends the target the New Agent picker would store, at its default context', async () => {
			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'claude-code',
				runOn: 'ep-ollama:qwen3:latest',
			});

			expect(sentPayload.runOn).toEqual({ ...QWEN, contextTokens: 40_960 });
			expect(consoleSpy).toHaveBeenCalledWith(
				'  Run on: ep-ollama:qwen3:latest (context 40960 tokens)'
			);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('sends the context it is given, and reports the target in JSON', async () => {
			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'codex',
				runOn: 'ep-ollama:qwen3:latest',
				runOnContext: '131072',
				json: true,
			});

			const target = { ...QWEN, contextTokens: 131_072 };
			expect(sentPayload.runOn).toEqual(target);
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				runOn: target,
			});
		});

		it.each([[{ runOn: 'provider' }], [{}]])(
			'sends no target for the provider (%j): it is the absence of one',
			async (flags) => {
				await createAgent('Agent', { cwd: '/tmp', type: 'claude-code', ...flags, json: true });

				expect(sentPayload).not.toHaveProperty('runOn');
				expect(JSON.parse(consoleSpy.mock.calls[0][0])).not.toHaveProperty('runOn');
				expect(processExitSpy).not.toHaveBeenCalled();
			}
		);

		it.each([
			['a spelling that is not a target', { runOn: 'qwen3' }, '--run-on:'],
			['a source id that names nothing', { runOn: 'ep-typo:qwen3' }, 'No source has the id'],
			[
				'a context under the agent minimum',
				{ runOn: 'ep-ollama:qwen3', runOnContext: '8192' },
				'at least 40960 tokens',
			],
			['a context with no target', { runOnContext: '65536' }, 'Pass --run-on'],
			[
				'a gateway beside a source target',
				{ runOn: 'ep-ollama:qwen3', gatewayUrl: 'http://127.0.0.1:8787' },
				'--gateway-url: Not applied while Run on is a source',
			],
		])('refuses %s before it reaches the app', async (_name, flags, expected) => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', ...flags });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining(expected));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses a source for a provider with no recipe, with the reason, in JSON', async () => {
			await createAgent('Bad', {
				cwd: '/tmp',
				type: 'gemini-cli',
				runOn: 'ep-ollama:qwen3',
				json: true,
			});

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('speaks only the Gemini API');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	// `--model auto`: the Auto choice of the New Agent model picker. Stored as
	// the word, and only for a provider Auto can act on.
	describe('--model auto', () => {
		let sentPayload: Record<string, unknown>;

		beforeEach(() => {
			sentPayload = {};
			vi.mocked(readHarnessTierDefaults).mockReturnValue({});
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'auto-1',
						});
					}),
				};
				return action(mockClient as never);
			});
		});

		/** Run a call that must be refused before it reaches the app. */
		async function refused(flags: Parameters<typeof createAgent>[1]) {
			processExitSpy.mockImplementation(() => {
				throw new Error('process.exit');
			});
			await expect(createAgent('Bad', flags)).rejects.toThrow('process.exit');
			expect(withMaestroClient).not.toHaveBeenCalled();
		}

		it.each(['auto', 'Auto'])('sends %s as the word auto for claude-code', async (model) => {
			await createAgent('Agent', { cwd: '/tmp', type: 'claude-code', model });

			expect(sentPayload.customModel).toBe('auto');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('leaves a named model as it was typed', async () => {
			await createAgent('Agent', { cwd: '/tmp', type: 'claude-code', model: 'Opus' });

			expect(sentPayload.customModel).toBe('Opus');
			expect(readHarnessTierDefaults).not.toHaveBeenCalled();
		});

		it('refuses it by name for a provider Auto cannot act on', async () => {
			await refused({ cwd: '/tmp', type: 'opencode', model: 'auto' });

			expect(formatError).toHaveBeenCalledWith(
				expect.stringMatching(/^--model auto: Auto would change nothing for this agent/)
			);
		});

		it('refuses it as JSON with --json', async () => {
			await refused({ cwd: '/tmp', type: 'opencode', model: 'auto', json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: false,
				error: expect.stringMatching(/^--model auto: /),
			});
		});

		it('allows it for that provider when a harness default maps a tier', async () => {
			vi.mocked(readHarnessTierDefaults).mockReturnValue({
				opencode: { medium: { type: 'provider-model', model: 'some-model' } },
			});

			await createAgent('Agent', { cwd: '/tmp', type: 'opencode', model: 'auto' });

			expect(sentPayload.customModel).toBe('auto');
			expect(processExitSpy).not.toHaveBeenCalled();
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
