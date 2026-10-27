/**
 * Sketch Book room client (spec section 6, wire contract sections 4 and 5):
 * one WebSocket per shared sketch, beside the sketch's session in
 * `sketchSessionStore`, so closing the Sketch tab keeps the room live.
 *
 * The order on every socket:
 *
 * 1. `hello {auth:{owner}}`. A refused `hello` is answered by the close code
 *    (D1), so every close code maps to a notice in the Sketch tab.
 * 2. `welcome`: the room state (`guestEdited`, `botOnline`, `headSeq`,
 *    `keyEpoch`, the server's screening value and `since`) goes into the
 *    session's `room`.
 * 3. `screening.set` with the value the consent module gives for the room
 *    (`setRoomLive()`, which is `roomScreening()` plus the join), then
 *    `bot.presence {online:true}` when this client speaks for an agent (D4).
 *    The consent module's later changes send `screening.set` again. The
 *    server's value counts as confirmed when it equals what was sent: an
 *    identical value is not rebroadcast, so `welcome` confirms too (G4).
 * 4. `catchup {sinceSeq}` until `more` is false. Live `delta` frames that
 *    arrive meanwhile wait, so the catchup cursor never skips a gap.
 * 5. Local edits made while the socket was down, then live sync.
 *
 * Sync. Outgoing: every scene change in the session (the view's edits, an
 * agent's writes) is diffed by `version` against what the room already has
 * and sent as `delta` frames, at most {@link SKETCH_DELTA_MAX_PER_SECOND} a
 * second. An agent's edit (this desktop's own stamp says `kind: 'bot'`) is
 * sent with `asBot: true` (X2) once the bot is announced. Incoming: `delta`
 * and `ops` are decrypted, merged with Excalidraw's `reconcileElements`, and
 * each element version that won is recorded in the author map from the op's
 * envelope (`actor`, `seq`, server `ts`; `guestTextAt` follows from
 * `nextElementAuthorship()`). `customData` is never read for authorship.
 *
 * Reconnect with backoff on any close the server may lift; stop for good on
 * the ones it will not (auth, revoked, kicked, superseded, expired, archived).
 *
 * Baseline: the room is assumed to hold the scene as it was when the client
 * started, or `options.baseline` when main just uploaded a snapshot (share,
 * rotate): then every element newer than the baseline goes out as a delta
 * once the client is live, so an edit made during the upload is not lost.
 *
 * Snapshots (spec section 6): after {@link SKETCH_SNAPSHOT_EVERY_OPS} ops, or
 * {@link SKETCH_SNAPSHOT_IDLE_MS} after the last op, the live scene goes to
 * main (`uploadSnapshot`), which seals it and uploads it with `baseSeq` = the
 * newest op the scene includes. A failed upload is tried again after the
 * idle delay.
 */

import { readElementStamp, sketchTextHash } from '../../shared/sketch/attribution';
import {
	decryptPayload,
	encryptPayload,
	importRoomKey,
	type SealedField,
	type SketchRoomKey,
} from '../../shared/sketch/crypto';
import type {
	DecodePayloadResult,
	SketchPayloadByKind,
	SketchPayloadKind,
	SketchWireElement,
} from '../../shared/sketch/payloads';
import {
	CLOSE_CODES,
	PROTOCOL_VERSION,
	parseServerFrame,
	type ClientFrame,
	type OpItem,
	type Screening,
	type ServerFrame,
} from '../../shared/sketch/protocol';
import { sketchRoomSocketUrl } from '../../shared/sketch/server';
import type { SketchScreeningChange } from '../../shared/sketch/cloud-consent';
import type { SketchElementVersion, SketchSceneForSnapshot } from '../../shared/sketch/commands';
import { generateUUID } from '../../shared/uuid';
import { loadExcalidraw } from '../components/SketchBook/excalidrawAssets';
import {
	openReadySketchSession,
	useSketchSessionStore,
	type SketchRoomNotice,
	type SketchRoomState,
} from '../stores/sketchSessionStore';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CTX = '[SketchBook][Room]';

/** Spec section 6: upload a snapshot after this many ops since the last one. */
export const SKETCH_SNAPSHOT_EVERY_OPS = 200;
/** Spec section 6: or this long after the last op, when any op came since the last one. */
export const SKETCH_SNAPSHOT_IDLE_MS = 60_000;

/** Spec section 6: outgoing `delta` frames per second, at most. */
export const SKETCH_DELTA_MAX_PER_SECOND = 30;
export const SKETCH_DELTA_MIN_INTERVAL_MS = Math.ceil(1000 / SKETCH_DELTA_MAX_PER_SECOND);

