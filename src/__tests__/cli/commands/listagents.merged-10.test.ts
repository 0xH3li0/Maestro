// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/list-agents.test.ts
//   - src/__tests__/cli/commands/profiling.test.ts

import { listAgents } from '../../../cli/commands/list-agents';
import { profilingStart, profilingStatus, profilingStop } from '../../../cli/commands/profiling';
import { formatAgents, formatError } from '../../../cli/output/formatter';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	getSessionsByGroup,
	readGroups,
	readSessions,
	resolveGroupId,
} from '../../../cli/services/storage';
import type { Group, SessionInfo } from '../../../shared/types';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(),
	readGroups: vi.fn(),
	getSessionsByGroup: vi.fn(),
	resolveGroupId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatAgents: vi.fn((agents, groupName) => {
		if (agents.length === 0) {
			return groupName ? `No agents in group "${groupName}"` : 'No agents found';
		}
		const header = groupName ? `Agents in "${groupName}":\n` : 'Agents:\n';
		return header + agents.map((a: any) => `${a.name} (${a.toolType})`).join('\n');
	}),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

// ===== from src/__tests__/cli/commands/list-agents.test.ts =====

describe('list-agents command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'sess-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		groupId: undefined,
		autoRunFolderPath: undefined,
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

	describe('human-readable output', () => {
		it('should display agents in human-readable format', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'a1', name: 'Agent One', toolType: 'claude-code' }),
				mockSession({ id: 'a2', name: 'Agent Two', toolType: 'factory-droid' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(readSessions).toHaveBeenCalled();
			expect(formatAgents).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'a1', name: 'Agent One' }),
					expect.objectContaining({ id: 'a2', name: 'Agent Two' }),
				]),
				undefined
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty agents list', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith([], undefined);
			expect(consoleSpy).toHaveBeenCalledWith('No agents found');
		});

		it('should display a single agent', () => {
			const mockSessions: SessionInfo[] = [mockSession({ id: 'solo', name: 'Solo Agent' })];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith(
				[expect.objectContaining({ id: 'solo', name: 'Solo Agent' })],
				undefined
			);
		});

		it('should include all agent properties', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'full',
					name: 'Full Agent',
					toolType: 'terminal',
					cwd: '/home/user/project',
					groupId: 'group-1',
					autoRunFolderPath: '/home/user/playbooks',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({});

			expect(formatAgents).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						id: 'full',
						name: 'Full Agent',
						toolType: 'terminal',
						cwd: '/home/user/project',
						groupId: 'group-1',
						autoRunFolderPath: '/home/user/playbooks',
					}),
				],
				undefined
			);
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'json-agent',
					name: 'JSON Agent',
					toolType: 'claude-code',
					cwd: '/test',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			expect(formatAgents).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(1);
			expect(parsed[0]).toEqual(
				expect.objectContaining({
					id: 'json-agent',
					name: 'JSON Agent',
					toolType: 'claude-code',
					cwd: '/test',
				})
			);
		});

		it('should expose the worktree directory as worktreeBasePath, null when unset', () => {
			// An agent reads this to put a worktree where the desktop will see it,
			// rather than inventing a path the app never registers.
			vi.mocked(readSessions).mockReturnValue([
				mockSession({
					id: 'with-wt',
					worktreeConfig: { basePath: '/home/user/Project-WorkTrees', watchEnabled: true },
				}),
				mockSession({ id: 'without-wt', worktreeConfig: undefined }),
			]);

			listAgents({ json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].worktreeBasePath).toBe('/home/user/Project-WorkTrees');
			expect(parsed[1].worktreeBasePath).toBeNull();
		});

		it('should output empty JSON array for no agents', () => {
			vi.mocked(readSessions).mockReturnValue([]);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toEqual([]);
		});

		it('should output multiple agents as JSON array', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'a1', name: 'Agent 1' }),
				mockSession({ id: 'a2', name: 'Agent 2' }),
				mockSession({ id: 'a3', name: 'Agent 3' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(3);
			expect(parsed[0].id).toBe('a1');
			expect(parsed[1].id).toBe('a2');
			expect(parsed[2].id).toBe('a3');
		});

		it('should include all properties in JSON output', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'complete',
					name: 'Complete Agent',
					toolType: 'gemini-cli',
					cwd: '/project',
					groupId: 'dev-group',
					autoRunFolderPath: '/project/autorun',
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0]).toHaveProperty('id', 'complete');
			expect(parsed[0]).toHaveProperty('name', 'Complete Agent');
			expect(parsed[0]).toHaveProperty('toolType', 'gemini-cli');
			expect(parsed[0]).toHaveProperty('cwd', '/project');
			expect(parsed[0]).toHaveProperty('groupId', 'dev-group');
			expect(parsed[0]).toHaveProperty('autoRunFolderPath', '/project/autorun');
		});
	});

	describe('group filtering', () => {
		it('should filter agents by group', () => {
			const mockGroups: Group[] = [
				{ id: 'group-frontend', name: 'Frontend', emoji: '🎨', collapsed: false },
			];
			const mockGroupSessions: SessionInfo[] = [
				mockSession({ id: 'fe1', name: 'React App', groupId: 'group-frontend' }),
				mockSession({ id: 'fe2', name: 'Vue App', groupId: 'group-frontend' }),
			];

			vi.mocked(resolveGroupId).mockReturnValue('group-frontend');
			vi.mocked(getSessionsByGroup).mockReturnValue(mockGroupSessions);
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listAgents({ group: 'group-frontend' });

			expect(resolveGroupId).toHaveBeenCalledWith('group-frontend');
			expect(getSessionsByGroup).toHaveBeenCalledWith('group-frontend');
			expect(readGroups).toHaveBeenCalled();
			expect(formatAgents).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'fe1' }),
					expect.objectContaining({ id: 'fe2' }),
				]),
				'Frontend'
			);
		});

		it('should resolve partial group ID', () => {
			vi.mocked(resolveGroupId).mockReturnValue('group-full-id');
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'group-full-id', name: 'Full Group', emoji: '📁', collapsed: false },
			]);

			listAgents({ group: 'group' });

			expect(resolveGroupId).toHaveBeenCalledWith('group');
			expect(getSessionsByGroup).toHaveBeenCalledWith('group-full-id');
		});

		it('should handle empty group', () => {
			vi.mocked(resolveGroupId).mockReturnValue('empty-group');
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'empty-group', name: 'Empty Group', emoji: '📭', collapsed: false },
			]);

			listAgents({ group: 'empty-group' });

			expect(formatAgents).toHaveBeenCalledWith([], 'Empty Group');
			expect(consoleSpy).toHaveBeenCalledWith('No agents in group "Empty Group"');
		});

		it('should filter by group in JSON mode', () => {
			const mockGroupSessions: SessionInfo[] = [
				mockSession({ id: 'g1', name: 'Group Agent', groupId: 'test-group' }),
			];

			vi.mocked(resolveGroupId).mockReturnValue('test-group');
			vi.mocked(getSessionsByGroup).mockReturnValue(mockGroupSessions);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'test-group', name: 'Test Group', emoji: '🧪', collapsed: false },
			]);

			listAgents({ group: 'test', json: true });

			expect(getSessionsByGroup).toHaveBeenCalledWith('test-group');
			expect(formatAgents).not.toHaveBeenCalled();

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].id).toBe('g1');
		});

		it('should handle group not found', () => {
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'other-group', name: 'Other', emoji: '📁', collapsed: false },
			]);
			vi.mocked(getSessionsByGroup).mockReturnValue([]);
			// Return undefined when group is not found
			vi.mocked(readGroups).mockReturnValue([]);

			listAgents({ group: 'unknown' });

			expect(formatAgents).toHaveBeenCalledWith([], undefined);
		});
	});

	describe('error handling', () => {
		it('should handle storage read errors in human-readable mode', () => {
			const error = new Error('Storage read failed');
			vi.mocked(readSessions).mockImplementation(() => {
				throw error;
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Storage read failed');
		});

		it('should handle storage read errors in JSON mode', () => {
			const error = new Error('JSON storage error');
			vi.mocked(readSessions).mockImplementation(() => {
				throw error;
			});

			expect(() => listAgents({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('JSON storage error');
		});

		it('should handle group resolution errors', () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Ambiguous group ID');
			});

			expect(() => listAgents({ group: 'amb' })).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Ambiguous group ID');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(readSessions).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list agents: Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(readSessions).mockImplementation(() => {
				throw new Error('Exit test');
			});

			expect(() => listAgents({})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle agents with undefined optional fields', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'minimal',
					name: 'Minimal',
					groupId: undefined,
					autoRunFolderPath: undefined,
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].groupId).toBeUndefined();
			expect(parsed[0].autoRunFolderPath).toBeUndefined();
		});

		it('should handle special characters in paths', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({
					id: 'special',
					name: 'Special',
					cwd: '/Users/dev/My Projects/Test "App"',
					autoRunFolderPath: "/path with 'quotes'",
				}),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].cwd).toBe('/Users/dev/My Projects/Test "App"');
			expect(parsed[0].autoRunFolderPath).toBe("/path with 'quotes'");
		});

		it('should handle all tool types', () => {
			const toolTypes = ['claude-code', 'factory-droid', 'terminal', 'gemini-cli', 'qwen3-coder'];
			const mockSessions: SessionInfo[] = toolTypes.map((toolType, i) =>
				mockSession({ id: `agent-${i}`, name: `Agent ${i}`, toolType: toolType as any })
			);
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(5);
			toolTypes.forEach((type, i) => {
				expect(parsed[i].toolType).toBe(type);
			});
		});

		it('should preserve agent order from storage', () => {
			const mockSessions: SessionInfo[] = [
				mockSession({ id: 'z-last', name: 'Z Last' }),
				mockSession({ id: 'a-first', name: 'A First' }),
				mockSession({ id: 'm-middle', name: 'M Middle' }),
			];
			vi.mocked(readSessions).mockReturnValue(mockSessions);

			listAgents({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].id).toBe('z-last');
			expect(parsed[1].id).toBe('a-first');
			expect(parsed[2].id).toBe('m-middle');
		});
	});
});

