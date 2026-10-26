/**
 * Sketch Book wire protocol v1, desktop side: every frame of
 * `docs/sketch-book-wire-contract.md` sections 4 and 5, the size caps of
 * section 1, close and error codes, a hand-written server frame parser, and
 * the only builder allowed to emit `guardrail_rejected`.
 *
 * The hosted Worker validates client frames against the same contract
 * (`workers/sketch-room/src/protocol.ts` in the RunMaestro.ai repo). Bundled
 * into the renderer and the CLI, so it imports nothing from Electron or Node.
 */

import {
	BOT_POLICIES,
	BOT_STATUSES,
	GUARDRAIL_NOTICES,
	SKETCH_ACTOR_KINDS,
	SKETCH_LINK_ROLES,
	SKETCH_ROLES,
	type BotPolicy,
	type BotProgressStatus,
	type BotStatus,
	type GuardrailNotice,
	type GuardrailReason,
	type SketchActor,
	type SketchActorKind,
	type SketchLinkRole,
	type SketchRole,
} from './types';

export const PROTOCOL_VERSION = 1;

const KiB = 1024;
const MiB = 1024 * KiB;

/** Contract section 1: the largest WebSocket text frame, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 1 * MiB;

/**
 * Contract section 1. Caps on the base64url `ct` string as sent. `chat` and
 * `bot.reply` are 32 KiB (Y1); the server broadcasts a bot reply as `chat`.
 */
export const CT_MAX_BYTES = {
	chat: 32 * KiB,
	'bot.reply': 32 * KiB,
	delta: 1 * MiB,
	presence: 2 * KiB,
} as const;

/** Contract section 1 (Y2): HTTP blob bodies, raw `iv || ct` as sent. */
export const SNAPSHOT_MAX_BYTES = 25 * MiB;
export const FILE_MAX_BYTES = 4 * MiB;

/** Contract section 4: `catchup` answers with at most this many ops per page. */
export const CATCHUP_PAGE_MAX = 500;

/** Upper bound on any id or name string. Not in the contract; an abuse guard only. */
const MAX_ID_CHARS = 256;
/** R2 object keys in `welcome.snapshot.key`. */
const MAX_KEY_CHARS = 1024;

/** Where guest text goes when the desktop screens it (X10). */
export type Screening = 'local' | 'cloud';
export const SCREENINGS: readonly Screening[] = ['local', 'cloud'];

/** Contract section 5. */
export const CLOSE_CODES = {
	auth_failed: 4001,
	revoked: 4003,
	kicked: 4004,
	rate_limited: 4008,
	superseded: 4009,
	expired: 4010,
	archived: 4011,
} as const;
export type CloseCodeName = keyof typeof CLOSE_CODES;

/**
 * `error {code}` values. The contract names `bad_frame`, `forbidden`,
 * `unknown_ref` and `rate_limited`; `auth_failed`, `name_reserved` (M2) and
 * `room_full` are the hosted rejections sent before a close.
 */
