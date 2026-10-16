// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/cli/services/agent-sessions.test.ts
//   - src/__tests__/cli/services/maestro-client.test.ts

import { listClaudeSessions } from '../../../cli/services/agent-sessions';
import {
	MaestroClient,
	resolveSessionId,
	withMaestroClient,
} from '../../../cli/services/maestro-client';
import { readSessions } from '../../../cli/services/storage';
import { isCliServerRunning, readCliServerInfo } from '../../../shared/cli-server-discovery';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	statSync: vi.fn(),
}));
vi.mock('os', () => ({
	homedir: vi.fn(() => '/home/testuser'),
	platform: vi.fn(() => 'darwin'),
}));
vi.mock('ws', async () => {
	const { EventEmitter: EE } = await import('events');
	const WS_OPEN = 1;
	class MockWebSocket extends EE {
		close = vi.fn();
		send = vi.fn();
		readyState = WS_OPEN;
		static OPEN = WS_OPEN;
		constructor() {
			super();
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			mockWsInstance = this as unknown as typeof mockWsInstance;
		}
	}
	return { default: MockWebSocket };
});
vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(),
}));

// ===== from src/__tests__/cli/services/agent-sessions.test.ts =====

describe('listClaudeSessions', () => {
	const projectPath = '/path/to/project';
	// encodeClaudeProjectPath: replace all non-alphanumeric with -
	const encodedPath = '-path-to-project';
	const sessionsDir = path.join('/home/testuser', '.claude', 'projects', encodedPath);

	const makeJsonlContent = (
		opts: {
			userMessage?: string;
			assistantMessage?: string;
			timestamp?: string;
			inputTokens?: number;
			outputTokens?: number;
		} = {}
	) => {
		const lines: string[] = [];
		const ts = opts.timestamp || '2026-02-08T10:00:00.000Z';

		if (opts.userMessage) {
			lines.push(
				JSON.stringify({
					type: 'user',
					timestamp: ts,
					message: { role: 'user', content: opts.userMessage },
				})
			);
		}
		if (opts.assistantMessage) {
			lines.push(
				JSON.stringify({
					type: 'assistant',
					timestamp: ts,
					message: { role: 'assistant', content: opts.assistantMessage },
				})
			);
		}
		if (opts.inputTokens || opts.outputTokens) {
			lines.push(
				JSON.stringify({
					type: 'result',
					timestamp: ts,
					usage: {
						input_tokens: opts.inputTokens || 0,
						output_tokens: opts.outputTokens || 0,
					},
				})
			);
		}
		return lines.join('\n');
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return empty result when project directory does not exist', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toEqual([]);
		expect(result.totalCount).toBe(0);
	});

	it('should parse session files and return sorted results', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			// Origins file doesn't exist
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-old.jsonl' as unknown as fs.Dirent,
			'session-new.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-old')) {
				return { size: 500, mtimeMs: new Date('2026-02-01T00:00:00Z').getTime() } as fs.Stats;
			}
			return { size: 800, mtimeMs: new Date('2026-02-08T00:00:00Z').getTime() } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-old')) {
				return makeJsonlContent({
					userMessage: 'Old task',
					assistantMessage: 'Old response',
					timestamp: '2026-02-01T00:00:00.000Z',
					inputTokens: 100,
					outputTokens: 50,
				});
			}
			if (pStr.includes('session-new')) {
				return makeJsonlContent({
					userMessage: 'New task',
					assistantMessage: 'New response',
					timestamp: '2026-02-08T00:00:00.000Z',
					inputTokens: 200,
					outputTokens: 100,
				});
			}
			// Origins store - not found
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.totalCount).toBe(2);
		expect(result.sessions).toHaveLength(2);
		// Newest first
		expect(result.sessions[0].sessionId).toBe('session-new');
		expect(result.sessions[1].sessionId).toBe('session-old');
	});

	it('should skip empty (0-byte) session files', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-empty.jsonl' as unknown as fs.Dirent,
			'session-valid.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-empty')) {
				return { size: 0, mtimeMs: Date.now() } as fs.Stats;
			}
			return { size: 500, mtimeMs: Date.now() } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-valid')) {
				return makeJsonlContent({
					userMessage: 'Hello',
					assistantMessage: 'Hi there',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.totalCount).toBe(1);
		expect(result.sessions[0].sessionId).toBe('session-valid');
	});

	it('should apply limit to results', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
			'session-3.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { limit: 2 });

		expect(result.totalCount).toBe(3);
		expect(result.sessions).toHaveLength(2);
	});

	it('should skip sessions for pagination', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-a.jsonl' as unknown as fs.Dirent,
			'session-b.jsonl' as unknown as fs.Dirent,
			'session-c.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-a')) return { size: 500, mtimeMs: 3000 } as fs.Stats;
			if (pStr.includes('session-b')) return { size: 500, mtimeMs: 2000 } as fs.Stats;
			return { size: 500, mtimeMs: 1000 } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		// Skip first 2, get the last one
		const result = listClaudeSessions(projectPath, { skip: 2, limit: 10 });

		expect(result.totalCount).toBe(3);
		expect(result.sessions).toHaveLength(1);
		// Sorted newest first: session-a (3000), session-b (2000), session-c (1000)
		// After skip 2, only session-c remains
		expect(result.sessions[0].sessionId).toBe('session-c');
	});

	it('should combine skip and limit for pagination', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
			'session-3.jsonl' as unknown as fs.Dirent,
			'session-4.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-1')) return { size: 500, mtimeMs: 4000 } as fs.Stats;
			if (pStr.includes('session-2')) return { size: 500, mtimeMs: 3000 } as fs.Stats;
			if (pStr.includes('session-3')) return { size: 500, mtimeMs: 2000 } as fs.Stats;
			return { size: 500, mtimeMs: 1000 } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		// Skip 1, take 2 → sessions 2 and 3
		const result = listClaudeSessions(projectPath, { skip: 1, limit: 2 });

		expect(result.totalCount).toBe(4);
		expect(result.sessions).toHaveLength(2);
		expect(result.sessions[0].sessionId).toBe('session-2');
		expect(result.sessions[1].sessionId).toBe('session-3');
	});

	it('should filter sessions by search keyword in first message', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-auth.jsonl' as unknown as fs.Dirent,
			'session-tests.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-auth')) {
				return makeJsonlContent({
					userMessage: 'Fix the authentication flow',
					assistantMessage: 'I will help fix auth',
				});
			}
			if (pStr.includes('session-tests')) {
				return makeJsonlContent({
					userMessage: 'Write unit tests',
					assistantMessage: 'I will write tests',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { search: 'auth' });

		expect(result.totalCount).toBe(2);
		expect(result.filteredCount).toBe(1);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].sessionId).toBe('session-auth');
	});

	it('should attach session names from origins store', () => {
		vi.mocked(os.platform).mockReturnValue('darwin');

		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue(['session-named.jsonl' as unknown as fs.Dirent]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('claude-session-origins.json')) {
				return JSON.stringify({
					origins: {
						[projectPath]: {
							'session-named': {
								origin: 'user',
								sessionName: 'My Named Session',
								starred: true,
							},
						},
					},
				});
			}
			if (pStr.includes('session-named.jsonl')) {
				return makeJsonlContent({
					userMessage: 'Do something',
					assistantMessage: 'Done',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].sessionName).toBe('My Named Session');
		expect(result.sessions[0].starred).toBe(true);
		expect(result.sessions[0].origin).toBe('user');
	});

	it('should search in session names from origins store', () => {
		vi.mocked(os.platform).mockReturnValue('darwin');

		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('claude-session-origins.json')) {
				return JSON.stringify({
					origins: {
						[projectPath]: {
							'session-1': {
								origin: 'user',
								sessionName: 'Refactor auth module',
							},
							'session-2': {
								origin: 'user',
								sessionName: 'Database migration',
							},
						},
					},
				});
			}
			if (pStr.includes('session-1.jsonl')) {
				return makeJsonlContent({ userMessage: 'Start refactoring', assistantMessage: 'OK' });
			}
			if (pStr.includes('session-2.jsonl')) {
				return makeJsonlContent({ userMessage: 'Start migration', assistantMessage: 'OK' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { search: 'migration' });

		expect(result.filteredCount).toBe(1);
		expect(result.sessions[0].sessionName).toBe('Database migration');
	});

	it('should extract token counts and calculate cost', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue(['session-tokens.jsonl' as unknown as fs.Dirent]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 1000,
			mtimeMs: Date.now(),
		} as fs.Stats);

		const content = [
			JSON.stringify({
				type: 'user',
				timestamp: '2026-02-08T10:00:00.000Z',
				message: { role: 'user', content: 'Hello' },
			}),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-02-08T10:00:05.000Z',
				message: { role: 'assistant', content: 'Hi there' },
			}),
			JSON.stringify({
				type: 'result',
				timestamp: '2026-02-08T10:00:05.000Z',
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 100,
				},
			}),
		].join('\n');

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-tokens.jsonl')) return content;
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0];
		expect(session.inputTokens).toBe(1000);
		expect(session.outputTokens).toBe(500);
		expect(session.cacheReadTokens).toBe(200);
		expect(session.cacheCreationTokens).toBe(100);
		expect(session.costUsd).toBeGreaterThan(0);
		expect(session.durationSeconds).toBe(5);
	});
});

