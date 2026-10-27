/**
 * @file sketch-store.test.ts
 *
 * The Sketch Book store (spec section 3, Binding record). Properties worth
 * protecting:
 *
 *   - **A sketch is a record plus a scene file**: the record lands in
 *     `sketches/index.json`, the scene at `sketches/<agentId>/<sketchId>.excalidraw`.
 *   - **Writes to one sketch never overlap**, however many are in flight.
 *   - **A torn index is moved aside**, the store starts empty, and the scenes stay.
 *   - **A room key or owner token is never readable text on disk.**
 *   - **Save to project never writes outside the folder it was given**, by a
 *     `..` in the name or by a symlink inside the folder.
 *
 * Paths are built with `path.join` throughout: the Windows CI leg runs this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
// The production binding is never used here: every store gets a temp dir and a fake seal.
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => 'sketch-store-unused') },
	safeStorage: {
		isEncryptionAvailable: vi.fn(() => false),
		encryptString: vi.fn(),
		decryptString: vi.fn(),
	},
}));

/**
 * Counts how many atomic writes of one file are running at once. A short delay
 * inside each write gives overlapping writes the chance to overlap, so a store
 * that did not serialize them would show more than one in flight.
 */
const writeProbe = vi.hoisted(() => ({
	delayMs: 0,
	inFlight: new Map<string, number>(),
	maxInFlight: new Map<string, number>(),
	writes: new Map<string, number>(),
}));
vi.mock('../../../main/utils/atomic-json-store', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/utils/atomic-json-store')>();
	return {
		...actual,
		atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
			const file = String(args[0]);
			const running = (writeProbe.inFlight.get(file) ?? 0) + 1;
			writeProbe.inFlight.set(file, running);
			writeProbe.maxInFlight.set(file, Math.max(running, writeProbe.maxInFlight.get(file) ?? 0));
			writeProbe.writes.set(file, (writeProbe.writes.get(file) ?? 0) + 1);
			try {
				if (writeProbe.delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, writeProbe.delayMs));
				}
				return await actual.atomicWriteFile(...args);
			} finally {
				writeProbe.inFlight.set(file, (writeProbe.inFlight.get(file) ?? 1) - 1);
			}
		},
	};
});

import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import {
	SKETCHES_DIR_NAME,
	SKETCH_INDEX_FILE,
	SKETCH_FILE_EXTENSION,
	createSketchStore,
	emptySketchScene,
	isSketchStoreError,
	linkCapSecretName,
	type SketchStore,
	type SketchStoreErrorCode,
} from '../../../main/sketch/sketch-store';
import type { SketchScene } from '../../../shared/sketch/types';

/** An OS seal that marks what it sealed, so plaintext never survives it. */
function fakeOsSeal(available = true): SealProvider {
	return {
		available: () => available,
		seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
		unseal: (blob) => {
			const text = blob.toString();
			if (!text.startsWith('os-sealed:')) throw new Error('not sealed by this OS key');
			return Buffer.from(text.slice('os-sealed:'.length), 'hex').toString();
		},
	};
}

const ROOM_KEY = 'room-key-AAAABBBBCCCCDDDDEEEEFFFF0123456789';
const OWNER_TOKEN = 'owner-token-zyxwvutsrqponmlkjihgfedcba9876';

let tempDir: string;
let dataDir: string;
let seal: SealProvider;
let store: SketchStore;

function makeStore(): SketchStore {
	let clock = 1_000;
	return createSketchStore({
		dataDir: () => dataDir,
		osSeal: () => seal,
		// A strictly increasing clock, so creation order is the list order.
		now: () => ++clock,
	});
}

function indexFile(): string {
	return path.join(dataDir, SKETCHES_DIR_NAME, SKETCH_INDEX_FILE);
}

function sceneFile(ownerAgentId: string, sketchId: string): string {
	return path.join(dataDir, SKETCHES_DIR_NAME, ownerAgentId, `${sketchId}${SKETCH_FILE_EXTENSION}`);
}