export const ERROR_CODES = {
	bad_frame: 'bad_frame',
	forbidden: 'forbidden',
	unknown_ref: 'unknown_ref',
	rate_limited: 'rate_limited',
	auth_failed: 'auth_failed',
	name_reserved: 'name_reserved',
	room_full: 'room_full',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------- client to server (contract 4)

export type HelloAuth = { owner: string } | { cap: string };

/** Exactly one of `replyTo` (a chat request) or `opSeq` (a canvas op). */
export type GuardrailTarget =
	| { replyTo: string; opSeq?: never }
	| { opSeq: number; replyTo?: never };

export type GuardrailRejectedFrame = {
	t: 'guardrail_rejected';
	reason: GuardrailReason;
} & GuardrailTarget;

export type ClientFrame =
	| { t: 'hello'; v: number; room: string; auth: HelloAuth; clientId: string; name: string }
	| { t: 'delta'; iv: string; ct: string; n: number; asBot?: true }
	| { t: 'catchup'; sinceSeq: number }
	| { t: 'chat'; id: string; iv: string; ct: string; toBot: boolean }
	| { t: 'presence'; iv: string; ct: string }
	| { t: 'policy.set'; botPolicy: BotPolicy }
	| { t: 'screening.set'; screening: Screening }
	| { t: 'bot.presence'; agentId: string; name: string; online: boolean }
	| { t: 'bot.progress'; replyTo: string; status: BotProgressStatus }
	| { t: 'bot.reply'; replyTo: string; iv: string; ct: string }
	| { t: 'bot.denied'; replyTo: string }
	| { t: 'bot.failed'; replyTo: string }
	| GuardrailRejectedFrame
	| { t: 'kick'; actorId: string; minutes?: number }
	| { t: 'actor.unlock'; actorId: string }
	| { t: 'cap.unsuspend'; capId: string }
	| { t: 'stats.get' };

export type ClientFrameType = ClientFrame['t'];

// ---------------------------------------------------------------- server to client (contract 5)

/** One stored op, as broadcast in `delta` and paged in `ops`. `ts` is server ms. */
export interface OpItem {
	seq: number;
	actor: SketchActor;
	ts: number;
	iv: string;
	ct: string;
}

/** Hosted spec section 8, `room.stats.actors[]`. */
export interface RoomStatsActor {
	actorId: string;
	kind: SketchActorKind;
	name: string;
	capId?: string;
	capLabel?: string;
	role: SketchRole;
	online: boolean;
	ops: number;
	toBot: number;
	denyStreak: number;
	denialsTotal: number;
	guardrailTotal: number;
	guardrailByReason: { injection: number; other: number };
	/** Y4: screen outages on the conductor's side. Never locks anyone out. */
	unavailableTotal: number;
	lockedOut: boolean;
	lastSeen: number;
}

/** Hosted spec section 8, `room.stats.caps[]`. */
export interface RoomStatsCap {
	capId: string;
	label: string;
	role: SketchLinkRole;
	expiresAt: number | null;
	revoked: boolean;
	botSuspended: boolean;
	guardrailTotal: number;
	online: number;
}

/** Hosted spec section 8 plus X10 `screening` / `screeningSince`. Conductor only. */
export interface RoomStatsFrame {
	t: 'room.stats';
	guestEdited: boolean;
	actors: RoomStatsActor[];
	caps: RoomStatsCap[];
	flaggedActors: string[];
	screening: Screening | null;
	screeningSince: number | null;
}

export interface WelcomeFrame {
	t: 'welcome';
	actor: SketchActor;
	role: SketchRole;
	botPolicy: BotPolicy;
	botOnline: boolean;
	guestEdited: boolean;
	/** Null until the conductor first sends `screening.set` (X10). */
	screening: Screening | null;
	screeningSince: number | null;
	headSeq: number;
	snapshot: { seq: number; key: string } | null;
	keyEpoch: number;
	limits: Readonly<Record<string, number>>;
}

export type ServerFrame =
	| WelcomeFrame
	| { t: 'screening'; screening: Screening; since: number }
	| { t: 'ack'; seq: number }
	| ({ t: 'delta' } & OpItem)
	| { t: 'ops'; items: OpItem[]; more: boolean }
	| ({ t: 'chat'; id: string; toBot: boolean; replyTo?: string } & OpItem)
	| { t: 'bot.status'; replyTo: string; status: BotStatus }
	| ({ t: 'guardrail_rejected'; reason: GuardrailNotice } & GuardrailTarget)
	| RoomStatsFrame
	| { t: 'policy'; botPolicy: BotPolicy }
	| { t: 'presence'; actor: SketchActor; iv: string; ct: string }
	| { t: 'presence.bot'; online: boolean; agentId?: string; name?: string }
	| { t: 'error'; code: ErrorCode; ref?: string };

export type ServerFrameType = ServerFrame['t'];

// ---------------------------------------------------------------- guardrail_rejected builder

/**
 * The only way the desktop builds `guardrail_rejected` (contract section 6,
 * obligation 2). It copies exactly `t`, one target key and `reason`, so a
 * score, an excerpt or ciphertext can never ride along, whatever the caller
 * passes. Throws on a programming error: both or neither target, a bad value,
 * or `screen_unavailable` with `opSeq` (X1: canvas outages are never reported).
 */
export function buildGuardrailRejected(
	target: GuardrailTarget,
	reason: GuardrailReason
): GuardrailRejectedFrame {
	if (reason !== 'injection' && reason !== 'screen_unavailable' && reason !== 'other') {
		throw new Error(`guardrail_rejected: unknown reason ${String(reason)}`);
	}
	const hasReplyTo = target.replyTo !== undefined;
	const hasOpSeq = target.opSeq !== undefined;
	if (hasReplyTo === hasOpSeq) {
		throw new Error('guardrail_rejected needs exactly one of replyTo, opSeq');
	}
	if (hasReplyTo) {
		const replyTo = target.replyTo;
		if (typeof replyTo !== 'string' || replyTo.length === 0 || replyTo.length > MAX_ID_CHARS) {
			throw new Error('guardrail_rejected: replyTo must be a non-empty id');
		}
		return { t: 'guardrail_rejected', replyTo, reason };
	}
	const opSeq = target.opSeq;
	if (typeof opSeq !== 'number' || !Number.isSafeInteger(opSeq) || opSeq < 1) {
		throw new Error('guardrail_rejected: opSeq must be a positive integer');
	}
	if (reason === 'screen_unavailable') {
		throw new Error('guardrail_rejected: screen_unavailable is never sent with opSeq (X1)');
	}
	return { t: 'guardrail_rejected', opSeq, reason };
}

// ---------------------------------------------------------------- server frame parser

export type ServerFrameParseResult =
	| { ok: true; frame: ServerFrame }
	| { ok: false; code: typeof ERROR_CODES.bad_frame; detail: string };

const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
/** The 16-byte GCM tag alone is 22 base64url chars, so a real ciphertext is never shorter. */
const MIN_CT_CHARS = 22;
const GUARDRAIL_FORBIDDEN_FIELDS = ['iv', 'ct', 'score', 'excerpt'] as const;

type Obj = Record<string, unknown>;

class FrameError extends Error {}

function fail(detail: string): never {
	throw new FrameError(detail);
}

function isObj(value: unknown): value is Obj {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(o: Obj, key: string): Obj {
	const value = o[key];
	if (!isObj(value)) fail(`field ${key}`);
	return value;
}

function arr(o: Obj, key: string): unknown[] {
	const value = o[key];
	if (!Array.isArray(value)) fail(`field ${key}`);
	return value;
}

function str(o: Obj, key: string, max = MAX_ID_CHARS, allowEmpty = false): string {
	const value = o[key];
	if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
		fail(`field ${key}`);
	}
	return value;
}

function optStr(o: Obj, key: string, allowEmpty = false): string | undefined {
	return o[key] === undefined ? undefined : str(o, key, MAX_ID_CHARS, allowEmpty);
}

function int(o: Obj, key: string, min = 0): number {
	const value = o[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
		fail(`field ${key}`);
	return value;
}

function nullableInt(o: Obj, key: string): number | null {
	return o[key] === null ? null : int(o, key);
}

function bool(o: Obj, key: string): boolean {
	const value = o[key];
	if (typeof value !== 'boolean') fail(`field ${key}`);
	return value;
}

function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
	const value = o[key];
	if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
		fail(`field ${key}`);
	}
	return value as T;
}

