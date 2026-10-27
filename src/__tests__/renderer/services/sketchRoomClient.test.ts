/**
 * Tests for the Sketch Book room client over a fake WebSocket: the order on a
 * socket (`hello`, `welcome`, `screening.set`, `bot.presence`, `catchup`),
 * the screening value the server confirmed and its `since`, the author map
 * taken from op envelopes (never `customData`), delta batching, catchup
 * paging, offline edits flushed after catchup, the close-code notices, the
 * snapshot baseline main hands over, and the snapshot cadence (200 ops, or
 * 60 s idle).
 *
 * Real WebCrypto seals and opens every frame; `reconcileElements` is a small
 * stand-in that keeps the higher version of each element.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SKETCH_DELTA_MIN_INTERVAL_MS,
	SKETCH_RATE_LIMITED_RECONNECT_MS,
	SKETCH_ROOM_CLOSE_ACTIONS,
	SKETCH_ROOM_SUSPENDED_NOTICE,
	SKETCH_SNAPSHOT_EVERY_OPS,
	SKETCH_SNAPSHOT_IDLE_MS,
	SketchRoomClient,
	connectSketchRoom,
	disconnectSketchRoom,
	setSketchRoomsAway,
	sketchReconnectDelay,
	type CreateSketchRoomSocket,
	type ReconcileSketchElements,
	type SketchRoomClientOptions,
	type SketchRoomScreeningApi,
	type SketchRoomSocketHandlers,
} from '../../../renderer/services/sketchRoomClient';
import {
	isRoomScreeningConfirmed,
	useSketchSessionStore,
} from '../../../renderer/stores/sketchSessionStore';
import type { SketchScreeningChange } from '../../../shared/sketch/cloud-consent';
import type { SketchPresenceChange, SketchSceneForSnapshot } from '../../../shared/sketch/commands';
import {
	decryptPayload,
	encryptPayload,
	generateRoomKey,
	importRoomKey,
	type SketchRoomKey,
} from '../../../shared/sketch/crypto';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import {
	CLOSE_CODES,
	PROTOCOL_VERSION,
	type ClientFrame,
	type OpItem,
	type Screening,
	type WelcomeFrame,
} from '../../../shared/sketch/protocol';
import type { SketchActor, SketchScene } from '../../../shared/sketch/types';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));
// The client is handed `reconcile`, so Excalidraw itself never loads.
vi.mock('../../../renderer/components/SketchBook/excalidrawAssets', () => ({
	loadExcalidraw: vi.fn(async () => {
		throw new Error('Excalidraw must not load in these tests');
	}),
}));

/** Captured before any test fakes the timers, so `until()` waits in real time. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const SKETCH_ID = 'sketch-1';
const ROOM_ID = 'room-1';
/** Not 0, so a frame sealed with the wrong epoch would fail to open. */
const EPOCH = 2;
const OWNER_TOKEN = 'owner-token-123';

const conductor: SketchActor = { id: 'c1', kind: 'conductor', name: 'Pedram', role: 'conductor' };
const guest: SketchActor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' };

type Wire = SketchWireElement;

function el(id: string, version: number, extra: Record<string, unknown> = {}): Wire {
	return { id, version, versionNonce: version, type: 'rectangle', ...extra };
}

function scene(elements: Wire[] = []): SketchScene {
	return {
		type: 'excalidraw',
		version: 2,
		source: 'maestro',
		elements,
		appState: { viewBackgroundColor: '#ffffff', gridSize: null },
		files: {},
	};
}

/** Stand-in for Excalidraw's `reconcileElements`: the higher version wins, new ids append. */
const reconcile: ReconcileSketchElements = (local, remote) => {
	const byId = new Map(local.map((element) => [element.id, element]));
	const order = local.map((element) => element.id);
	for (const element of remote) {
		const current = byId.get(element.id);
		if (!current) order.push(element.id);
		if (!current || element.version > current.version) byId.set(element.id, element);
	}
	return order.map((id) => byId.get(id)!);
};

// ---------------------------------------------------------------- fake socket

interface FakeSocket {
	url: string;
	handlers: SketchRoomSocketHandlers;
	sent: ClientFrame[];
	/** `afterSent`: how many frames had been sent when the client closed it. */
	closedByClient: { code?: number; reason?: string; afterSent: number } | null;
}

let sockets: FakeSocket[] = [];

const createSocket: CreateSketchRoomSocket = (url, handlers) => {
	const socket: FakeSocket = { url, handlers, sent: [], closedByClient: null };
	sockets.push(socket);
	return {
		send: (data) => socket.sent.push(JSON.parse(data) as ClientFrame),
		close: (code, reason) => {
			socket.closedByClient = { code, reason, afterSent: socket.sent.length };
		},
	};
};