/** A scene with one rectangle, labeled so two scenes are never equal. */
function sceneWith(label: string): SketchScene {
	return {
		...emptySketchScene(),
		elements: [{ id: `el-${label}`, version: 1, type: 'rectangle', x: 0, y: 0, label }],
	};
}

/** The code of a `SketchStoreError` the promise rejects with. */
async function rejectionCode(promise: Promise<unknown>): Promise<SketchStoreErrorCode> {
	try {
		await promise;
	} catch (error) {
		if (isSketchStoreError(error)) return error.code;
		throw error;
	}
	throw new Error('Expected the store to refuse, and it did not.');
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-store-'));
	dataDir = path.join(tempDir, 'userData');
	await fs.mkdir(dataDir, { recursive: true });
	seal = fakeOsSeal();
	writeProbe.delayMs = 0;
	writeProbe.inFlight.clear();
	writeProbe.maxInFlight.clear();
	writeProbe.writes.clear();
	store = makeStore();
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe('createSketch', () => {
	it('writes the record to the index and an empty scene beside it', async () => {
		const record = await store.createSketch({ ownerAgentId: 'agent-a', name: '  Plan   board ' });

		expect(record.ownerAgentId).toBe('agent-a');
		expect(record.name).toBe('Plan board');
		expect(record.share).toBeNull();
		expect(record.guestEdited).toBe(false);
		expect(record.filePath).toBe(sceneFile('agent-a', record.sketchId));

		const index = JSON.parse(await fs.readFile(indexFile(), 'utf-8'));
		expect(index.sketches[record.sketchId]).toEqual(record);

		const scene = JSON.parse(await fs.readFile(sceneFile('agent-a', record.sketchId), 'utf-8'));
		expect(scene).toEqual(emptySketchScene());
		expect(await store.getSketch(record.sketchId)).toEqual(record);
	});

	it('names an unnamed sketch and refuses an agent id that is not one plain segment', async () => {
		expect((await store.createSketch({ ownerAgentId: 'agent-a' })).name).toBe('Untitled Sketch');
		expect(await rejectionCode(store.createSketch({ ownerAgentId: '..' }))).toBe('invalid-agent');
		expect(await rejectionCode(store.createSketch({ ownerAgentId: path.join('a', 'b') }))).toBe(
			'invalid-agent'
		);
	});
});

describe('listSketches', () => {
	it('lists every sketch in creation order, or only those of one owner', async () => {
		const first = await store.createSketch({ ownerAgentId: 'agent-a', name: 'First' });
		const other = await store.createSketch({ ownerAgentId: 'agent-b', name: 'Other' });
		const second = await store.createSketch({ ownerAgentId: 'agent-a', name: 'Second' });

		expect((await store.listSketches()).map((r) => r.sketchId)).toEqual([
			first.sketchId,
			other.sketchId,
			second.sketchId,
		]);
		expect((await store.listSketches({ ownerAgentId: 'agent-a' })).map((r) => r.name)).toEqual([
			'First',
			'Second',
		]);
		expect((await store.listSketches({ ownerAgentId: 'agent-b' })).map((r) => r.name)).toEqual([
			'Other',
		]);
		expect(await store.listSketches({ ownerAgentId: 'agent-c' })).toEqual([]);
	});

	it('starts empty when nothing has been created', async () => {
		expect(await store.listSketches()).toEqual([]);
		expect(await exists(indexFile())).toBe(false);
	});
});

describe('readScene and writeScene', () => {
	it('reads back exactly the scene that was written', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const scene = sceneWith('one');

		await store.writeScene(sketchId, scene);

		expect(await store.readScene(sketchId)).toEqual(scene);
		expect(JSON.parse(await fs.readFile(sceneFile('agent-a', sketchId), 'utf-8'))).toEqual(scene);
	});

	it('refuses a value that is not an Excalidraw scene, and leaves the file alone', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const notAScene = { type: 'excalidraw', version: 2, elements: [{ id: 'x' }] };

		expect(
			await rejectionCode(store.writeScene(sketchId, notAScene as unknown as SketchScene))
		).toBe('invalid-scene');
		expect(await store.readScene(sketchId)).toEqual(emptySketchScene());
	});

	it('refuses an unknown sketch id', async () => {
		expect(
			await rejectionCode(store.writeScene('00000000-0000-4000-8000-000000000000', sceneWith('x')))
		).toBe('not-found');
		expect(await rejectionCode(store.readScene('not-a-uuid'))).toBe('not-found');
	});

	it('runs concurrent writes to one sketch one at a time, and the file ends whole', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const file = sceneFile('agent-a', sketchId);
		writeProbe.writes.clear();
		writeProbe.maxInFlight.clear();
		writeProbe.delayMs = 5;

		const scenes = Array.from({ length: 8 }, (_, i) => sceneWith(`concurrent-${i}`));
		await Promise.all(scenes.map((scene) => store.writeScene(sketchId, scene)));

		expect(writeProbe.writes.get(file)).toBe(scenes.length);
		expect(writeProbe.maxInFlight.get(file)).toBe(1);

		// Whatever order they landed in, the file is one complete scene, never a mix.
		const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
		expect(scenes).toContainEqual(onDisk);
		expect(await store.readScene(sketchId)).toEqual(onDisk);
	});

	it('refuses a scene file that is not JSON by name, and never writes over it', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const file = sceneFile('agent-a', sketchId);
		await fs.writeFile(file, '{"type":"excalidraw",', 'utf-8');

		expect(await rejectionCode(store.readScene(sketchId))).toBe('scene-unreadable');
		expect(await fs.readFile(file, 'utf-8')).toBe('{"type":"excalidraw",');
	});
});

