// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/queue.test.ts
//   - src/__tests__/cli/commands/remove-agent.test.ts

import { queueList, queueRemove } from '../../../cli/commands/queue';
import { removeAgent } from '../../../cli/commands/remove-agent';
import { formatError, formatSuccess } from '../../../cli/output/formatter';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

// ===== from src/__tests__/cli/commands/queue.test.ts =====

describe('queue command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('queue list', () => {
		it('sends list_queue for all agents when no --agent and prints queues + totalItems', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'list_queue_result',
				success: true,
				queues: [
					{
						sessionId: 's1',
						name: 'A',
						state: 'busy',
						items: [{ id: 'i1', timestamp: 1, tabId: 't1', type: 'message', text: 'x' }],
					},
				],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);

			await queueList({});

			expect(mockSendCommand).toHaveBeenCalledWith({ type: 'list_queue' }, 'list_queue_result');
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(true);
			expect(output.totalItems).toBe(1);
			expect(output.queues[0].items[0].id).toBe('i1');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('resolves --agent and scopes list_queue to that session', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			const mockSendCommand = vi
				.fn()
				.mockResolvedValue({ type: 'list_queue_result', success: true, queues: [] });
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);

			await queueList({ agent: 'ag' });

			expect(resolveAgentId).toHaveBeenCalledWith('ag');
			expect(mockSendCommand).toHaveBeenCalledWith(
				{ type: 'list_queue', sessionId: 'agent-1' },
				'list_queue_result'
			);
		});

		it('exits 1 with MAESTRO_NOT_RUNNING when the app is down', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

			await queueList({});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('MAESTRO_NOT_RUNNING');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('exits 1 with LIST_FAILED when the renderer returns success:false', async () => {
			const mockSendCommand = vi.fn().mockResolvedValue({
				type: 'list_queue_result',
				success: false,
				error: 'boom',
				queues: [],
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);

			await queueList({});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('LIST_FAILED');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('queue remove', () => {
		it('sends remove_queue_item and prints removed:true on success', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			const mockSendCommand = vi
				.fn()
				.mockResolvedValue({ type: 'remove_queue_item_result', success: true, removed: true });
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);

			await queueRemove('item-9', { agent: 'ag' });

			expect(mockSendCommand).toHaveBeenCalledWith(
				{ type: 'remove_queue_item', sessionId: 'agent-1', itemId: 'item-9' },
				'remove_queue_item_result'
			);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({
				success: true,
				agentId: 'agent-1',
				itemId: 'item-9',
				removed: true,
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('exits 1 with INVALID_OPTIONS when --agent is missing', async () => {
			await queueRemove('item-9', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_OPTIONS');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('exits 1 with ITEM_NOT_FOUND when the item was not in the queue', async () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			const mockSendCommand = vi
				.fn()
				.mockResolvedValue({ type: 'remove_queue_item_result', success: true, removed: false });
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);

			await queueRemove('ghost', { agent: 'ag' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('ITEM_NOT_FOUND');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});

// ===== from src/__tests__/cli/commands/remove-agent.test.ts =====

describe('remove-agent command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should remove an agent successfully', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'delete_session_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await removeAgent('full-ses', {});

		expect(resolveAgentId).toHaveBeenCalledWith('full-ses');
		expect(formatSuccess).toHaveBeenCalledWith('Removed agent full-session-id');
	});

	it('should output JSON on success', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({ type: 'delete_session_result', success: true }),
			};
			return action(mockClient as never);
		});

		await removeAgent('agent-123', { json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.agentId).toBe('agent-123');
	});

	it('should error when agent ID not found', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: xyz');
		});

		await removeAgent('xyz', {});

		expect(formatError).toHaveBeenCalledWith('Agent not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle server failure', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'delete_session_result',
					success: false,
					error: 'Session in use',
				}),
			};
			return action(mockClient as never);
		});

		await removeAgent('agent-id', {});

		expect(formatError).toHaveBeenCalledWith('Session in use');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle connection error', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-id');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

		await removeAgent('agent-id', {});

		expect(formatError).toHaveBeenCalledWith('App not running');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