function nullableScreening(o: Obj, key: string): Screening | null {
	return o[key] === null ? null : oneOf(o, key, SCREENINGS);
}

function iv(o: Obj): string {
	const value = o.iv;
	if (typeof value !== 'string' || !IV_RE.test(value)) fail('field iv');
	return value;
}

function ct(o: Obj, max: number): string {
	const value = o.ct;
	if (typeof value !== 'string') fail('field ct');
	if (value.length > max) fail('ct too large');
	// A length of 1 mod 4 never comes out of base64url encoding.
	if (value.length < MIN_CT_CHARS || value.length % 4 === 1 || !B64URL_RE.test(value)) {
		fail('field ct');
	}
	return value;
}

/** Copy the optional string fields that are present, leaving absent keys absent. */
function withOptional<T extends object>(
	target: T,
	o: Obj,
	keys: readonly string[],
	allowEmpty = false
): T {
	for (const key of keys) {
		const value = optStr(o, key, allowEmpty);
		if (value !== undefined) (target as Obj)[key] = value;
	}
	return target;
}

function actor(value: unknown, key = 'actor'): SketchActor {
	if (!isObj(value)) fail(`field ${key}`);
	return withOptional(
		{
			id: str(value, 'id'),
			kind: oneOf(value, 'kind', SKETCH_ACTOR_KINDS),
			name: str(value, 'name', MAX_ID_CHARS, true),
			role: oneOf(value, 'role', SKETCH_ROLES),
		} as SketchActor,
		value,
		['capId', 'capLabel']
	);
}