describe('a corrupt index', () => {
	it('is moved aside, the store starts empty, and the scene files stay', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		await store.writeScene(sketchId, sceneWith('kept'));
		const torn = '{"version":1,"sketches":{"';
		await fs.writeFile(indexFile(), torn, 'utf-8');

		expect(await store.listSketches()).toEqual([]);

		const sketchesDir = path.join(dataDir, SKETCHES_DIR_NAME);
		const sidecars = (await fs.readdir(sketchesDir)).filter((name) =>
			name.startsWith('index.corrupt-')
		);
		expect(sidecars).toHaveLength(1);
		expect(await fs.readFile(path.join(sketchesDir, sidecars[0]), 'utf-8')).toBe(torn);
		expect(logger.error).toHaveBeenCalled();

		// The scene is still on disk, untouched.
		const scene = JSON.parse(await fs.readFile(sceneFile('agent-a', sketchId), 'utf-8'));
		expect(scene).toEqual(sceneWith('kept'));

		// The store works again: the next create writes a fresh, valid index.
		const fresh = await store.createSketch({ ownerAgentId: 'agent-a', name: 'After' });
		expect((await store.listSketches()).map((r) => r.sketchId)).toEqual([fresh.sketchId]);
		expect(JSON.parse(await fs.readFile(indexFile(), 'utf-8')).sketches).toHaveProperty(
			fresh.sketchId
		);
	});

	it('drops a record that could name a path outside the sketches folder', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const index = JSON.parse(await fs.readFile(indexFile(), 'utf-8'));
		index.sketches[sketchId].ownerAgentId = '..';
		await fs.writeFile(indexFile(), JSON.stringify(index), 'utf-8');

		expect(await store.listSketches()).toEqual([]);
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe('sealed secrets', () => {
	it('never writes a room key or owner token as plaintext, and opens them again', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		await store.setSketchSecrets(sketchId, { roomKey: ROOM_KEY, ownerToken: OWNER_TOKEN });

		const raw = await fs.readFile(indexFile(), 'utf-8');
		expect(raw).not.toContain(ROOM_KEY);
		expect(raw).not.toContain(OWNER_TOKEN);
		expect(JSON.parse(raw).secrets[sketchId].roomKey.storage).toBe('os');

		// No record carries a secret out.
		const record = await store.getSketch(sketchId);
		expect(JSON.stringify(record)).not.toContain(ROOM_KEY);
		expect(JSON.stringify(await store.listSketches())).not.toContain(OWNER_TOKEN);

		expect(await store.readSketchSecrets(sketchId)).toEqual({
			roomKey: ROOM_KEY,
			ownerToken: OWNER_TOKEN,
		});
	});

	it('obscures secrets where the OS has no key store, still never as plaintext', async () => {
		seal = fakeOsSeal(false);
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		await store.setSketchSecrets(sketchId, { roomKey: ROOM_KEY, ownerToken: OWNER_TOKEN });

		const raw = await fs.readFile(indexFile(), 'utf-8');
		expect(raw).not.toContain(ROOM_KEY);
		expect(raw).not.toContain(OWNER_TOKEN);
		expect(JSON.parse(raw).secrets[sketchId].ownerToken.storage).toBe('obscured');
		expect(await store.readSketchSecrets(sketchId)).toEqual({
			roomKey: ROOM_KEY,
			ownerToken: OWNER_TOKEN,
		});
	});

	it('removes one secret with null, and all of them with the sketch', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		await store.setSketchSecrets(sketchId, { roomKey: ROOM_KEY, ownerToken: OWNER_TOKEN });

		await store.setSketchSecrets(sketchId, { roomKey: null });
		expect(await store.readSketchSecrets(sketchId)).toEqual({ ownerToken: OWNER_TOKEN });

		await store.deleteSketch(sketchId);
		const index = JSON.parse(await fs.readFile(indexFile(), 'utf-8'));
		expect(index.secrets).toEqual({});
		expect(index.sketches).toEqual({});
		expect(await exists(sceneFile('agent-a', sketchId))).toBe(false);
	});

	it('seals a link cap under its own name, and refuses a name that is not a secret', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		const cap = 'c'.repeat(43);

		await store.setSketchSecrets(sketchId, { [linkCapSecretName('capid0000001')]: cap });

		const raw = await fs.readFile(indexFile(), 'utf-8');
		expect(raw).not.toContain(cap);
		expect(await store.readSketchSecrets(sketchId)).toEqual({ 'cap:capid0000001': cap });
		await expect(
			store.setSketchSecrets(sketchId, { 'cap:../escape': cap } as Record<string, string>)
		).rejects.toThrow('is not a sketch secret');
	});

	it('drops a stored secret whose name is not one on load', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		await store.setSketchSecrets(sketchId, { roomKey: ROOM_KEY });
		const index = JSON.parse(await fs.readFile(indexFile(), 'utf-8'));
		index.secrets[sketchId].bogus = index.secrets[sketchId].roomKey;
		await fs.writeFile(indexFile(), JSON.stringify(index));

		expect(Object.keys(await makeStore().readSketchSecrets(sketchId))).toEqual(['roomKey']);
	});
});