function socket(index = sockets.length - 1): FakeSocket {
	const current = sockets[index];
	if (!current) throw new Error(`no socket ${index}`);
	return current;
}

function receive(frame: object, target = socket()): void {
	target.handlers.onMessage(JSON.stringify(frame));
}

function sentOf<T extends ClientFrame['t']>(
	type: T,
	target = socket()
): Extract<ClientFrame, { t: T }>[] {
	return target.sent.filter((frame): frame is Extract<ClientFrame, { t: T }> => frame.t === type);
}

function sentTypes(target = socket()): ClientFrame['t'][] {
	return target.sent.map((frame) => frame.t);
}

// ---------------------------------------------------------------- harness

const sketchApi = {
	readScene: vi.fn<(id: string) => Promise<SketchScene>>(),
	writeScene: vi.fn<(id: string, scene: SketchScene) => Promise<void>>(),
	onPresence: vi.fn<(callback: (change: SketchPresenceChange) => void) => () => void>(),
};

let screeningValue: Screening;
let screeningListener: ((change: SketchScreeningChange) => void) | null;
const screeningApi = {
	setRoomLive: vi.fn<SketchRoomScreeningApi['setRoomLive']>(),
	reportServerScreening: vi.fn<SketchRoomScreeningApi['reportServerScreening']>(),
	onScreeningChanged: vi.fn<SketchRoomScreeningApi['onScreeningChanged']>(),
};

const uploadSnapshot =
	vi.fn<(sketchId: string, input: SketchSceneForSnapshot) => Promise<unknown>>();

let roomKey: string;
let key: SketchRoomKey;
let client: SketchRoomClient | null = null;

function session() {
	return useSketchSessionStore.getState().sessions[SKETCH_ID];
}

function room() {
	const current = session()?.room;
	if (!current) throw new Error('no room state');
	return current;
}

/** Wait, in real time, for async work (WebCrypto, the inbound chain) to land. */
async function until(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (check()) return;
		await new Promise((resolve) => realSetTimeout(resolve, 1));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Let pending async work settle when the check is that nothing happened. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => realSetTimeout(resolve, 1));
}

async function startClient(
	options: Partial<SketchRoomClientOptions> = {},
	initial: Wire[] = [el('a', 1)]
): Promise<SketchRoomClient> {
	sketchApi.readScene.mockResolvedValueOnce(scene(initial));
	client = new SketchRoomClient(
		{
			sketchId: SKETCH_ID,
			roomId: ROOM_ID,
			roomKey,
			ownerToken: OWNER_TOKEN,
			clientId: 'client-1',
			...options,
		},
		{ createSocket, reconcile, screeningApi, uploadSnapshot, random: () => 0 }
	);
	await client.start();
	return client;
}

function welcome(overrides: Partial<WelcomeFrame> = {}): WelcomeFrame {
	return {
		t: 'welcome',
		actor: conductor,
		role: 'conductor',
		botPolicy: 'conductor',
		botOnline: false,
		guestEdited: false,
		screening: null,
		screeningSince: null,
		headSeq: 0,
		snapshot: null,
		keyEpoch: EPOCH,
		limits: {},
		...overrides,
	};
}

/** Open the socket and answer `hello` with `welcome`, then wait for the room to go live. */
async function joinLive(overrides: Partial<WelcomeFrame> = {}): Promise<void> {
	socket().handlers.onOpen();
	receive(welcome(overrides));
	await until(() => session()?.room?.connection === 'live', 'the room to go live');
}

async function op(seq: number, actor: SketchActor, ts: number, elements: Wire[]): Promise<OpItem> {
	const sealed = await encryptPayload(key, 'delta', ROOM_ID, EPOCH, { v: 1, elements });
	return { seq, actor, ts, ...sealed };
}

async function deltaElements(frame: Extract<ClientFrame, { t: 'delta' }>): Promise<Wire[]> {
	const opened = await decryptPayload(key, 'delta', ROOM_ID, EPOCH, frame);
	if (!opened.ok) throw new Error(`delta did not open: ${opened.error}`);
	return opened.payload.elements;
}

/** One local conductor edit: the whole next scene, as Excalidraw's onChange hands it over. */
function editLocally(elements: Wire[]): void {
	const current = session()!.scene!;
	useSketchSessionStore
		.getState()
		.applyLocalChange(SKETCH_ID, { elements, appState: current.appState, files: current.files });
}

function sceneIds(): string[] {
	return session()!.scene!.elements.map((element) => element.id);
}

