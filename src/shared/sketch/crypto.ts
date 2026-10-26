/**
 * Sketch Book end-to-end crypto (wire contract section 2, X8, Y2).
 *
 * AES-GCM-128 with a fresh random 12-byte IV per encryption and the X8
 * associated data `sketch/v1|<roomId>|<keyEpoch>|<kind>`, so a ciphertext
 * opens only as the kind, room and key epoch it was sealed for. The guest
 * client (`workers/sketch-room/web/src/crypto.ts` in the RunMaestro.ai repo)
 * does the same; the shared interop vectors in
 * `src/__tests__/fixtures/sketch/vectors.json` pin both.
 *
 * WebCrypto only (`globalThis.crypto`), so the module runs unchanged in the
 * renderer and in Node 20+. It imports nothing from Electron or Node.
 */

import {
	decodePayload,
	encodePayload,
	type DecodePayloadResult,
	type SketchPayloadByKind,
	type SketchPayloadKind,
} from './payloads';

/** AES-GCM-128: 16 raw key bytes, 22 base64url characters in the link. */
export const ROOM_KEY_BYTES = 16;
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

/** The imported, non-extractable room key. */
export type SketchRoomKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

/** An encrypted frame field pair, both base64url (contract section 1). */
export interface SealedField {
	iv: string;
	ct: string;
}

/** The kinds that travel as HTTP blobs, raw `iv || ct` (Y2). */
export type SketchBlobKind = Extract<SketchPayloadKind, 'snapshot' | 'file'>;

export interface SealOptions {
	/**
	 * Reproduce a test vector only. Production callers never pass this: every
	 * encryption must use a fresh IV, and an IV reused under one key breaks
	 * AES-GCM.
	 */
	iv?: Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------- base64url

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = new Map<string, number>(
	Array.from(B64URL_ALPHABET, (char, index) => [char, index])
);

/** Unpadded base64url, as every encrypted field and the link key use. */
export function toBase64url(bytes: Uint8Array): string {
	let out = '';
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out +=
			B64URL_ALPHABET[(n >> 18) & 63] +
			B64URL_ALPHABET[(n >> 12) & 63] +
			B64URL_ALPHABET[(n >> 6) & 63] +
			B64URL_ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63];
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out +=
			B64URL_ALPHABET[(n >> 18) & 63] +
			B64URL_ALPHABET[(n >> 12) & 63] +
			B64URL_ALPHABET[(n >> 6) & 63];
	}
	return out;
}

/** Strict unpadded base64url. Throws on any other character or an impossible length. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	// A length of 1 mod 4 never comes out of base64url encoding.
	if (text.length % 4 === 1) throw new Error('bad base64url');
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let bits = 0;
	let buffer = 0;
	let o = 0;
	for (const char of text) {
		const value = B64URL_LOOKUP.get(char);
		if (value === undefined) throw new Error('bad base64url');
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (buffer >> bits) & 0xff;
		}
	}
	return out;
}

// ---------------------------------------------------------------- keys and AAD

/**
 * A fresh room key, base64url (22 characters): the `key` part of the share
 * link. Import it with `importRoomKey()` to encrypt.
 */
export function generateRoomKey(): string {
	return toBase64url(globalThis.crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES)));
}

/** The room key from its link form. Not extractable. Throws on a malformed key. */
export async function importRoomKey(encoded: string): Promise<SketchRoomKey> {
	const raw = fromBase64url(encoded);
	if (raw.length !== ROOM_KEY_BYTES) throw new Error(`room key must be ${ROOM_KEY_BYTES} bytes`);
	return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
}

/** X8: the UTF-8 of `sketch/v1|<roomId>|<keyEpoch>|<kind>`. */
export function sketchAad(
	roomId: string,
	keyEpoch: number,
	kind: SketchPayloadKind
): Uint8Array<ArrayBuffer> {
	return encoder.encode(`sketch/v1|${roomId}|${keyEpoch}|${kind}`);
}

function freshIv(): Uint8Array<ArrayBuffer> {
	return globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

// ---------------------------------------------------------------- byte level

/** AES-GCM seal under `aad`. A fresh IV unless `options.iv` reproduces a vector. */
export async function sealBytes(
	key: SketchRoomKey,
	aad: Uint8Array<ArrayBuffer>,
	plaintext: Uint8Array<ArrayBuffer>,
	options: SealOptions = {}
): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
	const iv = options.iv ?? freshIv();
	if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
	const ct = await globalThis.crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		key,
		plaintext
	);
	return { iv, ct: new Uint8Array(ct) };
}