// ===== from src/__tests__/cli/commands/profiling.test.ts =====

/** Capture the payload + responseType + timeout passed to sendCommand. */
function mockSend(result: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(result);
				}),
		} as never)
	);
	return captured;
}

describe('profiling commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('start', () => {
		it('sends profiling_start and expects profiling_start_result', async () => {
			const cap = mockSend({ success: true, active: true });
			await profilingStart({});
			expect(cap.payload?.type).toBe('profiling_start');
			expect(cap.responseType).toBe('profiling_start_result');
		});

		it('exits non-zero when the app reports failure', async () => {
			mockSend({ success: false, error: 'boom' });
			await expect(profilingStart({})).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('stop', () => {
		it('requires --output and exits before connecting when missing', async () => {
			await expect(profilingStop({})).rejects.toThrow('__exit__');
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('resolves a relative output path to absolute and sends a long timeout', async () => {
			const cap = mockSend({ success: true, path: '/tmp/out.zip', durationMs: 1234 });
			await profilingStop({ output: 'sub/out.zip' });
			expect(cap.payload?.type).toBe('profiling_stop');
			expect(cap.responseType).toBe('profiling_stop_result');
			const outputPath = cap.payload?.outputPath as string;
			expect(path.isAbsolute(outputPath)).toBe(true);
			expect(outputPath.endsWith(path.join('sub', 'out.zip'))).toBe(true);
			// Compression is slow; the command must raise the default 10s timeout.
			expect(cap.timeout ?? 0).toBeGreaterThan(60_000);
		});

		it('expands a leading ~ to the home directory', async () => {
			const cap = mockSend({ success: true, path: '/x.zip' });
			await profilingStop({ output: '~/Desktop/p.zip' });
			const outputPath = cap.payload?.outputPath as string;
			expect(outputPath).toBe(path.join(os.homedir(), 'Desktop', 'p.zip'));
		});

		it('exits non-zero when the app reports failure', async () => {
			mockSend({ success: false, error: 'no active recording' });
			await expect(profilingStop({ output: '/tmp/p.zip' })).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('status', () => {
		it('sends profiling_status and prints active state as JSON', async () => {
			const cap = mockSend({ success: true, active: true, elapsedMs: 4200 });
			await profilingStatus({ json: true });
			expect(cap.payload?.type).toBe('profiling_status');
			expect(cap.responseType).toBe('profiling_status_result');
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"active":true'));
		});
	});
});
