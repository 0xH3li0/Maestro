// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-ipc-handlers.test.ts
//   - src/__tests__/main/cue/cue-webhook-server.test.ts
//   - src/__tests__/main/cue/cue-yaml-write.test.ts

import {
	deleteCueConfigFile,
	pruneOrphanedPromptFiles,
	readCueConfigFile,
	readCuePromptFile,
	removeEmptyMaestroDir,
	removeEmptyPromptsDir,
	writeCueConfigFile,
	writeCuePromptFile,
} from '../../../main/cue/config/cue-config-repository';
import { renamePipelineOnDisk } from '../../../main/cue/cue-pipeline-rename';
import {
	handleCueWebhookRequest,
	registerCueWebhook,
	resetCueWebhookServerForTests,
} from '../../../main/cue/cue-webhook-server';
import type {
	CueWebhookDelivery,
	CueWebhookRegistration,
} from '../../../main/cue/cue-webhook-server';
import { validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import {
	extractLeadingCommentBlock,
	writeCueYamlAtomicSync,
} from '../../../main/cue/cue-yaml-write';
import { loadPipelineLayout, savePipelineLayout } from '../../../main/cue/pipeline-layout-store';
import { registerCueHandlers } from '../../../main/ipc/handlers/cue';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import type * as http from 'http';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));
vi.mock('js-yaml', () => ({
	load: vi.fn(),
}));
vi.mock('../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging: vi.fn(
		(
			_opts: unknown,
			handler: (...args: unknown[]) => unknown
		): ((_event: unknown, ...args: unknown[]) => unknown) => {
			return (_event: unknown, ...args: unknown[]) => handler(...args);
		}
	),
}));
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	validateCueConfig: vi.fn(),
}));
vi.mock('../../../main/cue/config/cue-config-repository', () => ({
	readCueConfigFile: vi.fn(),
	readCuePromptFile: vi.fn(),
	writeCueConfigFile: vi.fn(),
	deleteCueConfigFile: vi.fn(),
	writeCuePromptFile: vi.fn(),
	pruneOrphanedPromptFiles: vi.fn(() => []),
	removeEmptyPromptsDir: vi.fn(() => false),
	removeEmptyMaestroDir: vi.fn(() => false),
}));
vi.mock('../../../main/cue/pipeline-layout-store', () => ({
	savePipelineLayout: vi.fn(),
	loadPipelineLayout: vi.fn(),
}));
vi.mock('../../../main/cue/cue-pipeline-rename', () => ({
	renamePipelineOnDisk: vi.fn(),
}));
vi.mock('../../../main/cue/cue-types', () => ({
	CUE_YAML_FILENAME: 'maestro-cue.yaml', // legacy name kept in cue-types for compat
}));

// ===== from src/__tests__/main/cue/cue-ipc-handlers.test.ts =====

// Track registered IPC handlers
const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

// Create a mock CueEngine
function createMockEngine() {
	return {
		getSettings: vi.fn().mockReturnValue({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		}),
		getStatus: vi.fn().mockReturnValue([]),
		getActiveRuns: vi.fn().mockReturnValue([]),
		getActivityLog: vi.fn().mockReturnValue([]),
		getEventCount: vi.fn().mockReturnValue(0),
		start: vi.fn(),
		stop: vi.fn(),
		stopRun: vi.fn().mockReturnValue(true),
		stopAll: vi.fn(),
		triggerSubscription: vi.fn().mockReturnValue(true),
		getQueueStatus: vi.fn().mockReturnValue(new Map()),
		refreshSession: vi.fn(),
		removeSession: vi.fn(),
		getGraphData: vi.fn().mockReturnValue([]),
		isEnabled: vi.fn().mockReturnValue(false),
	};
}

