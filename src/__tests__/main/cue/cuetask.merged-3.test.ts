// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-task-scanner.test.ts
//   - src/__tests__/main/cue/cue-token-accessor.test.ts
//   - src/__tests__/main/cue/cue-session-state.test.ts

import type { AgentSessionInfo, AgentSessionStorage } from '../../../main/agents';
import {
	computeOwnershipWarning,
	countActiveSubscriptions,
	isSubscriptionParticipant,
} from '../../../main/cue/cue-session-state';
import type { OwnershipCandidate } from '../../../main/cue/cue-session-state';
import {
	buildTaskPendingPayload,
	createCueTaskScanner,
	extractPendingTasks,
	scanTaskFilesNow,
} from '../../../main/cue/cue-task-scanner';
import {
	_resetCueTokenAccessorCache,
	getAgentTypesForSessions,
	getSessionTokenSummaries,
} from '../../../main/cue/stats/cue-token-accessor';
import type { CueConfig, CueSubscription } from '../../../shared/cue/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));
vi.mock('picomatch', () => ({
	default: (pattern: string) => {
		// Simple mock: match files ending in .md for "**/*.md" pattern
		if (pattern === '**/*.md' || pattern === 'tasks/**/*.md') {
			return (file: string) => file.endsWith('.md');
		}
		return () => true;
	},
}));
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
	createHash: () => ({
		update: (content: string) => ({
			digest: () => `hash-${content.length}`,
		}),
	}),
}));
vi.mock('../../../main/stats', () => ({
	getStatsDB: vi.fn(() => ({
		database: { prepare: mockPrepare },
	})),
}));
vi.mock('../../../main/agents', () => ({
	getSessionStorage: (agentId: string) => storageRegistry.get(agentId) ?? null,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// ===== from src/__tests__/main/cue/cue-task-scanner.test.ts =====

// Mock fs
const mockReadFileSync = vi.fn();

const mockReaddirSync = vi.fn();

describe('cue-task-scanner', () => {
	describe('extractPendingTasks', () => {
		it('extracts unchecked tasks from markdown', () => {
			const content = `# Tasks
- [ ] First task
- [x] Completed task
- [ ] Second task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(2);
			expect(tasks[0]).toEqual({ line: 2, text: 'First task' });
			expect(tasks[1]).toEqual({ line: 4, text: 'Second task' });
		});

		it('handles indented tasks', () => {
			const content = `# Project
  - [ ] Nested task
    - [ ] Deeply nested
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(2);
			expect(tasks[0].text).toBe('Nested task');
			expect(tasks[1].text).toBe('Deeply nested');
		});

		it('handles different list markers', () => {
			const content = `- [ ] Dash task
* [ ] Star task
+ [ ] Plus task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(3);
		});

		it('returns empty array for no pending tasks', () => {
			const content = `# Done
- [x] All done
- [x] Also done
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(0);
		});

		it('returns empty array for empty content', () => {
			const tasks = extractPendingTasks('');
			expect(tasks).toHaveLength(0);
		});

		it('skips tasks with empty text', () => {
			const content = `- [ ]
- [ ] Real task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].text).toBe('Real task');
		});

		it('does not match checked tasks', () => {
			const content = `- [x] Done
- [X] Also done
- [ ] Not done
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].text).toBe('Not done');
		});
	});

	describe('buildTaskPendingPayload', () => {
		it('maps a file and its tasks into the task.pending payload shape', () => {
			const tasks = [
				{ line: 2, text: 'First' },
				{ line: 5, text: 'Second' },
			];
			const payload = buildTaskPendingPayload(
				'/project/research.md',
				'research.md',
				'- [ ] First\n',
				tasks
			);
			expect(payload).toMatchObject({
				path: '/project/research.md',
				filename: 'research.md',
				directory: '/project',
				extension: '.md',
				taskCount: 2,
				taskList: 'L2: First\nL5: Second',
				tasks,
			});
		});

		it('truncates content to 10K chars', () => {
			const long = 'x'.repeat(20000);
			const payload = buildTaskPendingPayload('/p/a.md', 'a.md', long, [{ line: 1, text: 't' }]);
			expect((payload.content as string).length).toBe(10000);
		});
	});

	describe('scanTaskFilesNow', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('returns files that currently have pending tasks, with no hash dedup', () => {
			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'research.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});
			mockReadFileSync.mockReturnValue('- [ ] open task\n');

			const result = scanTaskFilesNow('/project', '**/*.md');
			expect(result).toHaveLength(1);
			expect(result[0].relPath).toBe('research.md');
			expect(result[0].tasks).toHaveLength(1);
			expect(result[0].tasks[0].text).toBe('open task');

			// Calling again returns the same result - unlike the polling scanner,
			// there is no seeding or content-hash suppression.
			expect(scanTaskFilesNow('/project', '**/*.md')).toHaveLength(1);
		});

		it('skips files with no pending tasks', () => {
			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'done.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});
			mockReadFileSync.mockReturnValue('- [x] done\n');

			expect(scanTaskFilesNow('/project', '**/*.md')).toHaveLength(0);
		});

		it('skips files that do not match the watch glob', () => {
			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'notes.txt', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});
			mockReadFileSync.mockReturnValue('- [ ] open\n');

			expect(scanTaskFilesNow('/project', '**/*.md')).toHaveLength(0);
		});
	});

	describe('createCueTaskScanner', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns a cleanup function', () => {
			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent: vi.fn(),
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});
			expect(typeof cleanup).toBe('function');
			cleanup();
		});

		it('cleanup stops polling', () => {
			const onEvent = vi.fn();
			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			cleanup();

			// Advance past initial delay
			vi.advanceTimersByTime(3000);
			expect(onEvent).not.toHaveBeenCalled();
		});

		it('seeds hashes on first scan without firing events', async () => {
			const onEvent = vi.fn();

			// Mock directory walk: one .md file with pending tasks
			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});
			mockReadFileSync.mockReturnValue('- [ ] Pending task\n');

			createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// Advance past initial delay
			await vi.advanceTimersByTimeAsync(3000);

			// First scan seeds hashes - should NOT fire events
			expect(onEvent).not.toHaveBeenCalled();
		});

		it('fires event on second scan when content has changed and has pending tasks', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// First scan: seed with initial content
			mockReadFileSync.mockReturnValueOnce('- [ ] Initial task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// First scan (seed)
			await vi.advanceTimersByTimeAsync(3000);
			expect(onEvent).not.toHaveBeenCalled();

			// Second scan: content changed, has pending tasks
			mockReadFileSync.mockReturnValue('- [ ] Initial task\n- [ ] New task\n');
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).toHaveBeenCalledTimes(1);
			const event = onEvent.mock.calls[0][0];
			expect(event.type).toBe('task.pending');
			expect(event.triggerName).toBe('test-scanner');
			expect(event.payload.taskCount).toBe(2);
			expect(event.payload.filename).toBe('task.md');

			cleanup();
		});

		it('does not fire when content unchanged', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// Same content every scan
			mockReadFileSync.mockReturnValue('- [ ] Same task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// First scan + second scan
			await vi.advanceTimersByTimeAsync(3000);
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).not.toHaveBeenCalled();
			cleanup();
		});

		it('does not fire when content changed but no pending tasks', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// First scan: has pending tasks
			mockReadFileSync.mockReturnValueOnce('- [ ] Task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// Seed
			await vi.advanceTimersByTimeAsync(3000);

			// Second scan: all tasks completed
			mockReadFileSync.mockReturnValue('- [x] Task\n');
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).not.toHaveBeenCalled();
			cleanup();
		});

		it('logs error when scan fails', async () => {
			const onLog = vi.fn();

			mockReaddirSync.mockImplementation(() => {
				throw new Error('Permission denied');
			});

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent: vi.fn(),
				onLog,
				triggerName: 'test-scanner',
			});

			await vi.advanceTimersByTimeAsync(3000);

			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('Task scan error'));

			cleanup();
		});

		// PR-B 1.4: visibility-aware pause
		describe('isActive gate', () => {
			it('skips the directory walk when isActive returns false', async () => {
				const onEvent = vi.fn();
				const active = false;

				const cleanup = createCueTaskScanner({
					watchGlob: '**/*.md',
					pollMinutes: 1,
					projectRoot: '/project',
					onEvent,
					onLog: vi.fn(),
					triggerName: 'test-scanner',
					isActive: () => active,
				});

				await vi.advanceTimersByTimeAsync(3000);

				expect(onEvent).not.toHaveBeenCalled();
				// Walk never happened - readdirSync should not have been called
				expect(mockReaddirSync).not.toHaveBeenCalled();
				expect(mockReadFileSync).not.toHaveBeenCalled();

				cleanup();
			});

			it('resumes scanning on the next interval when isActive flips back to true', async () => {
				const onEvent = vi.fn();
				let active = false;

				mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
					if (opts?.withFileTypes) {
						return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
					}
					return [];
				});
				mockReadFileSync.mockReturnValue('- [ ] task\n');

				const cleanup = createCueTaskScanner({
					watchGlob: '**/*.md',
					pollMinutes: 1,
					projectRoot: '/project',
					onEvent,
					onLog: vi.fn(),
					triggerName: 'test-scanner',
					isActive: () => active,
				});

				// Initial scan happens but is paused
				await vi.advanceTimersByTimeAsync(3000);
				expect(mockReaddirSync).not.toHaveBeenCalled();

				// Activate - next interval tick should now scan
				active = true;
				await vi.advanceTimersByTimeAsync(60_000); // pollMinutes * 60_000 = 1 min
				expect(mockReaddirSync).toHaveBeenCalled();

				cleanup();
			});

			it('defaults to always-active when isActive is omitted', async () => {
				const onEvent = vi.fn();

				mockReaddirSync.mockImplementation(() => []);

				const cleanup = createCueTaskScanner({
					watchGlob: '**/*.md',
					pollMinutes: 1,
					projectRoot: '/project',
					onEvent,
					onLog: vi.fn(),
					triggerName: 'test-scanner',
					// No isActive - should behave as always-active.
				});

				await vi.advanceTimersByTimeAsync(3000);
				expect(mockReaddirSync).toHaveBeenCalled();

				cleanup();
			});
		});
	});
});

