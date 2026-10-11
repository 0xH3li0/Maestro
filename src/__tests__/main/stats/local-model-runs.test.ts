/**
 * Tests for Local Models task-run recording (`local_model_runs`).
 *
 * better-sqlite3 is compiled for Electron's Node, so these drive the module
 * against a fake `Database` and assert on the bound parameters and the row
 * mapping, the two places a run can be silently corrupted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
	recordLocalModelRun,
	getLocalModelRuns,
	clearLocalModelRunsCache,
} from '../../../main/stats/local-model-runs';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/stats/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/stats/utils')>()),
	generateId: () => 'run-id',
}));

const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(),
	all: vi.fn(() => [] as unknown[]),
};

const mockDb = {
	prepare: vi.fn(() => mockStatement),
} as unknown as Database.Database;

describe('local-model-runs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearLocalModelRunsCache();
		mockStatement.all.mockReturnValue([]);
	});

	describe('recordLocalModelRun', () => {
		it('binds an endpoint run in schema order and returns the generated id', () => {
			const id = recordLocalModelRun(mockDb, {
				taskId: 'git-drafts',
				sourceType: 'endpoint',
				modelId: 'llama3.2',
				endpointId: 'ep-1',
				startedAt: 1_000,
				durationMs: 812.6,
				outcome: 'ok',
				tokensIn: 120,
				tokensOut: 30,
			});

			expect(id).toBe('run-id');
			expect(mockStatement.run).toHaveBeenCalledWith(
				'run-id',
				'git-drafts',
				'endpoint',
				'llama3.2',
				'ep-1',
				1_000,
				813,
				'ok',
				null,
				120,
				30
			);
		});

		it('stores NULL for what a local failure does not have', () => {
			recordLocalModelRun(mockDb, {
				taskId: 'tab-naming',
				sourceType: 'local',
				modelId: 'qwen3-1.7b-instruct-q4km',
				startedAt: 2_000,
				durationMs: 5,
				outcome: 'error',
				errorCode: 'model-not-installed',
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				'run-id',
				'tab-naming',
				'local',
				'qwen3-1.7b-instruct-q4km',
				null,
				2_000,
				5,
				'error',
				'model-not-installed',
				null,
				null
			);
		});
	});

	describe('getLocalModelRuns', () => {
		it('maps rows back, dropping NULL columns rather than inventing values', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'a',
					task_id: 'tab-naming',
					source_type: 'local',
					model_id: 'qwen3-1.7b-instruct-q4km',
					endpoint_id: null,
					started_at: 10,
					duration_ms: 400,
					outcome: 'ok',
					error_code: null,
					tokens_in: 50,
					tokens_out: null,
				},
			]);

			expect(getLocalModelRuns(mockDb, 'all')).toEqual([
				{
					id: 'a',
					taskId: 'tab-naming',
					sourceType: 'local',
					modelId: 'qwen3-1.7b-instruct-q4km',
					startedAt: 10,
					durationMs: 400,
					outcome: 'ok',
					tokensIn: 50,
				},
			]);
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			expect(sql).toContain('WHERE started_at >= ?');
			expect(sql).toContain('ORDER BY started_at DESC');
		});
	});
});
