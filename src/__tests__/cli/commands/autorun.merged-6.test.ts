// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/auto-run-control.test.ts
//   - src/__tests__/cli/commands/rename-agent.test.ts
//   - src/__tests__/cli/commands/bookmark.test.ts
//   - src/__tests__/cli/commands/remove-playbook.test.ts

import {
	abortAutoRun,
	autoRunFolder,
	autoRunStatus,
	resetAutoRunTasks,
	resumeAutoRun,
	skipAutoRun,
	stopAutoRun,
} from '../../../cli/commands/auto-run-control';
import { setBookmark } from '../../../cli/commands/bookmark';
import { removePlaybook } from '../../../cli/commands/remove-playbook';
import { renameAgent } from '../../../cli/commands/rename-agent';
import { formatError, formatSuccess } from '../../../cli/output/formatter';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

// ===== from src/__tests__/cli/commands/auto-run-control.test.ts =====

function mockSend(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('auto-run control commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it.each([
		[stopAutoRun, 'stop_auto_run'],
		[resumeAutoRun, 'resume_auto_run_error'],
		[skipAutoRun, 'skip_auto_run_document'],
		[abortAutoRun, 'abort_auto_run_error'],
	] as const)('%o sends the right message type', async (fn, expectedType) => {
		const getPayload = mockSend({ success: true });
		await fn('agent-1', {});
		const p = getPayload();
		expect(p.type).toBe(expectedType);
		expect(p.sessionId).toBe('agent-1');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('reset-auto-run-tasks sends filename', async () => {
		const getPayload = mockSend({ success: true });
		await resetAutoRunTasks('agent-1', 'loop/step-1.md', {});
		const p = getPayload();
		expect(p.type).toBe('reset_auto_run_doc_tasks');
		expect(p.filename).toBe('loop/step-1.md');
	});

	it('reset-auto-run-tasks rejects path traversal before connecting', async () => {
		await expect(resetAutoRunTasks('agent-1', '../escape.md', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid filename'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reset-auto-run-tasks rejects absolute paths', async () => {
		await expect(resetAutoRunTasks('agent-1', '/etc/passwd', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid filename'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Auto-run stopping not configured' });
		await expect(stopAutoRun('agent-1', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Auto-run stopping not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	describe('auto-run-status', () => {
		it('asks for the agent state and reports progress as JSON', async () => {
			const captured = mockSend({
				type: 'auto_run_state',
				state: { isRunning: true, totalTasks: 4, completedTasks: 1 },
			});
			await autoRunStatus('agent-1', { json: true });
			expect(captured()).toMatchObject({ type: 'get_auto_run_state', sessionId: 'agent-1' });
			const out = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
			expect(out).toMatchObject({ success: true, running: true });
		});

		it('fails on a generic error frame instead of reporting an idle agent', async () => {
			mockSend({ type: 'error', message: 'Session detail not configured' });
			await expect(autoRunStatus('agent-1', {})).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('auto-run-folder', () => {
		it('resolves a relative path against the cwd', async () => {
			const captured = mockSend({ success: true });
			await autoRunFolder('agent-1', 'docs/runs', {});
			expect(captured()).toMatchObject({
				type: 'set_auto_run_folder',
				sessionId: 'agent-1',
				folderPath: path.resolve(process.cwd(), 'docs/runs'),
			});
		});

		it('sends absolute and ~ paths as typed (they may name a remote host path)', async () => {
			const captured = mockSend({ success: true });
			await autoRunFolder('agent-1', '~/runs', {});
			expect(captured().folderPath).toBe('~/runs');
		});
	});
});

// ===== from src/__tests__/cli/commands/rename-agent.test.ts =====

function mockSend_1(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('rename-agent command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('renames an agent and sends the correct payload', async () => {
		const getPayload = mockSend_1({ success: true });

		await renameAgent('agent-1', 'New Name', {});

		const p = getPayload();
		expect(p.type).toBe('rename_session');
		expect(p.sessionId).toBe('agent-1');
		expect(p.newName).toBe('New Name');
		expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('New Name'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('trims the new name', async () => {
		const getPayload = mockSend_1({ success: true });
		await renameAgent('agent-1', '  Trimmed  ', {});
		expect(getPayload().newName).toBe('Trimmed');
	});

	it('rejects an empty name without opening a connection', async () => {
		await expect(renameAgent('agent-1', '   ', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('New name must not be empty');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects a name longer than 100 characters', async () => {
		await expect(renameAgent('agent-1', 'x'.repeat(101), {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('New name must be 100 characters or less');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('fails when the agent cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: nope');
		});
		await expect(renameAgent('nope', 'Name', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Agent not found: nope');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend_1({ success: false, error: 'Session renaming not configured' });
		await expect(renameAgent('agent-1', 'Name', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Session renaming not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('emits JSON on success', async () => {
		mockSend_1({ success: true });
		await renameAgent('agent-1', 'Name', { json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.success).toBe(true);
		expect(parsed.sessionId).toBe('agent-1');
	});
});

// ===== from src/__tests__/cli/commands/bookmark.test.ts =====

function mockClient(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('bookmark commands', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('bookmark sends an explicit bookmarked:true config patch', async () => {
		const getPayload = mockClient({ success: true });
		await setBookmark('agent-1', true, {});
		const p = getPayload();
		expect(p.type).toBe('update_session_config');
		expect(p.sessionId).toBe('agent-1');
		expect(p.configPatch).toEqual({ bookmarked: true });
	});

	it('unbookmark sends bookmarked:false rather than toggling', async () => {
		const getPayload = mockClient({ success: true });
		await setBookmark('agent-1', false, {});
		expect(getPayload().configPatch).toEqual({ bookmarked: false });
	});

	it('resolves a partial agent id before sending', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('session-full-id');
		const getPayload = mockClient({ success: true });
		await setBookmark('sess', true, {});
		expect(resolveAgentId).toHaveBeenCalledWith('sess');
		expect(getPayload().sessionId).toBe('session-full-id');
	});

	it('emits JSON with the resulting state for scripting', async () => {
		mockClient({ success: true });
		await setBookmark('agent-1', true, { json: true });
		expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			agentId: 'agent-1',
			bookmarked: true,
		});
	});

	it('exits non-zero when the desktop rejects the write', async () => {
		mockClient({ success: false, error: 'Agent not found' });
		await expect(setBookmark('agent-1', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Agent not found');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits non-zero when the desktop app is unreachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));
		await expect(setBookmark('agent-1', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Maestro is not running');
	});
});

// ===== from src/__tests__/cli/commands/remove-playbook.test.ts =====

function mockSend_2(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('remove-playbook command', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends delete_playbook with sessionId + playbookId', async () => {
		const getPayload = mockSend_2({ success: true });
		await removePlaybook('agent-1', 'pb-42', {});
		const p = getPayload();
		expect(p.type).toBe('delete_playbook');
		expect(p.sessionId).toBe('agent-1');
		expect(p.playbookId).toBe('pb-42');
	});

	it('rejects an empty playbook id', async () => {
		await expect(removePlaybook('agent-1', '   ', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Playbook ID must not be empty');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend_2({ success: false, error: 'Playbook deletion not configured' });
		await expect(removePlaybook('agent-1', 'pb-1', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Playbook deletion not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