// ===== from src/__tests__/main/cue/cue-token-accessor.test.ts =====

// ─── Mocks ──────────────────────────────────────────────────────────────────

interface SessionLookupRow {
	session_id: string;
	agent_type: string;
	project_path: string | null;
	is_remote: number | null;
}

let lookupRows: SessionLookupRow[] = [];

const mockPrepareAll = vi.fn((...sessionIds: string[]): SessionLookupRow[] =>
	lookupRows.filter((r) => sessionIds.includes(r.session_id))
);

const mockPrepare = vi.fn(() => ({ all: mockPrepareAll }));

const storageRegistry = new Map<string, AgentSessionStorage>();

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInfo(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
	return {
		sessionId: 'p-x',
		projectPath: '/proj',
		timestamp: '2026-04-28T10:00:00.000Z',
		modifiedAt: '2026-04-28T10:30:00.000Z',
		firstMessage: '',
		messageCount: 1,
		sizeBytes: 1024,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 60,
		...overrides,
	};
}

/**
 * Register a fake storage for `agentId` that returns `infos` from
 * `listSessions(projectPath)`. Other methods throw - we never call them.
 */
function registerFakeStorage(agentId: string, infos: AgentSessionInfo[]): void {
	const listSessions = vi.fn(async () => infos);
	storageRegistry.set(agentId, {
		agentId: agentId as AgentSessionStorage['agentId'],
		listSessions,
		listSessionsPaginated: vi.fn() as never,
		readSessionMessages: vi.fn() as never,
		searchSessions: vi.fn() as never,
		getSessionPath: vi.fn(() => null),
		deleteMessagePair: vi.fn() as never,
	});
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue-token-accessor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lookupRows = [];
		storageRegistry.clear();
		_resetCueTokenAccessorCache();
	});

	describe('per-agent coverage mapping', () => {
		it('claude-code session reports full coverage with all token + cost fields', async () => {
			lookupRows = [
				{
					session_id: 'm-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 'p-claude',
					projectPath: '/proj/a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.0123,
					timestamp: '2026-04-28T09:00:00.000Z',
					modifiedAt: '2026-04-28T09:45:00.000Z',
				}),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude', providerSessionId: 'p-claude' },
			]);

			expect(result.size).toBe(1);
			const summary = result.get('p-claude');
			expect(summary).toEqual({
				sessionId: 'p-claude',
				agentType: 'claude-code',
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				costUsd: 0.0123,
				windowStartMs: Date.parse('2026-04-28T09:00:00.000Z'),
				windowEndMs: Date.parse('2026-04-28T09:45:00.000Z'),
				coverage: 'full',
			});
		});

		it('opencode session reports full coverage with cost', async () => {
			lookupRows = [
				{
					session_id: 'm-opencode',
					agent_type: 'opencode',
					project_path: '/proj/oc',
					is_remote: 0,
				},
			];
			registerFakeStorage('opencode', [
				makeInfo({
					sessionId: 'p-opencode',
					projectPath: '/proj/oc',
					inputTokens: 2222,
					outputTokens: 333,
					cacheReadTokens: 44,
					cacheCreationTokens: 5,
					costUsd: 0.05,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-opencode', providerSessionId: 'p-opencode' },
				])
			).get('p-opencode');

			expect(summary?.coverage).toBe('full');
			expect(summary?.inputTokens).toBe(2222);
			expect(summary?.outputTokens).toBe(333);
			expect(summary?.cacheReadTokens).toBe(44);
			expect(summary?.cacheCreationTokens).toBe(5);
			expect(summary?.costUsd).toBe(0.05);
		});

		it('factory-droid session reports full coverage with costUsd === null (no cost field)', async () => {
			lookupRows = [
				{
					session_id: 'm-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/d',
					is_remote: 0,
				},
			];
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 'p-droid',
					projectPath: '/proj/d',
					inputTokens: 700,
					outputTokens: 300,
					cacheReadTokens: 50,
					cacheCreationTokens: 25,
					// no costUsd - droid storage omits it
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-droid', providerSessionId: 'p-droid' },
				])
			).get('p-droid');

			expect(summary?.coverage).toBe('full');
			expect(summary?.costUsd).toBeNull();
			expect(summary?.inputTokens).toBe(700);
		});

		it('codex session reports partial coverage (cacheCreation always 0, no cost)', async () => {
			lookupRows = [
				{
					session_id: 'm-codex',
					agent_type: 'codex',
					project_path: '/proj/cx',
					is_remote: 0,
				},
			];
			registerFakeStorage('codex', [
				makeInfo({
					sessionId: 'p-codex',
					projectPath: '/proj/cx',
					inputTokens: 800,
					outputTokens: 400,
					cacheReadTokens: 90,
					cacheCreationTokens: 0,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-codex', providerSessionId: 'p-codex' },
				])
			).get('p-codex');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(800);
			expect(summary?.cacheCreationTokens).toBe(0);
			expect(summary?.costUsd).toBeNull();
		});

		it('copilot-cli session reports partial coverage', async () => {
			lookupRows = [
				{
					session_id: 'm-copilot',
					agent_type: 'copilot-cli',
					project_path: '/proj/cp',
					is_remote: 0,
				},
			];
			registerFakeStorage('copilot-cli', [
				makeInfo({
					sessionId: 'p-copilot',
					projectPath: '/proj/cp',
					inputTokens: 1500,
					outputTokens: 250,
					cacheReadTokens: 100,
					cacheCreationTokens: 75,
				}),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-copilot', providerSessionId: 'p-copilot' },
				])
			).get('p-copilot');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(1500);
			expect(summary?.costUsd).toBeNull();
		});
	});

	describe('id-space join', () => {
		it('resolves agent/project by Maestro agent id but matches tokens by provider session id', async () => {
			// The whole point of the rewrite: the lookup id (Maestro agent id)
			// and the on-disk session id (provider session id) differ. A naive
			// `byId.get(maestroId)` would miss and report zeros.
			lookupRows = [
				{
					session_id: 'm-agent',
					agent_type: 'claude-code',
					project_path: '/proj/x',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({ sessionId: 'p-run', projectPath: '/proj/x', inputTokens: 4242 }),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-agent', providerSessionId: 'p-run' },
			]);

			expect(result.get('p-run')?.inputTokens).toBe(4242);
		});

		it('provider session not present on disk yields partial zeros (not a miss)', async () => {
			lookupRows = [
				{
					session_id: 'm-agent',
					agent_type: 'claude-code',
					project_path: '/proj/x',
					is_remote: 0,
				},
			];
			registerFakeStorage('claude-code', [
				makeInfo({ sessionId: 'p-other', projectPath: '/proj/x', inputTokens: 100 }),
			]);

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-agent', providerSessionId: 'p-run' },
				])
			).get('p-run');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(0);
		});
	});

	describe('unsupported and missing sessions', () => {
		it('unknown agent type returns coverage=unsupported with zeros', async () => {
			lookupRows = [
				{
					session_id: 'm-unknown',
					agent_type: 'made-up-agent',
					project_path: '/proj/u',
					is_remote: 0,
				},
			];
			// No storage registered for the unknown agent.

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-unknown', providerSessionId: 'p-unknown' },
				])
			).get('p-unknown');

			expect(summary).toEqual({
				sessionId: 'p-unknown',
				agentType: 'made-up-agent',
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: null,
				windowStartMs: 0,
				windowEndMs: 0,
				coverage: 'unsupported',
			});
		});

		it('Maestro agent absent from session_lifecycle is omitted from the result map', async () => {
			lookupRows = []; // DB returns nothing.

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-missing', providerSessionId: 'p-missing' },
			]);

			expect(result.size).toBe(0);
			expect(result.has('p-missing')).toBe(false);
		});

		it('empty input returns empty map without touching the DB', async () => {
			const result = await getSessionTokenSummaries([]);
			expect(result.size).toBe(0);
			expect(mockPrepare).not.toHaveBeenCalled();
		});
	});

	describe('batched mixed-agent lookup', () => {
		it('returns correctly attributed results for sessions across multiple agent types in one call', async () => {
			lookupRows = [
				{
					session_id: 'm-claude',
					agent_type: 'claude-code',
					project_path: '/proj/a',
					is_remote: 0,
				},
				{
					session_id: 'm-codex',
					agent_type: 'codex',
					project_path: '/proj/b',
					is_remote: 0,
				},
				{
					session_id: 'm-droid',
					agent_type: 'factory-droid',
					project_path: '/proj/c',
					is_remote: 0,
				},
				// 'm-missing' is requested below but absent from the lookup table.
			];
			registerFakeStorage('claude-code', [
				makeInfo({
					sessionId: 'p-claude',
					projectPath: '/proj/a',
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cacheCreationTokens: 5,
					costUsd: 0.01,
				}),
			]);
			registerFakeStorage('codex', [
				makeInfo({
					sessionId: 'p-codex',
					projectPath: '/proj/b',
					inputTokens: 200,
					outputTokens: 75,
					cacheReadTokens: 25,
				}),
			]);
			registerFakeStorage('factory-droid', [
				makeInfo({
					sessionId: 'p-droid',
					projectPath: '/proj/c',
					inputTokens: 300,
					outputTokens: 100,
					cacheReadTokens: 30,
					cacheCreationTokens: 15,
				}),
			]);

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude', providerSessionId: 'p-claude' },
				{ maestroSessionId: 'm-codex', providerSessionId: 'p-codex' },
				{ maestroSessionId: 'm-droid', providerSessionId: 'p-droid' },
				{ maestroSessionId: 'm-missing', providerSessionId: 'p-missing' },
			]);

			expect(result.size).toBe(3);
			expect(result.get('p-missing')).toBeUndefined();

			expect(result.get('p-claude')).toMatchObject({
				agentType: 'claude-code',
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.01,
				coverage: 'full',
			});
			expect(result.get('p-codex')).toMatchObject({
				agentType: 'codex',
				inputTokens: 200,
				outputTokens: 75,
				cacheReadTokens: 25,
				cacheCreationTokens: 0,
				costUsd: null,
				coverage: 'partial',
			});
			expect(result.get('p-droid')).toMatchObject({
				agentType: 'factory-droid',
				inputTokens: 300,
				outputTokens: 100,
				cacheReadTokens: 30,
				cacheCreationTokens: 15,
				costUsd: null,
				coverage: 'full',
			});
		});

		it('groups sessions by (agentType, projectPath) so listSessions runs once per group', async () => {
			lookupRows = [
				{
					session_id: 'm-claude-1',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
				{
					session_id: 'm-claude-2',
					agent_type: 'claude-code',
					project_path: '/proj/shared',
					is_remote: 0,
				},
			];
			const listSessions = vi.fn(async () => [
				makeInfo({
					sessionId: 'p-claude-1',
					projectPath: '/proj/shared',
					inputTokens: 11,
				}),
				makeInfo({
					sessionId: 'p-claude-2',
					projectPath: '/proj/shared',
					inputTokens: 22,
				}),
			]);
			storageRegistry.set('claude-code', {
				agentId: 'claude-code',
				listSessions,
				listSessionsPaginated: vi.fn() as never,
				readSessionMessages: vi.fn() as never,
				searchSessions: vi.fn() as never,
				getSessionPath: vi.fn(() => null),
				deleteMessagePair: vi.fn() as never,
			});

			const result = await getSessionTokenSummaries([
				{ maestroSessionId: 'm-claude-1', providerSessionId: 'p-claude-1' },
				{ maestroSessionId: 'm-claude-2', providerSessionId: 'p-claude-2' },
			]);

			expect(listSessions).toHaveBeenCalledTimes(1);
			expect(result.get('p-claude-1')?.inputTokens).toBe(11);
			expect(result.get('p-claude-2')?.inputTokens).toBe(22);
		});
	});

	describe('remote-session safety net', () => {
		it('marks is_remote=1 sessions partial with zeros (known limitation)', async () => {
			lookupRows = [
				{
					session_id: 'm-remote',
					agent_type: 'claude-code',
					project_path: '/proj/r',
					is_remote: 1,
				},
			];
			const listSessions = vi.fn(async () => []);
			storageRegistry.set('claude-code', {
				agentId: 'claude-code',
				listSessions,
				listSessionsPaginated: vi.fn() as never,
				readSessionMessages: vi.fn() as never,
				searchSessions: vi.fn() as never,
				getSessionPath: vi.fn(() => null),
				deleteMessagePair: vi.fn() as never,
			});

			const summary = (
				await getSessionTokenSummaries([
					{ maestroSessionId: 'm-remote', providerSessionId: 'p-remote' },
				])
			).get('p-remote');

			expect(summary?.coverage).toBe('partial');
			expect(summary?.inputTokens).toBe(0);
			expect(listSessions).not.toHaveBeenCalled();
		});
	});

	describe('getAgentTypesForSessions', () => {
		it('resolves agent type by Maestro agent id from session_lifecycle', async () => {
			lookupRows = [
				{ session_id: 'm-a', agent_type: 'claude-code', project_path: '/p', is_remote: 0 },
				{ session_id: 'm-b', agent_type: 'codex', project_path: '/p', is_remote: 0 },
			];

			const result = getAgentTypesForSessions(['m-a', 'm-b', 'm-missing']);

			expect(result.get('m-a')).toBe('claude-code');
			expect(result.get('m-b')).toBe('codex');
			expect(result.has('m-missing')).toBe(false);
		});

		it('returns an empty map for empty input without touching the DB', () => {
			const result = getAgentTypesForSessions([]);
			expect(result.size).toBe(0);
			expect(mockPrepare).not.toHaveBeenCalled();
		});
	});
});