describe('Cue IPC Handlers', () => {
	let mockEngine: ReturnType<typeof createMockEngine>;

	beforeEach(() => {
		registeredHandlers.clear();
		vi.clearAllMocks();
		// clearAllMocks wipes call history but NOT return values, so the
		// change-detection reads in cue:writeYaml could otherwise inherit a
		// mockReturnValue from a prior test and silently skip a write. Reset the
		// read mocks to their "nothing on disk" default each test.
		vi.mocked(readCueConfigFile).mockReturnValue(null);
		vi.mocked(readCuePromptFile).mockReturnValue(null);
		mockEngine = createMockEngine();
	});

	afterEach(() => {
		registeredHandlers.clear();
	});

	function registerAndGetHandler(channel: string) {
		registerCueHandlers({
			getCueEngine: () => mockEngine as any,
		});
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`Handler for channel "${channel}" not registered`);
		}
		return handler;
	}

	describe('handler registration', () => {
		it('should register all expected IPC channels', () => {
			registerCueHandlers({
				getCueEngine: () => mockEngine as any,
			});

			const expectedChannels = [
				'cue:getSettings',
				'cue:getStatus',
				'cue:getActiveRuns',
				'cue:getActivityLog',
				'cue:enable',
				'cue:disable',
				'cue:stopRun',
				'cue:stopAll',
				'cue:triggerSubscription',
				'cue:getQueueStatus',
				'cue:refreshSession',
				'cue:removeSession',
				'cue:getGraphData',
				'cue:readYaml',
				'cue:writeYaml',
				'cue:deleteYaml',
				'cue:validateYaml',
				'cue:renamePipeline',
				'cue:savePipelineLayout',
				'cue:loadPipelineLayout',
			];

			for (const channel of expectedChannels) {
				expect(registeredHandlers.has(channel)).toBe(true);
			}
		});
	});

	describe('engine not initialized', () => {
		it('should throw when engine is null', async () => {
			registerCueHandlers({
				getCueEngine: () => null,
			});

			const handler = registeredHandlers.get('cue:getStatus')!;
			await expect(handler(null)).rejects.toThrow('Cue engine not initialized');
		});
	});

	describe('cue:getStatus', () => {
		it('should delegate to engine.getStatus()', async () => {
			const mockStatus = [
				{
					sessionId: 's1',
					sessionName: 'Test',
					toolType: 'claude-code',
					enabled: true,
					subscriptionCount: 2,
					activeRuns: 0,
				},
			];
			mockEngine.getStatus.mockReturnValue(mockStatus);

			const handler = registerAndGetHandler('cue:getStatus');
			const result = await handler(null);
			expect(result).toEqual(mockStatus);
			expect(mockEngine.getStatus).toHaveBeenCalledOnce();
		});
	});

	describe('cue:getActiveRuns', () => {
		it('should delegate to engine.getActiveRuns()', async () => {
			const mockRuns = [{ runId: 'r1', status: 'running' }];
			mockEngine.getActiveRuns.mockReturnValue(mockRuns);

			const handler = registerAndGetHandler('cue:getActiveRuns');
			const result = await handler(null);
			expect(result).toEqual(mockRuns);
			expect(mockEngine.getActiveRuns).toHaveBeenCalledOnce();
		});
	});

	describe('cue:getActivityLog', () => {
		it('should delegate to engine.getActivityLog() with limit', async () => {
			const mockLog = [{ runId: 'r1', status: 'completed' }];
			mockEngine.getActivityLog.mockReturnValue(mockLog);

			const handler = registerAndGetHandler('cue:getActivityLog');
			const result = await handler(null, { limit: 10 });
			expect(result).toEqual(mockLog);
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(10);
		});

		it('should pass undefined limit when not provided', async () => {
			const handler = registerAndGetHandler('cue:getActivityLog');
			await handler(null, {});
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(undefined);
		});
	});

	describe('cue:enable', () => {
		it('should call engine.start() with system-boot reason', async () => {
			const handler = registerAndGetHandler('cue:enable');
			await handler(null);
			expect(mockEngine.start).toHaveBeenCalledWith('system-boot');
		});
	});

	describe('cue:disable', () => {
		it('should call engine.stop()', async () => {
			const handler = registerAndGetHandler('cue:disable');
			await handler(null);
			expect(mockEngine.stop).toHaveBeenCalledOnce();
		});
	});

	describe('cue:removeSession', () => {
		it('should call engine.removeSession()', async () => {
			const handler = registerAndGetHandler('cue:removeSession');
			await handler(null, { sessionId: 's1' });
			expect(mockEngine.removeSession).toHaveBeenCalledWith('s1');
		});
	});

	describe('cue:stopRun', () => {
		it('should delegate to engine.stopRun() with runId', async () => {
			mockEngine.stopRun.mockReturnValue(true);
			const handler = registerAndGetHandler('cue:stopRun');
			const result = await handler(null, { runId: 'run-123' });
			expect(result).toBe(true);
			expect(mockEngine.stopRun).toHaveBeenCalledWith('run-123');
		});

		it('should return false when run not found', async () => {
			mockEngine.stopRun.mockReturnValue(false);
			const handler = registerAndGetHandler('cue:stopRun');
			const result = await handler(null, { runId: 'nonexistent' });
			expect(result).toBe(false);
		});
	});

	describe('cue:stopAll', () => {
		it('should call engine.stopAll()', async () => {
			const handler = registerAndGetHandler('cue:stopAll');
			await handler(null);
			expect(mockEngine.stopAll).toHaveBeenCalledOnce();
		});
	});

	describe('cue:refreshSession', () => {
		it('should delegate to engine.refreshSession()', async () => {
			const handler = registerAndGetHandler('cue:refreshSession');
			await handler(null, { sessionId: 's1', projectRoot: '/projects/test' });
			expect(mockEngine.refreshSession).toHaveBeenCalledWith('s1', '/projects/test');
		});
	});

	describe('cue:readYaml', () => {
		it('should return file content when file exists', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: 'subscriptions: []',
			});

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe('subscriptions: []');
			expect(readCueConfigFile).toHaveBeenCalledWith('/projects/test');
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue(null);

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBeNull();
		});
	});

	describe('cue:writeYaml', () => {
		it('should delegate to writeCueConfigFile', async () => {
			const content = 'subscriptions:\n  - name: test\n    event: time.heartbeat';

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content });
			expect(writeCueConfigFile).toHaveBeenCalledWith('/projects/test', content);
		});

		it('returns changed=true and writes when YAML differs from disk', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: 'subscriptions: []',
			});
			const content = 'subscriptions:\n  - name: new';

			const handler = registerAndGetHandler('cue:writeYaml');
			const result = await handler(null, { projectRoot: '/projects/test', content });

			expect(writeCueConfigFile).toHaveBeenCalledWith('/projects/test', content);
			expect(result).toEqual({ changed: true });
		});

		it('skips the write and returns changed=false when YAML is byte-identical (layout-only save)', async () => {
			const content = 'subscriptions:\n  - name: same';
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: content,
			});

			const handler = registerAndGetHandler('cue:writeYaml');
			const result = await handler(null, { projectRoot: '/projects/test', content });

			// Identical content must NOT touch cue.yaml: no mtime bump → the config
			// watcher stays quiet → the session never re-arms → no re-execution.
			expect(writeCueConfigFile).not.toHaveBeenCalled();
			expect(result).toEqual({ changed: false });
		});

		it('skips an identical prompt file but still reports changed when YAML differs', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: 'old yaml',
			});
			vi.mocked(readCuePromptFile).mockReturnValue('identical body');

			const handler = registerAndGetHandler('cue:writeYaml');
			const result = await handler(null, {
				projectRoot: '/projects/test',
				content: 'subscriptions: []',
				promptFiles: { '.maestro/prompts/sub-1.md': 'identical body' },
			});

			expect(writeCuePromptFile).not.toHaveBeenCalled();
			expect(result).toEqual({ changed: true });
		});

		it('returns changed=true when only a prompt file changed (YAML identical)', async () => {
			const content = 'subscriptions: []';
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: content,
			});
			vi.mocked(readCuePromptFile).mockReturnValue('old body');

			const handler = registerAndGetHandler('cue:writeYaml');
			const result = await handler(null, {
				projectRoot: '/projects/test',
				content,
				promptFiles: { '.maestro/prompts/sub-1.md': 'new body' },
			});

			expect(writeCueConfigFile).not.toHaveBeenCalled();
			expect(writeCuePromptFile).toHaveBeenCalledWith(
				'/projects/test',
				'.maestro/prompts/sub-1.md',
				'new body'
			);
			expect(result).toEqual({ changed: true });
		});

		it('adds fan_out_prompt_files entries to the prune keep-set', async () => {
			// Regression guard: without this, per-agent fan-out prompt files
			// would be deleted by pruneOrphanedPromptFiles on every save -
			// only `prompt_file` and `output_prompt_file` were kept.
			vi.mocked(yaml.load).mockReturnValue({
				subscriptions: [
					{
						name: 'fan-out',
						event: 'app.startup',
						fan_out: ['A', 'B', 'C'],
						fan_out_prompt_files: [
							'.maestro/prompts/a-pipe.md',
							'.maestro/prompts/b-pipe.md',
							'.maestro/prompts/c-pipe.md',
						],
					},
				],
			});

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content: 'ignored-by-mock' });

			expect(pruneOrphanedPromptFiles).toHaveBeenCalledTimes(1);
			const [, keepSet] = vi.mocked(pruneOrphanedPromptFiles).mock.calls[0];
			const kept = [...(keepSet as Iterable<string>)];
			expect(kept).toEqual(
				expect.arrayContaining([
					'.maestro/prompts/a-pipe.md',
					'.maestro/prompts/b-pipe.md',
					'.maestro/prompts/c-pipe.md',
				])
			);
		});

		it('should also write external prompt files when provided', async () => {
			const content = 'subscriptions: []';
			const promptFiles = {
				'.maestro/prompts/sub-1.md': 'prompt body 1',
				'.maestro/prompts/sub-2.md': 'prompt body 2',
			};

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content, promptFiles });

			expect(writeCueConfigFile).toHaveBeenCalledWith('/projects/test', content);
			expect(writeCuePromptFile).toHaveBeenCalledWith(
				'/projects/test',
				'.maestro/prompts/sub-1.md',
				'prompt body 1'
			);
			expect(writeCuePromptFile).toHaveBeenCalledWith(
				'/projects/test',
				'.maestro/prompts/sub-2.md',
				'prompt body 2'
			);
		});

		// Security-hardening tests: reject malformed prompt-file keys that
		// could write outside the .maestro/prompts/ directory. The handler
		// validates and throws synchronously from inside the async callback -
		// vi.mock's `withIpcErrorLogging` preserves the rejection.
		//
		// Every negative case must also assert that writeCueConfigFile was
		// NOT called - rejecting the promptFile loop must abort the whole
		// save, otherwise the YAML would land on disk while referencing a
		// prompt file that was never written.
		describe('prompt-file path hardening', () => {
			it('rejects empty string keys', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '': 'x' },
					})
				).rejects.toThrow(/must be a non-empty string/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects absolute paths', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '/etc/passwd.md': 'x' },
					})
				).rejects.toThrow(/must be a relative path/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with parent-directory segments', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '../../escape.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with single-dot segments', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/./sub.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths that resolve outside .maestro/prompts/', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { 'not-prompts/file.md': 'x' },
					})
				).rejects.toThrow(/resolves outside the .maestro\/prompts directory/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with mixed-in parent segments that pre-normalize to a valid location', async () => {
				// 'prompts/../../escape.md' - .split('/') catches the '..'
				// segment before path.resolve normalizes it away.
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/../../escape.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects non-.md extensions', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/payload.sh': 'x' },
					})
				).rejects.toThrow(/must end with .md/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('normalizes Windows backslash paths to forward-slash before writing', async () => {
				// Only meaningful on non-Windows, where path.sep is '/'. Windows
				// already accepts both separators via path.resolve.
				if (process.platform === 'win32') return;
				const handler = registerAndGetHandler('cue:writeYaml');
				await handler(null, {
					projectRoot: '/projects/test',
					content: 'subscriptions: []',
					promptFiles: { '.maestro\\prompts\\sub.md': 'body' },
				});
				// Normalized separator is stored as the written-file key.
				expect(writeCuePromptFile).toHaveBeenCalledWith(
					'/projects/test',
					'.maestro/prompts/sub.md',
					'body'
				);
			});
		});
	});

	describe('cue:deleteYaml', () => {
		it('should delegate to deleteCueConfigFile and return its result', async () => {
			vi.mocked(deleteCueConfigFile).mockReturnValue(true);

			const handler = registerAndGetHandler('cue:deleteYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe(true);
			expect(deleteCueConfigFile).toHaveBeenCalledWith('/projects/test');
		});

		it('returns false when there is nothing to delete', async () => {
			vi.mocked(deleteCueConfigFile).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:deleteYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe(false);
		});

		it('prunes all .md prompt files and removes the empty prompts dir', async () => {
			// The "Remove Cue configuration" button must collapse the project's
			// `.maestro` footprint - deleting the yaml alone used to leave
			// orphaned prompt files behind forever.
			vi.mocked(deleteCueConfigFile).mockReturnValue(true);

			const handler = registerAndGetHandler('cue:deleteYaml');
			await handler(null, { projectRoot: '/projects/test' });

			// Keep-set is empty - everything in .maestro/prompts/ is orphaned.
			expect(pruneOrphanedPromptFiles).toHaveBeenCalledWith('/projects/test', []);
			// Then collapse the now-empty prompts directory, then .maestro/ itself.
			expect(removeEmptyPromptsDir).toHaveBeenCalledWith('/projects/test');
			expect(removeEmptyMaestroDir).toHaveBeenCalledWith('/projects/test');
		});

		it('prunes prompts even when the yaml file was already absent', async () => {
			// Users sometimes delete cue.yaml by hand, then click the Remove
			// button. Cleanup must still run so orphaned prompts don't linger.
			vi.mocked(deleteCueConfigFile).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:deleteYaml');
			await handler(null, { projectRoot: '/projects/test' });

			expect(pruneOrphanedPromptFiles).toHaveBeenCalledWith('/projects/test', []);
			expect(removeEmptyPromptsDir).toHaveBeenCalledWith('/projects/test');
			expect(removeEmptyMaestroDir).toHaveBeenCalledWith('/projects/test');
		});
	});

	describe('cue:validateYaml', () => {
		it('should return valid result for valid YAML', async () => {
			const content = 'subscriptions: []';
			vi.mocked(yaml.load).mockReturnValue({ subscriptions: [] });
			vi.mocked(validateCueConfig).mockReturnValue({ valid: true, errors: [] });

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({ valid: true, errors: [] });
			expect(yaml.load).toHaveBeenCalledWith(content);
			expect(validateCueConfig).toHaveBeenCalledWith({ subscriptions: [] });
		});

		it('should return errors for invalid config', async () => {
			const content = 'subscriptions: invalid';
			vi.mocked(yaml.load).mockReturnValue({ subscriptions: 'invalid' });
			vi.mocked(validateCueConfig).mockReturnValue({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});
		});

		it('should return parse error for malformed YAML', async () => {
			const content = '{{invalid yaml';
			vi.mocked(yaml.load).mockImplementation(() => {
				throw new Error('bad indentation');
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({
				valid: false,
				errors: ['YAML parse error: bad indentation'],
			});
		});
	});

	describe('edge cases', () => {
		it('cue:getStatus returns empty array when engine not started', async () => {
			// Engine exists but getStatus returns empty (no sessions registered)
			mockEngine.getStatus.mockReturnValue([]);

			const handler = registerAndGetHandler('cue:getStatus');
			const result = await handler(null);
			expect(result).toEqual([]);
			expect(mockEngine.getStatus).toHaveBeenCalledOnce();
		});

		it('cue:getActivityLog with limit returns bounded results', async () => {
			const manyEntries = Array.from({ length: 10 }, (_, i) => ({
				runId: `r${i}`,
				sessionId: 's1',
				sessionName: 'Test',
				subscriptionName: 'timer',
				event: {
					id: `e${i}`,
					type: 'time.heartbeat',
					timestamp: new Date().toISOString(),
					triggerName: 'timer',
					payload: {},
				},
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			}));

			// Simulate engine returning only the last 2 entries (bounded by limit)
			mockEngine.getActivityLog.mockReturnValue(manyEntries.slice(-2));

			const handler = registerAndGetHandler('cue:getActivityLog');
			const result = await handler(null, { limit: 2 });

			expect(result).toHaveLength(2);
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(2);
		});

		it('cue:validateYaml handles empty content', async () => {
			// Empty string: yaml.load returns undefined/null for empty input
			vi.mocked(yaml.load).mockReturnValue(undefined);
			vi.mocked(validateCueConfig).mockReturnValue({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = (await handler(null, { content: '' })) as { valid: boolean; errors: string[] };

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe('cue:savePipelineLayout', () => {
		it('should delegate to savePipelineLayout', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 0, y: 0, zoom: 1 },
			};

			const handler = registerAndGetHandler('cue:savePipelineLayout');
			await handler(null, { layout });
			expect(savePipelineLayout).toHaveBeenCalledWith(layout);
		});
	});

	describe('cue:renamePipeline', () => {
		const okResult = {
			renamed: true,
			subscriptionsUpdated: 2,
			filesWritten: ['/a/.maestro/cue.yaml'],
			warnings: [],
		};

		it('enumerates the roots itself rather than trusting the caller', async () => {
			// The invariant that matters: a cross-agent pipeline is physically N
			// files at N roots, and the engine is the only side that knows the
			// whole set. A handler that renamed only a caller-supplied root would
			// leave half the pipeline under the old name.
			mockEngine.getStatus.mockReturnValue([
				{ projectRoot: '/a' },
				{ projectRoot: '/b' },
				{ projectRoot: '/c' },
			]);
			vi.mocked(renamePipelineOnDisk).mockReturnValue(okResult);

			const handler = registerAndGetHandler('cue:renamePipeline');
			await handler(null, { oldName: 'Old', newName: 'New' });

			expect(renamePipelineOnDisk).toHaveBeenCalledWith(['/a', '/b', '/c'], 'Old', 'New');
		});

		it('drops a session with no usable project root', async () => {
			// A session can be registered before its root resolves. Passing '' or
			// undefined down would make the rename resolve a config path relative
			// to the process cwd.
			mockEngine.getStatus.mockReturnValue([
				{ projectRoot: '/a' },
				{ projectRoot: '' },
				{ projectRoot: undefined },
				{},
			]);
			vi.mocked(renamePipelineOnDisk).mockReturnValue(okResult);

			const handler = registerAndGetHandler('cue:renamePipeline');
			await handler(null, { oldName: 'Old', newName: 'New' });

			expect(renamePipelineOnDisk).toHaveBeenCalledWith(['/a'], 'Old', 'New');
		});

		it('returns the result unchanged, including a refusal', async () => {
			// The renderer decides how to present a refusal, so the handler must
			// not flatten one into a thrown error or a bare boolean.
			const refusal = {
				renamed: false,
				subscriptionsUpdated: 0,
				filesWritten: [],
				reason: 'the name is unchanged',
				warnings: ['could not read /b/.maestro/cue.yaml: EACCES'],
			};
			mockEngine.getStatus.mockReturnValue([{ projectRoot: '/a' }]);
			vi.mocked(renamePipelineOnDisk).mockReturnValue(refusal);

			const handler = registerAndGetHandler('cue:renamePipeline');
			await expect(handler(null, { oldName: 'Old', newName: 'Old' })).resolves.toEqual(refusal);
		});

		it('throws when the engine is not initialized', async () => {
			registerCueHandlers({ getCueEngine: () => null });
			const handler = registeredHandlers.get('cue:renamePipeline')!;
			await expect(handler(null, { oldName: 'Old', newName: 'New' })).rejects.toThrow();
			expect(renamePipelineOnDisk).not.toHaveBeenCalled();
		});
	});

	describe('cue:triggerSubscription', () => {
		it('should pass subscriptionName to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, { subscriptionName: 'my-sub' });
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith('my-sub', undefined, undefined);
		});

		it('should pass prompt to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, { subscriptionName: 'my-sub', prompt: 'custom prompt' });
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				'custom prompt',
				undefined
			);
		});

		it('should pass sourceAgentId to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, {
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz-123',
			});
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				undefined,
				'agent-xyz-123'
			);
		});

		it('should pass both prompt and sourceAgentId to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, {
				subscriptionName: 'my-sub',
				prompt: 'override prompt',
				sourceAgentId: 'agent-abc',
			});
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				'override prompt',
				'agent-abc'
			);
		});

		it('should return the boolean result from engine', async () => {
			mockEngine.triggerSubscription.mockReturnValue(false);
			const handler = registerAndGetHandler('cue:triggerSubscription');
			const result = await handler(null, { subscriptionName: 'nonexistent' });
			expect(result).toBe(false);
		});
	});

	describe('cue:loadPipelineLayout', () => {
		it('should return layout when file exists', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 100, y: 200, zoom: 1.5 },
			};
			vi.mocked(loadPipelineLayout).mockReturnValue(layout as any);

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toEqual(layout);
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(loadPipelineLayout).mockReturnValue(null);

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toBeNull();
		});
	});
});

