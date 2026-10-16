// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/ipc/handlers/agentSessions.test.ts
//   - src/__tests__/main/ipc/handlers/bmad.test.ts
//   - src/__tests__/main/ipc/handlers/openspec.test.ts

import * as agentSessionStorage from '../../../../main/agents';
import * as bmadManager from '../../../../main/bmad-manager';
import {
	isExpectedSessionReadError,
	registerAgentSessionsHandlers,
} from '../../../../main/ipc/handlers/agentSessions';
import { registerBmadHandlers } from '../../../../main/ipc/handlers/bmad';
import { registerOpenSpecHandlers } from '../../../../main/ipc/handlers/openspec';
import * as openspecManager from '../../../../main/openspec-manager';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));
vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
	hasSessionStorage: vi.fn(),
	getAllSessionStorages: vi.fn(),
}));
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/bmad-manager', () => ({
	getBmadMetadata: vi.fn(),
	getBmadPrompts: vi.fn(),
	getBmadCommandBySlash: vi.fn(),
	saveBmadPrompt: vi.fn(),
	resetBmadPrompt: vi.fn(),
	refreshBmadPrompts: vi.fn(),
}));

vi.mock('../../../../main/openspec-manager', () => ({
	getOpenSpecMetadata: vi.fn(),
	getOpenSpecPrompts: vi.fn(),
	getOpenSpecCommandBySlash: vi.fn(),
	saveOpenSpecPrompt: vi.fn(),
	resetOpenSpecPrompt: vi.fn(),
	refreshOpenSpecPrompts: vi.fn(),
}));

// ===== from src/__tests__/main/ipc/handlers/agentSessions.test.ts =====

describe('agentSessions IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerAgentSessionsHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all agentSessions handlers', () => {
			const expectedChannels = [
				'agentSessions:list',
				'agentSessions:listPaginated',
				'agentSessions:read',
				'agentSessions:search',
				'agentSessions:getPath',
				'agentSessions:deleteMessagePair',
				'agentSessions:hasStorage',
				'agentSessions:getAvailableStorages',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('agentSessions:list', () => {
		it('should return sessions from storage', async () => {
			const mockSessions = [
				{ sessionId: 'session-1', projectPath: '/test', firstMessage: 'Hello' },
				{ sessionId: 'session-2', projectPath: '/test', firstMessage: 'Hi' },
			];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'unknown-agent', '/test');

			expect(result).toEqual([]);
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockSessions = [{ sessionId: 'session-1', projectPath: '/test' }];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			// Note: Without settings store, sshConfig will be undefined even if sshRemoteId is passed
			const result = await handler!({} as any, 'claude-code', '/test', 'ssh-remote-1');

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});
	});

	describe('agentSessions:listPaginated', () => {
		it('should return paginated sessions from storage', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: true,
				totalCount: 50,
				nextCursor: 'session-1',
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'claude-code', '/test', { limit: 10 });

			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'unknown-agent', '/test', {});

			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				{ limit: 10 },
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});
	});

	describe('agentSessions:read', () => {
		it('should return session messages from storage', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 10,
				hasMore: true,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1', {
				offset: 0,
				limit: 20,
			});

			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{
					offset: 0,
					limit: 20,
				},
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', {});

			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 1,
				hasMore: false,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				{ offset: 0, limit: 20 },
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{ offset: 0, limit: 20 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});
	});

	describe('agentSessions:search', () => {
		it('should return search results from storage', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'claude-code', '/test', 'hello', 'all');

			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'hello', 'all');

			expect(result).toEqual([]);
		});

		it('should pass sshRemoteId to storage when provided', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'hello',
				'all',
				'ssh-remote-1'
			);

			// Since no settings store is configured, sshConfig should be undefined
			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});
	});

	describe('agentSessions:getPath', () => {
		it('should return session path from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				getSessionPath: vi.fn().mockReturnValue('/path/to/session.jsonl'),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1');

			expect(mockStorage.getSessionPath).toHaveBeenCalledWith('/test', 'session-1');
			expect(result).toBe('/path/to/session.jsonl');
		});

		it('should return null when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1');

			expect(result).toBe(null);
		});
	});

	describe('agentSessions:deleteMessagePair', () => {
		it('should delete message pair from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 3 }),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);

			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);
			expect(result).toEqual({ success: true, linesRemoved: 3 });
		});

		it('should return error when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', 'uuid-123');

			expect(result).toEqual({
				success: false,
				error: 'No session storage available for agent: unknown-agent',
			});
		});
	});

	describe('agentSessions:hasStorage', () => {
		it('should return true when storage exists', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(true);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'claude-code');

			expect(agentSessionStorage.hasSessionStorage).toHaveBeenCalledWith('claude-code');
			expect(result).toBe(true);
		});

		it('should return false when storage does not exist', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(false);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toBe(false);
		});
	});

	describe('agentSessions:getAvailableStorages', () => {
		it('should return list of available storage agent IDs', async () => {
			const mockStorages = [{ agentId: 'claude-code' }, { agentId: 'opencode' }];

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				mockStorages as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAvailableStorages');
			const result = await handler!({} as any);

			expect(result).toEqual(['claude-code', 'opencode']);
		});
	});
});