// ===== from src/__tests__/main/cue/cue-session-state.test.ts =====

/** Helper so individual tests read as the sub's shape only, not boilerplate. */
function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'sub-1',
		event: 'time.heartbeat',
		prompt: 'go',
		enabled: true,
		...overrides,
	};
}

describe('isSubscriptionParticipant', () => {
	it('returns true for unbound (no agent_id) subscriptions - legacy / shared', () => {
		const sub = makeSub({ agent_id: undefined });
		expect(isSubscriptionParticipant(sub, 'any-session', 'Any Name')).toBe(true);
	});

	it('returns true when agent_id matches the session id (owner)', () => {
		const sub = makeSub({ agent_id: 'session-A' });
		expect(isSubscriptionParticipant(sub, 'session-A', 'Agent A')).toBe(true);
	});

	it('returns false for a non-owner, non-fan-out session', () => {
		const sub = makeSub({ agent_id: 'session-A' });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(false);
	});

	it('returns true for a fan-out target matched by sessionName', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B', 'Agent C'] });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(true);
		expect(isSubscriptionParticipant(sub, 'session-C', 'Agent C')).toBe(true);
	});

	it('returns true for a fan-out target matched by sessionId (dispatch accepts both)', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['session-B', 'session-C'] });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(true);
		expect(isSubscriptionParticipant(sub, 'session-C', 'Agent C')).toBe(true);
	});

	it('returns false for a session not listed in fan_out', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B'] });
		expect(isSubscriptionParticipant(sub, 'session-D', 'Agent D')).toBe(false);
	});
});

