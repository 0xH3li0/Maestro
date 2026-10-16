// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/ipc/handlers/aiCommand.test.ts
//   - src/__tests__/main/ipc/handlers/ssh-remote.test.ts

import type { AgentDetector } from '../../../../main/agents';
import { registerAiCommandHandlers } from '../../../../main/ipc/handlers/aiCommand';
import type {
	AiCommandSuggestRequest,
	AiCommandSuggestResult,
} from '../../../../main/ipc/handlers/aiCommand';
import { registerSshRemoteHandlers } from '../../../../main/ipc/handlers/ssh-remote';
import type { ProcessManager } from '../../../../main/process-manager';
import * as sshRemoteManagerModule from '../../../../main/ssh-remote-manager';
import { groomContext } from '../../../../main/utils/context-groomer';
import { SshRemoteConfig } from '../../../../shared/types';
import { ipcMain } from 'electron';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn(
		() => 'PROMPT {{OS}} {{SHELL}} {{CWD}} {{IS_GIT_REPO}} {{REMOTE_LINE}} {{USER_REQUEST}}'
	),
}));
vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

// ===== from src/__tests__/main/ipc/handlers/aiCommand.test.ts =====

const mockGroomContext = groomContext as unknown as Mock;

/** Invoke the registered `aiCommand:suggest` handler the way ipcMain would. */
function invokeSuggest(config: Partial<AiCommandSuggestRequest>): Promise<AiCommandSuggestResult> {
	const registered = (ipcMain.handle as Mock).mock.calls.find(
		([channel]) => channel === 'aiCommand:suggest'
	);
	expect(registered).toBeDefined();
	const handler = registered![1] as (
		event: unknown,
		config: AiCommandSuggestRequest
	) => Promise<AiCommandSuggestResult>;
	return handler({}, {
		request: 'find the biggest files here',
		agentType: 'claude-code',
		cwd: '/repo',
		...config,
	} as AiCommandSuggestRequest);
}