function opItem(o: Obj, ctMax: number): OpItem {
	return {
		seq: int(o, 'seq', 1),
		actor: actor(o.actor),
		ts: int(o, 'ts'),
		iv: iv(o),
		ct: ct(o, ctMax),
	};
}

function guardrailTarget(o: Obj): GuardrailTarget {
	const hasReplyTo = o.replyTo !== undefined;
	const hasOpSeq = o.opSeq !== undefined;
	if (hasReplyTo === hasOpSeq) fail('guardrail_rejected needs exactly one of replyTo, opSeq');
	return hasReplyTo ? { replyTo: str(o, 'replyTo') } : { opSeq: int(o, 'opSeq', 1) };
}

function roomStatsActor(value: unknown): RoomStatsActor {
	if (!isObj(value)) fail('field actors');
	const byReason = obj(value, 'guardrailByReason');
	return withOptional(
		{
			actorId: str(value, 'actorId'),
			kind: oneOf(value, 'kind', SKETCH_ACTOR_KINDS),
			name: str(value, 'name', MAX_ID_CHARS, true),
			role: oneOf(value, 'role', SKETCH_ROLES),
			online: bool(value, 'online'),
			ops: int(value, 'ops'),
			toBot: int(value, 'toBot'),
			denyStreak: int(value, 'denyStreak'),
			denialsTotal: int(value, 'denialsTotal'),
			guardrailTotal: int(value, 'guardrailTotal'),
			guardrailByReason: { injection: int(byReason, 'injection'), other: int(byReason, 'other') },
			unavailableTotal: int(value, 'unavailableTotal'),
			lockedOut: bool(value, 'lockedOut'),
			lastSeen: int(value, 'lastSeen'),
		} as RoomStatsActor,
		value,
		['capId', 'capLabel']
	);
}

function roomStatsCap(value: unknown): RoomStatsCap {
	if (!isObj(value)) fail('field caps');
	return {
		capId: str(value, 'capId'),
		label: str(value, 'label', MAX_ID_CHARS, true),
		role: oneOf(value, 'role', SKETCH_LINK_ROLES),
		expiresAt: nullableInt(value, 'expiresAt'),
		revoked: bool(value, 'revoked'),
		botSuspended: bool(value, 'botSuspended'),
		guardrailTotal: int(value, 'guardrailTotal'),
		online: int(value, 'online'),
	};
}

function limits(o: Obj): Readonly<Record<string, number>> {
	const raw = obj(o, 'limits');
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== 'number' || !Number.isFinite(value)) fail(`field limits.${key}`);
		out[key] = value;
	}
	return out;
}

function snapshotRef(o: Obj): { seq: number; key: string } | null {
	if (o.snapshot === null) return null;
	const snapshot = obj(o, 'snapshot');
	return { seq: int(snapshot, 'seq'), key: str(snapshot, 'key', MAX_KEY_CHARS) };
}