// ===== from src/__tests__/cli/services/maestro-client.test.ts =====

// Track WebSocket instances created
let mockWsInstance: EventEmitter & {
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	readyState: number;
};

describe('MaestroClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('connect()', () => {
		it('should throw when no discovery file exists', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			const client = new MaestroClient();
			await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		});

		it('should throw when PID is stale', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(false);

			const client = new MaestroClient();
			await expect(client.connect()).rejects.toThrow('Maestro discovery file is stale');
		});

		it('should connect successfully when server is running', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Simulate WebSocket open event
			mockWsInstance.emit('open');

			await connectPromise;

			// Verify connection was established (mockWsInstance is set)
			expect(mockWsInstance).toBeDefined();
		});

		it('should reject on WebSocket error', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Simulate WebSocket error
			mockWsInstance.emit('error', new Error('Connection refused'));

			await expect(connectPromise).rejects.toThrow(
				'Failed to connect to Maestro: Connection refused'
			);
		});

		it('should timeout after 5 seconds', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Advance past timeout
			vi.advanceTimersByTime(5001);

			await expect(connectPromise).rejects.toThrow('Connection to Maestro timed out');
		});
	});

	describe('sendCommand()', () => {
		async function createConnectedClient(): Promise<MaestroClient> {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;
			return client;
		}

		it('should throw when not connected', async () => {
			const client = new MaestroClient();
			await expect(client.sendCommand({ type: 'ping' }, 'pong')).rejects.toThrow(
				'Not connected to Maestro'
			);
		});

		it('should resolve via requestId when response includes matching requestId', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string; data: string }>(
				{ type: 'ping' },
				'pong'
			);

			// Extract the requestId that was sent
			const sentPayload = JSON.parse(mockWsInstance.send.mock.calls[0][0] as string) as Record<
				string,
				unknown
			>;
			expect(sentPayload.requestId).toBeDefined();

			// Respond with the same requestId (triggers requestId-based resolution)
			mockWsInstance.emit(
				'message',
				JSON.stringify({ type: 'pong', data: 'ok', requestId: sentPayload.requestId })
			);

			const result = await commandPromise;
			expect(result.type).toBe('pong');
			expect(result.data).toBe('ok');
		});

		it('should resolve on matching response type', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string; data: string }>(
				{ type: 'ping' },
				'pong'
			);

			// Simulate matching response
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong', data: 'ok' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
			expect(result.data).toBe('ok');
			expect(mockWsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
		});

		it('should reject on timeout', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong', 2000);

			// Advance past timeout
			vi.advanceTimersByTime(2001);

			// The error names the expected response type so callers can tell which
			// command stalled.
			await expect(commandPromise).rejects.toThrow("expected 'pong'");
		});

		it('should use default 10s timeout', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			// At 9.9s it should still be pending
			vi.advanceTimersByTime(9900);

			// At 10.1s it should timeout
			vi.advanceTimersByTime(200);

			await expect(commandPromise).rejects.toThrow('Timed out waiting for the Maestro app');
		});

		it('rejects immediately with UnsupportedCommandError when the app echoes back', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'brand_new_cmd' }, 'brand_new_cmd_result');

			// The app does not recognize the type and replies with an echo carrying
			// the original message (and its requestId) under `data`.
			const sent = JSON.parse((mockWsInstance.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
			mockWsInstance.emit(
				'message',
				JSON.stringify({
					type: 'echo',
					originalType: 'brand_new_cmd',
					data: { type: 'brand_new_cmd', requestId: sent.requestId },
				})
			);

			await expect(commandPromise).rejects.toThrow("does not support the 'brand_new_cmd' command");
		});

		it('should ignore non-matching response types', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Send non-matching response first
			mockWsInstance.emit('message', JSON.stringify({ type: 'other_event', data: 'ignored' }));

			// Then matching one
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
		});

		it('should ignore non-JSON messages', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Send invalid JSON
			mockWsInstance.emit('message', 'not json');

			// Then send valid matching message
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
		});
	});

	describe('disconnect()', () => {
		it('should close the WebSocket connection', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			client.disconnect();

			expect(mockWsInstance.close).toHaveBeenCalled();
		});

		it('should reject pending requests on disconnect', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			client.disconnect();

			await expect(commandPromise).rejects.toThrow('Client disconnected');
		});

		it('should be safe to call when not connected', () => {
			const client = new MaestroClient();
			expect(() => client.disconnect()).not.toThrow();
		});
	});
});