describe('renameSketch', () => {
	it('renames the record and keeps the scene where it was', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a', name: 'Old' });

		const renamed = await store.renameSketch(sketchId, 'New name');

		expect(renamed.name).toBe('New name');
		expect((await store.getSketch(sketchId))?.name).toBe('New name');
		expect(await exists(sceneFile('agent-a', sketchId))).toBe(true);
	});
});

describe('setBotSessionId', () => {
	it('keeps the bot session on the record and forgets it with null', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		const set = await store.setBotSessionId(sketchId, 'provider-session-1');
		expect(set.botSessionId).toBe('provider-session-1');
		expect((await store.getSketch(sketchId))?.botSessionId).toBe('provider-session-1');

		const cleared = await store.setBotSessionId(sketchId, null);
		expect(cleared.botSessionId).toBeUndefined();
		expect((await store.getSketch(sketchId))?.botSessionId).toBeUndefined();
	});

	it('refuses a sketch that does not exist', async () => {
		await expect(
			store.setBotSessionId('00000000-0000-4000-8000-000000000000', 'x')
		).rejects.toThrow(/No sketch/);
	});
});

describe('updateSketchShare', () => {
	const share = {
		roomId: 'R'.repeat(22),
		keyEpoch: 0,
		links: [],
		botPolicy: 'conductor' as const,
		serverUrl: 'https://sketch.runmaestro.ai',
	};

	it('stores the share state on the record, keeps it across a reload, and clears it with null', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		const shared = await store.updateSketchShare(sketchId, (current) => {
			expect(current).toBeNull();
			return share;
		});
		expect(shared.share).toEqual(share);

		await store.updateSketchShare(sketchId, (current) =>
			current ? { ...current, keyEpoch: current.keyEpoch + 1 } : current
		);
		expect((await makeStore().getSketch(sketchId))?.share).toEqual({ ...share, keyEpoch: 1 });

		const cleared = await store.updateSketchShare(sketchId, () => null);
		expect(cleared.share).toBeNull();
		expect((await store.getSketch(sketchId))?.share).toBeNull();
	});

	it('refuses an unknown sketch and never calls the change', async () => {
		const change = vi.fn(() => share);
		await expect(
			store.updateSketchShare('99999999-2222-4333-8444-555555555555', change)
		).rejects.toMatchObject({ code: 'not-found' });
		expect(change).not.toHaveBeenCalled();
	});
});