/**
 * Plaintext budget of one `delta`. Base64url of the sealed bytes is 4/3 of
 * it, which stays under the 1 MiB `delta.ct` and frame caps (contract 1).
 */
export const SKETCH_DELTA_MAX_PLAINTEXT_BYTES = 700 * 1024;

export const SKETCH_RECONNECT_BASE_MS = 1_000;
export const SKETCH_RECONNECT_MAX_MS = 30_000;
/** A 4008 close (rate limited) waits at least this long before the next try. */
export const SKETCH_RATE_LIMITED_RECONNECT_MS = 10_000;

/** The `hello.name` the desktop sends. The server ignores it and uses the owner's name. */
const CONDUCTOR_HELLO_NAME = 'Conductor';

/** What Excalidraw's `reconcileElements` reads from the app state: nothing is mid-edit here. */
const RECONCILE_APP_STATE = { editingTextElement: null, resizingElement: null, newElement: null };

/** Excalidraw's `reconcileElements`, over the wire element shape. */
export type ReconcileSketchElements = (
	local: readonly SketchWireElement[],
	remote: readonly SketchWireElement[]
) => SketchWireElement[];

async function loadReconcile(): Promise<ReconcileSketchElements> {
	const { reconcileElements } = await loadExcalidraw();
	return (local, remote) =>
		reconcileElements(
			local as unknown as Parameters<typeof reconcileElements>[0],
			remote as unknown as Parameters<typeof reconcileElements>[1],
			RECONCILE_APP_STATE as unknown as Parameters<typeof reconcileElements>[2]
		) as unknown as SketchWireElement[];
}

// ---------------------------------------------------------------- close codes

/** How the client answers one close code. */
export interface SketchRoomCloseAction {
	notice: SketchRoomNotice;
	/** True when the server may let this desktop back in, so the client retries. */
	reconnect: boolean;
}

const LOST_CONNECTION = 'Lost the connection to the room. Reconnecting.';

/** Every close code of contract section 5, with the Sketch tab's message. */
export const SKETCH_ROOM_CLOSE_ACTIONS: Readonly<Record<number, SketchRoomCloseAction>> = {
	[CLOSE_CODES.auth_failed]: {
		notice: {
			tone: 'error',
			text: 'The room did not accept this desktop as its owner. Sign in to Sketch Book again, then reconnect.',
		},
		reconnect: false,
	},
	[CLOSE_CODES.revoked]: {
		notice: {
			tone: 'error',
			text: 'Access to this room was revoked. The sketch stays on this desktop.',
		},
		reconnect: false,
	},
	[CLOSE_CODES.kicked]: {
		notice: { tone: 'error', text: 'This desktop was removed from the room.' },
		reconnect: false,
	},
	[CLOSE_CODES.rate_limited]: {
		notice: {
			tone: 'warning',
			text: 'The room is limiting this desktop. Reconnecting shortly.',
		},
		reconnect: true,
	},
	[CLOSE_CODES.superseded]: {
		notice: {
			tone: 'warning',
			text: 'This room was opened from another Maestro window or device, so this one stopped syncing.',
		},
		reconnect: false,
	},
	[CLOSE_CODES.expired]: {
		notice: {
			tone: 'error',
			text: 'The room expired. The sketch stays on this desktop; share it again to start a new room.',
		},
		reconnect: false,
	},
	[CLOSE_CODES.archived]: {
		notice: {
			tone: 'error',
			text: 'The room was archived. The sketch stays on this desktop.',
		},
		reconnect: false,
	},
};

/** The action for any close code: a listed one, or a dropped connection that retries. */
export function sketchRoomCloseAction(code: number): SketchRoomCloseAction {
	const action = SKETCH_ROOM_CLOSE_ACTIONS[code];
	const notice = action?.notice ?? { tone: 'warning', text: LOST_CONNECTION };
	return { notice: { ...notice, closeCode: code }, reconnect: action?.reconnect ?? true };
}

/**
 * The wait before reconnect attempt `attempt` (0-based): exponential from
 * {@link SKETCH_RECONNECT_BASE_MS} to {@link SKETCH_RECONNECT_MAX_MS}, with
 * jitter in [50%, 100%] so a fleet of desktops does not return in step.
 */
export function sketchReconnectDelay(attempt: number, code: number, random: () => number): number {
	const ceiling = Math.min(SKETCH_RECONNECT_MAX_MS, SKETCH_RECONNECT_BASE_MS * 2 ** attempt);
	const delay = Math.round(ceiling * (0.5 + random() * 0.5));
	return code === CLOSE_CODES.rate_limited
		? Math.max(delay, SKETCH_RATE_LIMITED_RECONNECT_MS)
		: delay;
}

// ---------------------------------------------------------------- socket

