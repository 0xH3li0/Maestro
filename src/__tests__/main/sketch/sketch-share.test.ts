/**
 * @file sketch-share.test.ts
 *
 * Sharing a sketch (spec section 6) through the SketchService, over a real
 * store in a temp dir, a fake room API, a fake renderer bridge, and real
 * WebCrypto. Properties worth protecting:
 *
 *   - **The first share is room, snapshot, link, in that order**: the images
 *     and the encrypted snapshot are on the server before any link exists, so
 *     no link opens an empty room. The snapshot is the LIVE scene (unsaved
 *     edits included), sealed under the new key at epoch 0, and the owning
 *     window joins the room with the uploaded baseline.
 *   - **A failed first share leaves nothing behind**: the new room is archived
 *     and the record and room key are cleared.
 *   - **A later share mints a link only**: no new room, no new snapshot.
 *   - **Rotate bumps `keyEpoch` and re-uploads**: every link revoked, a new
 *     key, the scene and its images sealed again under the new epoch, the old
 *     key no longer opens it, and the window rejoins under the new key.
 *   - **A1**: when an agent asks, the desktop confirmation comes first and
 *     nothing runs (no request, no record change) until Allow; Deny changes
 *     nothing. A person's request runs directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => 'sketch-share-unused') },
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
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => undefined }),
	getLiveSessions: () => [],
}));

import { createSketchService, type SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchDesktopConfirmPrompt } from '../../../main/sketch/sketch-desktop-confirm';
import type { SketchOwnerAuth } from '../../../main/sketch/sketch-owner-auth';
import type { SketchRendererBridge } from '../../../main/sketch/sketch-renderer-bridge';
import type { SketchRoomApi, SketchRoomAuth } from '../../../main/sketch/sketch-room-api';
import {
	createSketchStore,
	emptySketchScene,
	type SketchStore,
} from '../../../main/sketch/sketch-store';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import type { SketchRendererRequest } from '../../../shared/sketch/commands';
import { decryptPayloadBlob, generateRoomKey, importRoomKey } from '../../../shared/sketch/crypto';
import { sketchShareLinkUrl } from '../../../shared/sketch/server';
import type { SketchScene } from '../../../shared/sketch/types';

const SERVER = 'https://sketch.example';
const OWNER_TOKEN = 'T'.repeat(80);
const ROOM_ID = 'R'.repeat(22);
const IMAGE_ID = 'img-1';
const NOW = 1_800_000_000_000;

const agent: SketchOwnerAgent = { id: 'agent-1', name: 'Builder', sshRemote: false, cwd: '/p' };

/** An OS seal that marks what it sealed. */
const seal: SealProvider = {
	available: () => true,
	seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
	unseal: (blob) => {
		const text = blob.toString();
		if (!text.startsWith('os-sealed:')) throw new Error('not sealed by this OS key');
		return Buffer.from(text.slice('os-sealed:'.length), 'hex').toString();
	},
};

