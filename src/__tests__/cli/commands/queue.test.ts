/**
 * @file queue.test.ts
 * @description Tests for the `maestro-cli queue` verbs (list / remove / steer).
 *
 * These proxy to the desktop renderer's authoritative execution queue over the
 * same WebSocket the `dispatch` verb uses, so the tests assert the exact WS
 * message shapes and the JSON the CLI prints.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));

import { queueList, queueRemove, queueSteer } from '../../../cli/commands/queue';
import { QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS } from '../../../shared/chatSteering';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';

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

	describe('queue steer', () => {
		function mockSteerResponse(response: Record<string, unknown>) {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			const mockSendCommand = vi
				.fn()
				.mockResolvedValue({ type: 'steer_queue_item_result', ...response });
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand: mockSendCommand } as never)
			);
			return mockSendCommand;
		}

		it('sends steer_queue_item with the round-trip timeout and exits 0 on delivered', async () => {
			const send = mockSteerResponse({
				success: true,
				result: { outcome: 'delivered', verdict: 'delivered' },
			});

			await queueSteer('item-1', { agent: 'ag' });

			// The timeout must outlast main's wait on the renderer, which outlasts the
			// renderer's wait on the steering socket.
			expect(send).toHaveBeenCalledWith(
				{ type: 'steer_queue_item', sessionId: 'agent-1', itemId: 'item-1' },
				'steer_queue_item_result',
				QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS
			);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({
				success: true,
				agentId: 'agent-1',
				itemId: 'item-1',
				outcome: 'delivered',
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('exits 1 with a per-outcome code when the steer was refused', async () => {
			mockSteerResponse({
				success: true,
				result: {
					outcome: 'refused',
					verdict: 'refused',
					refusal: 'blocking-dialog',
					detail: 'a permission prompt',
				},
			});

			await queueSteer('item-1', { agent: 'ag' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({
				success: false,
				outcome: 'refused',
				refusal: 'blocking-dialog',
				code: 'STEER_REFUSED',
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('reports an unsteerable item with its blocked reason', async () => {
			mockSteerResponse({
				success: true,
				result: { outcome: 'not-steerable', blockedReason: 'not-claude' },
			});

			await queueSteer('item-1', { agent: 'ag' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({ code: 'NOT_STEERABLE', blockedReason: 'not-claude' });
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('exits 1 with STEER_FAILED when the round trip produced no result', async () => {
			mockSteerResponse({ success: false, error: 'Renderer did not respond' });

			await queueSteer('item-1', { agent: 'ag' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({
				success: false,
				code: 'STEER_FAILED',
				error: 'Renderer did not respond',
			});
		});

		it('exits 1 with INVALID_OPTIONS when --agent is missing', async () => {
			await queueSteer('item-1', {});

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.code).toBe('INVALID_OPTIONS');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});
});