// ===== from src/__tests__/main/cue/cue-webhook-server.test.ts =====

interface FakeResponse {
	status: number | null;
	body: Record<string, unknown> | null;
	writeHead: (status: number, headers: Record<string, unknown>) => void;
	end: (payload: string) => void;
}

function makeResponse(): FakeResponse {
	const res: FakeResponse = {
		status: null,
		body: null,
		writeHead(status) {
			res.status = status;
		},
		end(payload) {
			res.body = payload ? JSON.parse(payload) : null;
		},
	};
	return res;
}

/**
 * Minimal IncomingMessage stand-in. The handler only reads `method`, `url`,
 * `headers`, and the data/end stream events, so emitting the body on the next
 * microtask is enough to drive the real `readBody` path.
 */
function makeRequest(opts: {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
}): http.IncomingMessage {
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = opts.method ?? 'POST';
	req.url = opts.url;
	req.headers = opts.headers ?? {};
	req.destroy = () => {};

	queueMicrotask(() => {
		if (opts.body) req.emit('data', Buffer.from(opts.body, 'utf8'));
		req.emit('end');
	});

	return req;
}

function register(overrides: Partial<CueWebhookRegistration> = {}): {
	deliveries: CueWebhookDelivery[];
	onLog: ReturnType<typeof vi.fn>;
	unregister: () => void;
} {
	const deliveries: CueWebhookDelivery[] = [];
	const onLog = vi.fn();
	const unregister = registerCueWebhook({
		path: 'my-hook',
		secret: 's3cret',
		onDelivery: (d) => deliveries.push(d),
		onLog,
		...overrides,
	});
	return { deliveries, onLog, unregister };
}