/** The saved scene: one rectangle and an image. */
const savedScene: SketchScene = {
	...emptySketchScene(),
	elements: [
		{ id: 'box', version: 3, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
		{ id: 'pic', version: 1, type: 'image', fileId: IMAGE_ID, x: 20, y: 0 },
	],
	files: {
		[IMAGE_ID]: {
			id: IMAGE_ID,
			mimeType: 'image/png',
			dataURL: 'data:image/png;base64,iVBO',
			created: 5,
		},
	},
};

/** The live scene in the window: the saved one plus an edit not saved yet. */
const liveScene: SketchScene = {
	...savedScene,
	elements: [
		{ ...savedScene.elements[0], version: 4 },
		savedScene.elements[1],
		{ id: 'unsaved', version: 1, type: 'ellipse', x: 40, y: 0, width: 5, height: 5 },
	],
};
const LIVE_BASE_SEQ = 0;

type Event =
	| { kind: 'createRoom' }
	| { kind: 'deleteRoom'; roomId: string }
	| { kind: 'createLink'; roomId: string; input: Record<string, unknown> }
	| { kind: 'revokeLink'; roomId: string; capId: string }
	| { kind: 'rotate'; roomId: string }
	| { kind: 'putSnapshot'; roomId: string; baseSeq: number; body: Uint8Array<ArrayBuffer> }
	| { kind: 'putFile'; roomId: string; fileId: string; body: Uint8Array<ArrayBuffer> }
	| { kind: 'renderer'; request: SketchRendererRequest };

describe('Sketch Book sharing', () => {
	let tempDir: string;
	let store: SketchStore;
	let events: Event[];
	let auths: SketchRoomAuth[];
	let keys: string[];
	let ownerToken: string | null;
	let epoch: number;
	let linkCount: number;
	let failSnapshot: boolean;
	let failLink: boolean;
	let confirm: ReturnType<typeof vi.fn<(prompt: SketchDesktopConfirmPrompt) => Promise<boolean>>>;
	let sketchId: string;

	const kinds = () =>
		events.map((event) =>
			event.kind === 'renderer' ? `renderer:${event.request.action}` : event.kind
		);
	const ofKind = <K extends Event['kind']>(kind: K) =>
		events.filter((event): event is Extract<Event, { kind: K }> => event.kind === kind);
	const roomEvents = () => events.filter((event) => event.kind !== 'renderer');

	const roomApi: SketchRoomApi = {
		async createRoom(auth) {
			auths.push(auth);
			events.push({ kind: 'createRoom' });
			return { roomId: ROOM_ID };
		},
		async deleteRoom(auth, roomId) {
			auths.push(auth);
			events.push({ kind: 'deleteRoom', roomId });
		},
		async createLink(auth, roomId, input) {
			auths.push(auth);
			events.push({ kind: 'createLink', roomId, input });
			if (failLink) throw new Error('link refused');
			linkCount += 1;
			return {
				capId: `capid${String(linkCount).padStart(7, '0')}`,
				cap: String(linkCount).repeat(43).slice(0, 43),
				expiresAt: NOW + 7 * 86_400_000,
			};
		},
		async revokeLink(auth, roomId, capId) {
			auths.push(auth);
			events.push({ kind: 'revokeLink', roomId, capId });
		},
		async rotate(auth, roomId) {
			auths.push(auth);
			events.push({ kind: 'rotate', roomId });
			epoch += 1;
			return { keyEpoch: epoch };
		},
		async putSnapshot(auth, roomId, baseSeq, body) {
			auths.push(auth);
			events.push({ kind: 'putSnapshot', roomId, baseSeq, body });
			if (failSnapshot) throw new Error('snapshot refused');
		},
		async putFile(auth, roomId, fileId, body) {
			auths.push(auth);
			events.push({ kind: 'putFile', roomId, fileId, body });
			return 'stored';
		},
	};

	const renderer: SketchRendererBridge = async (_agentId, request) => {
		events.push({ kind: 'renderer', request });
		if (request.action === 'snapshotScene') {
			return { success: true, snapshot: { scene: liveScene, baseSeq: LIVE_BASE_SEQ } };
		}
		return { success: true };
	};

	const ownerAuth = {
		ownerToken: async () => ownerToken,
	} as Partial<SketchOwnerAuth> as SketchOwnerAuth;

	const service = () =>
		createSketchService({
			store: () => store,
			isEnabled: () => true,
			findAgent: (id) => (id === agent.id ? agent : null),
			renderer,
			ownerAuth: () => ownerAuth,
			serverUrl: () => SERVER,
			roomApi,
			confirm,
			newRoomKey: () => {
				const key = generateRoomKey();
				keys.push(key);
				return key;
			},
			now: () => NOW,
		});

	async function openSnapshot(body: Uint8Array<ArrayBuffer>, roomKey: string, keyEpoch: number) {
		return decryptPayloadBlob(await importRoomKey(roomKey), 'snapshot', ROOM_ID, keyEpoch, body);
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sketch-share-'));
		store = createSketchStore({ dataDir: () => tempDir, osSeal: () => seal });
		events = [];
		auths = [];
		keys = [];
		ownerToken = OWNER_TOKEN;
		epoch = 0;
		linkCount = 0;
		failSnapshot = false;
		failLink = false;
		confirm = vi.fn(async () => true);
		const record = await store.createSketch({ ownerAgentId: agent.id, name: 'Board' });
		sketchId = record.sketchId;
		await store.writeScene(sketchId, savedScene);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe('share', () => {
		it('creates the room, uploads the image and the snapshot, then mints the link', async () => {
			const result = await service().shareSketch(sketchId, { role: 'rw', label: 'Team' });

			expect(kinds()).toEqual([
				'createRoom',
				'renderer:snapshotScene',
				'putFile',
				'putSnapshot',
				'createLink',
				'renderer:syncRoom',
			]);
			expect(
				auths.every((auth) => auth.serverUrl === SERVER && auth.ownerToken === OWNER_TOKEN)
			).toBe(true);
			expect(confirm).not.toHaveBeenCalled();

			const [roomKey] = keys;
			expect(result.createdRoom).toBe(true);
			expect(result.link).toEqual({
				capId: 'capid0000001',
				role: 'rw',
				label: 'Team',
				expiresAt: NOW + 7 * 86_400_000,
				url: sketchShareLinkUrl(SERVER, ROOM_ID, roomKey, '1'.repeat(43)),
			});
			expect(ofKind('createLink')[0].input).toEqual({
				role: 'rw',
				expiresInDays: 7,
				label: 'Team',
			});

			// The record keeps the link without its secret.
			const stored = await store.getSketch(sketchId);
			expect(stored?.share).toEqual({
				roomId: ROOM_ID,
				keyEpoch: 0,
				botPolicy: 'conductor',
				serverUrl: SERVER,
				links: [
					{
						capId: 'capid0000001',
						role: 'rw',
						label: 'Team',
						createdAt: NOW,
						expiresAt: NOW + 7 * 86_400_000,
						revoked: false,
					},
				],
			});
			expect(JSON.stringify(stored)).not.toContain('1'.repeat(43));
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBe(roomKey);
		});

		it('uploads the live scene under the new key at epoch 0, and joins with its baseline', async () => {
			await service().shareSketch(sketchId);
			const [roomKey] = keys;

			const [snapshot] = ofKind('putSnapshot');
			expect(snapshot.baseSeq).toBe(LIVE_BASE_SEQ);
			const opened = await openSnapshot(snapshot.body, roomKey, 0);
			if (!opened.ok) throw new Error(opened.error);
			expect(opened.payload.elements.map((element) => element.id)).toEqual([
				'box',
				'pic',
				'unsaved',
			]);
			expect(opened.payload.files).toEqual([IMAGE_ID]);
			expect((await openSnapshot(snapshot.body, roomKey, 1)).ok).toBe(false);

			const [file] = ofKind('putFile');
			expect(file.fileId).toBe(IMAGE_ID);
			const image = await decryptPayloadBlob(
				await importRoomKey(roomKey),
				'file',
				ROOM_ID,
				0,
				file.body
			);
			expect(image.ok && image.payload.dataURL).toBe('data:image/png;base64,iVBO');

			const sync = ofKind('renderer').at(-1)?.request;
			expect(sync).toEqual({
				action: 'syncRoom',
				sketchId,
				connection: {
					sketchId,
					roomId: ROOM_ID,
					roomKey,
					ownerToken: OWNER_TOKEN,
					serverUrl: SERVER,
					bot: null,
				},
				baseline: [
					{ id: 'box', version: 4 },
					{ id: 'pic', version: 1 },
					{ id: 'unsaved', version: 1 },
				],
			});
		});

		it('mints only another link on a later share', async () => {
			await service().shareSketch(sketchId);
			events = [];
			const result = await service().shareSketch(sketchId, { role: 'ro' });

			expect(kinds()).toEqual(['createLink']);
			expect(result.createdRoom).toBe(false);
			expect(ofKind('createLink')[0].input).toEqual({ role: 'ro', expiresInDays: 30 });
			expect(result.link.url).toBe(sketchShareLinkUrl(SERVER, ROOM_ID, keys[0], '2'.repeat(43)));
			expect(keys).toHaveLength(1);
			expect((await store.getSketch(sketchId))?.share?.links.map((link) => link.role)).toEqual([
				'rw',
				'ro',
			]);
		});

		it('archives the new room and mints no link when the snapshot fails', async () => {
			failSnapshot = true;
			await expect(service().shareSketch(sketchId)).rejects.toThrow('snapshot refused');

			expect(kinds()).toEqual([
				'createRoom',
				'renderer:snapshotScene',
				'putFile',
				'putSnapshot',
				'deleteRoom',
			]);
			expect((await store.getSketch(sketchId))?.share).toBeNull();
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBeUndefined();
		});

		it('archives the new room when the link fails', async () => {
			failLink = true;
			await expect(service().shareSketch(sketchId)).rejects.toThrow('link refused');

			expect(kinds().slice(-2)).toEqual(['createLink', 'deleteRoom']);
			expect(kinds()).not.toContain('renderer:syncRoom');
			expect((await store.getSketch(sketchId))?.share).toBeNull();
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBeUndefined();
		});

		it('refuses before any request when no one is signed in', async () => {
			ownerToken = null;
			await expect(service().shareSketch(sketchId)).rejects.toThrow(
				'sign in to https://sketch.example first'
			);
			expect(events).toEqual([]);
		});
	});

	describe('rotate', () => {
		it('bumps keyEpoch, revokes every link, and re-uploads under a new key', async () => {
			await service().shareSketch(sketchId);
			await service().shareSketch(sketchId, { role: 'ro' });
			const [oldKey] = keys;
			events = [];

			const record = await service().rotateSketch(sketchId);

			expect(kinds()).toEqual([
				'renderer:syncRoom',
				'rotate',
				'renderer:snapshotScene',
				'putFile',
				'putSnapshot',
				'renderer:syncRoom',
			]);
			// The window leaves the room before the server rotates.
			expect(ofKind('renderer')[0].request).toMatchObject({ action: 'syncRoom', connection: null });

			const newKey = keys[1];
			expect(newKey).not.toBe(oldKey);
			expect(record.share?.keyEpoch).toBe(1);
			expect(record.share?.links.every((link) => link.revoked)).toBe(true);
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBe(newKey);

			const [snapshot] = ofKind('putSnapshot');
			const opened = await openSnapshot(snapshot.body, newKey, 1);
			expect(opened.ok).toBe(true);
			expect((await openSnapshot(snapshot.body, oldKey, 1)).ok).toBe(false);
			expect((await openSnapshot(snapshot.body, newKey, 0)).ok).toBe(false);

			// The image goes up again, sealed for the new epoch.
			const [file] = ofKind('putFile');
			expect(
				(await decryptPayloadBlob(await importRoomKey(newKey), 'file', ROOM_ID, 1, file.body)).ok
			).toBe(true);

			expect(ofKind('renderer').at(-1)?.request).toMatchObject({
				action: 'syncRoom',
				connection: { roomKey: newKey, roomId: ROOM_ID },
				baseline: [
					{ id: 'box', version: 4 },
					{ id: 'pic', version: 1 },
					{ id: 'unsaved', version: 1 },
				],
			});
		});

		it('keeps the new key and rejoins when the new snapshot fails, and says so', async () => {
			await service().shareSketch(sketchId);
			failSnapshot = true;
			events = [];

			await expect(service().rotateSketch(sketchId)).rejects.toThrow(
				'access was reset, but the new snapshot did not upload (snapshot refused)'
			);
			const record = await store.getSketch(sketchId);
			expect(record?.share?.keyEpoch).toBe(1);
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBe(keys[1]);
			const rejoin = ofKind('renderer').at(-1)?.request;
			expect(rejoin).toMatchObject({ action: 'syncRoom', connection: { roomKey: keys[1] } });
			expect(rejoin && 'baseline' in rejoin ? rejoin.baseline : undefined).toBeUndefined();
		});
	});

	describe('unshare and revoke-link', () => {
		it('unshare leaves the room, archives it, and forgets the key', async () => {
			await service().shareSketch(sketchId);
			events = [];

			const record = await service().unshareSketch(sketchId);

			expect(kinds()).toEqual(['renderer:syncRoom', 'deleteRoom']);
			expect(record.share).toBeNull();
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBeUndefined();
		});

		it('revoke-link revokes that link only', async () => {
			await service().shareSketch(sketchId);
			await service().shareSketch(sketchId);
			events = [];

			const record = await service().revokeSketchLink(sketchId, 'capid0000001');

			expect(roomEvents()).toEqual([
				{ kind: 'revokeLink', roomId: ROOM_ID, capId: 'capid0000001' },
			]);
			expect(record.share?.links.map((link) => [link.capId, link.revoked])).toEqual([
				['capid0000001', true],
				['capid0000002', false],
			]);
		});
	});

	describe('A1: an agent caller waits on the desktop confirmation', () => {
		it('runs nothing until Allow, then shares', async () => {
			let answer!: (allow: boolean) => void;
			confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));

			const pending = service().shareSketch(sketchId, {}, { requestedBy: 'Planner' });
			await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(events).toEqual([]);
			expect((await store.getSketch(sketchId))?.share).toBeNull();
			expect(confirm.mock.calls[0][0]).toMatchObject({
				title: 'Share a sketch?',
				message: 'Share "Board" on RunMaestro.ai?',
				requestedBy: 'Planner',
			});

			answer(true);
			const result = await pending;
			expect(result.createdRoom).toBe(true);
			expect(kinds()[0]).toBe('createRoom');
		});

		it('changes nothing on Deny', async () => {
			confirm.mockResolvedValue(false);
			await expect(service().shareSketch(sketchId, {}, { requestedBy: 'Planner' })).rejects.toThrow(
				'the conductor chose Deny, so nothing was changed'
			);

			expect(events).toEqual([]);
			expect((await store.getSketch(sketchId))?.share).toBeNull();
			expect(keys).toEqual([]);
		});

		it.each([
			[
				'unshare',
				(s: ReturnType<typeof service>, id: string) =>
					s.unshareSketch(id, { requestedBy: 'Planner' }),
			],
			[
				'revoke-link',
				(s: ReturnType<typeof service>, id: string) =>
					s.revokeSketchLink(id, 'capid0000001', { requestedBy: 'Planner' }),
			],
			[
				'rotate',
				(s: ReturnType<typeof service>, id: string) =>
					s.rotateSketch(id, { requestedBy: 'Planner' }),
			],
		])('%s from an agent changes nothing on Deny', async (_verb, call) => {
			await service().shareSketch(sketchId);
			const before = await store.getSketch(sketchId);
			events = [];
			confirm.mockResolvedValue(false);

			await expect(call(service(), sketchId)).rejects.toThrow('the conductor chose Deny');

			expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: 'Planner' }));
			expect(events).toEqual([]);
			expect(await store.getSketch(sketchId)).toEqual(before);
			expect((await store.readSketchSecrets(sketchId)).roomKey).toBe(keys[0]);
		});

		it('runs a person request directly, with no confirmation', async () => {
			await service().shareSketch(sketchId, {}, {});
			await service().rotateSketch(sketchId);
			await service().unshareSketch(sketchId);

			expect(confirm).not.toHaveBeenCalled();
			expect(kinds()).toContain('rotate');
			expect(kinds()).toContain('deleteRoom');
		});
	});
});
