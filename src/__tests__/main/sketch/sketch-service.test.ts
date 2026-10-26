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
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
	settings: { encoreFeatures: { sketchBook: true } } as Record<string, unknown>,
	sessions: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => 'sketch-service-unused') },
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
		setSketchSecrets: vi.fn(async () => {}),
		readSketchSecrets: vi.fn(async () => ({})),
		sketchesDir: vi.fn(() => 'sketches'),
	} satisfies SketchStore;
}

const localAgent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false };

describe('SketchService', () => {
	let store: ReturnType<typeof fakeStore>;
	let enabled: boolean;

	const service = (agents: SketchOwnerAgent[] = [localAgent]) =>
		createSketchService({
			store: () => store,
			isEnabled: () => enabled,
			findAgent: (id) => agents.find((agent) => agent.id === id) ?? null,
		});

	beforeEach(() => {
		store = fakeStore();
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
			];

		it.each(calls)(
			'%s refuses while Sketch Book is off and leaves the store alone',
			async (_, call) => {
				enabled = false;
				await expect(call(service())).rejects.toThrow(encoreDisabledMessage('sketchBook'));
				for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled();
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
});
