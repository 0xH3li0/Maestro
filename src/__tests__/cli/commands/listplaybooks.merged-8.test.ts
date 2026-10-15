// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/list-playbooks.test.ts
//   - src/__tests__/cli/commands/auto-run.test.ts
//   - src/__tests__/cli/commands/refresh.test.ts
//   - src/__tests__/cli/commands/reference.test.ts

import { autoRun } from '../../../cli/commands/auto-run';
import { listPlaybooks } from '../../../cli/commands/list-playbooks';
import { escapeMdxProse } from '../../../cli/commands/reference';
import { refreshAutoRun } from '../../../cli/commands/refresh-auto-run';
import { refreshFiles } from '../../../cli/commands/refresh-files';
import {
	formatError,
	formatPlaybooks,
	formatPlaybooksByAgent,
} from '../../../cli/output/formatter';
import { refreshFileTreeFor } from '../../../cli/services/file-tree-refresh';
import { resolveTargetSessionId, withMaestroClient } from '../../../cli/services/maestro-client';
import { listAllPlaybooks, readPlaybooks } from '../../../cli/services/playbooks';
import { getSessionById, readSessions, resolveAgentId } from '../../../cli/services/storage';
import type { Playbook, SessionInfo } from '../../../shared/types';
import { existsSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/playbooks', () => ({
	readPlaybooks: vi.fn(),
	listAllPlaybooks: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	resolveAgentId: vi.fn((id: string) => id),
	readSessions: vi.fn(),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatPlaybooks: vi.fn((playbooks, agentName, _folderPath) => {
		if (playbooks.length === 0) {
			return 'No playbooks found.';
		}
		const header = agentName ? `Playbooks for ${agentName}:\n` : 'Playbooks:\n';
		return header + playbooks.map((p: any) => `${p.name} (${p.documents.length} docs)`).join('\n');
	}),
	formatPlaybooksByAgent: vi.fn((groups) => {
		const agentsWithPlaybooks = groups.filter((g: any) => g.playbooks.length > 0);
		if (agentsWithPlaybooks.length === 0) {
			return 'No playbooks found.';
		}
		return agentsWithPlaybooks
			.map((g: any) => `${g.agentName}:\n` + g.playbooks.map((p: any) => `  ${p.name}`).join('\n'))
			.join('\n\n');
	}),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));
vi.mock('fs', () => ({
	existsSync: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn(),
}));
vi.mock('../../../cli/services/file-tree-refresh', () => ({
	refreshFileTreeFor: vi.fn(),
}));

// ===== from src/__tests__/cli/commands/list-playbooks.test.ts =====