describe('withMaestroClient()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should connect, run action, and disconnect', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionResult = 'action-result';
		const actionFn = vi.fn().mockResolvedValue(actionResult);

		const resultPromise = withMaestroClient(actionFn);

		// Wait for connect
		mockWsInstance.emit('open');

		const result = await resultPromise;

		expect(result).toBe(actionResult);
		expect(actionFn).toHaveBeenCalledTimes(1);
		// Should disconnect after action
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should disconnect even when action throws', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionFn = vi.fn().mockRejectedValue(new Error('Action failed'));

		const resultPromise = withMaestroClient(actionFn);
		mockWsInstance.emit('open');

		await expect(resultPromise).rejects.toThrow('Action failed');
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should propagate connection errors', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);

		await expect(withMaestroClient(async () => 'should not reach')).rejects.toThrow(
			'Maestro desktop app is not running'
		);
	});
});

describe('resolveSessionId()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return provided session option directly', () => {
		const result = resolveSessionId({ session: 'my-session-id' });
		expect(result).toBe('my-session-id');
		expect(readSessions).not.toHaveBeenCalled();
	});

	it('should return first session ID when no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([
			{
				id: 'first-session',
				name: 'First',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
			{
				id: 'second-session',
				name: 'Second',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
		]);

		const result = resolveSessionId({});
		expect(result).toBe('first-session');
	});

	it('should exit when no sessions exist and no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([]);
		const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit called');
		});
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => resolveSessionId({})).toThrow('process.exit called');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No agents found'));

		processExitSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});
