/**
 * @file local-models.test.ts
 *
 * The core Local Models IPC channels (`localModels:*`) and the service they
 * share with A Cappella's `models:*` / `runtimes:*` channels.
 *
 * Properties worth protecting:
 *
 *   - **No Encore gate.** Local Models is a core service; every channel answers
 *     with no feature flag set at all.
 *   - **Ids are validated before they reach a path join.**
 *   - **Remove cancels first**, so a live writer cannot recreate what was deleted.
 *   - **One implementation behind both transports.** A runtime install started
 *     on the core channel is joined, not duplicated, by the voice channel, and
 *     its progress is broadcast on both.
 *   - **Re-registering never doubles a broadcast.**
 *   - **Endpoint channels are thin.** `endpoints:*` hand their arguments to the
 *     endpoint service untouched, the same functions the CLI bridge calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const downloader = vi.hoisted(() => {
	const listeners = new Set<(progress: unknown) => void>();
	return {
		listeners,
		onProgress: vi.fn((listener: (progress: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		download: vi.fn(async (modelId: string) => ({ modelId, status: 'complete' })),
		pause: vi.fn(() => true),
		resume: vi.fn(async (modelId: string) => ({ modelId, status: 'complete' })),
		cancel: vi.fn(async () => true),
		cancelAll: vi.fn(async () => {}),
	};
});

vi.mock('../../../../main/local-models/model-downloader', () => ({
	getModelDownloader: () => downloader,
}));

vi.mock('../../../../main/local-models/model-store', () => ({
	listStatuses: vi.fn(async () => []),
	installPathFor: vi.fn(
		(entry: { id: string }, file: { path: string }) => `/models/${entry.id}/${file.path}`
	),
	remove: vi.fn(async () => 42),
	removeAll: vi.fn(async () => 1_000),
	totalFootprint: vi.fn(async () => ({ bytes: 7 })),
	verify: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../../main/local-models/runtime/runtime-installer', () => ({
	installNativeRuntime: vi.fn(),
}));

vi.mock('../../../../main/local-models/runtime/runtime-store', () => ({
	artifactForThisPlatform: vi.fn(() => ({ url: 'payload.tgz', bytes: 100, dependencies: [] })),
	isRuntimeInstalled: vi.fn(async () => false),
	isRuntimeStale: vi.fn(async () => false),
	removeAllRuntimes: vi.fn(async () => {}),
	runtimesFootprint: vi.fn(async () => 0),
}));

vi.mock('../../../../main/local-models/runtime/native-loader', () => ({
	resetNativeRuntimes: vi.fn(),
}));

vi.mock('../../../../main/local-models/endpoint-service', () => ({
	detectNewLocalModelEndpoints: vi.fn(async () => [
		{ kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: [] },
	]),
	listLocalModelEndpointModels: vi.fn(async () => ({ ok: true, models: [{ id: 'm' }] })),
	testLocalModelEndpoint: vi.fn(async () => ({ ok: true, model: 'm', latencyMs: 12 })),
}));

import {
	registerLocalModelsHandlers,
	LOCAL_MODEL_PROGRESS_CHANNEL,
	LOCAL_RUNTIME_PROGRESS_CHANNEL,
} from '../../../../main/ipc/handlers/local-models';
import {
	registerACappellaModelsHandlers,
	ACAPPELLA_RUNTIME_PROGRESS_CHANNEL,
} from '../../../../main/ipc/handlers/acappella-models';
import type { LocalRuntimeListing } from '../../../../main/local-models/service';
import { LOCAL_MODEL_CATALOG } from '../../../../shared/local-models/model-catalog';
import { remove, removeAll, verify } from '../../../../main/local-models/model-store';
import { installNativeRuntime } from '../../../../main/local-models/runtime/runtime-installer';
import { removeAllRuntimes } from '../../../../main/local-models/runtime/runtime-store';
import { resetNativeRuntimes } from '../../../../main/local-models/runtime/native-loader';
import {
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../../main/local-models/endpoint-service';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const MODEL_ID = LOCAL_MODEL_CATALOG[0].id;
const broadcasts: Array<{ channel: string; payload: unknown }> = [];
const safeSend = vi.fn((channel: string, payload: unknown) => {
	broadcasts.push({ channel, payload });
});

/** The most recent registration for a channel (handlers are re-registered per test). */
function handlerFor(channel: string): Handler {
	const registration = vi
		.mocked(ipcMain.handle)
		.mock.calls.filter(([registered]) => registered === channel)
		.at(-1);
	expect(registration, `no handler registered for ${channel}`).toBeDefined();
	return registration?.[1] as unknown as Handler;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	broadcasts.length = 0;
	registerLocalModelsHandlers({ safeSend: safeSend as never });
});

