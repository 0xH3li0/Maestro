// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/ipc/handlers/agent-error.test.ts
//   - src/__tests__/main/ipc/handlers/agents-codex-reset.test.ts

import { registerAgentErrorHandlers } from '../../../../main/ipc/handlers/agent-error';
import { withIpcErrorLogging } from '../../../../main/utils/ipcHandler';
import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	mockLogger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: mocks.mockLogger,
}));

// ===== from src/__tests__/main/ipc/handlers/agent-error.test.ts =====

// Alias for easier access in tests
const mockLogger = mocks.mockLogger;

describe('Agent Error IPC Handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerAgentErrorHandlers();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('handler registration', () => {
		it('should register agent:clearError handler', () => {
			expect(handlers.has('agent:clearError')).toBe(true);
		});

		it('should register agent:retryAfterError handler', () => {
			expect(handlers.has('agent:retryAfterError')).toBe(true);
		});

		it('should register exactly 2 handlers', () => {
			expect(handlers.size).toBe(2);
		});
	});

	describe('agent:clearError', () => {
		it('should return success for valid session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			const result = await handler({}, 'session-123');

			expect(result).toEqual({ success: true });
		});

		it('should log debug message with session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			await handler({}, 'test-session-abc');

			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Clearing agent error for session',
				'AgentError',
				{ sessionId: 'test-session-abc' }
			);
		});

		it('should handle empty session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			const result = await handler({}, '');

			expect(result).toEqual({ success: true });
			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Clearing agent error for session',
				'AgentError',
				{ sessionId: '' }
			);
		});

		it('should handle UUID format session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
			const result = await handler({}, uuid);

			expect(result).toEqual({ success: true });
			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Clearing agent error for session',
				'AgentError',
				{ sessionId: uuid }
			);
		});

		it('should handle long session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			const longSessionId = 'session-' + 'a'.repeat(500);
			const result = await handler({}, longSessionId);

			expect(result).toEqual({ success: true });
		});

		it('should handle special characters in session ID', async () => {
			const handler = handlers.get('agent:clearError')!;
			const specialId = 'session_with-special.chars:123';
			const result = await handler({}, specialId);

			expect(result).toEqual({ success: true });
		});

		it('should handle group chat session ID format', async () => {
			const handler = handlers.get('agent:clearError')!;
			const groupChatId = 'group-chat-test-123-participant-Agent-abc';
			const result = await handler({}, groupChatId);

			expect(result).toEqual({ success: true });
			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Clearing agent error for session',
				'AgentError',
				{ sessionId: groupChatId }
			);
		});
	});

	describe('agent:retryAfterError', () => {
		it('should return success without options', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123');

			expect(result).toEqual({ success: true });
		});

		it('should return success with empty options', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', {});

			expect(result).toEqual({ success: true });
		});

		it('should return success with prompt option', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', { prompt: 'Retry with this prompt' });

			expect(result).toEqual({ success: true });
		});

		it('should return success with newSession option', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', { newSession: true });

			expect(result).toEqual({ success: true });
		});

		it('should return success with both options', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', {
				prompt: 'Retry prompt',
				newSession: true,
			});

			expect(result).toEqual({ success: true });
		});

		it('should log info with session ID and no options', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'test-session-xyz');

			expect(mockLogger.info).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
				sessionId: 'test-session-xyz',
				hasPrompt: false,
				newSession: false,
			});
		});

		it('should log info with hasPrompt=true when prompt provided', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'session-abc', { prompt: 'Some prompt text' });

			expect(mockLogger.info).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
				sessionId: 'session-abc',
				hasPrompt: true,
				newSession: false,
			});
		});

		it('should log info with newSession=true when specified', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'session-def', { newSession: true });

			expect(mockLogger.info).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
				sessionId: 'session-def',
				hasPrompt: false,
				newSession: true,
			});
		});

		it('should handle empty prompt string as no prompt', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'session-123', { prompt: '' });

			expect(mockLogger.info).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
				sessionId: 'session-123',
				hasPrompt: false,
				newSession: false,
			});
		});

		it('should handle undefined newSession as false', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'session-123', { prompt: 'test' });

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Retrying after agent error',
				'AgentError',
				expect.objectContaining({ newSession: false })
			);
		});

		it('should handle newSession=false explicitly', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			await handler({}, 'session-123', { newSession: false });

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Retrying after agent error',
				'AgentError',
				expect.objectContaining({ newSession: false })
			);
		});

		it('should handle very long prompt', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const longPrompt = 'A'.repeat(10000);
			const result = await handler({}, 'session-123', { prompt: longPrompt });

			expect(result).toEqual({ success: true });
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Retrying after agent error',
				'AgentError',
				expect.objectContaining({ hasPrompt: true })
			);
		});

		it('should handle unicode in prompt', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', { prompt: '请重试这个操作 🔄' });

			expect(result).toEqual({ success: true });
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Retrying after agent error',
				'AgentError',
				expect.objectContaining({ hasPrompt: true })
			);
		});
	});

	describe('handler idempotency', () => {
		it('should handle multiple clearError calls for same session', async () => {
			const handler = handlers.get('agent:clearError')!;

			const result1 = await handler({}, 'session-123');
			const result2 = await handler({}, 'session-123');
			const result3 = await handler({}, 'session-123');

			expect(result1).toEqual({ success: true });
			expect(result2).toEqual({ success: true });
			expect(result3).toEqual({ success: true });
			expect(mockLogger.debug).toHaveBeenCalledTimes(3);
		});

		it('should handle multiple retryAfterError calls for same session', async () => {
			const handler = handlers.get('agent:retryAfterError')!;

			const result1 = await handler({}, 'session-123', { prompt: 'First retry' });
			const result2 = await handler({}, 'session-123', { prompt: 'Second retry' });

			expect(result1).toEqual({ success: true });
			expect(result2).toEqual({ success: true });
			expect(mockLogger.info).toHaveBeenCalledTimes(2);
		});
	});

	describe('concurrent handler calls', () => {
		it('should handle concurrent clearError calls for different sessions', async () => {
			const handler = handlers.get('agent:clearError')!;

			const results = await Promise.all([
				handler({}, 'session-1'),
				handler({}, 'session-2'),
				handler({}, 'session-3'),
			]);

			expect(results).toEqual([{ success: true }, { success: true }, { success: true }]);
		});

		it('should handle concurrent retryAfterError calls', async () => {
			const handler = handlers.get('agent:retryAfterError')!;

			const results = await Promise.all([
				handler({}, 'session-1', { prompt: 'Prompt 1' }),
				handler({}, 'session-2', { newSession: true }),
				handler({}, 'session-3', { prompt: 'Prompt 3', newSession: false }),
			]);

			expect(results).toEqual([{ success: true }, { success: true }, { success: true }]);
		});
	});

	describe('edge cases', () => {
		it('should handle null-ish session ID', async () => {
			const handler = handlers.get('agent:clearError')!;

			// TypeScript would normally prevent this, but testing runtime behavior
			const result = await handler({}, null as unknown as string);

			expect(result).toEqual({ success: true });
		});

		it('should handle undefined options in retryAfterError', async () => {
			const handler = handlers.get('agent:retryAfterError')!;
			const result = await handler({}, 'session-123', undefined);

			expect(result).toEqual({ success: true });
			expect(mockLogger.info).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
				sessionId: 'session-123',
				hasPrompt: false,
				newSession: false,
			});
		});
	});
});

