/**
 * Tests for the Sketch Book preload API (`window.maestro.sketch`): one
 * `sketch:*` channel per method, with optional arguments sent as `{}` so the
 * main process always receives an object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createSketchApi } from '../../../main/preload/sketch';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const scene = {
	type: 'excalidraw' as const,
	version: 2,
	elements: [],
	appState: {},
	files: {},
};

describe('Sketch Book Preload API', () => {
	let api: ReturnType<typeof createSketchApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSketchApi();
	});

	it('creates a sketch with one request object', async () => {
		await api.create({ ownerAgentId: 'agent-1', name: 'Board' });
		expect(mockInvoke).toHaveBeenCalledWith('sketch:create', {
			ownerAgentId: 'agent-1',
			name: 'Board',
		});
	});

	it('lists every sketch or one owner', async () => {
		await api.list();
		expect(mockInvoke).toHaveBeenCalledWith('sketch:list', {});
		await api.list({ ownerAgentId: 'agent-1' });
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:list', { ownerAgentId: 'agent-1' });
	});

	it('reads, writes, renames and deletes by sketch id', async () => {
		await api.get(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:get', SKETCH_ID);
		await api.readScene(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:readScene', SKETCH_ID);
		await api.writeScene(SKETCH_ID, scene);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:writeScene', SKETCH_ID, scene);
		await api.rename(SKETCH_ID, 'Renamed');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:rename', SKETCH_ID, 'Renamed');
		await api.delete(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:delete', SKETCH_ID);
	});

	it('saves to a project with or without options', async () => {
		mockInvoke.mockResolvedValue('/project/Board.excalidraw');
		await expect(api.saveToProject(SKETCH_ID, '/project')).resolves.toBe(
			'/project/Board.excalidraw'
		);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:saveToProject', SKETCH_ID, '/project', {});
		await api.saveToProject(SKETCH_ID, '/project', {
			fileName: 'plan.excalidraw',
			overwrite: true,
		});
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:saveToProject', SKETCH_ID, '/project', {
			fileName: 'plan.excalidraw',
			overwrite: true,
		});
	});
});