describe('Local Models IPC handlers', () => {
	it('answers every channel with no Encore Feature enabled', async () => {
		// No settings store exists on this transport at all: the gate is a
		// consumer's concern, never the core service's.
		await expect(handlerFor('localModels:list')({})).resolves.toHaveLength(
			LOCAL_MODEL_CATALOG.length
		);
		await expect(handlerFor('localModels:footprint')({})).resolves.toEqual({ bytes: 7 });
		await expect(handlerFor('localModels:runtimes:list')({})).resolves.not.toHaveLength(0);
	});

	it('lists every catalog model with its install paths', async () => {
		const listings = (await handlerFor('localModels:list')({})) as Array<{
			entry: { id: string };
			installPaths: string[];
		}>;
		expect(listings[0].entry.id).toBe(MODEL_ID);
		expect(listings[0].installPaths[0]).toContain(`/models/${MODEL_ID}/`);
	});

	it('delegates download, pause, resume, cancel, and verify for a catalog id', async () => {
		await handlerFor('localModels:download')({}, MODEL_ID);
		await handlerFor('localModels:pause')({}, MODEL_ID);
		await handlerFor('localModels:resume')({}, MODEL_ID);
		await handlerFor('localModels:cancel')({}, MODEL_ID);
		await handlerFor('localModels:verify')({}, MODEL_ID);

		expect(downloader.download).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.pause).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.resume).toHaveBeenCalledWith(MODEL_ID);
		expect(downloader.cancel).toHaveBeenCalledWith(MODEL_ID);
		expect(verify).toHaveBeenCalledWith(MODEL_ID);
	});

	it('rejects an id that is not in the catalog before it reaches a path join', async () => {
		for (const channel of ['localModels:download', 'localModels:remove', 'localModels:verify']) {
			await expect(handlerFor(channel)({}, '../../etc/passwd')).rejects.toThrow(
				'UnknownLocalModel'
			);
		}
		expect(downloader.download).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it('cancels a live download before deleting the model', async () => {
		await expect(handlerFor('localModels:remove')({}, MODEL_ID)).resolves.toBe(42);
		expect(downloader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(remove).mock.invocationCallOrder[0]
		);

		await expect(handlerFor('localModels:remove-all')({})).resolves.toBe(1_000);
		expect(downloader.cancelAll.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(removeAll).mock.invocationCallOrder[0]
		);
	});

	it('broadcasts download progress on its own channel, once per registration', async () => {
		// A second registration must replace the first listener, not add to it.
		registerLocalModelsHandlers({ safeSend: safeSend as never });
		for (const listener of downloader.listeners) listener({ modelId: MODEL_ID });

		const progress = broadcasts.filter((b) => b.channel === LOCAL_MODEL_PROGRESS_CHANNEL);
		expect(progress).toEqual([
			{ channel: LOCAL_MODEL_PROGRESS_CHANNEL, payload: { modelId: MODEL_ID } },
		]);
	});

	it('lists each runtime with the models that need it', async () => {
		const listings = (await handlerFor('localModels:runtimes:list')({})) as LocalRuntimeListing[];
		for (const listing of listings) {
			expect(listing).not.toHaveProperty('slots');
			expect(Array.isArray(listing.models)).toBe(true);
			expect(listing.bytes).toBe(100);
		}
		expect(listings.some((listing) => listing.models.length > 0)).toBe(true);
	});

	it('installs a runtime, resets the loader, and rejects an unknown id', async () => {
		vi.mocked(installNativeRuntime).mockResolvedValue({} as never);

		await expect(handlerFor('localModels:runtimes:install')({}, 'onnx')).resolves.toBe(true);
		expect(resetNativeRuntimes).toHaveBeenCalled();

		await expect(handlerFor('localModels:runtimes:install')({}, 'cuda')).rejects.toThrow(
			'UnknownLocalRuntime'
		);
	});

	it('frees runtime disk and drops whatever is dlopened', async () => {
		await expect(handlerFor('localModels:runtimes:remove-all')({})).resolves.toBeUndefined();
		expect(removeAllRuntimes).toHaveBeenCalled();
		expect(resetNativeRuntimes).toHaveBeenCalled();
	});
});

describe('one service behind both transports', () => {
	beforeEach(() => {
		registerACappellaModelsHandlers({
			settingsStore: {
				get: (key: string) => (key === 'encoreFeatures' ? { aCappella: true } : undefined),
			},
			safeSend: safeSend as never,
		});
	});

	it('joins a runtime install started on the other transport and broadcasts on both', async () => {
		const gate = deferred<never>();
		vi.mocked(installNativeRuntime).mockImplementation((async (_id, options) => {
			options?.onProgress?.({ runtimeId: 'onnx', phase: 'downloading', bytes: 1, totalBytes: 2 });
			return gate.promise;
		}) as never);

		const core = handlerFor('localModels:runtimes:install')({}, 'onnx');
		const voice = handlerFor('runtimes:install')({}, 'onnx');
		gate.resolve({} as never);

		await expect(Promise.all([core, voice])).resolves.toEqual([true, true]);
		expect(installNativeRuntime).toHaveBeenCalledTimes(1);

		const channels = broadcasts.map((b) => b.channel);
		expect(channels).toContain(LOCAL_RUNTIME_PROGRESS_CHANNEL);
		expect(channels).toContain(ACAPPELLA_RUNTIME_PROGRESS_CHANNEL);
	});

	it('serves the voice model channels from the same service', async () => {
		await handlerFor('models:download')({}, MODEL_ID);
		expect(downloader.download).toHaveBeenCalledWith(MODEL_ID);
		await expect(handlerFor('models:remove')({}, 'nope')).rejects.toThrow('UnknownLocalModel');
	});
});

describe('endpoint channels', () => {
	it('detects without arguments', async () => {
		await expect(handlerFor('localModels:endpoints:detect')({})).resolves.toEqual([
			expect.objectContaining({ kind: 'ollama' }),
		]);
	});

	it('hands listModels its endpoint reference untouched', async () => {
		await expect(handlerFor('localModels:endpoints:listModels')({}, 'ep-1')).resolves.toEqual({
			ok: true,
			models: [{ id: 'm' }],
		});
		expect(listLocalModelEndpointModels).toHaveBeenCalledWith('ep-1');
	});

	it('hands test its endpoint reference and model untouched', async () => {
		const draft = { id: 'draft' };
		await expect(handlerFor('localModels:endpoints:test')({}, draft, 'llama')).resolves.toEqual({
			ok: true,
			model: 'm',
			latencyMs: 12,
		});
		expect(testLocalModelEndpoint).toHaveBeenCalledWith(draft, 'llama');
	});
});
