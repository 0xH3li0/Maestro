/**
 * `sketch:*` IPC. Each handler is a pass-through to one SketchService method
 * (the CLI's WS verbs call the same methods), and a refusal from the service
 * (the Encore gate, a bad argument, a missing sketch) is logged and rethrown
 * to the renderer unchanged. Registration hands the window resolver to the
 * renderer bridge, so the CLI reaches the window that owns an agent, and
 * starts the cloud screening consent module and the B2 policy watch, whose
 * channels pass through to them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
	botTurns: null as Record<string, ReturnType<typeof vi.fn>> | null,
	logError: vi.fn(),
	setSketchWindowResolver: vi.fn(),
	consent: null as Record<string, ReturnType<typeof vi.fn>> | null,
	startSketchCloudConsent: vi.fn(),
	botPolicy: null as Record<string, ReturnType<typeof vi.fn>> | null,
	startSketchBotPolicyWatch: vi.fn(),
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
vi.mock('../../../../main/sketch/sketch-bot-turns', () => ({
	getSketchBotTurnService: () => h.botTurns,
}));
vi.mock('../../../../main/sketch/sketch-renderer-bridge', () => ({
	setSketchWindowResolver: h.setSketchWindowResolver,
}));
vi.mock('../../../../main/sketch/sketch-cloud-consent', () => ({
	getSketchCloudConsent: () => h.consent,
	startSketchCloudConsent: h.startSketchCloudConsent,
}));
vi.mock('../../../../main/sketch/sketch-bot-policy', () => ({
	getSketchBotPolicy: () => h.botPolicy,
	startSketchBotPolicyWatch: h.startSketchBotPolicyWatch,
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
		h.startSketchBotPolicyWatch.mockReset();
		h.botPolicy = {
			status: vi.fn(async () => ({
				sketchId: SKETCH_ID,
				policy: 'conductor',
				availability: { ok: true },
			})),
			setPolicy: vi.fn(async () => ({
				sketchId: SKETCH_ID,
				policy: 'writers',
				availability: { ok: true },
			})),
			noteRoomPolicy: vi.fn(async () => ({
				sketchId: SKETCH_ID,
				policy: 'writers',
				availability: { ok: true },
			})),
			installScreen: vi.fn(async () => ({ installed: true, assigned: true })),
		};
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
			ownerStatus: vi.fn(async () => ({ state: 'signed-out' })),
			registerOwner: vi.fn(async () => ({ email: 'sent' })),
			waitForOwner: vi.fn(async () => ({ state: 'confirmed' })),
			signOutOwner: vi.fn(async () => ({ state: 'signed-out' })),
			shareSketch: vi.fn(async () => ({ record, createdRoom: true })),
			unshareSketch: vi.fn(async () => record),
			revokeSketchLink: vi.fn(async () => record),
			rotateSketch: vi.fn(async () => record),
			uploadSnapshot: vi.fn(async () => ({ bytes: 64 })),
			roomConnection: vi.fn(async () => null),
			screenBotRequest: vi.fn(async () => ({
				status: 'clean' as const,
				score: 0.04,
				sourceLabel: 'Prompt Guard 2 22M',
				locality: 'local' as const,
			})),
		};
		h.botTurns = {
			prepareBotTurn: vi.fn(async () => ({ ok: false, reason: 'The owner agent was removed.' })),
			screenBotReply: vi.fn(async () => ({ ok: true, text: 'Done.' })),
			setBotSessionId: vi.fn(async () => record),
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

	it('starts the B2 policy watch with the same push', () => {
		const safeSend = vi.fn();
		registerSketchHandlers({ safeSend });
		expect(h.startSketchBotPolicyWatch).toHaveBeenLastCalledWith({ safeSend });
	});

	it('passes the B2 policy channels through with no caller (the person in the tab is the conductor)', async () => {
		const botPolicy = h.botPolicy!;
		await invoke('sketch:botPolicyStatus', SKETCH_ID);
		expect(botPolicy.status).toHaveBeenCalledWith(SKETCH_ID);
		await invoke('sketch:setBotPolicy', SKETCH_ID, 'writers');
		expect(botPolicy.setPolicy).toHaveBeenCalledWith(SKETCH_ID, 'writers');
		await invoke('sketch:noteRoomBotPolicy', SKETCH_ID, 'writers');
		expect(botPolicy.noteRoomPolicy).toHaveBeenCalledWith(SKETCH_ID, 'writers');
		await expect(invoke('sketch:installScreen')).resolves.toEqual({
			installed: true,
			assigned: true,
		});
	});

	it('registers exactly the sketch channels', () => {
		expect([...h.handlers.keys()].sort()).toEqual([
			'sketch:botPolicyStatus',
			'sketch:confirmCloudScreening',
			'sketch:create',
			'sketch:delete',
			'sketch:get',
			'sketch:grantScreeningConsent',
			'sketch:installScreen',
			'sketch:list',
			'sketch:noteRoomBotPolicy',
			'sketch:ownerStatus',
			'sketch:prepareBotTurn',
			'sketch:readScene',
			'sketch:registerOwner',
			'sketch:rename',
			'sketch:reportServerScreening',
			'sketch:revokeLink',
			'sketch:revokeScreeningConsent',
			'sketch:roomConnection',
			'sketch:roomScreening',
			'sketch:rotate',
			'sketch:saveToProject',
			'sketch:screenBotReply',
			'sketch:screenBotRequest',
			'sketch:screeningConsentStatus',
			'sketch:setBotPolicy',
			'sketch:setBotSessionId',
			'sketch:setRoomLive',
			'sketch:share',
			'sketch:signOutOwner',
			'sketch:unshare',
			'sketch:uploadSnapshot',
			'sketch:waitForOwner',
			'sketch:writeScene',
		]);
	});

	it('passes each sharing channel through with no caller (the person in the tab is the conductor)', async () => {
		const service = h.service!;
		await invoke('sketch:ownerStatus');
		expect(service.ownerStatus).toHaveBeenCalled();
		await invoke('sketch:registerOwner', 'a@example.com');
		expect(service.registerOwner).toHaveBeenCalledWith('a@example.com');
		await invoke('sketch:waitForOwner', { timeoutMs: 1000 });
		expect(service.waitForOwner).toHaveBeenCalledWith({ timeoutMs: 1000 });
		await invoke('sketch:signOutOwner');
		expect(service.signOutOwner).toHaveBeenCalled();

		await invoke('sketch:share', SKETCH_ID, { role: 'ro' });
		expect(service.shareSketch).toHaveBeenCalledWith(SKETCH_ID, { role: 'ro' });
		await invoke('sketch:unshare', SKETCH_ID);
		expect(service.unshareSketch).toHaveBeenCalledWith(SKETCH_ID);
		await invoke('sketch:revokeLink', SKETCH_ID, 'cap-1');
		expect(service.revokeSketchLink).toHaveBeenCalledWith(SKETCH_ID, 'cap-1');
		await invoke('sketch:rotate', SKETCH_ID);
		expect(service.rotateSketch).toHaveBeenCalledWith(SKETCH_ID);
		await expect(
			invoke('sketch:uploadSnapshot', SKETCH_ID, { scene, baseSeq: 3 })
		).resolves.toEqual({
			bytes: 64,
		});
		expect(service.uploadSnapshot).toHaveBeenCalledWith(SKETCH_ID, { scene, baseSeq: 3 });
		await expect(invoke('sketch:roomConnection', SKETCH_ID)).resolves.toBeNull();
		expect(service.roomConnection).toHaveBeenCalledWith(SKETCH_ID);
		const request = {
			replyTo: 'msg-1',
			ts: 1_000,
			actor: { id: 'guest-1', kind: 'guest', name: 'Sam', role: 'rw' },
			text: 'add a box',
		};
		await expect(invoke('sketch:screenBotRequest', SKETCH_ID, request)).resolves.toMatchObject({
			status: 'clean',
		});
		expect(service.screenBotRequest).toHaveBeenCalledWith(SKETCH_ID, request);
	});

	it('passes each bot turn channel through to the bot turn service', async () => {
		const botTurns = h.botTurns!;
		await expect(invoke('sketch:prepareBotTurn', SKETCH_ID, 'restricted')).resolves.toEqual({
			ok: false,
			reason: 'The owner agent was removed.',
		});
		expect(botTurns.prepareBotTurn).toHaveBeenCalledWith(SKETCH_ID, 'restricted');
		await expect(invoke('sketch:screenBotReply', SKETCH_ID, 'Done.')).resolves.toEqual({
			ok: true,
			text: 'Done.',
		});
		expect(botTurns.screenBotReply).toHaveBeenCalledWith(SKETCH_ID, 'Done.');
		await expect(invoke('sketch:setBotSessionId', SKETCH_ID, 'session-1')).resolves.toBe(record);
		expect(botTurns.setBotSessionId).toHaveBeenCalledWith(SKETCH_ID, 'session-1');
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
