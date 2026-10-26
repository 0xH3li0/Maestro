/**
 * Sketch Book plaintext payloads: what sits inside `ct` before encryption,
 * one shape per `kind` (wire contract section 3, X9). The guest web client
 * (`workers/sketch-room/web/src/payloads.ts` in the RunMaestro.ai repo)
 * checks the same shapes, so both sides decode each other's frames.
 *
 * Display names inside payloads are cosmetic: every client shows the
 * server-stamped envelope `actor.name`. Bundled into the renderer and the
 * CLI, so it imports nothing from Electron or Node.
 */

export const PAYLOAD_VERSION = 1;

/** Chat and `bot.reply` text cap, in code points (contract section 3, Y1). */
export const CHAT_MAX_CHARS = 4000;

/**
 * The element fields the wire relies on. Payloads keep every other
 * Excalidraw field as sent; the renderer reads them through its own types.
 */
export interface SketchWireElement {
	id: string;
	version: number;
	isDeleted?: boolean;
	[field: string]: unknown;
}

export interface DeltaPayload {
	v: 1;
	/** Full elements whose `version` changed; deletions carry `isDeleted: true`. */
	elements: SketchWireElement[];
}

export interface SnapshotPayload {
	v: 1;
	type: 'excalidraw';
	elements: SketchWireElement[];
	appState: { viewBackgroundColor: string; gridSize: number | null };
	/** File ids only; each file travels as its own `file` blob. */
	files: string[];
}

export interface FilePayload {
	v: 1;
	id: string;
	mimeType: string;
	dataURL: string;
	created: number;
}

export interface ChatPayload {
	v: 1;
	text: string;
}

export interface BotReplyPayload {
	v: 1;
	text: string;
	/** What the turn changed, for the "show me" link. */
	elementIds?: string[];
}

export interface PresencePayload {
	v: 1;
	pointer?: { x: number; y: number };
	button?: 'down' | 'up';
	selectedElementIds?: string[];
	username?: string;
}

export interface SketchPayloadByKind {
	delta: DeltaPayload;
	snapshot: SnapshotPayload;
	file: FilePayload;
	chat: ChatPayload;
	'bot.reply': BotReplyPayload;
	presence: PresencePayload;
}

/** The plaintext kinds; also the `kind` in the AES-GCM associated data (X8). */
export type SketchPayloadKind = keyof SketchPayloadByKind;

export const SKETCH_PAYLOAD_KINDS: readonly SketchPayloadKind[] = [
	'delta',
	'snapshot',
	'file',
	'chat',
	'bot.reply',
	'presence',
];

export type DecodePayloadResult<K extends SketchPayloadKind> =
	| { ok: true; payload: SketchPayloadByKind[K] }
	| { ok: false; error: string };

type Obj = Record<string, unknown>;

class PayloadError extends Error {}

function fail(detail: string): never {
	throw new PayloadError(detail);
}

function isObj(value: unknown): value is Obj {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Code points, so 4,000 emoji count as 4,000 characters, as on the guest client. */
export function payloadCharCount(text: string): number {
	return Array.from(text).length;
}

function v1(value: unknown): Obj {
	if (!isObj(value) || value.v !== PAYLOAD_VERSION) fail('v must be 1');
	return value;
}

function stringArray(value: unknown, key: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		fail(`field ${key}`);
	}
	return [...value];
}

function nonEmptyString(value: unknown, key: string): string {
	if (typeof value !== 'string' || value.length === 0) fail(`field ${key}`);
	return value;
}

function text(value: unknown): string {
	if (typeof value !== 'string') fail('field text');
	if (payloadCharCount(value) > CHAT_MAX_CHARS) fail(`text over ${CHAT_MAX_CHARS} characters`);
	return value;
}

function element(value: unknown): SketchWireElement {
	if (!isObj(value)) fail('field elements');
	nonEmptyString(value.id, 'elements[].id');
	if (!Number.isSafeInteger(value.version)) fail('field elements[].version');
	if (value.isDeleted !== undefined && typeof value.isDeleted !== 'boolean') {
		fail('field elements[].isDeleted');
	}
	return value as SketchWireElement;
}

function elements(value: unknown): SketchWireElement[] {
	if (!Array.isArray(value)) fail('field elements');
	return value.map(element);
}