// ===== from src/__tests__/main/ipc/handlers/agents-codex-reset.test.ts =====

/**
 * Regression test for Codex reset-credit IPC handlers.
 *
 * Bug: The handlers were declared with an extra `_event` parameter,
 * which caused argument shifting through withIpcErrorLogging.
 *
 * withIpcErrorLogging returns a function with signature:
 *   (_event: unknown, ...args: TArgs) => Promise<TResult>
 *
 * But it strips the event and calls handler(...args).
 *
 * If a handler incorrectly declares (_event, arg1, arg2), the event
 * gets passed as arg1, arg2 as the event (and gets lost), and arg3
 * is missing entirely.
 */

describe('Codex reset-credit IPC handlers argument passing', () => {
	let mockFetchCredits: ReturnType<typeof vi.fn>;
	let mockConsumeCredit: ReturnType<typeof vi.fn>;
	let handlerGetCredits: ReturnType<typeof withIpcErrorLogging>;
	let handlerConsumeCredit: ReturnType<typeof withIpcErrorLogging>;

	beforeEach(() => {
		mockFetchCredits = vi.fn().mockResolvedValue({ ok: true });
		mockConsumeCredit = vi.fn().mockResolvedValue({ ok: true });

		// Correct handler: no _event parameter
		handlerGetCredits = withIpcErrorLogging(
			{ context: '[Test]', operation: 'getCodexResetCredits' },
			async (codexHome: string) => {
				return mockFetchCredits(codexHome);
			}
		);

		// Correct handler: no _event parameter
		handlerConsumeCredit = withIpcErrorLogging(
			{ context: '[Test]', operation: 'consumeCodexResetCredit' },
			async (codexHome: string, creditId: string, idempotencyKey?: string) => {
				return mockConsumeCredit(codexHome, creditId, idempotencyKey);
			}
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('getCodexResetCredits passes codexHome correctly to the handler', async () => {
		// withIpcErrorLogging returns (_event, ...args) => Promise<TResult>
		// The caller (ipcMain.handle) will pass (event, codexHome)
		// withIpcErrorLogging should strip event and call handler(codexHome)
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';

		await handlerGetCredits(event, testHome);

		// The handler should have received codexHome, not the event
		expect(mockFetchCredits).toHaveBeenCalledWith(testHome);
		expect(mockFetchCredits).toHaveBeenCalledTimes(1);
	});

	it('consumeCodexResetCredit passes all three arguments correctly', async () => {
		// withIpcErrorLogging returns (_event, ...args) => Promise<TResult>
		// The caller will pass (event, codexHome, creditId, idempotencyKey)
		// withIpcErrorLogging should strip event and call handler(codexHome, creditId, idempotencyKey)
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';
		const idempotencyKey = 'idempotent-key-xyz';

		await handlerConsumeCredit(event, testHome, creditId, idempotencyKey);

		// The handler should have received all three arguments in order
		expect(mockConsumeCredit).toHaveBeenCalledWith(testHome, creditId, idempotencyKey);
		expect(mockConsumeCredit).toHaveBeenCalledTimes(1);
	});

	it('consumeCodexResetCredit handles optional idempotencyKey gracefully', async () => {
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';

		// Call without idempotencyKey (it should be undefined)
		await handlerConsumeCredit(event, testHome, creditId);

		expect(mockConsumeCredit).toHaveBeenCalledWith(testHome, creditId, undefined);
		expect(mockConsumeCredit).toHaveBeenCalledTimes(1);
	});

	it('demonstrates the old buggy pattern would have failed', async () => {
		// This shows what would happen if the handler incorrectly had _event parameter
		const buggyHandler = withIpcErrorLogging(
			{ context: '[Test]', operation: 'buggyHandler' },
			// BUG: handler declares _event even though withIpcErrorLogging already strips it
			async (_event: string, codexHome: string) => {
				// _event receives the codexHome value instead!
				// codexHome receives the creditId value (or undefined)
				return { received_event: _event, received_codexHome: codexHome };
			}
		);

		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';

		// Call with (event, codexHome, creditId)
		// withIpcErrorLogging passes to handler (codexHome, creditId)
		// but handler expects (_event, codexHome)
		// so it receives: _event=codexHome, codexHome=creditId
		const result = await buggyHandler(event, testHome, creditId);

		expect(result).toEqual({
			received_event: testHome, // WRONG: got codexHome
			received_codexHome: creditId, // WRONG: got creditId
		});
	});
});