beforeEach(async () => {
	// The text hash and the room key are WebCrypto; jsdom does not always expose `subtle`.
	if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(1_000_000);

	sockets = [];
	client = null;
	useSketchSessionStore.setState({ sessions: {} });
	sketchApi.readScene.mockReset();
	sketchApi.writeScene.mockReset().mockResolvedValue(undefined);
	(window.maestro as unknown as { sketch: typeof sketchApi }).sketch = sketchApi;

	uploadSnapshot.mockReset().mockResolvedValue({ bytes: 64 });
	screeningValue = 'local';
	screeningListener = null;
	screeningApi.setRoomLive.mockReset().mockImplementation(async () => screeningValue);
	screeningApi.reportServerScreening.mockReset().mockResolvedValue(undefined);
	screeningApi.onScreeningChanged.mockReset().mockImplementation((callback) => {
		screeningListener = callback;
		return () => {
			screeningListener = null;
		};
	});

	roomKey = generateRoomKey();
	key = await importRoomKey(roomKey);
});

afterEach(() => {
	client?.stop();
	client = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- tests

describe('hello and welcome', () => {
	it('opens the room socket and sends hello with the owner token, nothing else before welcome', async () => {
		await startClient({ serverUrl: 'http://localhost:8787' });
		expect(socket().url).toBe(`ws://localhost:8787/ws/${ROOM_ID}`);
		expect(room().connection).toBe('connecting');

		socket().handlers.onOpen();
		// A consent change before welcome must not send screening.set yet.
		screeningListener?.({
			rooms: [{ sketchId: SKETCH_ID, screening: 'cloud' }],
		} as SketchScreeningChange);
		await settle();

		expect(socket().sent).toEqual([
			{
				t: 'hello',
				v: PROTOCOL_VERSION,
				room: ROOM_ID,
				auth: { owner: OWNER_TOKEN },
				clientId: 'client-1',
				name: 'Conductor',
			},
		]);
	});

	it('stores the welcome state in the session room', async () => {
		await startClient();
		await joinLive({
			guestEdited: true,
			botOnline: true,
			headSeq: 0,
			keyEpoch: EPOCH,
			botPolicy: 'writers',
		});

		expect(room()).toMatchObject({
			roomId: ROOM_ID,
			connection: 'live',
			notice: null,
			actor: conductor,
			role: 'conductor',
			botPolicy: 'writers',
			botOnline: true,
			guestEdited: true,
			headSeq: 0,
			keyEpoch: EPOCH,
			syncedSeq: 0,
		});
	});

	it('keeps later room frames in the session: bot presence, policy, guestEdited, stats', async () => {
		await startClient();
		await joinLive();
		expect(room().stats).toBeNull();

		receive({ t: 'presence.bot', online: true, agentId: 'a9', name: 'Codex' });
		receive({ t: 'policy', botPolicy: 'writers' });
		const statsFrame = {
			t: 'room.stats' as const,
			guestEdited: true,
			actors: [
				{
					actorId: 'g1',
					kind: 'guest' as const,
					name: 'Sam',
					role: 'rw' as const,
					online: true,
					ops: 3,
					toBot: 1,
					denyStreak: 0,
					denialsTotal: 0,
					guardrailTotal: 0,
					guardrailByReason: { injection: 0, other: 0 },
					unavailableTotal: 2,
					lockedOut: false,
					lastSeen: 5,
				},
			],
			caps: [],
			flaggedActors: [],
			screening: 'local' as const,
			screeningSince: 1,
		};
		receive(statsFrame);
		await until(() => room().guestEdited, 'room.stats');

		const { t: _t, ...stats } = statsFrame;
		expect(room()).toMatchObject({ botOnline: true, botPolicy: 'writers', guestEdited: true });
		expect(room().stats).toEqual(stats);
	});
});

describe('screening', () => {
	it('sends screening.set right after welcome, then bot.presence, then anything else (D4)', async () => {
		await startClient({ bot: { agentId: 'a1', name: 'Claude' } });
		socket().handlers.onOpen();
		receive(welcome({ headSeq: 2 }));
		await until(() => sentOf('catchup').length === 1, 'catchup');

		expect(sentTypes()).toEqual(['hello', 'screening.set', 'bot.presence', 'catchup']);
		expect(sentOf('screening.set')[0]).toEqual({ t: 'screening.set', screening: 'local' });
		expect(sentOf('bot.presence')[0]).toEqual({
			t: 'bot.presence',
			agentId: 'a1',
			name: 'Claude',
			online: true,
		});
		expect(screeningApi.setRoomLive).toHaveBeenCalledWith(SKETCH_ID, true);
		expect(room().screening.reported).toBe('local');
	});

	it('sends screening.set again when the consent module changes the value, never a repeat', async () => {
		await startClient();
		await joinLive();
		expect(sentOf('screening.set')).toEqual([{ t: 'screening.set', screening: 'local' }]);

		screeningListener!({
			rooms: [{ sketchId: SKETCH_ID, screening: 'cloud' }],
		} as SketchScreeningChange);
		screeningListener!({
			rooms: [{ sketchId: SKETCH_ID, screening: 'cloud' }],
		} as SketchScreeningChange);
		// Another sketch's room is not this client's business.
		screeningListener!({
			rooms: [{ sketchId: 'other', screening: 'local' }],
		} as SketchScreeningChange);

		expect(sentOf('screening.set')).toEqual([
			{ t: 'screening.set', screening: 'local' },
			{ t: 'screening.set', screening: 'cloud' },
		]);
		expect(room().screening.reported).toBe('cloud');
	});

	it('records the value and since of a screening frame and reports them to main', async () => {
		screeningValue = 'cloud';
		await startClient();
		await joinLive({ screening: 'local', screeningSince: 500 });
		expect(isRoomScreeningConfirmed(room(), 'cloud')).toBe(false);

		receive({ t: 'screening', screening: 'cloud', since: 2_000 });
		await until(() => room().screening.server === 'cloud', 'the screening frame');

		expect(room().screening).toEqual({ reported: 'cloud', server: 'cloud', since: 2_000 });
		expect(isRoomScreeningConfirmed(room(), 'cloud')).toBe(true);
		expect(screeningApi.reportServerScreening).toHaveBeenLastCalledWith(SKETCH_ID, 'cloud', 2_000);
	});

	it('counts welcome.screening: cloud as confirmation, since no echo follows an identical value', async () => {
		screeningValue = 'cloud';
		await startClient();
		await joinLive({ screening: 'cloud', screeningSince: 1_234 });

		expect(sentOf('screening.set')).toEqual([{ t: 'screening.set', screening: 'cloud' }]);
		expect(room().screening).toEqual({ reported: 'cloud', server: 'cloud', since: 1_234 });
		expect(isRoomScreeningConfirmed(room(), 'cloud')).toBe(true);
		expect(screeningApi.reportServerScreening).toHaveBeenCalledWith(SKETCH_ID, 'cloud', 1_234);
	});

	it('reports local, and so stays unconfirmed for cloud, when the consent module fails', async () => {
		screeningApi.setRoomLive.mockRejectedValueOnce(new Error('ipc down'));
		await startClient();
		await joinLive({ screening: 'cloud', screeningSince: 10 });

		expect(sentOf('screening.set')).toEqual([{ t: 'screening.set', screening: 'local' }]);
		expect(isRoomScreeningConfirmed(room(), 'cloud')).toBe(false);
	});
});

describe('the author map', () => {
	it('comes from the op envelope, never from customData', async () => {
		await startClient();
		await joinLive();

		const forged = el('t', 1, {
			type: 'text',
			text: 'hi',
			customData: {
				createdBy: { id: 'c1', name: 'Pedram', kind: 'conductor' },
				lastEditedBy: { id: 'c1', name: 'Pedram', kind: 'conductor' },
				lastEditedAt: 1,
			},
		});
		receive({ t: 'delta', ...(await op(1, guest, 5_000, [forged])) });
		await until(() => session()!.authors.t !== undefined, 'the author entry');

		expect(sceneIds()).toEqual(['a', 't']);
		expect(session()!.authors.t).toMatchObject({
			version: 1,
			actor: guest,
			opSeq: 1,
			guestTouched: true,
			guestTextAt: 5_000,
		});
		expect(room().syncedSeq).toBe(1);
	});

	it('takes guestTextAt from the op ts, and a conductor move does not change it', async () => {
		await startClient();
		await joinLive();

		const text = el('t', 1, { type: 'text', text: 'hi', x: 0 });
		receive({ t: 'delta', ...(await op(1, guest, 5_000, [text])) });
		await until(() => session()!.authors.t?.version === 1, 'the guest text');
		expect(session()!.authors.t.guestTextAt).toBe(5_000);

		// The conductor moves it: same text, newer version, later ts.
		receive({ t: 'delta', ...(await op(2, conductor, 9_000, [{ ...text, version: 2, x: 50 }])) });
		await until(() => session()!.authors.t?.version === 2, 'the conductor move');
		expect(session()!.authors.t).toMatchObject({
			actor: conductor,
			opSeq: 2,
			guestTouched: true,
			guestTextAt: 5_000,
		});

		// The guest rewrites the text: guestTextAt moves to that op's ts.
		receive({
			t: 'delta',
			...(await op(3, guest, 12_000, [{ ...text, version: 3, text: 'hello' }])),
		});
		await until(() => session()!.authors.t?.version === 3, 'the guest rewrite');
		expect(session()!.authors.t).toMatchObject({ actor: guest, opSeq: 3, guestTextAt: 12_000 });
	});

	it('ignores an op that loses to the version the scene already holds', async () => {
		await startClient({}, [el('a', 5)]);
		await joinLive();

		receive({ t: 'delta', ...(await op(1, guest, 5_000, [el('a', 3)])) });
		await until(() => room().syncedSeq === 1, 'the op');

		expect(session()!.scene!.elements[0].version).toBe(5);
		expect(session()!.authors.a).toBeUndefined();
	});
});

describe('outgoing deltas', () => {
	it('batches local edits into one delta, sealed under the welcome key epoch', async () => {
		await startClient();
		await joinLive();

		editLocally([el('a', 2)]);
		editLocally([el('a', 2), el('b', 1)]);
		editLocally([el('a', 2), el('b', 1), el('c', 1)]);
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the first delta');

		const [frame] = sentOf('delta');
		expect(frame.n).toBe(3);
		expect(frame.asBot).toBeUndefined();
		expect((await deltaElements(frame)).map((element) => element.id).sort()).toEqual([
			'a',
			'b',
			'c',
		]);
		// The AAD carries the epoch from welcome: another epoch does not open it.
		expect((await decryptPayload(key, 'delta', ROOM_ID, 0, frame)).ok).toBe(false);
	});

	it(`sends at most one delta per ${SKETCH_DELTA_MIN_INTERVAL_MS} ms (30 a second)`, async () => {
		await startClient();
		await joinLive();

		editLocally([el('a', 2)]);
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the first delta');

		editLocally([el('a', 3)]);
		await vi.advanceTimersByTimeAsync(SKETCH_DELTA_MIN_INTERVAL_MS - 1);
		await settle();
		expect(sentOf('delta')).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		await until(() => sentOf('delta').length === 2, 'the second delta');
		expect((await deltaElements(sentOf('delta')[1])).map((element) => element.version)).toEqual([
			3,
		]);
	});

	it("sends this desktop's agent edits as asBot, after the human edits", async () => {
		await startClient({ bot: { agentId: 'a1', name: 'Claude' } });
		await joinLive();

		useSketchSessionStore
			.getState()
			.applyAgentChange(SKETCH_ID, [el('a', 1), el('bot-1', 1)], { id: 'a1', name: 'Claude' });
		editLocally([el('a', 2), el('bot-1', 1)]);
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the human delta');
		await vi.advanceTimersByTimeAsync(SKETCH_DELTA_MIN_INTERVAL_MS);
		await until(() => sentOf('delta').length === 2, 'the agent delta');

		const [human, agent] = sentOf('delta');
		expect(human.asBot).toBeUndefined();
		expect((await deltaElements(human)).map((element) => element.id)).toEqual(['a']);
		expect(agent.asBot).toBe(true);
		expect((await deltaElements(agent)).map((element) => element.id)).toEqual(['bot-1']);
	});

	it('never echoes a merged remote element back to the room', async () => {
		await startClient();
		await joinLive();

		receive({ t: 'delta', ...(await op(1, guest, 5_000, [el('g', 1)])) });
		await until(() => sceneIds().includes('g'), 'the remote element');
		await vi.advanceTimersByTimeAsync(SKETCH_DELTA_MIN_INTERVAL_MS);
		await settle();

		expect(sentOf('delta')).toHaveLength(0);
	});

	it('drops a queued edit that a newer remote version beat, and only that one', async () => {
		await startClient({}, [el('a', 1), el('b', 1)]);
		await joinLive();

		editLocally([el('a', 2), el('b', 2)]);
		receive({ t: 'delta', ...(await op(1, guest, 5_000, [el('a', 5)])) });
		await until(() => session()!.scene!.elements[0].version === 5, 'the remote version');
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the delta');

		expect((await deltaElements(sentOf('delta')[0])).map((element) => element.id)).toEqual(['b']);
	});
});

describe('catchup', () => {
	it('pages catchup until more is false, holding live deltas until it is done', async () => {
		await startClient();
		socket().handlers.onOpen();
		receive(welcome({ headSeq: 3 }));
		await until(() => sentOf('catchup').length === 1, 'the first catchup');
		expect(sentOf('catchup')[0]).toEqual({ t: 'catchup', sinceSeq: 0 });
		expect(room().connection).toBe('catching-up');

		// A live op arrives mid-catchup: it waits so the cursor never skips 3.
		receive({ t: 'delta', ...(await op(4, guest, 4_000, [el('d', 1)])) });
		receive({
			t: 'ops',
			items: [await op(1, guest, 1_000, [el('o1', 1)]), await op(2, guest, 2_000, [el('o2', 1)])],
			more: true,
		});
		await until(() => sentOf('catchup').length === 2, 'the second catchup');
		expect(sentOf('catchup')[1]).toEqual({ t: 'catchup', sinceSeq: 2 });
		expect(sceneIds()).toEqual(['a', 'o1', 'o2']);

		receive({ t: 'ops', items: [await op(3, guest, 3_000, [el('o3', 1)])], more: false });
		await until(() => room().connection === 'live', 'the room to go live');

		expect(sceneIds()).toEqual(['a', 'o1', 'o2', 'o3', 'd']);
		expect(room().syncedSeq).toBe(4);
		expect(sentOf('catchup')).toHaveLength(2);
		expect(session()!.authors.o3).toMatchObject({ actor: guest, opSeq: 3 });
	});

	it('resumes catchup from the seq it already holds after a reconnect', async () => {
		await startClient({ sinceSeq: 7 });
		socket().handlers.onOpen();
		receive(welcome({ headSeq: 9 }));
		await until(() => sentOf('catchup').length === 1, 'catchup');

		expect(sentOf('catchup')[0]).toEqual({ t: 'catchup', sinceSeq: 7 });
	});

	it('flushes edits made offline and during catchup only after catchup is done', async () => {
		await startClient();
		// Offline: the socket is not even open yet.
		editLocally([el('a', 2)]);
		socket().handlers.onOpen();
		receive(welcome({ headSeq: 1 }));
		await until(() => sentOf('catchup').length === 1, 'catchup');

		// During catchup: still held.
		editLocally([el('a', 2), el('b', 1)]);
		await vi.advanceTimersByTimeAsync(SKETCH_DELTA_MIN_INTERVAL_MS);
		await settle();
		expect(sentOf('delta')).toHaveLength(0);

		receive({ t: 'ops', items: [await op(1, guest, 1_000, [el('r', 1)])], more: false });
		await until(() => room().connection === 'live', 'the room to go live');
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the offline delta');

		const types = sentTypes();
		expect(types.indexOf('delta')).toBeGreaterThan(types.lastIndexOf('catchup'));
		const ids = (await deltaElements(sentOf('delta')[0])).map((element) => element.id).sort();
		// The room's own element is not sent back.
		expect(ids).toEqual(['a', 'b']);
	});
});

describe('close codes', () => {
	it.each([
		[CLOSE_CODES.revoked, /revoked/],
		[CLOSE_CODES.superseded, /another Maestro window or device/],
	])('close %i stops the client and shows its message in the Sketch tab', async (code, text) => {
		await startClient();
		await joinLive();

		socket().handlers.onClose(code, '');

		expect(room().connection).toBe('stopped');
		expect(room().notice).toEqual({ ...SKETCH_ROOM_CLOSE_ACTIONS[code].notice, closeCode: code });
		expect(room().notice?.text).toMatch(text);
		expect(screeningApi.setRoomLive).toHaveBeenLastCalledWith(SKETCH_ID, false);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(sockets).toHaveLength(1);
	});

	it('every listed close code has a message, and only 4008 among them retries', () => {
		for (const code of Object.values(CLOSE_CODES)) {
			const action = SKETCH_ROOM_CLOSE_ACTIONS[code];
			expect(action.notice.text.length).toBeGreaterThan(0);
			expect(action.reconnect).toBe(code === CLOSE_CODES.rate_limited);
		}
	});

	it('reconnects after a dropped connection and clears the notice on the next welcome', async () => {
		await startClient();
		await joinLive();

		socket().handlers.onClose(1006, '');
		expect(room().connection).toBe('reconnecting');
		expect(room().notice).toMatchObject({ tone: 'warning', closeCode: 1006 });
		expect(room().screening.reported).toBeNull();

		await vi.advanceTimersByTimeAsync(sketchReconnectDelay(0, 1006, () => 0));
		expect(sockets).toHaveLength(2);

		await joinLive();
		expect(room().notice).toBeNull();
		expect(sentOf('screening.set')).toEqual([{ t: 'screening.set', screening: 'local' }]);
	});

	it('waits at least the rate-limit delay before reconnecting after 4008', async () => {
		await startClient();
		await joinLive();

		socket().handlers.onClose(CLOSE_CODES.rate_limited, '');
		await vi.advanceTimersByTimeAsync(SKETCH_RATE_LIMITED_RECONNECT_MS - 1);
		expect(sockets).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(2);
	});
});

describe('sketchReconnectDelay', () => {
	it('grows exponentially to the cap, with jitter between half and all of it', () => {
		expect(sketchReconnectDelay(0, 1006, () => 0)).toBe(500);
		expect(sketchReconnectDelay(0, 1006, () => 1)).toBe(1_000);
		expect(sketchReconnectDelay(3, 1006, () => 1)).toBe(8_000);
		expect(sketchReconnectDelay(20, 1006, () => 1)).toBe(30_000);
		expect(sketchReconnectDelay(0, CLOSE_CODES.rate_limited, () => 0)).toBe(
			SKETCH_RATE_LIMITED_RECONNECT_MS
		);
	});
});

describe('payload seal and open for the bot relay', () => {
	it("seals and opens under the welcome's key epoch, and refuses another epoch", async () => {
		await startClient();
		await joinLive();
		const sealed = await client!.sealPayload('bot.reply', {
			v: 1,
			text: 'done',
			elementIds: ['a'],
		});
		expect(sealed).not.toBeNull();
		await expect(decryptPayload(key, 'bot.reply', ROOM_ID, EPOCH, sealed!)).resolves.toEqual({
			ok: true,
			payload: { v: 1, text: 'done', elementIds: ['a'] },
		});

		const chat = await encryptPayload(key, 'chat', ROOM_ID, EPOCH, { v: 1, text: '@bot hi' });
		await expect(client!.openPayload('chat', chat)).resolves.toEqual({
			ok: true,
			payload: { v: 1, text: '@bot hi' },
		});
		const stale = await encryptPayload(key, 'chat', ROOM_ID, EPOCH - 1, { v: 1, text: 'old' });
		await expect(client!.openPayload('chat', stale)).resolves.toMatchObject({ ok: false });
	});
});

describe('snapshot baseline', () => {
	it('sends, once live, every element newer than the snapshot main uploaded', async () => {
		// The session moved on while main uploaded: a at 3 (snapshot has 2), b is new.
		await startClient({ baseline: [{ id: 'a', version: 2 }] }, [el('a', 3), el('b', 1)]);
		await joinLive();
		await vi.advanceTimersByTimeAsync(0);
		await until(() => sentOf('delta').length === 1, 'the delta');

		const sent = await deltaElements(sentOf('delta')[0]);
		expect(sent.map((element) => [element.id, element.version]).sort()).toEqual([
			['a', 3],
			['b', 1],
		]);
	});

	it('sends nothing when the session matches the snapshot', async () => {
		await startClient({ baseline: [{ id: 'a', version: 1 }] }, [el('a', 1)]);
		await joinLive();
		await vi.advanceTimersByTimeAsync(SKETCH_DELTA_MIN_INTERVAL_MS);
		await settle();
		expect(sentOf('delta')).toHaveLength(0);
	});
});

describe('snapshots', () => {
	it(`uploads the live scene ${SKETCH_SNAPSHOT_IDLE_MS / 1000} s after the last op, with baseSeq = the newest op`, async () => {
		await startClient();
		await joinLive();
		receive({ t: 'delta', ...(await op(1, guest, 5_000, [el('g', 1)])) });
		await until(() => client!.currentSeq() === 1, 'the op');

		await vi.advanceTimersByTimeAsync(SKETCH_SNAPSHOT_IDLE_MS - 1);
		expect(uploadSnapshot).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await until(() => uploadSnapshot.mock.calls.length === 1, 'the snapshot');

		const [sketchId, input] = uploadSnapshot.mock.calls[0];
		expect(sketchId).toBe(SKETCH_ID);
		expect(input.baseSeq).toBe(1);
		expect(input.scene.elements.map((element) => element.id).sort()).toEqual(['a', 'g']);

		// Nothing new since: no second upload.
		await vi.advanceTimersByTimeAsync(SKETCH_SNAPSHOT_IDLE_MS);
		await settle();
		expect(uploadSnapshot).toHaveBeenCalledTimes(1);
	});

	it(`uploads at once after ${SKETCH_SNAPSHOT_EVERY_OPS} ops, acks of its own deltas included`, async () => {
		await startClient();
		await joinLive();
		receive({ t: 'ack', seq: SKETCH_SNAPSHOT_EVERY_OPS - 1 });
		await settle();
		expect(uploadSnapshot).not.toHaveBeenCalled();

		receive({ t: 'ack', seq: SKETCH_SNAPSHOT_EVERY_OPS });
		await until(() => uploadSnapshot.mock.calls.length === 1, 'the snapshot');
		expect(uploadSnapshot.mock.calls[0][1].baseSeq).toBe(SKETCH_SNAPSHOT_EVERY_OPS);
	});

	it('tries a failed upload again after the idle delay, never in a loop', async () => {
		uploadSnapshot.mockRejectedValueOnce(new Error('offline'));
		await startClient();
		await joinLive();
		receive({ t: 'ack', seq: SKETCH_SNAPSHOT_EVERY_OPS });
		await until(() => uploadSnapshot.mock.calls.length === 1, 'the first try');
		await settle();
		expect(uploadSnapshot).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(SKETCH_SNAPSHOT_IDLE_MS);
		await until(() => uploadSnapshot.mock.calls.length === 2, 'the retry');
	});

	it('uploads nothing while no op came, and nothing after stop', async () => {
		await startClient();
		await joinLive();
		await vi.advanceTimersByTimeAsync(SKETCH_SNAPSHOT_IDLE_MS * 2);
		expect(uploadSnapshot).not.toHaveBeenCalled();

		receive({ t: 'ack', seq: 3 });
		await settle();
		client!.stop();
		await vi.advanceTimersByTimeAsync(SKETCH_SNAPSHOT_IDLE_MS);
		await settle();
		expect(uploadSnapshot).not.toHaveBeenCalled();
	});
});

describe('sleep, wake and quit', () => {
	const bot = { agentId: 'a1', name: 'Claude' };
	let presence: ((change: SketchPresenceChange) => void) | null;

	beforeEach(() => {
		presence = null;
		sketchApi.onPresence.mockReset().mockImplementation((callback) => {
			presence = callback;
			return () => {
				presence = null;
			};
		});
	});

	afterEach(() => {
		disconnectSketchRoom(SKETCH_ID);
		setSketchRoomsAway(false);
	});

	/** Join through the registry, which follows main's `sketch:presence` pushes. */
	async function connect(options: Partial<SketchRoomClientOptions> = { bot }): Promise<void> {
		sketchApi.readScene.mockResolvedValueOnce(scene([el('a', 1)]));
		client = await connectSketchRoom(
			{
				sketchId: SKETCH_ID,
				roomId: ROOM_ID,
				roomKey,
				ownerToken: OWNER_TOKEN,
				clientId: 'client-1',
				...options,
			},
			{ createSocket, reconcile, screeningApi, uploadSnapshot, random: () => 0 }
		);
	}

	function push(online: boolean, reason: SketchPresenceChange['reason']): void {
		if (!presence) throw new Error('the registry does not follow presence');
		presence({ online, reason });
	}

	it('before-quit sends bot.presence {online:false} before the socket closes, and nothing retries', async () => {
		await connect();
		await joinLive();
		const joined = socket();
		const sentBefore = joined.sent.length;

		push(false, 'quit');

		expect(joined.sent.slice(sentBefore)).toEqual([
			{ t: 'bot.presence', agentId: 'a1', name: 'Claude', online: false },
		]);
		expect(joined.closedByClient).toEqual({
			code: 1000,
			reason: 'suspended',
			afterSent: sentBefore + 1,
		});
		expect(screeningApi.setRoomLive).toHaveBeenLastCalledWith(SKETCH_ID, false);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(sockets).toHaveLength(1);
	});

	it('sleep shows the room as away; wake reconnects and the next welcome announces the bot (D4)', async () => {
		await connect();
		await joinLive({ botOnline: true });

		push(false, 'suspend');
		expect(room()).toMatchObject({
			connection: 'reconnecting',
			notice: SKETCH_ROOM_SUSPENDED_NOTICE,
			botOnline: false,
		});
		expect(room().screening.reported).toBeNull();

		push(true, 'resume');
		expect(sockets).toHaveLength(2);
		await joinLive();

		expect(sentTypes()).toEqual(['hello', 'screening.set', 'bot.presence']);
		expect(sentOf('bot.presence')).toEqual([
			{ t: 'bot.presence', agentId: 'a1', name: 'Claude', online: true },
		]);
		expect(room().notice).toBeNull();
	});

	it('a room without a bot, or not yet joined, just closes its socket', async () => {
		await connect({});
		await joinLive();
		const joined = socket();
		const sentBefore = joined.sent.length;

		push(false, 'suspend');
		expect(joined.sent).toHaveLength(sentBefore);
		expect(joined.closedByClient).toMatchObject({ code: 1000 });

		push(true, 'resume');
		const opening = socket();
		push(false, 'quit');
		expect(opening.sent).toEqual([]);
		expect(opening.closedByClient).toMatchObject({ code: 1000, afterSent: 0 });
	});

	it('a room joined while away opens no socket until wake', async () => {
		await connect();
		await joinLive();
		push(false, 'suspend');
		const before = sockets.length;

		await connect();
		expect(sockets).toHaveLength(before);
		expect(room().notice).toEqual(SKETCH_ROOM_SUSPENDED_NOTICE);

		push(true, 'resume');
		expect(sockets).toHaveLength(before + 1);
	});

	it('stops following presence once the window holds no room', async () => {
		await connect();
		expect(presence).not.toBeNull();

		disconnectSketchRoom(SKETCH_ID);
		expect(presence).toBeNull();
	});
});
