// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/ipc/handlers/context-timeline.test.ts
//   - src/__tests__/main/ipc/handlers/wakatime.test.ts

import { registerContextTimelineHandlers } from '../../../../main/ipc/handlers/context-timeline';
import { registerWakatimeHandlers } from '../../../../main/ipc/handlers/wakatime';
import {
	__resetUsageCaptureLogForTests,
	appendUsageCapture,
	getUsageCaptures,
} from '../../../../main/process-listeners/context-timeline-log';
import type { UsageStats } from '../../../../shared/types';
import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

// ===== from src/__tests__/main/ipc/handlers/context-timeline.test.ts =====

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 100,
	outputTokens: 50,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0,
	contextWindow: 200000,
	...overrides,
});

describe('Context Timeline IPC Handlers', () => {
	let handlers: Map<string, Handler>;

	beforeEach(() => {
		vi.clearAllMocks();
		__resetUsageCaptureLogForTests();
		handlers = new Map();
		(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			(channel: string, handler: Handler) => {
				handlers.set(channel, handler);
			}
		);
		registerContextTimelineHandlers();
	});

	it('registers both channels', () => {
		expect(handlers.has('contextTimeline:getCaptures')).toBe(true);
		expect(handlers.has('contextTimeline:clearCaptures')).toBe(true);
	});

	it('returns the captures and the trimmed flag for an agent', async () => {
		appendUsageCapture('agent-1', usage({ inputTokens: 1 }));
		appendUsageCapture('agent-1-ai-tab1', usage({ inputTokens: 2 }));

		const result = (await handlers.get('contextTimeline:getCaptures')!(null, 'agent-1')) as {
			success: boolean;
			captures: Array<{ usageStats: UsageStats }>;
			trimmed: boolean;
		};

		expect(result.success).toBe(true);
		expect(result.trimmed).toBe(false);
		expect(result.captures.map((c) => c.usageStats.inputTokens)).toEqual([1, 2]);
	});

	it('returns an empty result for a null session id', async () => {
		const result = (await handlers.get('contextTimeline:getCaptures')!(null, null)) as {
			success: boolean;
			captures: unknown[];
		};
		expect(result.success).toBe(true);
		expect(result.captures).toEqual([]);
	});

	it('does not read anything off the IPC event (web-desktop bridge has no sender)', async () => {
		appendUsageCapture('agent-1', usage());
		const hostileEvent = new Proxy(
			{},
			{
				get() {
					throw new Error('handler must not touch the IPC event');
				},
			}
		);
		await expect(
			handlers.get('contextTimeline:getCaptures')!(hostileEvent, 'agent-1')
		).resolves.toMatchObject({ success: true });
	});

	it('clears the captures for an agent', async () => {
		appendUsageCapture('agent-1', usage());
		appendUsageCapture('agent-2', usage());

		const result = (await handlers.get('contextTimeline:clearCaptures')!(null, 'agent-1')) as {
			success: boolean;
		};

		expect(result.success).toBe(true);
		expect(getUsageCaptures('agent-1').captures).toHaveLength(0);
		expect(getUsageCaptures('agent-2').captures).toHaveLength(1);
	});
});

// ===== from src/__tests__/main/ipc/handlers/wakatime.test.ts =====

// Mock execFileNoThrow
const mockExecFileNoThrow = vi.fn();

/** Create a mock WakaTimeManager with configurable behavior */
function createMockWakaTimeManager(
	overrides: {
		ensureCliInstalled?: () => Promise<boolean>;
		getCliPath?: () => string | null;
	} = {}
) {
	return {
		ensureCliInstalled: overrides.ensureCliInstalled ?? vi.fn().mockResolvedValue(true),
		getCliPath: overrides.getCliPath ?? vi.fn().mockReturnValue('/usr/local/bin/wakatime-cli'),
		sendHeartbeat: vi.fn(),
		removeSession: vi.fn(),
	} as any;
}

describe('WakaTime IPC Handlers', () => {
	const handlers: Map<string, Function> = new Map();

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});
	});

	describe('wakatime:checkCli', () => {
		it('should register the handler', () => {
			registerWakatimeHandlers(createMockWakaTimeManager());
			expect(handlers.has('wakatime:checkCli')).toBe(true);
		});

		it('should return available: true with version when CLI is installed', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime-cli 1.73.0' });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockManager.getCliPath).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('/usr/local/bin/wakatime-cli', [
				'--version',
			]);
		});

		it('should return available: false when ensureCliInstalled fails', async () => {
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(false),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return available: false when getCliPath returns null', async () => {
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(null),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should trigger auto-install via ensureCliInstalled', async () => {
			const cliPath = '/home/user/.wakatime/wakatime-cli-linux-amd64';
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(true),
				getCliPath: vi.fn().mockReturnValue(cliPath),
			});
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.90.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime-cli 1.90.0' });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith(cliPath, ['--version']);
		});
	});

	describe('wakatime:validateApiKey', () => {
		it('should register the handler', () => {
			registerWakatimeHandlers(createMockWakaTimeManager());
			expect(handlers.has('wakatime:validateApiKey')).toBe(true);
		});

		it('should return valid: false for empty key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, '');

			expect(result).toEqual({ valid: false });
			expect(mockManager.ensureCliInstalled).not.toHaveBeenCalled();
		});

		it('should return valid: true when CLI validates the key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			// Key validation succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('/usr/local/bin/wakatime-cli', [
				'--key',
				'waka_test_key_123',
				'--today',
			]);
		});

		it('should return valid: false when CLI rejects the key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			// Key validation fails
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 1,
				stdout: '',
				stderr: 'Invalid API key',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_bad_key');

			expect(result).toEqual({ valid: false });
		});

		it('should return valid: false when CLI is not available', async () => {
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(false),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return valid: false when getCliPath returns null', async () => {
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(null),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should use the manager CLI path for validation', async () => {
			const cliPath = '/home/user/.wakatime/wakatime-cli-linux-amd64';
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(cliPath),
			});
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockExecFileNoThrow).toHaveBeenCalledWith(cliPath, [
				'--key',
				'waka_test_key_123',
				'--today',
			]);
		});
	});
});