describe('list-playbooks command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockPlaybook = (overrides: Partial<Playbook> = {}): Playbook => ({
		id: 'pb-123',
		name: 'Test Playbook',
		documents: [{ filename: 'doc1.md', resetOnCompletion: false }],
		loopEnabled: false,
		maxLoops: null,
		...overrides,
	});

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		autoRunFolderPath: '/path/to/playbooks',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe('listing playbooks for a specific agent', () => {
		it('should list playbooks for a specific agent in human-readable format', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'My Agent',
				autoRunFolderPath: '/playbooks',
			});
			const mockPbs = [
				mockPlaybook({
					id: 'pb-1',
					name: 'Playbook One',
					documents: [{ filename: 'doc1.md', resetOnCompletion: false }],
				}),
				mockPlaybook({
					id: 'pb-2',
					name: 'Playbook Two',
					documents: [{ filename: 'doc2.md', resetOnCompletion: true }],
				}),
			];

			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1' });

			expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
			expect(readPlaybooks).toHaveBeenCalledWith('agent-1');
			expect(getSessionById).toHaveBeenCalledWith('agent-1');
			expect(formatPlaybooks).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'pb-1', name: 'Playbook One' }),
					expect.objectContaining({ id: 'pb-2', name: 'Playbook Two' }),
				]),
				'My Agent',
				'/playbooks'
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle agent with no autoRunFolderPath', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'My Agent',
				autoRunFolderPath: undefined,
			});
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith(expect.any(Array), 'My Agent', undefined);
		});

		it('should handle agent that does not exist (getSessionById returns undefined)', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(undefined);

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith(expect.any(Array), undefined, undefined);
		});

		it('should handle empty playbooks for agent', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith([], 'Test Agent', '/path/to/playbooks');
			expect(consoleSpy).toHaveBeenCalledWith('No playbooks found.');
		});

		it('should output JSON for specific agent when --json flag is used', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'Agent JSON',
				autoRunFolderPath: '/json/path',
			});
			const mockPbs = [
				mockPlaybook({
					id: 'pb-json-1',
					name: 'JSON Playbook',
					documents: [
						{ filename: 'readme', resetOnCompletion: false },
						{ filename: 'tasks.md', resetOnCompletion: true },
					],
					loopEnabled: true,
					maxLoops: 5,
				}),
			];

			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1', json: true });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const outputCall = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(outputCall);

			expect(parsed).toHaveLength(1);
			expect(parsed[0]).toEqual({
				id: 'pb-json-1',
				name: 'JSON Playbook',
				agentId: 'agent-1',
				agentName: 'Agent JSON',
				folderPath: '/json/path',
				loopEnabled: true,
				maxLoops: 5,
				documents: [
					{ filename: 'readme.md', resetOnCompletion: false },
					{ filename: 'tasks.md', resetOnCompletion: true },
				],
			});
		});

		it('should normalize filenames without .md extension in JSON output', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({
					documents: [
						{ filename: 'no-extension', resetOnCompletion: false },
						{ filename: 'already.md', resetOnCompletion: true },
					],
				}),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].documents[0].filename).toBe('no-extension.md');
			expect(parsed[0].documents[1].filename).toBe('already.md');
		});

		it('should normalize filenames without .md extension in human-readable output', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({
					documents: [{ filename: 'no-extension', resetOnCompletion: false }],
				}),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			// Check that formatPlaybooks was called with normalized filenames
			const callArgs = vi.mocked(formatPlaybooks).mock.calls[0];
			expect(callArgs[0][0].documents[0].filename).toBe('no-extension.md');
		});
	});

	describe('listing all playbooks grouped by agent', () => {
		it('should list all playbooks grouped by agent in human-readable format', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Playbook A' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-2', name: 'Playbook B' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-3', name: 'Playbook C' }), sessionId: 'agent-2' },
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent One' }),
				mockSession({ id: 'agent-2', name: 'Agent Two' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({});

			expect(listAllPlaybooks).toHaveBeenCalled();
			expect(readSessions).toHaveBeenCalled();
			expect(formatPlaybooksByAgent).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						agentId: 'agent-1',
						agentName: 'Agent One',
						playbooks: expect.arrayContaining([
							expect.objectContaining({ id: 'pb-1', name: 'Playbook A' }),
							expect.objectContaining({ id: 'pb-2', name: 'Playbook B' }),
						]),
					}),
					expect.objectContaining({
						agentId: 'agent-2',
						agentName: 'Agent Two',
						playbooks: expect.arrayContaining([
							expect.objectContaining({ id: 'pb-3', name: 'Playbook C' }),
						]),
					}),
				])
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty playbooks list', () => {
			vi.mocked(listAllPlaybooks).mockReturnValue([]);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({});

			expect(formatPlaybooksByAgent).toHaveBeenCalledWith([]);
			expect(consoleSpy).toHaveBeenCalledWith('No playbooks found.');
		});

		it('should use "Unknown Agent" when session is not found', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Orphan Playbook' }), sessionId: 'unknown-agent' },
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs[0].agentName).toBe('Unknown Agent');
		});

		it('should output JSON for all playbooks when --json flag is used', () => {
			const mockPbs = [
				{
					...mockPlaybook({
						id: 'pb-1',
						name: 'Global PB 1',
						loopEnabled: true,
						maxLoops: 3,
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
					}),
					sessionId: 'agent-1',
				},
				{
					...mockPlaybook({
						id: 'pb-2',
						name: 'Global PB 2',
						documents: [{ filename: 'work.md', resetOnCompletion: true }],
					}),
					sessionId: 'agent-2',
				},
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent Alpha', autoRunFolderPath: '/alpha/playbooks' }),
				mockSession({ id: 'agent-2', name: 'Agent Beta', autoRunFolderPath: '/beta/playbooks' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({ json: true });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);

			expect(parsed).toHaveLength(2);
			expect(parsed[0]).toEqual({
				id: 'pb-1',
				name: 'Global PB 1',
				agentId: 'agent-1',
				agentName: 'Agent Alpha',
				folderPath: '/alpha/playbooks',
				loopEnabled: true,
				maxLoops: 3,
				documents: [{ filename: 'tasks.md', resetOnCompletion: false }],
			});
			expect(parsed[1]).toEqual({
				id: 'pb-2',
				name: 'Global PB 2',
				agentId: 'agent-2',
				agentName: 'Agent Beta',
				folderPath: '/beta/playbooks',
				loopEnabled: false,
				maxLoops: null,
				documents: [{ filename: 'work.md', resetOnCompletion: true }],
			});
		});

		it('should handle session not found in JSON output', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Orphan' }), sessionId: 'missing-agent' },
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({ json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].agentName).toBeUndefined();
			expect(parsed[0].folderPath).toBeUndefined();
		});

		it('should normalize filenames in grouped output', () => {
			const mockPbs = [
				{
					...mockPlaybook({
						documents: [{ filename: 'no-ext', resetOnCompletion: false }],
					}),
					sessionId: 'agent-1',
				},
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'agent-1' })]);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs[0].playbooks[0].documents[0].filename).toBe('no-ext.md');
		});
	});

	describe('error handling', () => {
		it('should handle resolveAgentId throwing an error', () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found: xyz');
			});

			expect(() => listPlaybooks({ agent: 'xyz' })).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Agent not found: xyz');
		});

		it('should handle resolveAgentId error with JSON output', () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found: xyz');
			});

			expect(() => listPlaybooks({ agent: 'xyz', json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Agent not found: xyz' });
		});

		it('should handle readPlaybooks throwing an error', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockImplementation(() => {
				throw new Error('Storage error');
			});

			expect(() => listPlaybooks({ agent: 'agent-1' })).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Storage error');
		});

		it('should handle listAllPlaybooks throwing an error', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw new Error('Failed to read playbooks directory');
			});

			expect(() => listPlaybooks({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith(
				'Failed to list playbooks: Failed to read playbooks directory'
			);
		});

		it('should handle listAllPlaybooks error with JSON output', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw new Error('Failed to read playbooks directory');
			});

			expect(() => listPlaybooks({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Failed to read playbooks directory' });
		});

		it('should handle non-Error throws', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw 'string error';
			});

			expect(() => listPlaybooks({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Unknown error');
		});

		it('should handle non-Error throws with JSON output', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw { custom: 'object error' };
			});

			expect(() => listPlaybooks({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Unknown error' });
		});
	});

	describe('edge cases', () => {
		it('should handle playbook with empty documents array', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ documents: [] })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			const callArgs = vi.mocked(formatPlaybooks).mock.calls[0];
			expect(callArgs[0][0].documents).toEqual([]);
		});

		it('should handle multiple agents with varying playbook counts', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-2' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-3' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-4' }), sessionId: 'agent-2' },
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent One' }),
				mockSession({ id: 'agent-2', name: 'Agent Two' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs.find((g: any) => g.agentId === 'agent-1').playbooks).toHaveLength(3);
			expect(callArgs.find((g: any) => g.agentId === 'agent-2').playbooks).toHaveLength(1);
		});

		it('should handle playbook with null maxLoops', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ loopEnabled: true, maxLoops: null }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].loopEnabled).toBe(true);
			expect(parsed[0].maxLoops).toBe(null);
		});

		it('should handle playbook with specific maxLoops value', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ loopEnabled: true, maxLoops: 10 })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].loopEnabled).toBe(true);
			expect(parsed[0].maxLoops).toBe(10);
		});

		it('should handle special characters in playbook names', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ name: 'Playbook with "quotes" and <brackets>' }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].name).toBe('Playbook with "quotes" and <brackets>');
		});

		it('should handle unicode characters in playbook names', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ name: '日本語プレイブック 🎭' })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].name).toBe('日本語プレイブック 🎭');
		});

		it('should handle very long filenames', () => {
			const longFilename = 'a'.repeat(200);
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ documents: [{ filename: longFilename, resetOnCompletion: false }] }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].documents[0].filename).toBe(longFilename + '.md');
		});

		it('should handle partial agent ID resolution', () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-agent-id-1234');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'full-agent-id-1234' }));

			listPlaybooks({ agent: 'full-agent' });

			expect(resolveAgentId).toHaveBeenCalledWith('full-agent');
			expect(readPlaybooks).toHaveBeenCalledWith('full-agent-id-1234');
		});
	});
});