describe('aiCommand IPC handler', () => {
	let getAgent: Mock;
	let settingsValues: Record<string, unknown>;

	beforeEach(() => {
		vi.clearAllMocks();
		settingsValues = {};
		mockGroomContext.mockResolvedValue({ response: 'du -sh *' });
		getAgent = vi.fn().mockResolvedValue({ id: 'claude-code', available: true });

		registerAiCommandHandlers({
			getProcessManager: () => ({}) as unknown as ProcessManager,
			getAgentDetector: () => ({ getAgent }) as unknown as AgentDetector,
			agentConfigsStore: {
				get: vi.fn(() => ({ 'claude-code': { customModel: 'ignored' } })),
			} as never,
			settingsStore: {
				get: vi.fn((key: string, fallback: unknown) => settingsValues[key] ?? fallback),
			} as never,
		});
	});

	it('registers the suggest channel', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('aiCommand:suggest', expect.any(Function));
	});

	it('returns the extracted command line for a successful suggestion', async () => {
		mockGroomContext.mockResolvedValue({ response: '```bash\ndu -sh * | sort -h\n```' });

		const result = await invokeSuggest({});

		expect(result).toEqual({ success: true, command: 'du -sh * | sort -h' });
	});

	it('runs the suggestion read-only with tools disabled, so the model names work instead of doing it', async () => {
		await invokeSuggest({ customModel: 'opus', customEffort: 'high' });

		expect(mockGroomContext).toHaveBeenCalledTimes(1);
		const [options] = mockGroomContext.mock.calls[0];
		expect(options.readOnlyMode).toBe(true);
		expect(options.disableTools).toBe(true);
		// The tab's own provider and settings, not a hard-coded agent.
		expect(options.agentType).toBe('claude-code');
		expect(options.sessionCustomModel).toBe('opus');
		expect(options.sessionCustomEffort).toBe('high');
		expect(options.projectRoot).toBe('/repo');
	});

	it('names the configured shell so the prompt and the eventual run agree', async () => {
		settingsValues.defaultShell = '/bin/zsh';

		await invokeSuggest({});

		expect(mockGroomContext.mock.calls[0][0].prompt).toContain('/bin/zsh');
	});

	it('prefers an explicit custom shell path over the selected shell', async () => {
		settingsValues.defaultShell = '/bin/zsh';
		settingsValues.customShellPath = '/opt/homebrew/bin/fish';

		await invokeSuggest({});

		const prompt = mockGroomContext.mock.calls[0][0].prompt;
		expect(prompt).toContain('/opt/homebrew/bin/fish');
		expect(prompt).not.toContain('/bin/zsh');
	});

	it('describes the remote rather than this machine when the agent runs over SSH', async () => {
		settingsValues.defaultShell = '/bin/zsh';

		await invokeSuggest({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			sshRemoteName: 'build-box',
		});

		const prompt = mockGroomContext.mock.calls[0][0].prompt;
		// The local shell is not the one the command will run in.
		expect(prompt).not.toContain('/bin/zsh');
		expect(prompt).toContain('build-box');
	});

	it('rejects an empty request without calling the model', async () => {
		const result = await invokeSuggest({ request: '   ' });

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('reports an unavailable provider instead of spawning it', async () => {
		getAgent.mockResolvedValue({ id: 'codex', available: false });

		const result = await invokeSuggest({ agentType: 'codex' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('codex');
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('surfaces a model failure as an error result rather than throwing at the renderer', async () => {
		mockGroomContext.mockRejectedValue(new Error('agent timed out'));

		const result = await invokeSuggest({});

		expect(result).toEqual({ success: false, error: 'agent timed out' });
	});

	it('fails rather than proposing an empty run when nothing usable comes back', async () => {
		mockGroomContext.mockResolvedValue({ response: '   \n\n  ' });

		const result = await invokeSuggest({});

		expect(result.success).toBe(false);
		expect(result.command).toBeUndefined();
	});
});

// ===== from src/__tests__/main/ipc/handlers/ssh-remote.test.ts =====

// Capture registered handlers
const registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

describe('SSH Remote IPC Handlers', () => {
	let mockSettingsStore: {
		get: Mock;
		set: Mock;
	};

	const createMockConfig = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
		id: 'test-id',
		name: 'Test Remote',
		host: 'example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '/home/user/.ssh/id_rsa',
		enabled: true,
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();

		// Capture handler registrations
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				registeredHandlers.set(channel, handler);
			}
		);

		// Create mock settings store
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
		};

		// Default store state
		mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [];
			if (key === 'defaultSshRemoteId') return null;
			return defaultValue;
		});

		// Register handlers
		registerSshRemoteHandlers({
			settingsStore: mockSettingsStore as unknown as Parameters<
				typeof registerSshRemoteHandlers
			>[0]['settingsStore'],
		});
	});

	// Helper to invoke a registered handler
	async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for channel: ${channel}`);
		}
		// IPC handlers receive (event, ...args), but our wrapper strips the event
		return handler({}, ...args);
	}

	describe('handler registration', () => {
		it('registers all SSH remote handlers', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:saveConfig', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:deleteConfig', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:getConfigs', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:getDefaultId', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:setDefaultId', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:test', expect.any(Function));
		});
	});

	describe('ssh-remote:getConfigs', () => {
		it('returns empty array when no configs exist', async () => {
			const result = await invokeHandler('ssh-remote:getConfigs');
			expect(result).toEqual({ success: true, configs: [] });
		});

		it('returns existing configs', async () => {
			const configs = [createMockConfig()];
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return configs;
				return null;
			});

			const result = await invokeHandler('ssh-remote:getConfigs');
			expect(result).toEqual({ success: true, configs });
		});
	});

	describe('ssh-remote:saveConfig', () => {
		beforeEach(() => {
			// Mock validateConfig to return valid
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'validateConfig').mockReturnValue({
				valid: true,
				errors: [],
			});
		});

		it('creates a new config with generated ID', async () => {
			const configData = {
				name: 'New Remote',
				host: 'new.example.com',
				port: 22,
				username: 'user',
				privateKeyPath: '/path/to/key',
			};

			const result = (await invokeHandler('ssh-remote:saveConfig', configData)) as {
				success: boolean;
				config?: SshRemoteConfig;
			};

			expect(result.success).toBe(true);
			expect(result.config).toBeDefined();
			expect(result.config?.id).toBeDefined();
			expect(result.config?.name).toBe('New Remote');
			expect(mockSettingsStore.set).toHaveBeenCalledWith('sshRemotes', expect.any(Array));
		});

		it('updates existing config when ID matches', async () => {
			const existingConfig = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [existingConfig];
				return null;
			});

			const updates = {
				id: existingConfig.id,
				name: 'Updated Remote',
				host: existingConfig.host,
				port: existingConfig.port,
				username: existingConfig.username,
				privateKeyPath: existingConfig.privateKeyPath,
				enabled: true,
			};

			const result = (await invokeHandler('ssh-remote:saveConfig', updates)) as {
				success: boolean;
				config?: SshRemoteConfig;
			};

			expect(result.success).toBe(true);
			expect(result.config?.name).toBe('Updated Remote');
			expect(mockSettingsStore.set).toHaveBeenCalled();
		});

		it('persists sshOptions rather than dropping them', async () => {
			// The handler rebuilds the config field by field, so a field missing from
			// that literal is silently discarded on every save from the UI.
			const result = (await invokeHandler('ssh-remote:saveConfig', {
				name: 'Tunnelled',
				host: 'tailcat-devbox',
				port: 22,
				sshOptions: { ProxyCommand: 'tailcat tcABC 22', ConnectTimeout: '45' },
			})) as { success: boolean; config?: SshRemoteConfig };

			expect(result.config?.sshOptions).toEqual({
				ProxyCommand: 'tailcat tcABC 22',
				ConnectTimeout: '45',
			});
		});

		it('strips a reserved ssh option before it reaches disk', async () => {
			const result = (await invokeHandler('ssh-remote:saveConfig', {
				name: 'Tunnelled',
				host: 'tailcat-devbox',
				port: 22,
				sshOptions: { RequestTTY: 'force', ProxyJump: 'bastion' },
			})) as { success: boolean; config?: SshRemoteConfig };

			expect(result.config?.sshOptions).toEqual({ ProxyJump: 'bastion' });
		});

		it('persists the parked records, which the field-by-field rebuild can drop', async () => {
			// The handler names every field it copies, so a field it does not name is
			// discarded on every save from the UI - the feature would work from the
			// CLI and be dead in Settings.
			const result = (await invokeHandler('ssh-remote:saveConfig', {
				name: 'Tunnelled',
				host: 'tailcat-devbox',
				port: 22,
				sshOptions: { ConnectTimeout: '45' },
				sshOptionsDisabled: { ProxyCommand: 'tailcat tcABC 22' },
				remoteEnv: { FOO: '1' },
				remoteEnvDisabled: { BAR: '2' },
			})) as { success: boolean; config?: SshRemoteConfig };

			expect(result.config?.sshOptionsDisabled).toEqual({ ProxyCommand: 'tailcat tcABC 22' });
			expect(result.config?.remoteEnvDisabled).toEqual({ BAR: '2' });
			// The live records are untouched by the parked ones.
			expect(result.config?.sshOptions).toEqual({ ConnectTimeout: '45' });
			expect(result.config?.remoteEnv).toEqual({ FOO: '1' });
		});

		it('strips a reserved key from the parked record too', async () => {
			// A parked RequestTTY could only ever be switched on into a rejection,
			// so it does not reach disk in the first place.
			const result = (await invokeHandler('ssh-remote:saveConfig', {
				name: 'Tunnelled',
				host: 'tailcat-devbox',
				port: 22,
				sshOptionsDisabled: { RequestTTY: 'force', ProxyJump: 'bastion' },
			})) as { success: boolean; config?: SshRemoteConfig };

			expect(result.config?.sshOptionsDisabled).toEqual({ ProxyJump: 'bastion' });
		});

		it('leaves sshOptions unset when none are supplied', async () => {
			const result = (await invokeHandler('ssh-remote:saveConfig', {
				name: 'Plain',
				host: 'example.com',
				port: 22,
			})) as { success: boolean; config?: SshRemoteConfig };

			expect(result.config?.sshOptions).toBeUndefined();
		});

		it('returns error when validation fails', async () => {
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'validateConfig').mockReturnValue({
				valid: false,
				errors: ['Host is required', 'Username is required'],
			});

			const result = (await invokeHandler('ssh-remote:saveConfig', {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid configuration');
			expect(result.error).toContain('Host is required');
		});
	});

	describe('ssh-remote:deleteConfig', () => {
		it('deletes an existing config', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				if (key === 'defaultSshRemoteId') return null;
				return null;
			});

			const result = await invokeHandler('ssh-remote:deleteConfig', config.id);

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('sshRemotes', []);
		});

		it('clears default ID when deleted config was default', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				if (key === 'defaultSshRemoteId') return config.id;
				return null;
			});

			await invokeHandler('ssh-remote:deleteConfig', config.id);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', null);
		});

		it('returns error when config not found', async () => {
			const result = (await invokeHandler('ssh-remote:deleteConfig', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});
	});

	describe('ssh-remote:getDefaultId', () => {
		it('returns null when no default is set', async () => {
			const result = await invokeHandler('ssh-remote:getDefaultId');
			expect(result).toEqual({ success: true, id: null });
		});

		it('returns the default ID when set', async () => {
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'defaultSshRemoteId') return 'my-default-id';
				return null;
			});

			const result = await invokeHandler('ssh-remote:getDefaultId');
			expect(result).toEqual({ success: true, id: 'my-default-id' });
		});
	});

	describe('ssh-remote:setDefaultId', () => {
		it('sets the default ID', async () => {
			const config = createMockConfig({ id: 'config-to-set' });
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			const result = await invokeHandler('ssh-remote:setDefaultId', 'config-to-set');

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', 'config-to-set');
		});

		it('clears the default ID when null is passed', async () => {
			const result = await invokeHandler('ssh-remote:setDefaultId', null);

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', null);
		});

		it('returns error when config ID does not exist', async () => {
			const result = (await invokeHandler('ssh-remote:setDefaultId', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});
	});

	describe('ssh-remote:test', () => {
		beforeEach(() => {
			// Default mock for testConnection
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'testConnection').mockResolvedValue({
				success: true,
				remoteInfo: {
					hostname: 'test-host',
				},
			});
		});

		it('tests connection using config object', async () => {
			const config = createMockConfig();

			const result = (await invokeHandler('ssh-remote:test', config)) as {
				success: boolean;
				result?: { success: boolean };
			};

			expect(result.success).toBe(true);
			expect(result.result?.success).toBe(true);
			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				undefined
			);
		});

		it('tests connection by config ID', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			const result = (await invokeHandler('ssh-remote:test', config.id)) as {
				success: boolean;
				result?: { success: boolean };
			};

			expect(result.success).toBe(true);
			expect(result.result?.success).toBe(true);
			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				undefined
			);
		});

		it('passes agent command when provided', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			await invokeHandler('ssh-remote:test', config.id, 'claude');

			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				'claude'
			);
		});

		it('returns error when config ID not found', async () => {
			const result = (await invokeHandler('ssh-remote:test', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});

		it('returns test failure result', async () => {
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'testConnection').mockResolvedValue({
				success: false,
				error: 'Connection refused',
			});

			const config = createMockConfig();
			const result = (await invokeHandler('ssh-remote:test', config)) as {
				success: boolean;
				result?: { success: boolean; error?: string };
			};

			expect(result.success).toBe(true); // IPC call succeeded
			expect(result.result?.success).toBe(false); // But test failed
			expect(result.result?.error).toBe('Connection refused');
		});
	});
});