describe('cue-webhook-server', () => {
	// Registering starts the shared listener, so pin it to an OS-assigned port:
	// the suite must not fight the default port with a Maestro instance running
	// on the same machine, or with a parallel test worker.
	const originalPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;

	beforeEach(() => {
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		resetCueWebhookServerForTests();
	});

	afterEach(() => {
		resetCueWebhookServerForTests();
		if (originalPort === undefined) {
			delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
		} else {
			process.env.MAESTRO_CUE_WEBHOOK_PORT = originalPort;
		}
	});

	it('accepts an authenticated delivery and hands it to the subscription', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret', 'x-github-event': 'pull_request' },
				body: JSON.stringify({ action: 'opened', number: 7 }),
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(res.body).toEqual({ accepted: 1 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].event).toBe('pull_request');
		expect(deliveries[0].body).toEqual({ action: 'opened', number: 7 });
	});

	it('accepts the secret via an Authorization: Bearer header', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { authorization: 'Bearer s3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects a delivery with the wrong secret and logs against the subscription', async () => {
		const { deliveries, onLog } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 'wrong' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('rejected'));
	});

	it('rejects a delivery with no credentials at all', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ url: '/cue/my-hook', body: '{}' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('verifies an HMAC signature in sha256=<hex> form', async () => {
		const body = JSON.stringify({ action: 'opened' });
		const digest = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': `sha256=${digest}` },
				body,
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects an HMAC signature computed over a different body', async () => {
		const digest = crypto
			.createHmac('sha256', 's3cret')
			.update('{"action":"opened"}')
			.digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': `sha256=${digest}` },
				body: '{"action":"closed"}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('does not accept a bare secret when the registration expects a signature', async () => {
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('strips auth material from the headers handed to the subscription', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: {
					'x-maestro-cue-secret': 's3cret',
					authorization: 'Bearer s3cret',
					cookie: 'session=abc',
					'user-agent': 'GitHub-Hookshot/1',
				},
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		const headers = deliveries[0].headers;
		expect(headers['user-agent']).toBe('GitHub-Hookshot/1');
		expect(headers['x-maestro-cue-secret']).toBeUndefined();
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toBeUndefined();
	});

	it('redacts the signature header too', async () => {
		const body = '{}';
		const digest = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': digest },
				body,
			}),
			res as unknown as http.ServerResponse
		);

		expect(deliveries[0].headers['x-hub-signature-256']).toBeUndefined();
	});

	it('fans one delivery out to every authenticated subscription on the path', async () => {
		const first = register();
		const second = register({ secret: 's3cret' });
		// A third subscription shares the path but expects a different secret,
		// so it must NOT see the payload.
		const third = register({ secret: 'other' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.body).toEqual({ accepted: 2 });
		expect(first.deliveries).toHaveLength(1);
		expect(second.deliveries).toHaveLength(1);
		expect(third.deliveries).toHaveLength(0);
	});

	it('404s an unknown path without revealing whether a secret would have matched', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/nope',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
	});

	it('404s a path outside the /cue/ prefix', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ url: '/my-hook', body: '{}' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
	});

	it('ignores the query string when routing', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook?foo=bar',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects non-POST methods', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ method: 'GET', url: '/cue/my-hook' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(405);
	});

	it('verifies an HMAC over the received bytes, not a re-encoded string', async () => {
		// A body with a byte sequence that is not valid UTF-8. Decoding it to a
		// string and re-encoding would substitute U+FFFD and change the digest,
		// so this only passes if the HMAC is taken over the original buffer.
		const rawBytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
		const digest = crypto.createHmac('sha256', 's3cret').update(rawBytes).digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
		req.method = 'POST';
		req.url = '/cue/my-hook';
		req.headers = { 'x-hub-signature-256': `sha256=${digest}` };
		req.destroy = () => {};
		queueMicrotask(() => {
			req.emit('data', rawBytes);
			req.emit('end');
		});

		await handleCueWebhookRequest(req, res as unknown as http.ServerResponse);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('404s a malformed percent-escape instead of throwing', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ url: '/cue/%', body: '{}' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
	});

	it('answers a broken connection with 400, not 413', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
		req.method = 'POST';
		req.url = '/cue/my-hook';
		req.headers = { 'x-maestro-cue-secret': 's3cret' };
		req.destroy = () => {};
		queueMicrotask(() => req.emit('error', new Error('socket hang up')));

		await handleCueWebhookRequest(req, res as unknown as http.ServerResponse);

		expect(res.status).toBe(400);
		expect(deliveries).toHaveLength(0);
	});

	it('rejects a body larger than the 1 MiB cap before authenticating', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: 'x'.repeat(1024 * 1024 + 1),
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(413);
		expect(deliveries).toHaveLength(0);
	});

	it('surfaces a non-JSON body as raw text with a null parsed body', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: 'build=passed',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries[0].body).toBeNull();
		expect(deliveries[0].rawBody).toBe('build=passed');
	});

	it('stops delivering after the subscription unregisters', async () => {
		const { deliveries, unregister } = register();
		unregister();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
		expect(deliveries).toHaveLength(0);
	});
});