// ===== from src/__tests__/cli/commands/auto-run.test.ts =====

describe('auto-run command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should configure auto-run with valid document paths', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc1.md', '/path/to/doc2.md'], { agent: 'agent-123' });

		expect(resolveTargetSessionId).toHaveBeenCalledWith('agent-123');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 2 documents')
		);
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should error with no documents', async () => {
		await autoRun([], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('At least one document path is required')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when document does not exist', async () => {
		vi.mocked(existsSync).mockReturnValue(false);

		await autoRun(['/nonexistent/doc.md'], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when document is not a .md file', async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		await autoRun(['/path/to/file.txt'], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('File must be a .md file')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should send saveAsPlaybook when --save-as is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
						playbookId: 'pb-456',
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { saveAs: 'My Playbook', agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.saveAsPlaybook).toBe('My Playbook');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Playbook 'My Playbook' saved")
		);
	});

	it('should send launch: true when --launch is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { launch: true, agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.launch).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run launched with 1 document')
		);
	});

	it('should send loop config when --loop is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { loop: true, agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.loopEnabled).toBe(true);
	});

	it('should send loop config with --max-loops', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { maxLoops: '5', agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.loopEnabled).toBe(true);
		expect(sentMessage!.maxLoops).toBe(5);
	});

	it('should error with invalid --max-loops value', async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		await autoRun(['/path/to/doc.md'], { maxLoops: 'abc' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--max-loops must be a positive integer')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should set resetOnCompletion on documents when flag is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			resetOnCompletion: true,
			agent: 'agent-123',
		});

		expect(sentMessage).toBeDefined();
		const docs = sentMessage!.documents as Array<{ filename: string; resetOnCompletion: boolean }>;
		expect(docs[0].resetOnCompletion).toBe(true);
	});

	it('should error gracefully when Maestro app is not running', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Maestro desktop app is not running')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should resolve a partial agent id via resolveTargetSessionId when --agent is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('full-agent-uuid-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'full-ag' });

		expect(resolveTargetSessionId).toHaveBeenCalledWith('full-ag');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 1 document')
		);
	});

	it('should propagate resolution failures from resolveTargetSessionId', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		// resolveTargetSessionId is the helper that owns the AGENT_NOT_FOUND
		// branch + process.exit. Simulating it via mockImplementationOnce
		// proves auto-run forwards the failure path without swallowing it.
		vi.mocked(resolveTargetSessionId).mockImplementationOnce(() => {
			throw new Error('Agent not found');
		});

		await expect(autoRun(['/path/to/doc.md'], { agent: 'bad-id' })).rejects.toThrow(
			'Agent not found'
		);
	});

	it('should send worktree config when --worktree flags are provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature/auto',
			worktreePath: '/tmp/wt',
			createPr: true,
			prTargetBranch: 'main',
		});

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.worktree).toEqual({
			enabled: true,
			path: path.resolve('/tmp/wt'),
			branchName: 'feature/auto',
			baseBranch: '', // --base-branch not supplied in this test
			createPROnCompletion: true,
			prTargetBranch: 'main',
		});
	});

	it('should send baseBranch when --base-branch is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature-from-rc',
			baseBranch: 'rc',
			worktreePath: '/tmp/wt',
		});

		expect(sentMessage).toBeDefined();
		const wt = sentMessage!.worktree as Record<string, unknown>;
		expect(wt.baseBranch).toBe('rc');
		expect(wt.branchName).toBe('feature-from-rc');
	});

	it('should reject --base-branch without --worktree', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(
			autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				baseBranch: 'rc',
			})
		).rejects.toThrow('process.exit');

		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--base-branch'));
		exitSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('should error when --worktree is used without --launch', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			worktree: true,
			branch: 'feature/x',
			worktreePath: '/tmp/wt',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --launch')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when --worktree is used without --branch', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			worktreePath: '/tmp/wt',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --branch')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when --worktree is used without --worktree-path', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature/x',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --worktree-path')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when worktree flags are provided without --worktree', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			branch: 'feature/x',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('require --worktree'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should omit worktree field when --worktree is not provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123', launch: true });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.worktree).toBeUndefined();
	});

	describe('per-run model/effort override', () => {
		/**
		 * Wire up a client whose sendCommand captures the outgoing message, so a
		 * test can assert on the `configure_auto_run` payload the CLI ships.
		 */
		const captureSentMessage = (): (() => Record<string, unknown> | undefined) => {
			let sentMessage: Record<string, unknown> | undefined;
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg) => {
						sentMessage = msg;
						return Promise.resolve({
							type: 'configure_auto_run_result',
							success: true,
						});
					}),
				};
				return action(mockClient as never);
			});
			return () => sentMessage;
		};

		it('should send model and effort when --model and --effort are provided', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				launch: true,
				model: 'opus',
				effort: 'high',
			});

			const sentMessage = getSent();
			expect(sentMessage).toBeDefined();
			expect(sentMessage!.model).toBe('opus');
			expect(sentMessage!.effort).toBe('high');
		});

		it('should omit model and effort entirely when the flags are not provided', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], { agent: 'agent-123', launch: true });

			const sentMessage = getSent();
			expect(sentMessage).toBeDefined();
			// Absent (not `undefined`) so an unset flag never serializes across the
			// WebSocket boundary and the agent default stays in effect.
			expect('model' in sentMessage!).toBe(false);
			expect('effort' in sentMessage!).toBe(false);
		});

		it('should send ignoreModelHints when --ignore-model-hints is given', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				launch: true,
				model: 'opus',
				ignoreModelHints: true,
			});

			expect(getSent()!.ignoreModelHints).toBe(true);
		});

		it('should omit ignoreModelHints entirely when the flag is not given', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], { agent: 'agent-123', launch: true });

			expect('ignoreModelHints' in getSent()!).toBe(false);
		});

		it('should treat whitespace-only --model/--effort as unset', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				launch: true,
				model: '   ',
				effort: '\t',
			});

			const sentMessage = getSent();
			expect(sentMessage).toBeDefined();
			expect('model' in sentMessage!).toBe(false);
			expect('effort' in sentMessage!).toBe(false);
		});

		it('should send model without effort when only --model is provided', async () => {
			const getSent = captureSentMessage();

			await autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				launch: true,
				model: 'sonnet',
			});

			const sentMessage = getSent();
			expect(sentMessage).toBeDefined();
			expect(sentMessage!.model).toBe('sonnet');
			expect('effort' in sentMessage!).toBe(false);
		});
	});

	it('should error when server returns failure', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: false,
					error: 'Agent not found',
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

// ===== from src/__tests__/cli/commands/refresh.test.ts =====

describe('refresh verbs', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-1');
	});

	/** Capture the payload `refresh-auto-run` puts on the wire. */
	function captureAutoRunSend() {
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_auto_run_docs_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	describe('refresh-auto-run', () => {
		it('stays in the background when neither flag is passed', async () => {
			// An unflagged refresh must not take the user to the target agent: it only
			// ever switched when that agent was off screen, which is an interruption.
			const send = captureAutoRunSend();

			await refreshAutoRun({});

			expect(send.mock.calls[0][0]).toMatchObject({
				type: 'refresh_auto_run_docs',
				sessionId: 'agent-1',
				background: true,
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('switches to the target agent with --focus', async () => {
			const send = captureAutoRunSend();

			await refreshAutoRun({ focus: true });

			expect(send.mock.calls[0][0]).toMatchObject({ background: false });
		});

		it('asks for background placement with --background', async () => {
			const send = captureAutoRunSend();

			await refreshAutoRun({ background: true });

			expect(send.mock.calls[0][0]).toMatchObject({ background: true });
		});

		it('lets --focus win when both are passed', async () => {
			const send = captureAutoRunSend();

			await refreshAutoRun({ background: true, focus: true });

			expect(send.mock.calls[0][0]).toMatchObject({ background: false });
		});

		it('reports the placement it used in --json', async () => {
			captureAutoRunSend();

			await refreshAutoRun({ background: true, json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				sessionId: 'agent-1',
				background: true,
			});
		});

		it('exits non-zero when the desktop rejects the refresh', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi.fn().mockResolvedValue({ success: false, error: 'No Auto Run folder' }),
				} as never)
			);

			await refreshAutoRun({ json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({ success: false });
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('refresh-files', () => {
		it('accepts --background and behaves identically', async () => {
			// The flag has nothing to suppress here. What is being pinned is that it
			// is ACCEPTED: an agent told to pass it everywhere must not get a usage
			// error from the one verb that was already polite.
			vi.mocked(refreshFileTreeFor).mockResolvedValue({ success: true });

			await refreshFiles({ background: true });
			await refreshFiles({});

			expect(refreshFileTreeFor).toHaveBeenCalledTimes(2);
			expect(refreshFileTreeFor).toHaveBeenNthCalledWith(1, 'agent-1');
			expect(refreshFileTreeFor).toHaveBeenNthCalledWith(2, 'agent-1');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('does not leak the flag into its --json output', async () => {
			// Reporting `background` here would imply the verb honoured it.
			vi.mocked(refreshFileTreeFor).mockResolvedValue({ success: true });

			await refreshFiles({ background: true, json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: true,
				sessionId: 'agent-1',
			});
		});
	});
});

// ===== from src/__tests__/cli/commands/reference.test.ts =====

describe('escapeMdxProse', () => {
	it('escapes a bare placeholder that MDX would read as an unclosed tag', () => {
		expect(escapeMdxProse('find IDs via "list playbooks -a <agent>"')).toBe(
			'find IDs via "list playbooks -a &lt;agent>"'
		);
	});

	it('escapes braces that MDX would read as an expression', () => {
		expect(escapeMdxProse('a {{VAR}} template')).toBe('a \\{\\{VAR\\}\\} template');
	});

	it('leaves code spans alone', () => {
		expect(escapeMdxProse('use `-a <agent>` or <id>')).toBe('use `-a <agent>` or &lt;id>');
	});

	it('passes plain text through unchanged', () => {
		expect(escapeMdxProse('Target agent ID')).toBe('Target agent ID');
	});
});
