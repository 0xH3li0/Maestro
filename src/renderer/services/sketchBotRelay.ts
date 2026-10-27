/**
 * Sketch Book bot relay (spec section 5, wire contract sections 4 and 5):
 * the desktop side of `@bot`.
 *
 * Guest request (B2). On a `chat` echo with `toBot: true` whose envelope
 * actor is a guest (D8: only `toBot: true` echoes are requests; the envelope
 * actor is the only identity trusted, never the ciphertext):
 *
 * 1. `bot.progress {screening}`, then decrypt, then the gate
 *    (`window.maestro.sketch.screenBotRequest`, main's `screenText()`).
 * 2. `flagged` sends `guardrail_rejected {replyTo, reason:'injection'}`;
 *    `unscreened`, a gate that throws, and a request that does not decrypt
 *    send `guardrail_rejected {replyTo, reason:'screen_unavailable'}`.
 *    Nothing else rides on the frame (`buildGuardrailRejected()`).
 * 3. `clean` sends `bot.progress {awaiting_approval}` and raises the approval
 *    chip: the request goes into the session's `botRequests`.
 * 4. Run sends `bot.progress {running}` and starts a restricted turn (Q4);
 *    Deny sends `bot.denied`.
 * 5. The turn's answer goes out as `bot.reply`; an error, a stop, or a reply
 *    that cannot be sealed sends `bot.failed` (X5), which costs the guest
 *    nothing.
 *
 * Conductor message. Typed in the Sketch tab, it skips the gate and starts
 * its turn at send time ({@link SketchBotRelay.sendConductorMessage}). In a
 * live room it also goes out as a `toBot` chat, so the room sees the request
 * and the reply threads under it; the server's echo of it is ignored. On an
 * unshared sketch (or with the socket down) the turn runs locally and the
 * reply is posted to the chat pane. Posture (spec section 5, Turn posture):
 * restricted while a guest has edited the canvas, unless the conductor
 * escalated that one message; full otherwise.
 *
 * Every request ends with exactly one of `guardrail_rejected`, `bot.denied`,
 * `bot.failed` or `bot.reply`, with two exceptions the server owns: a request
 * it expired before the desktop answered (X3, `bot.status {expired}`: the
 * chip goes, nothing is sent), and a request it failed because this desktop's
 * socket closed (X7, seen here as the next `welcome`). A turn already running
 * is never stopped for either: its reply is still posted (Y3), after the
 * socket comes back if it has to wait.
 *
 * The turn itself (the "Sketch: <name>" tab, `enqueuePromptForTab()`, the
 * outbound screen, the reply cap) belongs to the runner registered with
 * {@link setSketchBotTurnRunner}. Until one is registered every approved
 * request ends as `bot.failed`.
 *
 * The relay also mirrors the room's chat into the session's chat pane: every
 * message except the conductor's own, which the pane already shows from the
 * moment it was sent.
 */

import { botActor, localConductorActor } from '../../shared/sketch/attribution';
import type { SealedField } from '../../shared/sketch/crypto';
import {
	CHAT_MAX_CHARS,
	payloadCharCount,
	type DecodePayloadResult,
	type SketchPayloadByKind,
	type SketchPayloadKind,
} from '../../shared/sketch/payloads';
import {
	buildGuardrailRejected,
	type ClientFrame,
	type ServerFrame,
} from '../../shared/sketch/protocol';
import type {
	SketchActor,
	SketchBotScreenRequest,
	SketchScreenVerdict,
	SketchTurnPosture,
} from '../../shared/sketch/types';
import { generateUUID } from '../../shared/uuid';
import { notifyToast } from '../stores/notificationStore';
import {
	useSketchSessionStore,
	type SketchAgentIdentity,
	type SketchBotRequest,
} from '../stores/sketchSessionStore';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CTX = '[SketchBook][BotRelay]';

/** The part of the room client the relay uses (`SketchRoomClient`). */
export interface SketchBotRelayRoom {
	/** False while the socket is not joined; the frame is not sent then. */
	send(frame: ClientFrame): boolean;
	subscribe(listener: (frame: ServerFrame) => void): () => void;
	openPayload<K extends SketchPayloadKind>(
		kind: K,
		sealed: SealedField
	): Promise<DecodePayloadResult<K>>;
	sealPayload<K extends SketchPayloadKind>(
		kind: K,
		payload: SketchPayloadByKind[K]
	): Promise<SealedField | null>;
}