export interface SketchRoomSocketHandlers {
	onOpen(): void;
	onMessage(data: unknown): void;
	onClose(code: number, reason: string): void;
}

/** The part of a WebSocket the client uses. */
export interface SketchRoomSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type CreateSketchRoomSocket = (
	url: string,
	handlers: SketchRoomSocketHandlers
) => SketchRoomSocket;

/** The browser WebSocket. An `error` event is always followed by `close`, so only close counts. */
const createBrowserSocket: CreateSketchRoomSocket = (url, handlers) => {
	const socket = new WebSocket(url);
	socket.onopen = () => handlers.onOpen();
	socket.onmessage = (event) => handlers.onMessage(event.data);
	socket.onclose = (event) => handlers.onClose(event.code, event.reason);
	return {
		send: (data) => socket.send(data),
		close: (code, reason) => socket.close(code, reason),
	};
};

// ---------------------------------------------------------------- client

/** The consent module's room calls (`window.maestro.sketch`). */
export interface SketchRoomScreeningApi {
	setRoomLive(sketchId: string, live: boolean): Promise<Screening>;
	reportServerScreening(
		sketchId: string,
		screening: Screening,
		since: number | null
	): Promise<void>;
	onScreeningChanged(callback: (change: SketchScreeningChange) => void): () => void;
}

export interface SketchRoomClientOptions {
	sketchId: string;
	roomId: string;
	/** The room key from the link (base64url, 22 chars). Never leaves this desktop. */
	roomKey: string;
	/** The owner token from `sketch-owner-auth.ts`, for `hello.auth.owner`. */
	ownerToken: string;
	/** `sketchBook.serverUrl`; the hosted server when absent or unusable. */
	serverUrl?: string;
	/** The agent this desktop's bot speaks for, announced after `screening.set` (D4). */
	bot?: { agentId: string; name: string };
	/** Every op up to this seq is already in the scene. Default 0. */
	sinceSeq?: number;
	/**
	 * What the room holds, when main just uploaded it as a snapshot. Default:
	 * the session's scene when the client starts.
	 */
	baseline?: readonly SketchElementVersion[];
	/** `hello.clientId`. Default a fresh UUID. */
	clientId?: string;
}

export interface SketchRoomClientDeps {
	createSocket?: CreateSketchRoomSocket;
	/** Excalidraw's `reconcileElements`; loaded lazily by default. */
	reconcile?: ReconcileSketchElements;
	screeningApi?: SketchRoomScreeningApi;
	/** For the reconnect jitter. */
	random?: () => number;
	/** Seal and upload a snapshot (main). Default `window.maestro.sketch.uploadSnapshot`. */
	uploadSnapshot?: (sketchId: string, input: SketchSceneForSnapshot) => Promise<unknown>;
}

type Phase = 'idle' | 'connecting' | 'welcomed' | 'catching-up' | 'live' | 'stopped';

interface PendingEdit {
	element: SketchWireElement;
	/** This desktop's agent made it (the local stamp says `kind: 'bot'`). */
	bot: boolean;
}

export type SketchRoomFrameListener = (frame: ServerFrame) => void;

const encoder = new TextEncoder();

function initialRoomState(roomId: string, syncedSeq: number): SketchRoomState {
	return {
		roomId,
		connection: 'connecting',
		notice: null,
		actor: null,
		role: null,
		botPolicy: null,
		botOnline: false,
		guestEdited: false,
		headSeq: syncedSeq,
		keyEpoch: null,
		syncedSeq,
		screening: { reported: null, server: null, since: null },
	};
}

/** Of two versions of one element, the one `reconcileElements` keeps. */
function wins(candidate: SketchWireElement, current: SketchWireElement): boolean {
	if (candidate.version !== current.version) return candidate.version > current.version;
	return Number(candidate.versionNonce ?? 0) < Number(current.versionNonce ?? 0);
}

function sameVersion(a: SketchWireElement, b: SketchWireElement): boolean {
	return a.version === b.version && a.versionNonce === b.versionNonce;
}

export class SketchRoomClient {
	readonly sketchId: string;
	readonly roomId: string;

	private readonly options: SketchRoomClientOptions;
	private readonly clientId: string;
	private readonly createSocket: CreateSketchRoomSocket;
	private readonly screeningApi: SketchRoomScreeningApi;
	private readonly random: () => number;
	private readonly uploadSnapshot: NonNullable<SketchRoomClientDeps['uploadSnapshot']>;
	private reconcile: ReconcileSketchElements | null;