/**
 * One validator per kind. Each rebuilds the payload with only the contract's
 * fields; elements stay whole because Excalidraw needs every field.
 */
const VALIDATORS: { [K in SketchPayloadKind]: (value: unknown) => SketchPayloadByKind[K] } = {
	delta(value) {
		const o = v1(value);
		return { v: 1, elements: elements(o.elements) };
	},
	snapshot(value) {
		const o = v1(value);
		if (o.type !== 'excalidraw') fail('type must be excalidraw');
		const appState = o.appState;
		if (!isObj(appState)) fail('field appState');
		if (typeof appState.viewBackgroundColor !== 'string')
			fail('field appState.viewBackgroundColor');
		if (appState.gridSize !== null && !isFiniteNumber(appState.gridSize)) {
			fail('field appState.gridSize');
		}
		return {
			v: 1,
			type: 'excalidraw',
			elements: elements(o.elements),
			appState: {
				viewBackgroundColor: appState.viewBackgroundColor,
				gridSize: appState.gridSize,
			},
			files: stringArray(o.files, 'files'),
		};
	},
	file(value) {
		const o = v1(value);
		if (typeof o.mimeType !== 'string') fail('field mimeType');
		if (typeof o.dataURL !== 'string' || !o.dataURL.startsWith('data:')) fail('field dataURL');
		if (!isFiniteNumber(o.created)) fail('field created');
		return {
			v: 1,
			id: nonEmptyString(o.id, 'id'),
			mimeType: o.mimeType,
			dataURL: o.dataURL,
			created: o.created,
		};
	},
	chat(value) {
		const o = v1(value);
		return { v: 1, text: text(o.text) };
	},
	'bot.reply'(value) {
		const o = v1(value);
		const payload: BotReplyPayload = { v: 1, text: text(o.text) };
		if (o.elementIds !== undefined) payload.elementIds = stringArray(o.elementIds, 'elementIds');
		return payload;
	},
	presence(value) {
		const o = v1(value);
		const payload: PresencePayload = { v: 1 };
		if (o.pointer !== undefined) {
			const pointer = o.pointer;
			if (!isObj(pointer) || !isFiniteNumber(pointer.x) || !isFiniteNumber(pointer.y)) {
				fail('field pointer');
			}
			payload.pointer = { x: pointer.x, y: pointer.y };
		}
		if (o.button !== undefined) {
			if (o.button !== 'down' && o.button !== 'up') fail('field button');
			payload.button = o.button;
		}
		if (o.selectedElementIds !== undefined) {
			payload.selectedElementIds = stringArray(o.selectedElementIds, 'selectedElementIds');
		}
		if (o.username !== undefined) {
			if (typeof o.username !== 'string') fail('field username');
			payload.username = o.username;
		}
		return payload;
	},
};

function validate<K extends SketchPayloadKind>(kind: K, value: unknown): SketchPayloadByKind[K] {
	const validator = VALIDATORS[kind] as ((value: unknown) => SketchPayloadByKind[K]) | undefined;
	if (!validator) fail(`unknown kind ${String(kind)}`);
	return validator(value);
}

/**
 * Serialize a payload for encryption. Validates first, so the desktop never
 * sends a payload the guest client would drop. Throws on an invalid payload:
 * that is a programming error on this side, not bad input.
 */
export function encodePayload<K extends SketchPayloadKind>(
	kind: K,
	payload: SketchPayloadByKind[K]
): string {
	try {
		return JSON.stringify(validate(kind, payload));
	} catch (err) {
		if (err instanceof PayloadError) throw new Error(`Sketch ${kind} payload: ${err.message}`);
		throw err;
	}
}

/**
 * Parse and validate decrypted plaintext of `kind`. A failure means the frame
 * is dropped. The result holds only the contract's fields. Bad input never
 * throws.
 */
export function decodePayload<K extends SketchPayloadKind>(
	kind: K,
	json: string
): DecodePayloadResult<K> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { ok: false, error: 'invalid json' };
	}
	try {
		return { ok: true, payload: validate(kind, value) };
	} catch (err) {
		if (err instanceof PayloadError) return { ok: false, error: err.message };
		throw err;
	}
}