/** One turn the runner starts. */
export interface SketchBotTurnRequest {
	sketchId: string;
	/** The chat id the reply answers, or a local id on an unshared sketch. */
	replyTo: string;
	/** Who asked: the server-stamped actor, or the local conductor. */
	actor: SketchActor;
	/** Who asked, as the posture rules read it. */
	from: 'conductor' | 'guest';
	text: string;
	posture: SketchTurnPosture;
	/** The conductor chose "Run with full access" for this message. */
	escalated: boolean;
	/** The gate's decision for a guest request; null for the conductor. */
	verdict: SketchScreenVerdict | null;
}

/** How a turn ended. */
export type SketchBotTurnResult =
	| {
			status: 'reply';
			/** The final answer, already through the outbound screen and the cap. */
			text: string;
			/** What the turn changed, for the guests' "show me" link. */
			elementIds?: string[];
			/** The agent that answered, named in the chat pane. */
			agent: SketchAgentIdentity;
	  }
	| { status: 'failed'; reason: string };

export type SketchBotTurnRunner = (request: SketchBotTurnRequest) => Promise<SketchBotTurnResult>;

export interface SketchBotRelayDeps {
	/** The gate. Default `window.maestro.sketch.screenBotRequest`. */
	screen?: (sketchId: string, request: SketchBotScreenRequest) => Promise<SketchScreenVerdict>;
	runTurn?: SketchBotTurnRunner | null;
	/** Ids for conductor messages. Default a fresh UUID. */
	newId?: () => string;
	now?: () => number;
	/** Tell the conductor a turn failed. Default a red toast. */
	notifyFailure?: (sketchId: string, reason: string) => void;
}

export interface SketchBotRelay {
	/** Follow a sketch's room client; a client already attached for it is replaced. */
	attach(sketchId: string, room: SketchBotRelayRoom): void;
	/** Stop following the sketch's room. Running turns still answer once a room is attached. */
	detach(sketchId: string): void;
	/** Run a guest request the chip shows. False when it is not waiting on approval. */
	approve(sketchId: string, replyTo: string): boolean;
	/** Deny a guest request the chip shows. False when it is not waiting on approval. */
	deny(sketchId: string, replyTo: string): boolean;
	/**
	 * Send the conductor's own `@bot` message and start its turn now.
	 * Resolves with the request's `replyTo` once the turn has started.
	 */
	sendConductorMessage(
		sketchId: string,
		text: string,
		options?: { escalated?: boolean }
	): Promise<string>;
	setTurnRunner(runner: SketchBotTurnRunner | null): void;
	/** Forget every room and request. */
	dispose(): void;
}

type Phase = 'screening' | 'awaiting_approval' | 'running';

interface Tracked {
	sketchId: string;
	replyTo: string;
	phase: Phase;
	/** False for a conductor message no room saw: its reply goes to the chat pane only. */
	shared: boolean;
	/** The server expired it (X3) or failed it when the socket closed (X7). */
	ended: boolean;
}

/** A reply waiting for the socket; sealed when it is sent, under the key epoch then in force. */
interface PendingReply {
	replyTo: string;
	payload: SketchPayloadByKind['bot.reply'];
}

const NO_RUNNER = 'No agent turn runner is registered for Sketch Book.';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultNotifyFailure(_sketchId: string, reason: string): void {
	notifyToast({ color: 'red', title: 'Sketch Book', message: `The agent turn failed: ${reason}` });
}

/** The verdict the relay acts on when the gate itself cannot answer: fail closed. */
function gateFailed(reason: string): SketchScreenVerdict {
	return { status: 'unscreened', sourceLabel: 'Screen unavailable', locality: 'local', reason };
}