describe('isExpectedSessionReadError', () => {
	// The global-stats loops read provider transcripts that belong to the agent
	// CLI, not to us. Failures rooted in the user's filesystem must not reach
	// Sentry (MAESTRO-W9); a genuine parse fault still must.
	it('treats an unreadable transcript as expected (MAESTRO-W9)', () => {
		const error = Object.assign(
			new Error("EACCES: permission denied, open '/Users/x/.claude/projects/a/b.jsonl'"),
			{ code: 'EACCES' }
		);
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it('treats a transcript deleted mid-scan as expected', () => {
		const error = Object.assign(new Error('ENOENT: no such file or directory'), {
			code: 'ENOENT',
		});
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it.each(['EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY'])('treats %s as expected', (code) => {
		expect(isExpectedSessionReadError(Object.assign(new Error(code), { code }))).toBe(true);
	});

	it('still reports errors that are not filesystem conditions', () => {
		expect(isExpectedSessionReadError(new Error('Unexpected token in JSON'))).toBe(false);
		expect(isExpectedSessionReadError(new RangeError('Invalid string length'))).toBe(false);
		expect(isExpectedSessionReadError(Object.assign(new Error('boom'), { code: 'EMFILE' }))).toBe(
			false
		);
	});

	it('handles non-Error throwables', () => {
		expect(isExpectedSessionReadError(undefined)).toBe(false);
		expect(isExpectedSessionReadError('EACCES')).toBe(false);
	});
});

// ===== from src/__tests__/main/ipc/handlers/bmad.test.ts =====

describe('bmad IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerBmadHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	it('registers all BMAD handlers', () => {
		for (const channel of [
			'bmad:getMetadata',
			'bmad:getPrompts',
			'bmad:getCommand',
			'bmad:savePrompt',
			'bmad:resetPrompt',
			'bmad:refresh',
		]) {
			expect(handlers.has(channel)).toBe(true);
		}
	});

	it('returns metadata from the manager', async () => {
		const metadata = {
			lastRefreshed: '2026-03-14T00:00:00Z',
			commitSha: 'ac769b2',
			sourceVersion: '6.1.0',
			sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
		};
		vi.mocked(bmadManager.getBmadMetadata).mockResolvedValue(metadata);

		const result = await handlers.get('bmad:getMetadata')!({} as any);

		expect(result).toEqual({ success: true, metadata });
	});

	it('returns all commands from the manager', async () => {
		const commands = [
			{
				id: 'help',
				command: '/bmad-help',
				description: 'Get help',
				prompt: '# Help',
				isCustom: false,
				isModified: false,
			},
		];
		vi.mocked(bmadManager.getBmadPrompts).mockResolvedValue(commands);

		const result = await handlers.get('bmad:getPrompts')!({} as any);

		expect(result).toEqual({ success: true, commands });
	});

	it('returns a command by slash command', async () => {
		const command = {
			id: 'help',
			command: '/bmad-help',
			description: 'Get help',
			prompt: '# Help',
			isCustom: false,
			isModified: false,
		};
		vi.mocked(bmadManager.getBmadCommandBySlash).mockResolvedValue(command);

		const result = await handlers.get('bmad:getCommand')!({} as any, '/bmad-help');

		expect(bmadManager.getBmadCommandBySlash).toHaveBeenCalledWith('/bmad-help');
		expect(result).toEqual({ success: true, command });
	});

	it('saves a prompt customization', async () => {
		vi.mocked(bmadManager.saveBmadPrompt).mockResolvedValue(undefined);

		const result = await handlers.get('bmad:savePrompt')!({} as any, 'help', '# Custom');

		expect(bmadManager.saveBmadPrompt).toHaveBeenCalledWith('help', '# Custom');
		expect(result).toEqual({ success: true });
	});

	it('resets a prompt to its default', async () => {
		vi.mocked(bmadManager.resetBmadPrompt).mockResolvedValue('# Default');

		const result = await handlers.get('bmad:resetPrompt')!({} as any, 'help');

		expect(bmadManager.resetBmadPrompt).toHaveBeenCalledWith('help');
		expect(result).toEqual({ success: true, prompt: '# Default' });
	});

	it('refreshes prompts from GitHub', async () => {
		const metadata = {
			lastRefreshed: '2026-03-14T00:00:00Z',
			commitSha: 'ac769b2',
			sourceVersion: '6.1.0',
			sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
		};
		vi.mocked(bmadManager.refreshBmadPrompts).mockResolvedValue(metadata);

		const result = await handlers.get('bmad:refresh')!({} as any);

		expect(result).toEqual({ success: true, metadata });
	});
});

// ===== from src/__tests__/main/ipc/handlers/openspec.test.ts =====

describe('openspec IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerOpenSpecHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all openspec handlers', () => {
			const expectedChannels = [
				'openspec:getMetadata',
				'openspec:getPrompts',
				'openspec:getCommand',
				'openspec:savePrompt',
				'openspec:resetPrompt',
				'openspec:refresh',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('openspec:getMetadata', () => {
		it('should return metadata from manager', async () => {
			const mockMetadata = {
				lastRefreshed: '2025-01-01T00:00:00Z',
				commitSha: 'abc1234',
				sourceVersion: '0.1.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(openspecManager.getOpenSpecMetadata).mockResolvedValue(mockMetadata);

			const handler = handlers.get('openspec:getMetadata');
			const result = await handler!({} as any);

			expect(openspecManager.getOpenSpecMetadata).toHaveBeenCalled();
			expect(result).toEqual({ success: true, metadata: mockMetadata });
		});

		it('should handle errors gracefully', async () => {
			vi.mocked(openspecManager.getOpenSpecMetadata).mockRejectedValue(new Error('Failed to read'));

			const handler = handlers.get('openspec:getMetadata');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to read');
		});
	});

	describe('openspec:getPrompts', () => {
		it('should return all commands from manager', async () => {
			const mockCommands = [
				{
					id: 'proposal',
					command: '/openspec.proposal',
					description: 'Create a change proposal',
					prompt: '# Proposal',
					isCustom: false,
					isModified: false,
				},
				{
					id: 'help',
					command: '/openspec.help',
					description: 'Get help',
					prompt: '# Help',
					isCustom: true,
					isModified: false,
				},
			];

			vi.mocked(openspecManager.getOpenSpecPrompts).mockResolvedValue(mockCommands);

			const handler = handlers.get('openspec:getPrompts');
			const result = await handler!({} as any);

			expect(openspecManager.getOpenSpecPrompts).toHaveBeenCalled();
			expect(result).toEqual({ success: true, commands: mockCommands });
		});

		it('should handle errors gracefully', async () => {
			vi.mocked(openspecManager.getOpenSpecPrompts).mockRejectedValue(new Error('Failed'));

			const handler = handlers.get('openspec:getPrompts');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
		});
	});

	describe('openspec:getCommand', () => {
		it('should return command by slash command string', async () => {
			const mockCommand = {
				id: 'proposal',
				command: '/openspec.proposal',
				description: 'Create a change proposal',
				prompt: '# Proposal',
				isCustom: false,
				isModified: false,
			};

			vi.mocked(openspecManager.getOpenSpecCommandBySlash).mockResolvedValue(mockCommand);

			const handler = handlers.get('openspec:getCommand');
			const result = await handler!({} as any, '/openspec.proposal');

			expect(openspecManager.getOpenSpecCommandBySlash).toHaveBeenCalledWith('/openspec.proposal');
			expect(result).toEqual({ success: true, command: mockCommand });
		});

		it('should return null for unknown command', async () => {
			vi.mocked(openspecManager.getOpenSpecCommandBySlash).mockResolvedValue(null);

			const handler = handlers.get('openspec:getCommand');
			const result = await handler!({} as any, '/openspec.unknown');

			expect(result).toEqual({ success: true, command: null });
		});
	});

	describe('openspec:savePrompt', () => {
		it('should save prompt customization', async () => {
			vi.mocked(openspecManager.saveOpenSpecPrompt).mockResolvedValue(undefined);

			const handler = handlers.get('openspec:savePrompt');
			const result = await handler!({} as any, 'proposal', '# Custom Proposal');

			expect(openspecManager.saveOpenSpecPrompt).toHaveBeenCalledWith(
				'proposal',
				'# Custom Proposal'
			);
			expect(result).toEqual({ success: true });
		});

		it('should handle save errors', async () => {
			vi.mocked(openspecManager.saveOpenSpecPrompt).mockRejectedValue(new Error('Write failed'));

			const handler = handlers.get('openspec:savePrompt');
			const result = await handler!({} as any, 'proposal', '# Custom');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Write failed');
		});
	});

	describe('openspec:resetPrompt', () => {
		it('should reset prompt to default', async () => {
			const defaultPrompt = '# Default Proposal';
			vi.mocked(openspecManager.resetOpenSpecPrompt).mockResolvedValue(defaultPrompt);

			const handler = handlers.get('openspec:resetPrompt');
			const result = await handler!({} as any, 'proposal');

			expect(openspecManager.resetOpenSpecPrompt).toHaveBeenCalledWith('proposal');
			expect(result).toEqual({ success: true, prompt: defaultPrompt });
		});

		it('should handle unknown command error', async () => {
			vi.mocked(openspecManager.resetOpenSpecPrompt).mockRejectedValue(
				new Error('Unknown openspec command: nonexistent')
			);

			const handler = handlers.get('openspec:resetPrompt');
			const result = await handler!({} as any, 'nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unknown openspec command');
		});
	});

	describe('openspec:refresh', () => {
		it('should refresh prompts from GitHub', async () => {
			const newMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'def5678',
				sourceVersion: '0.1.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(openspecManager.refreshOpenSpecPrompts).mockResolvedValue(newMetadata);

			const handler = handlers.get('openspec:refresh');
			const result = await handler!({} as any);

			expect(openspecManager.refreshOpenSpecPrompts).toHaveBeenCalled();
			expect(result).toEqual({ success: true, metadata: newMetadata });
		});

		it('should handle network errors', async () => {
			vi.mocked(openspecManager.refreshOpenSpecPrompts).mockRejectedValue(
				new Error('Failed to fetch propose.ts: Not Found')
			);

			const handler = handlers.get('openspec:refresh');
			const result = await handler!({} as any);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to fetch');
		});
	});
});
