/**
 * `sketch:*` IPC. Each handler is a pass-through to one SketchService method
 * (the CLI's WS verbs call the same methods), and a refusal from the service
 * (the Encore gate, a bad argument, a missing sketch) is logged and rethrown
 * to the renderer unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
	logError: vi.fn(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() },
}));
vi.mock('../../../../main/sketch/sketch-service', () => ({
	getSketchService: () => h.service,
}));

import { registerSketchHandlers } from '../../../../main/ipc/handlers/sketch';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const record = { sketchId: SKETCH_ID, ownerAgentId: 'agent-1', name: 'Board' };
const scene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };

const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);

describe('sketch IPC handlers', () => {
	beforeEach(() => {
		h.handlers.clear();
		h.logError.mockReset();
		h.service = {
			createSketch: vi.fn(async () => record),
			listSketches: vi.fn(async () => [record]),
			getSketch: vi.fn(async () => record),
			readScene: vi.fn(async () => scene),
			writeScene: vi.fn(async () => undefined),
			renameSketch: vi.fn(async () => ({ ...record, name: 'Renamed' })),
			deleteSketch: vi.fn(async () => undefined),
			saveSketchToProject: vi.fn(async () => '/project/Board.excalidraw'),
		};
		registerSketchHandlers();
	});

	it('registers exactly the sketch channels', () => {
		expect([...h.handlers.keys()].sort()).toEqual([
			'sketch:create',
			'sketch:delete',
			'sketch:get',
			'sketch:list',
			'sketch:readScene',
			'sketch:rename',
			'sketch:saveToProject',
			'sketch:writeScene',
		]);
	});

	it('passes each channel through to its service method', async () => {
		const service = h.service!;
		await expect(invoke('sketch:create', { ownerAgentId: 'agent-1', name: 'Board' })).resolves.toBe(
			record
		);
		expect(service.createSketch).toHaveBeenCalledWith({ ownerAgentId: 'agent-1', name: 'Board' });

		await expect(invoke('sketch:list', { ownerAgentId: 'agent-1' })).resolves.toEqual([record]);
		expect(service.listSketches).toHaveBeenCalledWith({ ownerAgentId: 'agent-1' });

		await expect(invoke('sketch:get', SKETCH_ID)).resolves.toBe(record);
		expect(service.getSketch).toHaveBeenCalledWith(SKETCH_ID);

		await expect(invoke('sketch:readScene', SKETCH_ID)).resolves.toBe(scene);
		expect(service.readScene).toHaveBeenCalledWith(SKETCH_ID);

		await invoke('sketch:writeScene', SKETCH_ID, scene);
		expect(service.writeScene).toHaveBeenCalledWith(SKETCH_ID, scene);

		await expect(invoke('sketch:rename', SKETCH_ID, 'Renamed')).resolves.toMatchObject({
			name: 'Renamed',
		});
		expect(service.renameSketch).toHaveBeenCalledWith(SKETCH_ID, 'Renamed');

		await invoke('sketch:delete', SKETCH_ID);
		expect(service.deleteSketch).toHaveBeenCalledWith(SKETCH_ID);

		await expect(
			invoke('sketch:saveToProject', SKETCH_ID, '/project', { overwrite: true })
		).resolves.toBe('/project/Board.excalidraw');
		expect(service.saveSketchToProject).toHaveBeenCalledWith(SKETCH_ID, '/project', {
			overwrite: true,
		});
	});

	it('logs and rethrows a refusal from the service', async () => {
		const refusal = new Error('Sketch Book is turned off.');
		h.service!.listSketches.mockRejectedValueOnce(refusal);
		await expect(invoke('sketch:list', {})).rejects.toBe(refusal);
		expect(h.logError).toHaveBeenCalledWith('list error', '[SketchBook]', expect.anything());
	});
});