export function createSketchBotRelay(deps: SketchBotRelayDeps = {}): SketchBotRelay {
	const screen =
		deps.screen ??
		((sketchId: string, request: SketchBotScreenRequest) =>
			window.maestro.sketch.screenBotRequest(sketchId, request));
	const newId = deps.newId ?? generateUUID;
	const now = deps.now ?? Date.now;
	const notifyFailure = deps.notifyFailure ?? defaultNotifyFailure;
	let runTurn = deps.runTurn ?? null;

	const rooms = new Map<string, { room: SketchBotRelayRoom; unsubscribe: () => void }>();
	const tracked = new Map<string, Tracked>();
	const outbox = new Map<string, PendingReply[]>();

	const store = () => useSketchSessionStore.getState();
	const keyOf = (sketchId: string, replyTo: string) => `${sketchId}|${replyTo}`;

	function send(sketchId: string, frame: ClientFrame): boolean {
		return rooms.get(sketchId)?.room.send(frame) ?? false;
	}

	/** End a request with its one final frame. Does nothing for a request already ended. */
	function finish(entry: Tracked, frame: ClientFrame | null): void {
		const key = keyOf(entry.sketchId, entry.replyTo);
		if (tracked.get(key) !== entry) return;
		tracked.delete(key);
		store().removeSketchBotRequest(entry.sketchId, entry.replyTo);
		if (frame && !entry.ended && entry.shared) send(entry.sketchId, frame);
	}

	// ------------------------------------------------------------ inbound

	function onFrame(sketchId: string, room: SketchBotRelayRoom, frame: ServerFrame): void {
		switch (frame.t) {
			case 'welcome':
				onWelcome(sketchId);
				break;
			case 'chat':
				void onChat(sketchId, room, frame).catch((error) => {
					logger.error('Bot relay failed on a chat frame', LOG_CTX, { error: errorMessage(error) });
					captureException(error, { extra: { sketchId } });
				});
				break;
			case 'bot.status':
				if (frame.status === 'expired') onExpired(sketchId, frame.replyTo);
				break;
			default:
				break;
		}
	}

	/**
	 * A new socket joined. The server failed every request still pending on
	 * the old one when it closed (X7), so chips and screens in flight go; a
	 * running turn keeps going and its reply is still posted (Y3).
	 */
	function onWelcome(sketchId: string): void {
		for (const entry of [...tracked.values()]) {
			if (entry.sketchId !== sketchId || !entry.shared) continue;
			if (entry.phase === 'running') {
				markEnded(entry);
			} else {
				entry.ended = true;
				if (entry.phase === 'awaiting_approval') finish(entry, null);
			}
		}
		void flushOutbox(sketchId);
	}

	/** X3: the server expired a request. Nothing more is sent for it, except a running turn's reply. */
	function onExpired(sketchId: string, replyTo: string): void {
		const entry = tracked.get(keyOf(sketchId, replyTo));
		if (!entry) return;
		if (entry.phase === 'running') {
			markEnded(entry);
			return;
		}
		entry.ended = true;
		if (entry.phase === 'awaiting_approval') finish(entry, null);
	}

	function markEnded(entry: Tracked): void {
		entry.ended = true;
		store().updateSketchBotRequest(entry.sketchId, entry.replyTo, (request) => ({
			...request,
			expired: true,
		}));
	}

	async function onChat(
		sketchId: string,
		room: SketchBotRelayRoom,
		frame: Extract<ServerFrame, { t: 'chat' }>
	): Promise<void> {
		// The conductor's own messages are in the pane already, and its requests started at send.
		if (frame.actor.kind === 'conductor') return;
		const isRequest = frame.toBot && frame.actor.kind === 'guest';
		const key = keyOf(sketchId, frame.id);
		let entry: Tracked | undefined;
		if (isRequest) {
			if (tracked.has(key)) return;
			entry = { sketchId, replyTo: frame.id, phase: 'screening', shared: true, ended: false };
			tracked.set(key, entry);
			room.send({ t: 'bot.progress', replyTo: frame.id, status: 'screening' });
		}

		const sealed = { iv: frame.iv, ct: frame.ct };
		const opened =
			frame.actor.kind === 'bot'
				? await room.openPayload('bot.reply', sealed)
				: await room.openPayload('chat', sealed);
		if (opened.ok) {
			store().postSketchChat(sketchId, {
				actor: frame.actor,
				text: opened.payload.text,
				ts: frame.ts,
			});
		} else {
			logger.warn('Dropped a room chat message that did not decrypt', LOG_CTX, {
				error: opened.error,
			});
		}
		if (!entry) return;
		if (!opened.ok) {
			// Nothing the gate could read: fail closed, as an outage on this side.
			finish(entry, buildGuardrailRejected({ replyTo: entry.replyTo }, 'screen_unavailable'));
			return;
		}
		await screenRequest(entry, frame.actor, opened.payload.text, frame.ts);
	}

	async function screenRequest(
		entry: Tracked,
		actor: SketchActor,
		text: string,
		ts: number
	): Promise<void> {
		let verdict: SketchScreenVerdict;
		try {
			verdict = await screen(entry.sketchId, { replyTo: entry.replyTo, ts, actor, text });
		} catch (error) {
			logger.warn('The bot screen did not answer; failing closed', LOG_CTX, {
				error: errorMessage(error),
			});
			verdict = gateFailed(errorMessage(error));
		}
		if (entry.ended) {
			// The server let it go while it was screened; it holds no pending entry to answer.
			finish(entry, null);
			return;
		}
		switch (verdict.status) {
			case 'flagged':
				finish(entry, buildGuardrailRejected({ replyTo: entry.replyTo }, 'injection'));
				return;
			case 'unscreened':
				finish(entry, buildGuardrailRejected({ replyTo: entry.replyTo }, 'screen_unavailable'));
				return;
			case 'clean':
				entry.phase = 'awaiting_approval';
				send(entry.sketchId, {
					t: 'bot.progress',
					replyTo: entry.replyTo,
					status: 'awaiting_approval',
				});
				store().putSketchBotRequest(entry.sketchId, {
					replyTo: entry.replyTo,
					actor,
					text,
					ts,
					status: 'awaiting_approval',
					verdict,
					// Q4: a guest request never runs with full access.
					posture: 'restricted',
				});
				return;
		}
	}

	// ------------------------------------------------------------ the turn

	function startTurn(entry: Tracked, request: SketchBotRequest, escalated: boolean): void {
		entry.phase = 'running';
		void runAndAnswer(entry, {
			sketchId: entry.sketchId,
			replyTo: entry.replyTo,
			actor: request.actor,
			from: request.actor.kind === 'guest' ? 'guest' : 'conductor',
			text: request.text,
			posture: request.posture,
			escalated,
			verdict: request.verdict,
		});
	}

	async function runAndAnswer(entry: Tracked, request: SketchBotTurnRequest): Promise<void> {
		let result: SketchBotTurnResult;
		try {
			result = runTurn ? await runTurn(request) : { status: 'failed', reason: NO_RUNNER };
		} catch (error) {
			logger.error('A Sketch Book turn threw', LOG_CTX, { error: errorMessage(error) });
			captureException(error, { extra: { sketchId: entry.sketchId } });
			result = { status: 'failed', reason: errorMessage(error) };
		}
		if (result.status === 'failed') {
			notifyFailure(entry.sketchId, result.reason);
			finish(entry, { t: 'bot.failed', replyTo: entry.replyTo });
			return;
		}
		const payload: SketchPayloadByKind['bot.reply'] = {
			v: 1,
			text: result.text,
			...(result.elementIds && result.elementIds.length > 0
				? { elementIds: result.elementIds }
				: {}),
		};
		if (!entry.shared) {
			store().postSketchChat(entry.sketchId, {
				actor: botActor(result.agent.id, result.agent.name),
				text: result.text,
			});
			finish(entry, null);
			return;
		}
		// The room broadcasts the reply as bot chat, and the mirror puts it in the pane.
		const key = keyOf(entry.sketchId, entry.replyTo);
		if (tracked.get(key) !== entry) return;
		tracked.delete(key);
		store().removeSketchBotRequest(entry.sketchId, entry.replyTo);
		await postReply(entry.sketchId, { replyTo: entry.replyTo, payload });
	}

	/** Seal and send a reply, or keep it until the next socket joins (Y3). */
	async function postReply(sketchId: string, reply: PendingReply): Promise<void> {
		const room = rooms.get(sketchId)?.room;
		let sealed: SealedField | null = null;
		if (room) {
			try {
				sealed = await room.sealPayload('bot.reply', reply.payload);
			} catch (error) {
				// The payload does not validate (an over-long reply): a failure, not a retry.
				logger.error('A Sketch Book reply could not be sealed', LOG_CTX, {
					error: errorMessage(error),
				});
				notifyFailure(sketchId, errorMessage(error));
				room.send({ t: 'bot.failed', replyTo: reply.replyTo });
				return;
			}
		}
		if (
			room &&
			sealed &&
			room.send({ t: 'bot.reply', replyTo: reply.replyTo, iv: sealed.iv, ct: sealed.ct })
		) {
			return;
		}
		const queue = outbox.get(sketchId) ?? [];
		queue.push(reply);
		outbox.set(sketchId, queue);
	}

	async function flushOutbox(sketchId: string): Promise<void> {
		const queue = outbox.get(sketchId);
		if (!queue || queue.length === 0) return;
		outbox.delete(sketchId);
		for (const reply of queue) await postReply(sketchId, reply);
	}

	// ------------------------------------------------------------ the relay

	return {
		attach(sketchId, room) {
			rooms.get(sketchId)?.unsubscribe();
			const unsubscribe = room.subscribe((frame) => onFrame(sketchId, room, frame));
			rooms.set(sketchId, { room, unsubscribe });
		},

		detach(sketchId) {
			rooms.get(sketchId)?.unsubscribe();
			rooms.delete(sketchId);
		},

		approve(sketchId, replyTo) {
			const entry = tracked.get(keyOf(sketchId, replyTo));
			const request = store().sessions[sketchId]?.botRequests.find(
				(candidate) => candidate.replyTo === replyTo
			);
			if (!entry || entry.phase !== 'awaiting_approval' || !request) return false;
			send(sketchId, { t: 'bot.progress', replyTo, status: 'running' });
			store().updateSketchBotRequest(sketchId, replyTo, (current) => ({
				...current,
				status: 'running',
			}));
			startTurn(entry, request, false);
			return true;
		},

		deny(sketchId, replyTo) {
			const entry = tracked.get(keyOf(sketchId, replyTo));
			if (!entry || entry.phase !== 'awaiting_approval') return false;
			finish(entry, { t: 'bot.denied', replyTo });
			return true;
		},

		async sendConductorMessage(sketchId, text, options = {}) {
			const session = store().sessions[sketchId];
			if (!session) throw new Error('Sketch Book: the sketch is not open.');
			const body = text.trim();
			if (!body) throw new Error('Sketch Book: the message is empty.');
			if (payloadCharCount(body) > CHAT_MAX_CHARS) {
				throw new Error(`Sketch Book: a message holds at most ${CHAT_MAX_CHARS} characters.`);
			}
			const escalated = options.escalated === true;
			const guestEdited =
				session.room?.guestEdited === true ||
				Object.values(session.authors).some((author) => author.guestTouched);
			const posture: SketchTurnPosture = guestEdited && !escalated ? 'restricted' : 'full';
			const actor = session.room?.actor ?? localConductorActor();
			const ts = now();
			store().postSketchChat(sketchId, { actor, text: body, ts });

			// In a live room the request goes out as `toBot` chat, so the reply threads under it.
			const room = rooms.get(sketchId)?.room;
			let replyTo = `local-${newId()}`;
			let shared = false;
			if (room) {
				const id = newId();
				const sealed = await room.sealPayload('chat', { v: 1, text: body });
				if (sealed && room.send({ t: 'chat', id, iv: sealed.iv, ct: sealed.ct, toBot: true })) {
					replyTo = id;
					shared = true;
					room.send({ t: 'bot.progress', replyTo, status: 'running' });
				}
			}
			const entry: Tracked = { sketchId, replyTo, phase: 'running', shared, ended: false };
			tracked.set(keyOf(sketchId, replyTo), entry);
			const request: SketchBotRequest = {
				replyTo,
				actor,
				text: body,
				ts,
				status: 'running',
				verdict: null,
				posture,
			};
			store().putSketchBotRequest(sketchId, request);
			startTurn(entry, request, escalated);
			return replyTo;
		},

		setTurnRunner(runner) {
			runTurn = runner;
		},

		dispose() {
			for (const { unsubscribe } of rooms.values()) unsubscribe();
			rooms.clear();
			tracked.clear();
			outbox.clear();
		},
	};
}