function build(o: Obj): ServerFrame {
	const t = o.t;
	switch (t) {
		case 'welcome':
			return {
				t,
				actor: actor(o.actor),
				role: oneOf(o, 'role', SKETCH_ROLES),
				botPolicy: oneOf(o, 'botPolicy', BOT_POLICIES),
				botOnline: bool(o, 'botOnline'),
				guestEdited: bool(o, 'guestEdited'),
				screening: nullableScreening(o, 'screening'),
				screeningSince: nullableInt(o, 'screeningSince'),
				headSeq: int(o, 'headSeq'),
				snapshot: snapshotRef(o),
				keyEpoch: int(o, 'keyEpoch'),
				limits: limits(o),
			};
		case 'screening':
			return { t, screening: oneOf(o, 'screening', SCREENINGS), since: int(o, 'since') };
		case 'ack':
			return { t, seq: int(o, 'seq', 1) };
		case 'delta':
			return { t, ...opItem(o, CT_MAX_BYTES.delta) };
		case 'ops':
			return {
				t,
				items: arr(o, 'items').map((item) => {
					if (!isObj(item)) fail('field items');
					return opItem(item, CT_MAX_BYTES.delta);
				}),
				more: bool(o, 'more'),
			};
		case 'chat': {
			const frame: Extract<ServerFrame, { t: 'chat' }> = {
				t,
				id: str(o, 'id'),
				...opItem(o, CT_MAX_BYTES.chat),
				toBot: bool(o, 'toBot'),
			};
			const replyTo = optStr(o, 'replyTo');
			if (replyTo !== undefined) frame.replyTo = replyTo;
			return frame;
		}
		case 'bot.status':
			return { t, replyTo: str(o, 'replyTo'), status: oneOf(o, 'status', BOT_STATUSES) };
		case 'guardrail_rejected':
			for (const key of GUARDRAIL_FORBIDDEN_FIELDS) {
				if (key in o) fail(`guardrail_rejected must not carry ${key}`);
			}
			return { t, ...guardrailTarget(o), reason: oneOf(o, 'reason', GUARDRAIL_NOTICES) };
		case 'room.stats':
			return {
				t,
				guestEdited: bool(o, 'guestEdited'),
				actors: arr(o, 'actors').map(roomStatsActor),
				caps: arr(o, 'caps').map(roomStatsCap),
				flaggedActors: arr(o, 'flaggedActors').map((id) => {
					if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) {
						fail('field flaggedActors');
					}
					return id;
				}),
				screening: nullableScreening(o, 'screening'),
				screeningSince: nullableInt(o, 'screeningSince'),
			};
		case 'policy':
			return { t, botPolicy: oneOf(o, 'botPolicy', BOT_POLICIES) };
		case 'presence':
			return { t, actor: actor(o.actor), iv: iv(o), ct: ct(o, CT_MAX_BYTES.presence) };
		case 'presence.bot': {
			const frame: Extract<ServerFrame, { t: 'presence.bot' }> = { t, online: bool(o, 'online') };
			const agentId = optStr(o, 'agentId');
			if (agentId !== undefined) frame.agentId = agentId;
			const name = optStr(o, 'name', true);
			if (name !== undefined) frame.name = name;
			return frame;
		}
		case 'error':
			return withOptional({ t, code: oneOf(o, 'code', Object.values(ERROR_CODES)) }, o, ['ref']);
		default:
			fail('unknown t');
	}
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Validate one inbound text frame from the room server. Shape only: the
 * result carries exactly the contract's fields (unknown extras are dropped),
 * so callers never read an unvalidated value. Bad input never throws.
 */
export function parseServerFrame(
	raw: string,
	maxBytes: number = MAX_FRAME_BYTES
): ServerFrameParseResult {
	const bad = (detail: string): ServerFrameParseResult => ({
		ok: false,
		code: ERROR_CODES.bad_frame,
		detail,
	});
	if (typeof raw !== 'string') return bad('not text');
	// UTF-8 takes at least one byte per UTF-16 unit and at most three.
	if (raw.length > maxBytes || (raw.length * 3 > maxBytes && utf8Length(raw) > maxBytes)) {
		return bad('frame too large');
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return bad('invalid json');
	}
	if (!isObj(data)) return bad('not an object');
	try {
		return { ok: true, frame: build(data) };
	} catch (err) {
		if (err instanceof FrameError) return bad(err.message);
		throw err;
	}
}
