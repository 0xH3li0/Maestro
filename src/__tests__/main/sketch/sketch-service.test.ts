/**
 * @file sketch-service.test.ts
 *
 * The Sketch Book service: the one implementation the `sketch:*` IPC handlers
 * and the CLI's WS verbs share. Properties worth protecting:
 *
 *   - **The Encore gate comes first**: while `sketchBook` is off, every method
 *     refuses with the readable `encoreDisabledMessage('sketchBook')` text and
 *     the store is never touched.
 *   - **Only a live local agent can own a new sketch** (Q12): an unknown agent
 *     and an SSH agent are refused before the store is called.
 *   - **Arguments from IPC are checked by type** before the store sees them.
 *   - **Listing by owner does not need the agent to exist**: a sketch outlives
 *     the agent that made it.
 *   - **The sharing verbs** are gated too; their behavior is covered in
 *     `sketch-share.test.ts`.
 *   - **The bot screen** (`screenBotRequest`) takes guest requests only and
 *     hands the gate a chat subject for the sketch's owning agent.
 *   - **The CLI verbs** (`new`, `open`, `read`, `export`): a tab opens on the
 *     sketch's own agent through the renderer bridge, a gone or SSH owner is
 *     refused before the window is asked, `read` summarizes or returns live
 *     elements, and `export` answers JSON itself and asks a window for PNG/SVG.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
	settings: { encoreFeatures: { sketchBook: true } } as Record<string, unknown>,
	sessions: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => 'sketch-service-unused') },
	ipcMain: { on: vi.fn(), removeListener: vi.fn() },
	safeStorage: {
		isEncryptionAvailable: vi.fn(() => false),
		encryptString: vi.fn(),
		decryptString: vi.fn(),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => h.settings[key] }),
	getLiveSessions: () => h.sessions,
}));

import { createSketchService, type SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchRendererBridge } from '../../../main/sketch/sketch-renderer-bridge';
import type { SketchStore } from '../../../main/sketch/sketch-store';
import { encoreDisabledMessage } from '../../../shared/encoreFeatureDefaults';
import type { SketchRecord, SketchScene } from '../../../shared/sketch/types';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';

const record: SketchRecord = {
	sketchId: SKETCH_ID,
	ownerAgentId: 'agent-1',
	name: 'Board',
	filePath: 'sketches/agent-1/board.excalidraw',
	createdAt: 1,
	share: null,
	guestEdited: false,
};

const scene: SketchScene = {
	type: 'excalidraw',
	version: 2,
	source: 'maestro',
	elements: [],
	appState: {},
	files: {},
};

function fakeStore() {
	return {
		createSketch: vi.fn(async () => record),
		listSketches: vi.fn(async () => [record]),
		getSketch: vi.fn(async () => record),
		readScene: vi.fn(async () => scene),
		writeScene: vi.fn(async () => {}),
		renameSketch: vi.fn(async () => ({ ...record, name: 'Renamed' })),
		deleteSketch: vi.fn(async () => {}),
		saveSketchToProject: vi.fn(async () => '/project/Board.excalidraw'),
		updateSketchShare: vi.fn(async () => record),
		setBotSessionId: vi.fn(async () => record),
		setSketchSecrets: vi.fn(async () => {}),
		readSketchSecrets: vi.fn(async () => ({})),
		sketchesDir: vi.fn(() => 'sketches'),
	} satisfies SketchStore;
}

const localAgent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false };

describe('SketchService', () => {
	let store: ReturnType<typeof fakeStore>;
	let enabled: boolean;
	let renderer: ReturnType<typeof vi.fn<SketchRendererBridge>>;

	const service = (agents: SketchOwnerAgent[] = [localAgent]) =>
		createSketchService({
			store: () => store,
			isEnabled: () => enabled,
			findAgent: (id) => agents.find((agent) => agent.id === id) ?? null,
			renderer,
		});

	beforeEach(() => {
		store = fakeStore();
		renderer = vi.fn<SketchRendererBridge>(async () => ({ success: true, tabId: 'tab-1' }));
		enabled = true;
		h.settings = { encoreFeatures: { sketchBook: true } };
		h.sessions = [];
	});

	describe('Encore gate', () => {
		const calls: Array<[string, (s: ReturnType<typeof createSketchService>) => Promise<unknown>]> =
			[
				['createSketch', (s) => s.createSketch({ ownerAgentId: 'agent-1' })],
				['listSketches', (s) => s.listSketches()],
				['getSketch', (s) => s.getSketch(SKETCH_ID)],
				['readScene', (s) => s.readScene(SKETCH_ID)],
				['writeScene', (s) => s.writeScene(SKETCH_ID, scene)],
				['renameSketch', (s) => s.renameSketch(SKETCH_ID, 'New')],
				['deleteSketch', (s) => s.deleteSketch(SKETCH_ID)],
				['saveSketchToProject', (s) => s.saveSketchToProject(SKETCH_ID, '/project')],
				['newSketch', (s) => s.newSketch({ ownerAgentId: 'agent-1' })],
				['openSketch', (s) => s.openSketch(SKETCH_ID)],
				['readSketch', (s) => s.readSketch(SKETCH_ID)],
				['exportSketch', (s) => s.exportSketch(SKETCH_ID, 'png')],
				['ownerStatus', (s) => s.ownerStatus()],
				['registerOwner', (s) => s.registerOwner('a@example.com')],
				['waitForOwner', (s) => s.waitForOwner()],
				['signOutOwner', (s) => s.signOutOwner()],
				['shareSketch', (s) => s.shareSketch(SKETCH_ID)],
				['unshareSketch', (s) => s.unshareSketch(SKETCH_ID)],
				['revokeSketchLink', (s) => s.revokeSketchLink(SKETCH_ID, 'AAAAAAAAAAAA')],
				['rotateSketch', (s) => s.rotateSketch(SKETCH_ID)],
				['uploadSnapshot', (s) => s.uploadSnapshot(SKETCH_ID, { scene, baseSeq: 0 })],
				['roomConnection', (s) => s.roomConnection(SKETCH_ID)],
				[
					'screenBotRequest',
					(s) =>
						s.screenBotRequest(SKETCH_ID, {
							replyTo: 'msg-1',
							ts: 1,
							actor: { id: 'g', kind: 'guest', name: 'Sam', role: 'rw' },
							text: 'hi',
						}),
				],
			];

		it.each(calls)(
			'%s refuses while Sketch Book is off and leaves the store alone',
			async (_, call) => {
				enabled = false;
				await expect(call(service())).rejects.toThrow(encoreDisabledMessage('sketchBook'));
				for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
				expect(renderer).not.toHaveBeenCalled();
			}
		);

		it('reads the flag from the settings store by default', async () => {
			const defaults = createSketchService({ store: () => store, findAgent: () => localAgent });
			await expect(defaults.listSketches()).resolves.toEqual([record]);
			h.settings = { encoreFeatures: { sketchBook: false } };
			await expect(defaults.listSketches()).rejects.toThrow(encoreDisabledMessage('sketchBook'));
			// No stored flag means the default, which is off.
			h.settings = {};
			await expect(defaults.listSketches()).rejects.toThrow(encoreDisabledMessage('sketchBook'));
		});
	});

	describe('createSketch', () => {
		it('creates a sketch for a live local agent', async () => {
			await expect(
				service().createSketch({ ownerAgentId: 'agent-1', name: 'Board' })
			).resolves.toEqual(record);
			expect(store.createSketch).toHaveBeenCalledWith({ ownerAgentId: 'agent-1', name: 'Board' });
		});

		it('refuses an agent that does not exist', async () => {
			await expect(service().createSketch({ ownerAgentId: 'ghost' })).rejects.toThrow(
				'no agent has the id "ghost"'
			);
			expect(store.createSketch).not.toHaveBeenCalled();
		});

		it('refuses an agent that runs over SSH (Q12)', async () => {
			const remote = { id: 'agent-2', name: 'Remote', sshRemote: true };
			await expect(service([remote]).createSketch({ ownerAgentId: 'agent-2' })).rejects.toThrow(
				'"Remote" runs over SSH'
			);
			expect(store.createSketch).not.toHaveBeenCalled();
		});

		it('refuses a missing or mistyped owner and a non-string name', async () => {
			const s = service();
			await expect(s.createSketch(undefined as never)).rejects.toThrow('ownerAgentId');
			await expect(s.createSketch({ ownerAgentId: 42 } as never)).rejects.toThrow('ownerAgentId');
			await expect(s.createSketch({ ownerAgentId: 'agent-1', name: 7 } as never)).rejects.toThrow(
				'name must be a string'
			);
			expect(store.createSketch).not.toHaveBeenCalled();
		});

		it('resolves the owner from the live agent list by default', async () => {
			h.sessions = [
				{ id: 'agent-1', name: 'Builder' },
				{
					id: 'agent-2',
					name: 'Remote',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				},
				{ id: 'agent-3', name: 'Was remote', sessionSshRemoteConfig: { enabled: false } },
			];
			const defaults = createSketchService({ store: () => store, isEnabled: () => true });
			await expect(defaults.createSketch({ ownerAgentId: 'agent-1' })).resolves.toEqual(record);
			await expect(defaults.createSketch({ ownerAgentId: 'agent-3' })).resolves.toEqual(record);
			await expect(defaults.createSketch({ ownerAgentId: 'agent-2' })).rejects.toThrow(
				'runs over SSH'
			);
			await expect(defaults.createSketch({ ownerAgentId: 'agent-9' })).rejects.toThrow(
				'no agent has the id'
			);
			expect(store.createSketch).toHaveBeenCalledTimes(2);
		});
	});

	describe('listSketches', () => {
		it('lists every sketch without a filter', async () => {
			await service().listSketches();
			expect(store.listSketches).toHaveBeenCalledWith(undefined);
			await service().listSketches({});
			expect(store.listSketches).toHaveBeenLastCalledWith(undefined);
		});

		it('filters by an owner that no longer exists', async () => {
			await service([]).listSketches({ ownerAgentId: 'removed-agent' });
			expect(store.listSketches).toHaveBeenCalledWith({ ownerAgentId: 'removed-agent' });
		});

		it('refuses a mistyped owner filter', async () => {
			await expect(service().listSketches({ ownerAgentId: 5 } as never)).rejects.toThrow(
				'ownerAgentId must be a string'
			);
		});
	});

	describe('per-sketch methods', () => {
		it('passes each call through to the store', async () => {
			const s = service();
			await expect(s.getSketch(SKETCH_ID)).resolves.toEqual(record);
			await expect(s.readScene(SKETCH_ID)).resolves.toEqual(scene);
			await s.writeScene(SKETCH_ID, scene);
			await expect(s.renameSketch(SKETCH_ID, 'Renamed')).resolves.toMatchObject({
				name: 'Renamed',
			});
			await s.deleteSketch(SKETCH_ID);
			expect(store.getSketch).toHaveBeenCalledWith(SKETCH_ID);
			expect(store.readScene).toHaveBeenCalledWith(SKETCH_ID);
			expect(store.writeScene).toHaveBeenCalledWith(SKETCH_ID, scene);
			expect(store.renameSketch).toHaveBeenCalledWith(SKETCH_ID, 'Renamed');
			expect(store.deleteSketch).toHaveBeenCalledWith(SKETCH_ID);
		});

		it('refuses a sketch id that is not a non-empty string', async () => {
			const s = service();
			await expect(s.getSketch('' as string)).rejects.toThrow('sketchId');
			await expect(s.readScene(undefined as never)).rejects.toThrow('sketchId');
			await expect(s.writeScene(3 as never, scene)).rejects.toThrow('sketchId');
			await expect(s.deleteSketch(null as never)).rejects.toThrow('sketchId');
			await expect(s.renameSketch(SKETCH_ID, null as never)).rejects.toThrow(
				'name must be a string'
			);
			expect(store.getSketch).not.toHaveBeenCalled();
			expect(store.readScene).not.toHaveBeenCalled();
			expect(store.writeScene).not.toHaveBeenCalled();
			expect(store.deleteSketch).not.toHaveBeenCalled();
			expect(store.renameSketch).not.toHaveBeenCalled();
		});

		it('saves to a project with only the options it understands', async () => {
			const s = service();
			await expect(s.saveSketchToProject(SKETCH_ID, '/project')).resolves.toBe(
				'/project/Board.excalidraw'
			);
			expect(store.saveSketchToProject).toHaveBeenLastCalledWith(SKETCH_ID, '/project', {
				overwrite: false,
			});
			await s.saveSketchToProject(SKETCH_ID, '/project', {
				fileName: 'boards/plan.excalidraw',
				overwrite: true,
				extra: 'ignored',
			} as never);
			expect(store.saveSketchToProject).toHaveBeenLastCalledWith(SKETCH_ID, '/project', {
				fileName: 'boards/plan.excalidraw',
				overwrite: true,
			});
			// Only a real `true` overwrites.
			await s.saveSketchToProject(SKETCH_ID, '/project', { overwrite: 'yes' } as never);
			expect(store.saveSketchToProject).toHaveBeenLastCalledWith(SKETCH_ID, '/project', {
				overwrite: false,
			});
		});

		it('refuses a missing destination or a mistyped file name', async () => {
			const s = service();
			await expect(s.saveSketchToProject(SKETCH_ID, '' as string)).rejects.toThrow('destDir');
			await expect(
				s.saveSketchToProject(SKETCH_ID, '/project', { fileName: 9 } as never)
			).rejects.toThrow('fileName must be a string');
			expect(store.saveSketchToProject).not.toHaveBeenCalled();
		});
	});

	describe('newSketch', () => {
		it('creates the sketch and opens it on its agent, in the background when asked', async () => {
			const opened = await service().newSketch({
				ownerAgentId: 'agent-1',
				name: 'Plan',
				background: true,
			});

			expect(store.createSketch).toHaveBeenCalledWith({ ownerAgentId: 'agent-1', name: 'Plan' });
			expect(renderer).toHaveBeenCalledWith('agent-1', {
				action: 'open',
				sessionId: 'agent-1',
				sketchId: SKETCH_ID,
				name: 'Board',
				background: true,
			});
			expect(opened).toEqual({ record, tabId: 'tab-1' });
		});

		it('focuses unless background is literally true', async () => {
			await service().newSketch({ ownerAgentId: 'agent-1', background: 'yes' as never });
			expect(renderer.mock.calls[0][1]).toMatchObject({ background: false });
		});

		it('refuses an SSH owner before anything is created', async () => {
			await expect(
				service([{ ...localAgent, sshRemote: true }]).newSketch({ ownerAgentId: 'agent-1' })
			).rejects.toThrow('local agents only');
			expect(store.createSketch).not.toHaveBeenCalled();
			expect(renderer).not.toHaveBeenCalled();
		});

		it('names the created sketch when its tab did not open', async () => {
			renderer.mockResolvedValue({ success: false, error: 'No Maestro window is open.' });
			await expect(service().newSketch({ ownerAgentId: 'agent-1' })).rejects.toThrow(
				`Sketch "Board" (${SKETCH_ID}) was created, but its tab did not open. Sketch Book: No Maestro window is open.`
			);
		});
	});

	describe('openSketch', () => {
		it('opens the tab on the agent that owns the sketch, focused by default', async () => {
			await expect(service().openSketch(SKETCH_ID)).resolves.toEqual({ record, tabId: 'tab-1' });
			expect(renderer).toHaveBeenCalledWith(
				'agent-1',
				expect.objectContaining({ action: 'open', sketchId: SKETCH_ID, background: false })
			);
		});

		it('reports a missing tab id as null', async () => {
			renderer.mockResolvedValue({ success: true });
			await expect(service().openSketch(SKETCH_ID, { background: true })).resolves.toEqual({
				record,
				tabId: null,
			});
		});

		it('refuses an unknown sketch, a gone owner and an SSH owner without asking a window', async () => {
			store.getSketch.mockResolvedValueOnce(null as never);
			await expect(service().openSketch(SKETCH_ID)).rejects.toThrow('no sketch has the id');
			await expect(service([]).openSketch(SKETCH_ID)).rejects.toThrow('is gone');
			await expect(
				service([{ ...localAgent, sshRemote: true }]).openSketch(SKETCH_ID)
			).rejects.toThrow('runs over SSH');
			expect(renderer).not.toHaveBeenCalled();
		});

		it("passes the window's refusal through", async () => {
			renderer.mockResolvedValue({ success: false, error: 'The window did not answer in time.' });
			await expect(service().openSketch(SKETCH_ID)).rejects.toThrow(
				'Sketch Book: The window did not answer in time.'
			);
		});
	});

	describe('readSketch', () => {
		const drawn: SketchScene = {
			...scene,
			elements: [
				{ id: 'box', version: 1, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
				{ id: 'gone', version: 2, type: 'ellipse', isDeleted: true },
			],
		};

		it('summarizes the saved scene by default', async () => {
			store.readScene.mockResolvedValue(drawn);
			const reading = await service().readSketch(SKETCH_ID);

			expect(reading.format).toBe('summary');
			if (reading.format !== 'summary') return;
			expect(reading.record).toEqual(record);
			expect(reading.summary).toMatchObject({ elementCount: 1, deletedCount: 1 });
		});

		it('returns only the live elements for the elements format', async () => {
			store.readScene.mockResolvedValue(drawn);
			const reading = await service().readSketch(SKETCH_ID, 'elements');

			expect(reading).toEqual({ record, format: 'elements', elements: [drawn.elements[0]] });
		});

		it('refuses an unknown format and an unknown sketch', async () => {
			await expect(service().readSketch(SKETCH_ID, 'xml' as never)).rejects.toThrow(
				'format must be "summary" or "elements"'
			);
			store.getSketch.mockResolvedValueOnce(null as never);
			await expect(service().readSketch(SKETCH_ID)).rejects.toThrow('no sketch has the id');
			expect(store.readScene).not.toHaveBeenCalled();
		});
	});

	describe('exportSketch', () => {
		it('answers JSON from the saved file without a window', async () => {
			const { file } = await service().exportSketch(SKETCH_ID, 'json');

			expect(file).toEqual({
				format: 'json',
				mimeType: 'application/json',
				encoding: 'utf8',
				data: JSON.stringify(scene, null, '\t'),
			});
			expect(renderer).not.toHaveBeenCalled();
		});

		it("asks the owner's window to draw PNG and SVG", async () => {
			const png = {
				format: 'png',
				mimeType: 'image/png',
				encoding: 'base64',
				data: 'iVBO',
			} as const;
			renderer.mockResolvedValue({ success: true, file: png });

			await expect(service().exportSketch(SKETCH_ID, 'png')).resolves.toEqual({
				record,
				file: png,
			});
			expect(renderer).toHaveBeenCalledWith('agent-1', { action: 'export', format: 'png', scene });
		});

		it('lets any window draw a sketch whose agent is gone', async () => {
			renderer.mockResolvedValue({
				success: true,
				file: { format: 'svg', mimeType: 'image/svg+xml', encoding: 'utf8', data: '<svg/>' },
			});
			await service([]).exportSketch(SKETCH_ID, 'svg');
			expect(renderer.mock.calls[0][0]).toBeNull();
		});

		it('refuses a window that returned the wrong file or failed', async () => {
			renderer.mockResolvedValueOnce({ success: true });
			await expect(service().exportSketch(SKETCH_ID, 'svg')).rejects.toThrow(
				'did not return a svg file'
			);
			renderer.mockResolvedValueOnce({ success: false, error: 'Excalidraw failed to load.' });
			await expect(service().exportSketch(SKETCH_ID, 'png')).rejects.toThrow(
				'Sketch Book: Excalidraw failed to load.'
			);
		});

		it('refuses an unknown format before reading the scene', async () => {
			await expect(service().exportSketch(SKETCH_ID, 'gif' as never)).rejects.toThrow(
				'format must be "png", "svg" or "json"'
			);
			expect(store.readScene).not.toHaveBeenCalled();
		});
	});

	describe('screenBotRequest', () => {
		const guest = { id: 'guest-1', kind: 'guest' as const, name: 'Sam', role: 'rw' as const };
		const verdict = {
			status: 'clean' as const,
			score: 0.04,
			sourceLabel: 'Prompt Guard 2 22M',
			locality: 'local' as const,
		};

		it("hands the gate a chat subject on behalf of the sketch's agent", async () => {
			const screen = vi.fn(async () => verdict);
			const s = createSketchService({ store: () => store, isEnabled: () => true, screen });
			await expect(
				s.screenBotRequest(SKETCH_ID, {
					replyTo: 'msg-1',
					ts: 1_000,
					actor: { ...guest, capId: 'AAAAAAAAAAAA', capLabel: 'Team' },
					text: 'add a box',
				})
			).resolves.toEqual(verdict);
			expect(screen).toHaveBeenCalledWith({
				sketchId: SKETCH_ID,
				agentId: 'agent-1',
				subject: { kind: 'chat', replyTo: 'msg-1', ts: 1_000 },
				actor: { ...guest, capId: 'AAAAAAAAAAAA', capLabel: 'Team' },
				text: 'add a box',
			});
		});

		it('refuses anything but a guest request, so no caller can skip the gate', async () => {
			const screen = vi.fn(async () => verdict);
			const s = createSketchService({ store: () => store, isEnabled: () => true, screen });
			const base = { replyTo: 'msg-1', ts: 1, text: 'hi' };
			await expect(
				s.screenBotRequest(SKETCH_ID, {
					...base,
					actor: { id: 'c', kind: 'conductor', name: 'Me', role: 'conductor' },
				})
			).rejects.toThrow('only a guest request');
			await expect(
				s.screenBotRequest(SKETCH_ID, { ...base, ts: -1, actor: guest })
			).rejects.toThrow('ts must be');
			await expect(
				s.screenBotRequest(SKETCH_ID, { ...base, replyTo: '', actor: guest })
			).rejects.toThrow('replyTo must be');
			expect(screen).not.toHaveBeenCalled();
		});
	});
});