// ---------------------------------------------------------------- the app's relay

let appRelay: SketchBotRelay | null = null;

function relay(): SketchBotRelay {
	appRelay ??= createSketchBotRelay();
	return appRelay;
}

/** Follow a sketch's room client with the app's relay (`sketchSharing.ts` calls it on join). */
export function attachSketchBotRelay(sketchId: string, room: SketchBotRelayRoom): void {
	relay().attach(sketchId, room);
}

/** Stop following a sketch's room (the room client stopped). */
export function detachSketchBotRelay(sketchId: string): void {
	appRelay?.detach(sketchId);
}

/** The approval chip's Run. */
export function approveSketchBotRequest(sketchId: string, replyTo: string): boolean {
	return relay().approve(sketchId, replyTo);
}

/** The approval chip's Deny. */
export function denySketchBotRequest(sketchId: string, replyTo: string): boolean {
	return relay().deny(sketchId, replyTo);
}

/** The Sketch tab's composer: the conductor's own `@bot` message. */
export function sendSketchConductorMessage(
	sketchId: string,
	text: string,
	options?: { escalated?: boolean }
): Promise<string> {
	return relay().sendConductorMessage(sketchId, text, options);
}

/** Register the turn delivery (the "Sketch: <name>" tab). Null to remove it. */
export function setSketchBotTurnRunner(runner: SketchBotTurnRunner | null): void {
	relay().setTurnRunner(runner);
}
