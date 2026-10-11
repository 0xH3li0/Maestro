/**
 * @file models-manage.test.ts
 * @description Tests for `maestro-cli models list|install|remove|verify`: ids
 * are checked against the catalog before the bridge is opened, every verb
 * crosses the WS bridge in the shape the desktop handler expects, a pending
 * model is never offered for download, and removing a model a task runs on is
 * refused until `--force`, naming the tasks.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readLocalModelAssignments: vi.fn(() => ({})),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsInstall,
	modelsList,
	modelsRemove,
	modelsVerify,
} from '../../../cli/commands/models-manage';
import { readLocalModelAssignments } from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	BGE_SMALL_EN_ID,
	getLocalModel,
	LOCAL_MODEL_CATALOG,
	PROMPT_GUARD_2_22M_ID,
} from '../../../shared/local-models/model-catalog';
import type { LocalModelListing } from '../../../main/local-models/service';

function mockSend(reply: Record<string, unknown>) {
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
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return captured;
}

function listing(id: string, status: 'installed' | 'not-installed' | 'corrupt'): LocalModelListing {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: {
			id,
			status,
			manifest: null,
			bytesOnDisk: status === 'installed' ? entry.bytes : 0,
			...(status === 'corrupt' ? { detail: 'Hash mismatch' } : {}),
		},
		installPaths: [],
	};
}

const PENDING = LOCAL_MODEL_CATALOG.find((entry) => entry.pending);

describe('models list|install|remove|verify commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readLocalModelAssignments).mockReturnValue({});
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('list', () => {
		it('lists the catalog grouped by kind with status, footprint, and task usage', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			const captured = mockSend({
				success: true,
				listings: [
					listing(BGE_SMALL_EN_ID, 'installed'),
					listing(PROMPT_GUARD_2_22M_ID, 'corrupt'),
				],
				footprint: { bytes: 1024 * 1024 * 130, models: [] },
			});

			await modelsList({});

			expect(captured.payload).toEqual({ type: 'local_models_list' });
			expect(captured.responseType).toBe('local_models_list_result');
			const output = logSpy.mock.calls[0][0] as string;
			expect(output).toMatch(/LOCAL MODELS/);
			expect(output).toMatch(/Embeddings/);
			expect(output).toMatch(/Classifiers/);
			expect(output).toMatch(new RegExp(`${BGE_SMALL_EN_ID}\\s+installed`));
			expect(output).toMatch(new RegExp(`${PROMPT_GUARD_2_22M_ID}\\s+corrupt`));
			expect(output).toMatch(/Hash mismatch/);
			expect(output).toMatch(/in use by: Semantic search/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('filters by kind and prints JSON for scripts', async () => {
			mockSend({
				success: true,
				listings: [
					listing(BGE_SMALL_EN_ID, 'installed'),
					listing(PROMPT_GUARD_2_22M_ID, 'not-installed'),
				],
				footprint: { bytes: 42, models: [] },
			});

			await modelsList({ kind: 'embedding', json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.success).toBe(true);
			expect(parsed.footprintBytes).toBe(42);
			expect(parsed.models.map((model: { id: string }) => model.id)).toEqual([BGE_SMALL_EN_ID]);
			expect(parsed.models[0]).toMatchObject({ kind: 'embedding', status: 'installed' });
		});

		it('refuses an unknown kind before opening the bridge', async () => {
			await expect(modelsList({ kind: 'vision' })).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/--kind must be one of/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('install', () => {
		it('downloads through the bridge with a long wait and reports success', async () => {
			const captured = mockSend({
				success: true,
				result: { modelId: BGE_SMALL_EN_ID, status: 'complete' },
			});

			await modelsInstall(BGE_SMALL_EN_ID, {});

			expect(captured.payload).toEqual({ type: 'local_models_download', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_download_result');
			expect(captured.timeout).toBeGreaterThan(60 * 60 * 1000);
			expect(logSpy.mock.calls.at(-1)?.[0]).toMatch(/Installed BGE Small/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('exits non-zero with the hash mismatch when the download fails', async () => {
			mockSend({
				success: true,
				result: {
					modelId: BGE_SMALL_EN_ID,
					status: 'error',
					error: 'Hash mismatch',
					mismatch: { path: 'model.onnx', expected: 'aa', actual: 'bb' },
				},
			});

			await expect(modelsInstall(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy.mock.calls[0][0]).toMatch(
				/Hash mismatch \(model\.onnx: expected aa, got bb\)/
			);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it.skipIf(!PENDING)('refuses a pending model without opening the bridge', async () => {
			await expect(modelsInstall(PENDING!.id, {})).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/not offered for download/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('refuses an unknown model id without opening the bridge', async () => {
			await expect(modelsInstall('gpt-17', {})).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/Unknown model "gpt-17"/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		it('removes an unassigned model and reports the bytes reclaimed', async () => {
			const captured = mockSend({ success: true, bytes: 2048 });

			await modelsRemove(BGE_SMALL_EN_ID, { json: true });

			expect(captured.payload).toEqual({ type: 'local_models_remove', modelId: BGE_SMALL_EN_ID });
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				modelId: BGE_SMALL_EN_ID,
				bytesReclaimed: 2048,
				tasks: [],
			});
		});

		it('refuses a model a task is assigned to, naming the task, until --force', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});

			await expect(modelsRemove(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy.mock.calls[0][0]).toMatch(/assigned to Semantic search/);
			expect(errorSpy.mock.calls[0][0]).toMatch(/--force/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('removes an assigned model with --force and names what became unavailable', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			mockSend({ success: true, bytes: 2048 });

			await modelsRemove(BGE_SMALL_EN_ID, { force: true });

			const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
			expect(output).toMatch(/Removed BGE Small/);
			expect(output).toMatch(/Now unavailable: Semantic search/);
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	describe('verify', () => {
		it('reports a verified model', async () => {
			const captured = mockSend({
				success: true,
				result: { id: BGE_SMALL_EN_ID, ok: true, status: 'installed' },
			});

			await modelsVerify(BGE_SMALL_EN_ID, {});

			expect(captured.payload).toEqual({ type: 'local_models_verify', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_verify_result');
			expect(logSpy.mock.calls[0][0]).toMatch(/BGE Small \(English\) verified/);
		});

		it('exits non-zero for a corrupt model with JSON success false', async () => {
			mockSend({
				success: true,
				result: { id: BGE_SMALL_EN_ID, ok: false, status: 'corrupt', detail: 'Hash mismatch' },
			});

			await expect(modelsVerify(BGE_SMALL_EN_ID, { json: true })).rejects.toThrow('__exit__');

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
				success: false,
				status: 'corrupt',
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('reports a refused request from the app', async () => {
			mockSend({ success: false, error: 'UnknownLocalModel' });

			await expect(modelsVerify(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy).toHaveBeenCalledWith('Error: UnknownLocalModel');
		});
	});
});