describe('saveSketchToProject', () => {
	let projectDir: string;
	let outsideDir: string;

	beforeEach(async () => {
		projectDir = path.join(tempDir, 'project');
		outsideDir = path.join(tempDir, 'outside');
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });
	});

	it('copies the scene into the folder under the sketch name', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a', name: 'Board' });
		await store.writeScene(sketchId, sceneWith('saved'));

		const written = await store.saveSketchToProject(sketchId, projectDir);

		expect(written).toBe(path.join(projectDir, `Board${SKETCH_FILE_EXTENSION}`));
		expect(JSON.parse(await fs.readFile(written, 'utf-8'))).toEqual(sceneWith('saved'));
	});

	it('refuses a file name that climbs out of the folder, and writes nothing', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		expect(
			await rejectionCode(
				store.saveSketchToProject(sketchId, projectDir, {
					fileName: path.join('..', 'outside', 'escape.excalidraw'),
				})
			)
		).toBe('outside-destination');
		expect(
			await rejectionCode(
				store.saveSketchToProject(sketchId, projectDir, {
					fileName: path.join(outsideDir, 'absolute.excalidraw'),
				})
			)
		).toBe('outside-destination');
		expect(await fs.readdir(outsideDir)).toEqual([]);
		expect(await fs.readdir(projectDir)).toEqual([]);
	});

	it('refuses a path that a symlink inside the folder points outside', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });
		// A junction needs no privilege on Windows; POSIX ignores the type.
		await fs.symlink(outsideDir, path.join(projectDir, 'link'), 'junction');

		expect(
			await rejectionCode(
				store.saveSketchToProject(sketchId, projectDir, {
					fileName: path.join('link', 'escape.excalidraw'),
				})
			)
		).toBe('outside-destination');
		expect(await fs.readdir(outsideDir)).toEqual([]);
	});

	it('refuses a relative destination folder', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a' });

		expect(await rejectionCode(store.saveSketchToProject(sketchId, 'project'))).toBe(
			'invalid-destination'
		);
	});

	it('will not overwrite a file unless asked', async () => {
		const { sketchId } = await store.createSketch({ ownerAgentId: 'agent-a', name: 'Board' });
		const target = path.join(projectDir, `Board${SKETCH_FILE_EXTENSION}`);
		await fs.writeFile(target, 'keep me', 'utf-8');

		expect(await rejectionCode(store.saveSketchToProject(sketchId, projectDir))).toBe('exists');
		expect(await fs.readFile(target, 'utf-8')).toBe('keep me');

		await store.saveSketchToProject(sketchId, projectDir, { overwrite: true });
		expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual(emptySketchScene());
	});
});