describe('countActiveSubscriptions with fan-out', () => {
	it('counts the same fan-out sub for the owner AND every target - bug 2 regression', () => {
		// Pipeline: 1 trigger → 3 agents (fan-out). The YAML generator writes ONE
		// subscription with agent_id=A and fan_out=[A, B, C]. Before the fix the
		// dashboard showed only A as active; B and C looked unconfigured even
		// though they run whenever the trigger fires.
		const subs: CueSubscription[] = [
			makeSub({
				name: 'fan-out-pipeline',
				agent_id: 'session-A',
				fan_out: ['Agent A', 'Agent B', 'Agent C'],
			}),
		];
		expect(countActiveSubscriptions(subs, 'session-A', 'Agent A')).toBe(1);
		expect(countActiveSubscriptions(subs, 'session-B', 'Agent B')).toBe(1);
		expect(countActiveSubscriptions(subs, 'session-C', 'Agent C')).toBe(1);
	});

	it('skips disabled subscriptions even when the session would otherwise participate', () => {
		const subs: CueSubscription[] = [
			makeSub({
				agent_id: 'session-A',
				fan_out: ['Agent A', 'Agent B'],
				enabled: false,
			}),
		];
		expect(countActiveSubscriptions(subs, 'session-A', 'Agent A')).toBe(0);
		expect(countActiveSubscriptions(subs, 'session-B', 'Agent B')).toBe(0);
	});

	it('returns 0 for sessions that are not participants', () => {
		const subs: CueSubscription[] = [
			makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B'] }),
		];
		expect(countActiveSubscriptions(subs, 'session-X', 'Agent X')).toBe(0);
	});
});