	private key: SketchRoomKey | null = null;
	private started = false;
	private socket: SketchRoomSocket | null = null;
	/** Bumped per socket; events from an older socket are ignored. */
	private generation = 0;
	private phase: Phase = 'idle';
	private keyEpoch = 0;
	private syncedSeq: number;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	/** Inbound frames are handled one at a time, in arrival order. */
	private inbound: Promise<void> = Promise.resolve();
	/** Live `delta` frames that arrived during catchup. */
	private heldDeltas: OpItem[] = [];

	/** The newest version of each element the room holds or was sent. */
	private readonly knownVersions = new Map<string, number>();
	private readonly pending = new Map<string, PendingEdit>();
	private lastScene: unknown = null;
	private lastDeltaAt = Number.NEGATIVE_INFINITY;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;

	/** Ops the room gained since the last snapshot upload. */
	private opsSinceSnapshot = 0;
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshotting = false;

	private reportedScreening: Screening | null = null;
	private botAnnounced = false;
	private readonly listeners = new Set<SketchRoomFrameListener>();
	private unsubscribeStore: (() => void) | null = null;
	private unsubscribeScreening: (() => void) | null = null;

	constructor(options: SketchRoomClientOptions, deps: SketchRoomClientDeps = {}) {
		this.options = options;
		this.sketchId = options.sketchId;
		this.roomId = options.roomId;
		this.clientId = options.clientId ?? generateUUID();
		this.syncedSeq = options.sinceSeq ?? 0;
		this.createSocket = deps.createSocket ?? createBrowserSocket;
		this.screeningApi = deps.screeningApi ?? window.maestro.sketch;
		this.random = deps.random ?? Math.random;
		this.uploadSnapshot =
			deps.uploadSnapshot ??
			((sketchId, input) => window.maestro.sketch.uploadSnapshot(sketchId, input));
		this.reconcile = deps.reconcile ?? null;
	}

	/**
	 * Open the sketch's session, import the key and connect. Throws when the
	 * scene cannot be read or the key is malformed; nothing is connected then.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const session = await openReadySketchSession(this.sketchId);
		this.key = await importRoomKey(this.options.roomKey);
		this.reconcile ??= await loadReconcile();
		if (this.phase !== 'idle') return;

		for (const element of this.options.baseline ?? session.scene.elements) {
			this.knownVersions.set(element.id, element.version);
		}
		this.lastScene = session.scene;
		// Edits newer than the uploaded snapshot wait for the room like offline edits.
		if (this.options.baseline) this.collectLocalEdits(session.scene.elements);
		this.unsubscribeStore = useSketchSessionStore.subscribe((state) => {
			const scene = state.sessions[this.sketchId]?.scene;
			if (!scene || scene === this.lastScene) return;
			this.lastScene = scene;
			this.collectLocalEdits(scene.elements);
		});
		this.unsubscribeScreening = this.screeningApi.onScreeningChanged((change) => {
			const room = change.rooms.find((candidate) => candidate.sketchId === this.sketchId);
			if (room) this.reportScreening(room.screening);
		});
		this.updateRoom(() => initialRoomState(this.roomId, this.syncedSeq));
		this.connect();
	}

	/** The newest op seq the scene includes. */
	currentSeq(): number {
		return this.syncedSeq;
	}

	/** Leave the room for good: the bot goes offline, the socket closes, nothing retries. */
	stop(): void {
		if (this.phase === 'stopped') return;
		const wasJoined = this.isJoined();
		if (wasJoined && this.botAnnounced && this.options.bot) {
			this.sendFrame({ t: 'bot.presence', ...this.options.bot, online: false });
		}
		this.phase = 'stopped';
		this.generation++;
		this.clearTimers();
		this.socket?.close(1000, 'stopped');
		this.socket = null;
		this.unsubscribeStore?.();
		this.unsubscribeScreening?.();
		this.unsubscribeStore = null;
		this.unsubscribeScreening = null;
		if (wasJoined) this.leaveRoom();
		this.updateRoom((room) => (room ? { ...room, connection: 'stopped' } : room));
	}

	/**
	 * Send one frame for another module (the bot relay, the Room panel).
	 * Only once `welcome` and the first `screening.set` are done (D4).
	 */
	send(frame: ClientFrame): boolean {
		if (!this.isJoined() || this.reportedScreening === null) return false;
		return this.sendFrame(frame);
	}

