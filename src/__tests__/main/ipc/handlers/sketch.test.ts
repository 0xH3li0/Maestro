/**
 * `sketch:*` IPC. Each handler is a pass-through to one SketchService method
 * (the CLI's WS verbs call the same methods), and a refusal from the service
 * (the Encore gate, a bad argument, a missing sketch) is logged and rethrown
 * to the renderer unchanged. Registration hands the window resolver to the
 * renderer bridge, so the CLI reaches the window that owns an agent, and
 * starts the cloud screening consent module, whose channels pass through to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
	logError: vi.fn(),
	setSketchWindowResolver: vi.fn(),
	consent: null as Record<string, ReturnType<typeof vi.fn>> | null,
	startSketchCloudConsent: vi.fn(),
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
vi.mock('../../../../main/sketch/sketch-renderer-bridge', () => ({
	setSketchWindowResolver: h.setSketchWindowResolver,
}));
vi.mock('../../../../main/sketch/sketch-cloud-consent', () => ({
	getSketchCloudConsent: () => h.consent,
	startSketchCloudConsent: h.startSketchCloudConsent,
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
		h.setSketchWindowResolver.mockReset();
		h.startSketchCloudConsent.mockReset();
		h.consent = {
			status: vi.fn(async () => ({ consent: {}, source: null, sourceCovered: false, rooms: [] })),
			grantConsent: vi.fn(async () => ({ consent: { jev: { grantedAt: 1 } } })),
			revokeConsent: vi.fn(async () => ({ consent: {} })),
			confirmCloudScreening: vi.fn(async () => true),
			roomScreening: vi.fn(async () => 'local'),
			setRoomLive: vi.fn(async () => 'cloud'),
			reportServerScreening: vi.fn(() => undefined),
		};
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

	it('hands the window resolver to the renderer bridge only when given one', () => {
		expect(h.setSketchWindowResolver).not.toHaveBeenCalled();
		const resolveWindow = vi.fn(() => null);
		registerSketchHandlers({ resolveWindow });
		expect(h.setSketchWindowResolver).toHaveBeenCalledWith(resolveWindow);
	});

	it('starts the cloud consent module with the push to every window', () => {
		const safeSend = vi.fn();
		registerSketchHandlers({ safeSend });
		expect(h.startSketchCloudConsent).toHaveBeenLastCalledWith({ safeSend });
	});

	it('registers exactly the sketch channels', () => {
		expect([...h.handlers.keys()].sort()).toEqual([
			'sketch:confirmCloudScreening',
			'sketch:create',
			'sketch:delete',
			'sketch:get',
			'sketch:grantScreeningConsent',
			'sketch:list',
			'sketch:readScene',
			'sketch:rename',
			'sketch:reportServerScreening',
			'sketch:revokeScreeningConsent',
			'sketch:roomScreening',
			'sketch:saveToProject',
			'sketch:screeningConsentStatus',
			'sketch:setRoomLive',
			'sketch:writeScene',
		]);
	});

	it('passes each consent channel through to the consent module', async () => {
		const consent = h.consent!;
		await invoke('sketch:screeningConsentStatus');
		expect(consent.status).toHaveBeenCalled();

		await invoke('sketch:grantScreeningConsent', 'jev');
		expect(consent.grantConsent).toHaveBeenCalledWith('jev');

		await invoke('sketch:revokeScreeningConsent', 'openjev');
		expect(consent.revokeConsent).toHaveBeenCalledWith('openjev');

		await expect(invoke('sketch:confirmCloudScreening')).resolves.toBe(true);

		await expect(invoke('sketch:roomScreening', SKETCH_ID)).resolves.toBe('local');
		expect(consent.roomScreening).toHaveBeenCalledWith(SKETCH_ID);

		await expect(invoke('sketch:setRoomLive', SKETCH_ID, true)).resolves.toBe('cloud');
		expect(consent.setRoomLive).toHaveBeenCalledWith(SKETCH_ID, true);
		// Anything but a literal true is a leave, never a join.
		await invoke('sketch:setRoomLive', SKETCH_ID, 'yes');
		expect(consent.setRoomLive).toHaveBeenLastCalledWith(SKETCH_ID, false);

		await invoke('sketch:reportServerScreening', SKETCH_ID, 'cloud', 1234);
		expect(consent.reportServerScreening).toHaveBeenCalledWith(SKETCH_ID, 'cloud', 1234);
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