/** AES-GCM open. Throws on a wrong key, a wrong AAD, or any changed byte. */
export async function openBytes(
	key: SketchRoomKey,
	aad: Uint8Array<ArrayBuffer>,
	iv: Uint8Array<ArrayBuffer>,
	ct: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
	if (ct.length < GCM_TAG_BYTES) throw new Error('ciphertext shorter than the tag');
	const plaintext = await globalThis.crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		key,
		ct
	);
	return new Uint8Array(plaintext);
}

/** Decrypted bytes to a payload result. Bad UTF-8 or a bad shape is a dropped frame. */
function decodeOpened<K extends SketchPayloadKind>(
	kind: K,
	plaintext: Uint8Array<ArrayBuffer>
): DecodePayloadResult<K> {
	let json: string;
	try {
		json = decoder.decode(plaintext);
	} catch {
		return { ok: false, error: 'invalid utf-8' };
	}
	return decodePayload(kind, json);
}

// ---------------------------------------------------------------- frame fields

/**
 * Encrypt one plaintext payload for a frame's `iv` / `ct` pair. The payload
 * is validated first (`encodePayload()`), so the desktop never sends what
 * the guest client would drop.
 */
export async function encryptPayload<K extends SketchPayloadKind>(
	key: SketchRoomKey,
	kind: K,
	roomId: string,
	keyEpoch: number,
	payload: SketchPayloadByKind[K],
	options: SealOptions = {}
): Promise<SealedField> {
	const sealed = await sealBytes(
		key,
		sketchAad(roomId, keyEpoch, kind),
		encoder.encode(encodePayload(kind, payload)),
		options
	);
	return { iv: toBase64url(sealed.iv), ct: toBase64url(sealed.ct) };
}

/**
 * Decrypt and validate a frame's `iv` / `ct` pair as `kind`. A failure
 * (malformed field, wrong key or AAD, tampered bytes, bad payload) means
 * the caller drops the frame. Never throws.
 */
export async function decryptPayload<K extends SketchPayloadKind>(
	key: SketchRoomKey,
	kind: K,
	roomId: string,
	keyEpoch: number,
	sealed: SealedField
): Promise<DecodePayloadResult<K>> {
	let plaintext: Uint8Array<ArrayBuffer>;
	try {
		plaintext = await openBytes(
			key,
			sketchAad(roomId, keyEpoch, kind),
			fromBase64url(sealed.iv),
			fromBase64url(sealed.ct)
		);
	} catch {
		return { ok: false, error: 'decrypt failed' };
	}
	return decodeOpened(kind, plaintext);
}

// ---------------------------------------------------------------- HTTP blobs (Y2)

/** A snapshot or file body: raw `iv (12 bytes) || ct`, for `application/octet-stream`. */
export async function encryptPayloadBlob<K extends SketchBlobKind>(
	key: SketchRoomKey,
	kind: K,
	roomId: string,
	keyEpoch: number,
	payload: SketchPayloadByKind[K],
	options: SealOptions = {}
): Promise<Uint8Array<ArrayBuffer>> {
	const sealed = await sealBytes(
		key,
		sketchAad(roomId, keyEpoch, kind),
		encoder.encode(encodePayload(kind, payload)),
		options
	);
	const body = new Uint8Array(IV_BYTES + sealed.ct.length);
	body.set(sealed.iv, 0);
	body.set(sealed.ct, IV_BYTES);
	return body;
}

/** Open a snapshot or file body. Never throws; a failure means the blob is unusable. */
export async function decryptPayloadBlob<K extends SketchBlobKind>(
	key: SketchRoomKey,
	kind: K,
	roomId: string,
	keyEpoch: number,
	body: ArrayBuffer | Uint8Array<ArrayBuffer>
): Promise<DecodePayloadResult<K>> {
	const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
	if (bytes.length < IV_BYTES + GCM_TAG_BYTES) return { ok: false, error: 'blob too short' };
	let plaintext: Uint8Array<ArrayBuffer>;
	try {
		plaintext = await openBytes(
			key,
			sketchAad(roomId, keyEpoch, kind),
			bytes.slice(0, IV_BYTES),
			bytes.slice(IV_BYTES)
		);
	} catch {
		return { ok: false, error: 'decrypt failed' };
	}
	return decodeOpened(kind, plaintext);
}