	/** Every parsed server frame, after the client has handled it. Returns the unsubscribe. */
	subscribe(listener: SketchRoomFrameListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Announce or withdraw the bot (sleep, resume, quit). False without a bot or a room. */
	setBotOnline(online: boolean): boolean {
		const bot = this.options.bot;
		if (!bot || !this.isJoined() || this.reportedScreening === null) return false;
		if (!this.sendFrame({ t: 'bot.presence', ...bot, online })) return false;
		this.botAnnounced = online;
		if (online) this.scheduleFlush();
		return true;
	}

	/**
	 * Decrypt a frame's `iv` / `ct` as `kind` under the room key and the
	 * current key epoch, for the bot relay (chat requests). The key never
	 * leaves the client. Never throws; a failure means drop the frame.
	 */
	async openPayload<K extends SketchPayloadKind>(
		kind: K,
		sealed: SealedField
	): Promise<DecodePayloadResult<K>> {
		if (!this.key) return { ok: false, error: 'no room key' };
		return decryptPayload(this.key, kind, this.roomId, this.keyEpoch, sealed);
	}

	/**
	 * Encrypt a payload for a frame (`chat`, `bot.reply`) under the current
	 * key epoch. Null before the key is imported. Throws on an invalid
	 * payload, like `encryptPayload()`.
	 */
	async sealPayload<K extends SketchPayloadKind>(
		kind: K,
		payload: SketchPayloadByKind[K]
	): Promise<SealedField | null> {
		if (!this.key) return null;
		return encryptPayload(this.key, kind, this.roomId, this.keyEpoch, payload);
	}

	// ------------------------------------------------------------ connection

	private isJoined(): boolean {
		return this.phase === 'welcomed' || this.phase === 'catching-up' || this.phase === 'live';
	}

	private connect(): void {
		const generation = ++this.generation;
		this.phase = 'connecting';
		this.socket = this.createSocket(sketchRoomSocketUrl(this.options.serverUrl, this.roomId), {
			onOpen: () => {
				if (generation !== this.generation) return;
				this.sendFrame({
					t: 'hello',
					v: PROTOCOL_VERSION,
					room: this.roomId,
					auth: { owner: this.options.ownerToken },
					clientId: this.clientId,
					name: CONDUCTOR_HELLO_NAME,
				});
			},
			onMessage: (data) => {
				if (generation !== this.generation || typeof data !== 'string') return;
				const parsed = parseServerFrame(data);
				if (!parsed.ok) {
					logger.warn('Dropped a frame the room sent', LOG_CTX, { detail: parsed.detail });
					return;
				}
				this.inbound = this.inbound
					.then(() => this.handleFrame(parsed.frame, generation))
					.catch((error) => {
						// One bad frame must not stop the frames behind it; report it instead.
						captureException(error, { extra: { frame: parsed.frame.t } });
						logger.error('Room frame handling failed', LOG_CTX, { frame: parsed.frame.t });
					});
			},
			onClose: (code) => {
				if (generation !== this.generation) return;
				this.handleClose(code);
			},
		});
	}

	private handleClose(code: number): void {
		const wasJoined = this.isJoined();
		this.socket = null;
		this.generation++;
		this.clearTimers();
		this.heldDeltas = [];
		this.reportedScreening = null;
		this.botAnnounced = false;
		if (wasJoined) this.leaveRoom();

		const action = sketchRoomCloseAction(code);
		logger.info('Room socket closed', LOG_CTX, { code, reconnect: action.reconnect });
		if (!action.reconnect) {
			this.phase = 'stopped';
			this.unsubscribeStore?.();
			this.unsubscribeScreening?.();
			this.unsubscribeStore = null;
			this.unsubscribeScreening = null;
			this.updateRoom((room) =>
				room ? { ...room, connection: 'stopped', notice: action.notice, botOnline: false } : room
			);
			return;
		}
		this.phase = 'idle';
		const delay = sketchReconnectDelay(this.reconnectAttempt++, code, this.random);
		this.updateRoom((room) =>
			room ? { ...room, connection: 'reconnecting', notice: action.notice } : room
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.phase === 'idle') this.connect();
		}, delay);
	}

	/** Tell the consent module the room is no longer live (its socket left). */
	private leaveRoom(): void {
		this.screeningApi.setRoomLive(this.sketchId, false).catch((error) => {
			logger.warn('Could not report the room as closed', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.updateRoom((room) =>
			room ? { ...room, screening: { ...room.screening, reported: null } } : room
		);
	}

	private clearTimers(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.reconnectTimer = null;
		this.flushTimer = null;
		this.snapshotTimer = null;
	}

	private sendFrame(frame: ClientFrame): boolean {
		if (!this.socket) return false;
		this.socket.send(JSON.stringify(frame));
		return true;
	}

	private updateRoom(update: (room: SketchRoomState | null) => SketchRoomState | null): void {
		useSketchSessionStore.getState().updateSketchRoom(this.sketchId, update);
	}

	// ------------------------------------------------------------ inbound

	private async handleFrame(frame: ServerFrame, generation: number): Promise<void> {
		if (generation !== this.generation) return;
		switch (frame.t) {
			case 'welcome':
				await this.handleWelcome(frame, generation);
				break;
			case 'screening':
				this.recordServerScreening(frame.screening, frame.since);
				break;
			case 'ack':
				if (this.phase === 'live') this.advanceSeq(frame.seq);
				break;
			case 'delta': {
				const { t: _t, ...op } = frame;
				if (this.phase === 'catching-up' || this.phase === 'welcomed') this.heldDeltas.push(op);
				else if (this.phase === 'live') await this.applyOps([op], generation);
				break;
			}
			case 'ops':
				await this.handleOpsPage(frame.items, frame.more, generation);
				break;
			case 'presence.bot':
				this.updateRoom((room) => (room ? { ...room, botOnline: frame.online } : room));
				break;
			case 'policy':
				this.updateRoom((room) => (room ? { ...room, botPolicy: frame.botPolicy } : room));
				break;
			case 'room.stats':
				this.updateRoom((room) => (room ? { ...room, guestEdited: frame.guestEdited } : room));
				break;
			case 'error':
				logger.warn('The room refused a frame', LOG_CTX, { code: frame.code, ref: frame.ref });
				break;
			default:
				break;
		}
		if (generation !== this.generation) return;
		for (const listener of this.listeners) listener(frame);
	}

	private async handleWelcome(
		frame: Extract<ServerFrame, { t: 'welcome' }>,
		generation: number
	): Promise<void> {
		if (this.phase !== 'connecting') return;
		this.phase = 'welcomed';
		this.keyEpoch = frame.keyEpoch;
		this.reconnectAttempt = 0;
		this.updateRoom((room) =>
			room
				? {
						...room,
						connection: 'catching-up',
						notice: null,
						actor: frame.actor,
						role: frame.role,
						botPolicy: frame.botPolicy,
						botOnline: frame.botOnline,
						guestEdited: frame.guestEdited,
						headSeq: Math.max(frame.headSeq, room.syncedSeq),
						keyEpoch: frame.keyEpoch,
						screening: { reported: null, server: frame.screening, since: frame.screeningSince },
					}
				: room
		);
		if (frame.screening !== null) this.reportServerScreening(frame.screening, frame.screeningSince);

		// D4: screening.set first, then the bot, then anything else.
		let screening: Screening;
		try {
			screening = await this.screeningApi.setRoomLive(this.sketchId, true);
		} catch (error) {
			// Without the consent module's answer, report local: the gate then
			// never treats the room as cloud-confirmed, so it fails closed.
			logger.warn('Could not read the room screening value; reporting local', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
			screening = 'local';
		}
		if (generation !== this.generation) return;
		this.reportScreening(screening);
		if (
			this.options.bot &&
			this.sendFrame({ t: 'bot.presence', ...this.options.bot, online: true })
		) {
			this.botAnnounced = true;
		}

		if (frame.headSeq > this.syncedSeq) {
			this.phase = 'catching-up';
			this.sendFrame({ t: 'catchup', sinceSeq: this.syncedSeq });
		} else {
			await this.finishCatchup(generation);
		}
	}

	private async handleOpsPage(items: OpItem[], more: boolean, generation: number): Promise<void> {
		if (this.phase !== 'catching-up') return;
		await this.applyOps(items, generation);
		if (generation !== this.generation) return;
		const advanced = items.length > 0;
		if (more && advanced) {
			this.sendFrame({ t: 'catchup', sinceSeq: this.syncedSeq });
			return;
		}
		if (more) logger.warn('The room sent an empty catchup page with more set', LOG_CTX);
		await this.finishCatchup(generation);
	}

	private async finishCatchup(generation: number): Promise<void> {
		const held = this.heldDeltas
			.filter((op) => op.seq > this.syncedSeq)
			.sort((a, b) => a.seq - b.seq);
		this.heldDeltas = [];
		if (held.length > 0) await this.applyOps(held, generation);
		if (generation !== this.generation) return;
		this.phase = 'live';
		this.updateRoom((room) => (room ? { ...room, connection: 'live' } : room));
		// Edits made while the socket was down go out now, after the room's own.
		this.scheduleFlush();
		this.scheduleSnapshot();
	}

	private advanceSeq(seq: number): void {
		if (seq <= this.syncedSeq) return;
		this.opsSinceSnapshot += seq - this.syncedSeq;
		this.syncedSeq = seq;
		this.scheduleSnapshot();
		this.updateRoom((room) =>
			room ? { ...room, syncedSeq: seq, headSeq: Math.max(room.headSeq, seq) } : room
		);
	}

	/**
	 * Decrypt ops, merge the winning version of each element into the scene,
	 * and record its author from the op envelope.
	 */
	private async applyOps(ops: readonly OpItem[], generation: number): Promise<void> {
		const key = this.key;
		const reconcile = this.reconcile;
		if (!key || !reconcile || ops.length === 0) return;
		const decrypted = await Promise.all(
			ops.map((op) =>
				decryptPayload(key, 'delta', this.roomId, this.keyEpoch, { iv: op.iv, ct: op.ct })
			)
		);
		if (generation !== this.generation) return;

		const winners = new Map<string, { element: SketchWireElement; op: OpItem }>();
		let dropped = 0;
		ops.forEach((op, index) => {
			const result = decrypted[index];
			if (!result.ok) {
				dropped++;
				return;
			}
			for (const element of result.payload.elements) {
				const current = winners.get(element.id);
				if (!current || wins(element, current.element)) winners.set(element.id, { element, op });
			}
		});
		if (dropped > 0) {
			logger.warn('Dropped room ops that did not decrypt', LOG_CTX, { count: dropped });
		}
		const maxSeq = ops.reduce((max, op) => Math.max(max, op.seq), this.syncedSeq);

		if (winners.size > 0) {
			const entries = [...winners.values()];
			const hashes = await Promise.all(entries.map(({ element }) => sketchTextHash(element)));
			if (generation !== this.generation) return;
			const store = useSketchSessionStore.getState();
			const scene = store.sessions[this.sketchId]?.scene;
			if (!scene) return;
			// Copies: reconcile may rewrite fractional indices in place.
			const merged = reconcile(
				scene.elements.map((element) => ({ ...element })),
				entries.map(({ element }) => ({ ...element }))
			);
			const mergedById = new Map(merged.map((element) => [element.id, element]));
			for (const element of merged) {
				const known = this.knownVersions.get(element.id);
				if (known === undefined || element.version > known) {
					this.knownVersions.set(element.id, element.version);
				}
			}
			// A queued local edit is dropped only when a remote version beat it.
			// `merged` also holds the local elements, so it cannot decide that.
			for (const { element } of entries) {
				const kept = mergedById.get(element.id);
				const queued = this.pending.get(element.id);
				if (
					kept &&
					queued &&
					sameVersion(kept, element) &&
					queued.element.version <= kept.version
				) {
					this.pending.delete(element.id);
				}
			}
			// `knownVersions` already holds every merged version, so the scene
			// subscription finds nothing in this write to send back.
			store.applyRemoteElements(this.sketchId, merged);

			entries.forEach(({ element, op }, index) => {
				const kept = mergedById.get(element.id);
				if (!kept || !sameVersion(kept, element)) return;
				store.recordAuthorship(this.sketchId, element.id, {
					version: element.version,
					actor: op.actor,
					textHash: hashes[index],
					opSeq: op.seq,
					ts: op.ts,
				});
			});
		}
		this.advanceSeq(maxSeq);
	}

	// ------------------------------------------------------------ snapshots

	/** Upload now at the op threshold; otherwise (re)arm the idle timer. */
	private scheduleSnapshot(): void {
		if (this.phase !== 'live' || this.snapshotting || this.opsSinceSnapshot === 0) return;
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = null;
		if (this.opsSinceSnapshot >= SKETCH_SNAPSHOT_EVERY_OPS) {
			void this.snapshotNow();
			return;
		}
		this.armSnapshotTimer();
	}

	private armSnapshotTimer(): void {
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			void this.snapshotNow();
		}, SKETCH_SNAPSHOT_IDLE_MS);
	}

	private async snapshotNow(): Promise<void> {
		if (this.phase !== 'live' || this.snapshotting || this.opsSinceSnapshot === 0) return;
		const scene = useSketchSessionStore.getState().sessions[this.sketchId]?.scene;
		if (!scene) return;
		const generation = this.generation;
		const counted = this.opsSinceSnapshot;
		this.snapshotting = true;
		let failed = false;
		try {
			await this.uploadSnapshot(this.sketchId, { scene, baseSeq: this.syncedSeq });
			this.opsSinceSnapshot = Math.max(0, this.opsSinceSnapshot - counted);
		} catch (error) {
			failed = true;
			logger.warn('The room snapshot did not upload; trying again later', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.snapshotting = false;
		}
		if (generation !== this.generation || this.phase !== 'live') return;
		// A failure waits the idle delay, so a refused upload never loops.
		if (failed) this.armSnapshotTimer();
		else this.scheduleSnapshot();
	}

	// ------------------------------------------------------------ screening

	private recordServerScreening(screening: Screening, since: number): void {
		this.updateRoom((room) =>
			room ? { ...room, screening: { ...room.screening, server: screening, since } } : room
		);
		this.reportServerScreening(screening, since);
	}

	private reportServerScreening(screening: Screening, since: number | null): void {
		this.screeningApi.reportServerScreening(this.sketchId, screening, since).catch((error) => {
			logger.warn('Could not report the server screening value', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/** Send `screening.set` when the value differs from what this socket last sent. */
	private reportScreening(screening: Screening): void {
		if (!this.isJoined() || screening === this.reportedScreening) return;
		if (!this.sendFrame({ t: 'screening.set', screening })) return;
		this.reportedScreening = screening;
		this.updateRoom((room) =>
			room ? { ...room, screening: { ...room.screening, reported: screening } } : room
		);
	}

	// ------------------------------------------------------------ outbound

	/** Queue every element whose version the room has not seen. */
	private collectLocalEdits(elements: readonly SketchWireElement[]): void {
		let queued = false;
		for (const element of elements) {
			const known = this.knownVersions.get(element.id);
			if (known !== undefined && element.version <= known) continue;
			this.knownVersions.set(element.id, element.version);
			// This desktop stamped every element it changed, so its own stamp is
			// trusted here; an incoming element never reaches this path.
			const bot = readElementStamp(element)?.lastEditedBy.kind === 'bot';
			this.pending.set(element.id, { element, bot });
			queued = true;
		}
		if (queued) this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.phase !== 'live' || this.flushing || this.flushTimer || this.pending.size === 0) {
			return;
		}
		const wait = Math.max(0, this.lastDeltaAt + SKETCH_DELTA_MIN_INTERVAL_MS - Date.now());
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushOne();
		}, wait);
	}

	/**
	 * Send one `delta`: the human edits first, then the agent's (`asBot`, X2).
	 * An agent edit goes out as the conductor's when the bot is not announced,
	 * since the server refuses `asBot` then.
	 */
	private async flushOne(): Promise<void> {
		const key = this.key;
		if (this.phase !== 'live' || !key || this.pending.size === 0) return;
		const generation = this.generation;
		const asHuman = [...this.pending.values()].filter((edit) => !edit.bot || !this.botAnnounced);
		const asBot = asHuman.length === 0;
		const candidates = asBot ? [...this.pending.values()] : asHuman;

		const elements: SketchWireElement[] = [];
		let bytes = 0;
		for (const { element } of candidates) {
			const size = encoder.encode(JSON.stringify(element)).length;
			if (elements.length > 0 && bytes + size > SKETCH_DELTA_MAX_PLAINTEXT_BYTES) break;
			elements.push(element);
			bytes += size;
		}
		for (const element of elements) this.pending.delete(element.id);

		this.flushing = true;
		this.lastDeltaAt = Date.now();
		try {
			if (bytes > SKETCH_DELTA_MAX_PLAINTEXT_BYTES) {
				logger.warn('An element is too large for one delta frame; not sent', LOG_CTX, {
					elementId: elements[0]?.id,
					bytes,
				});
				return;
			}
			const sealed = await encryptPayload(key, 'delta', this.roomId, this.keyEpoch, {
				v: 1,
				elements,
			});
			if (generation !== this.generation || this.phase !== 'live') {
				// The socket went away while sealing: keep the edits for the next one.
				this.requeue(elements, asBot);
				return;
			}
			this.sendFrame({
				t: 'delta',
				iv: sealed.iv,
				ct: sealed.ct,
				n: elements.length,
				...(asBot ? { asBot: true as const } : {}),
			});
		} finally {
			this.flushing = false;
			this.scheduleFlush();
		}
	}

	private requeue(elements: readonly SketchWireElement[], bot: boolean): void {
		for (const element of elements) {
			const queued = this.pending.get(element.id);
			if (!queued || queued.element.version < element.version) {
				this.pending.set(element.id, { element, bot });
			}
		}
	}
}

// ---------------------------------------------------------------- registry

const clients = new Map<string, SketchRoomClient>();

/**
 * Connect a shared sketch to its room. A client already running for the
 * sketch is stopped first, so one sketch never holds two sockets.
 */
export async function connectSketchRoom(
	options: SketchRoomClientOptions,
	deps?: SketchRoomClientDeps
): Promise<SketchRoomClient> {
	clients.get(options.sketchId)?.stop();
	const client = new SketchRoomClient(options, deps);
	clients.set(options.sketchId, client);
	try {
		await client.start();
	} catch (error) {
		client.stop();
		if (clients.get(options.sketchId) === client) clients.delete(options.sketchId);
		throw error;
	}
	return client;
}

/** The sketch's room client, or undefined when it has none. */
export function getSketchRoomClient(sketchId: string): SketchRoomClient | undefined {
	return clients.get(sketchId);
}

/** Stop the sketch's room client and forget it. */
export function disconnectSketchRoom(sketchId: string): void {
	clients.get(sketchId)?.stop();
	clients.delete(sketchId);
}