describe('computeOwnershipWarning', () => {
	function makeCandidate(overrides: Partial<OwnershipCandidate> = {}): OwnershipCandidate {
		return {
			id: 'session-1',
			name: 'Agent A',
			projectRoot: '/projects/vault',
			...overrides,
		};
	}

	function makeConfig(overrides: Partial<CueConfig['settings']> = {}): CueConfig {
		return {
			subscriptions: [],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
				...overrides,
			},
		};
	}

	it('returns undefined when the session is the only agent in the projectRoot', () => {
		const session = makeCandidate();
		const result = computeOwnershipWarning({
			session,
			candidates: [session],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns undefined for the first session when >1 agent shares the root (implicit winner)', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns a tooltip naming the winner for the second session in shared-root, no owner set', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" was selected as the owner');
		expect(result).toContain('owner_agent_id');
	});

	it('returns undefined when owner_agent_id matches the session id', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'session-1' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns undefined when owner_agent_id matches the session name', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns a tooltip pointing to the owner for non-matching siblings', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toContain('owner_agent_id targets "Opus"');
	});

	it('shows the resolved display name in the tooltip when owner_agent_id is a uuid', () => {
		const session1 = makeCandidate({
			id: 'fe7c6b37-d7b1-4c2f-9049-f2288dd10c16',
			name: 'Obsidian',
		});
		const session2 = makeCandidate({ id: 'session-2', name: 'Server' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'fe7c6b37-d7b1-4c2f-9049-f2288dd10c16' }),
			configFromAncestor: false,
		});
		// The tooltip should reference the human-readable name, not the
		// uuid the user wrote in cue.yaml.
		expect(result).toContain('targets "Obsidian"');
		expect(result).not.toContain('fe7c6b37');
	});

	it('flags every session in the root when owner_agent_id matches nobody', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const config = makeConfig({ owner_agent_id: 'NonExistentAgent' });

		const result1 = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config,
			configFromAncestor: false,
		});
		const result2 = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config,
			configFromAncestor: false,
		});
		expect(result1).toContain('"NonExistentAgent" does not match any agent');
		expect(result2).toContain('"NonExistentAgent" does not match any agent');
	});

	it('ignores candidates with a different projectRoot when checking explicit owner existence', () => {
		// An agent named "Opus" exists but lives in a different projectRoot -
		// owner_agent_id should still resolve as unmatched for this root.
		const session = makeCandidate({ id: 'session-1', name: 'Sonnet' });
		const outsider = makeCandidate({
			id: 'session-99',
			name: 'Opus',
			projectRoot: '/projects/other',
		});
		const result = computeOwnershipWarning({
			session,
			candidates: [session, outsider],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" does not match any agent');
	});

	it('returns undefined for ancestor-loaded configs regardless of siblings', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'NonExistentAgent' }),
			configFromAncestor: true,
		});
		expect(result).toBeUndefined();
	});

	it('treats whitespace-only owner_agent_id as unset (falls back to first-wins)', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: '   ' }),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" was selected as the owner');
	});

	it('config-less candidates are excluded by the caller; the real Cue agent becomes owner', () => {
		// Simulates the P1 bug: a config-less agent appears earlier in the
		// session list. The caller is expected to filter it out before calling
		// this utility - only "configured" is passed in - so the real agent
		// wins the first-in-list race.
		const configured = makeCandidate({ id: 'session-real', name: 'Obsidian' });
		const result = computeOwnershipWarning({
			session: configured,
			candidates: [configured],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('owner_agent_id matched by two agents sharing a display name is ambiguous: both disabled, both warned', () => {
		const first = makeCandidate({ id: 'session-1', name: 'Assistant' });
		const second = makeCandidate({ id: 'session-2', name: 'Assistant' });

		const firstResult = computeOwnershipWarning({
			session: first,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'Assistant' }),
			configFromAncestor: false,
		});
		expect(firstResult).toContain('is ambiguous');
		expect(firstResult).toContain('matches 2 agents in this projectRoot by display name');
		expect(firstResult).toContain('session-1');
		expect(firstResult).toContain('session-2');

		const secondResult = computeOwnershipWarning({
			session: second,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'Assistant' }),
			configFromAncestor: false,
		});
		expect(secondResult).toContain('is ambiguous');
	});

	it('owner_agent_id set to a UUID still wins unambiguously even if display names collide', () => {
		const first = makeCandidate({ id: 'session-1', name: 'Assistant' });
		const second = makeCandidate({ id: 'session-2', name: 'Assistant' });

		const result = computeOwnershipWarning({
			session: second,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'session-2' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('owner_agent_id is resolved by id even when another session has that string as its display name', () => {
		// A is the intended owner by id. B happens to have a display name
		// equal to A's id (a pathological but possible configuration). Only
		// A should be treated as owner - B must not silently claim it.
		const a = makeCandidate({ id: 'uuid-alpha', name: 'Alpha' });
		const b = makeCandidate({ id: 'session-b', name: 'uuid-alpha' });

		const fromA = computeOwnershipWarning({
			session: a,
			candidates: [a, b],
			config: makeConfig({ owner_agent_id: 'uuid-alpha' }),
			configFromAncestor: false,
		});
		expect(fromA).toBeUndefined();

		const fromB = computeOwnershipWarning({
			session: b,
			candidates: [a, b],
			config: makeConfig({ owner_agent_id: 'uuid-alpha' }),
			configFromAncestor: false,
		});
		// The tooltip should reference the resolved display name ("Alpha"),
		// not the raw uuid the user wrote in cue.yaml.
		expect(fromB).toContain('targets "Alpha"');
	});
});