// ===== from src/__tests__/main/cue/cue-yaml-write.test.ts =====

describe('extractLeadingCommentBlock', () => {
	it('captures the leading comment + blank lines including the trailing newline', () => {
		const raw = '# Pipeline: Tasks (color: #abc)\n# second line\n\nsubscriptions:\n  - name: x\n';
		expect(extractLeadingCommentBlock(raw)).toBe(
			'# Pipeline: Tasks (color: #abc)\n# second line\n\n'
		);
	});

	it('returns an empty string when the file opens with content', () => {
		expect(extractLeadingCommentBlock('subscriptions:\n  - name: x\n')).toBe('');
	});

	it('stops at the first non-comment, non-blank line', () => {
		const raw = '# header\nsubscriptions: []\n# trailing comment is NOT part of the header\n';
		expect(extractLeadingCommentBlock(raw)).toBe('# header\n');
	});
});

describe('writeCueYamlAtomicSync', () => {
	let dir = '';

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-yaml-write-'));
	});

	afterEach(() => {
		if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes the content and leaves no temp file behind', () => {
		const target = path.join(dir, 'cue.yaml');
		writeCueYamlAtomicSync(target, 'subscriptions: []\n');
		expect(fs.readFileSync(target, 'utf-8')).toBe('subscriptions: []\n');
		expect(fs.existsSync(target + '.tmp')).toBe(false);
	});

	it('overwrites an existing file in place', () => {
		const target = path.join(dir, 'cue.yaml');
		fs.writeFileSync(target, 'old\n', 'utf-8');
		writeCueYamlAtomicSync(target, 'new\n');
		expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
	});

	it('rethrows and preserves the original file when the rename target is unwritable', () => {
		// Point at a path whose parent does not exist so writeFileSync throws; the
		// original (here, absent) file must be left untouched and the error surfaced.
		const target = path.join(dir, 'no-such-subdir', 'cue.yaml');
		expect(() => writeCueYamlAtomicSync(target, 'data\n')).toThrow();
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(target + '.tmp')).toBe(false);
	});
});
