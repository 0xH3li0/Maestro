/**
 * Tests for the Sketch Book end-to-end crypto (src/shared/sketch/crypto.ts)
 * against the shared interop vectors the hosted guest client also pins
 * (src/__tests__/fixtures/sketch/vectors.json, wire contract section 2, X8,
 * Y2): every vector decrypts to its plaintext and re-encrypts to its
 * ciphertext under its IV, every negative vector fails, a tampered tag or a
 * wrong AAD kind fails, and two encryptions never share an IV.
 */

import { describe, it, expect } from 'vitest';
import {
	decryptPayload,
	decryptPayloadBlob,
	encryptPayload,
	encryptPayloadBlob,
	fromBase64url,
	generateRoomKey,
	importRoomKey,
	IV_BYTES,
	openBytes,
	ROOM_KEY_BYTES,
	sealBytes,
	sketchAad,
	toBase64url,
	type SketchBlobKind,
} from '../../../shared/sketch/crypto';
import { encodePayload, type SketchPayloadKind } from '../../../shared/sketch/payloads';
import vectorFile from '../../fixtures/sketch/vectors.json';

interface Vector {
	kind: SketchPayloadKind;
	key: string;
	iv: string;
	aad: string;
	plaintext: string;
	ct: string;
}

interface NegativeVector {
	name: string;
	key: string;
	iv: string;
	aad: string;
	ct: string;
}

const vectors = vectorFile.vectors as Vector[];
const negatives = vectorFile.negative as NegativeVector[];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BLOB_KINDS: readonly SketchPayloadKind[] = ['snapshot', 'file'];

/** `sketch/v1|<roomId>|<keyEpoch>|<kind>` back to its parts. */
function parseAad(aad: string): { roomId: string; keyEpoch: number; kind: SketchPayloadKind } {
	const [prefix, roomId, epoch, kind] = aad.split('|');
	expect(prefix).toBe('sketch/v1');
	return { roomId, keyEpoch: Number(epoch), kind: kind as SketchPayloadKind };
}

/** A copy of `ct` (base64url) with the last tag byte flipped. */
function flipLastByte(ct: string): string {
	const bytes = fromBase64url(ct);
	bytes[bytes.length - 1] ^= 0x01;
	return toBase64url(bytes);
}

describe('fixture', () => {
	it('carries every vector and negative case', () => {
		expect(vectors.length).toBeGreaterThan(0);
		expect(negatives).toHaveLength(3);
	});
});

describe.each(vectors.map((vector) => [vector.kind, vector] as const))('vector %s', (_, vector) => {
	const { roomId, keyEpoch, kind } = parseAad(vector.aad);

	it('names its own kind in the AAD, byte for byte as sketchAad() builds it', () => {
		expect(kind).toBe(vector.kind);
		expect(decoder.decode(sketchAad(roomId, keyEpoch, kind))).toBe(vector.aad);
	});

	it('opens to its plaintext bytes', async () => {
		const key = await importRoomKey(vector.key);
		const plaintext = await openBytes(
			key,
			encoder.encode(vector.aad),
			fromBase64url(vector.iv),
			fromBase64url(vector.ct)
		);
		expect(decoder.decode(plaintext)).toBe(vector.plaintext);
	});

	it('seals back to its ciphertext under its IV', async () => {
		const key = await importRoomKey(vector.key);
		const sealed = await sealBytes(
			key,
			encoder.encode(vector.aad),
			encoder.encode(vector.plaintext),
			{
				iv: fromBase64url(vector.iv),
			}
		);
		expect(toBase64url(sealed.iv)).toBe(vector.iv);
		expect(toBase64url(sealed.ct)).toBe(vector.ct);
	});

	it('decrypts through the payload codec and encrypts back to the same ciphertext', async () => {
		const key = await importRoomKey(vector.key);
		const result = await decryptPayload(key, kind, roomId, keyEpoch, {
			iv: vector.iv,
			ct: vector.ct,
		});
		if (!result.ok) throw new Error(result.error);
		expect(encodePayload(kind, result.payload)).toBe(vector.plaintext);

		const resealed = await encryptPayload(key, kind, roomId, keyEpoch, result.payload, {
			iv: fromBase64url(vector.iv),
		});
		expect(resealed).toEqual({ iv: vector.iv, ct: vector.ct });
	});

	it('fails with a tampered tag', async () => {
		const key = await importRoomKey(vector.key);
		const result = await decryptPayload(key, kind, roomId, keyEpoch, {
			iv: vector.iv,
			ct: flipLastByte(vector.ct),
		});
		expect(result).toEqual({ ok: false, error: 'decrypt failed' });
	});

	it('fails when opened as another kind', async () => {
		const key = await importRoomKey(vector.key);
		const otherKind: SketchPayloadKind = kind === 'chat' ? 'delta' : 'chat';
		const result = await decryptPayload(key, otherKind, roomId, keyEpoch, {
			iv: vector.iv,
			ct: vector.ct,
		});
		expect(result).toEqual({ ok: false, error: 'decrypt failed' });
	});

	it('fails under another room or key epoch', async () => {
		const key = await importRoomKey(vector.key);
		const sealed = { iv: vector.iv, ct: vector.ct };
		expect((await decryptPayload(key, kind, `${roomId}x`, keyEpoch, sealed)).ok).toBe(false);
		expect((await decryptPayload(key, kind, roomId, keyEpoch + 1, sealed)).ok).toBe(false);
	});

	it('fails under another key', async () => {
		const other = await importRoomKey(generateRoomKey());
		const result = await decryptPayload(other, kind, roomId, keyEpoch, {
			iv: vector.iv,
			ct: vector.ct,
		});
		expect(result.ok).toBe(false);
	});

	if (BLOB_KINDS.includes(kind)) {
		const blobKind = kind as SketchBlobKind;

		it('opens and reseals as a raw iv || ct HTTP body (Y2)', async () => {
			const key = await importRoomKey(vector.key);
			const iv = fromBase64url(vector.iv);
			const ct = fromBase64url(vector.ct);
			const body = new Uint8Array(IV_BYTES + ct.length);
			body.set(iv, 0);
			body.set(ct, IV_BYTES);

			const opened = await decryptPayloadBlob(key, blobKind, roomId, keyEpoch, body);
			if (!opened.ok) throw new Error(opened.error);
			expect(encodePayload(blobKind, opened.payload)).toBe(vector.plaintext);

			const resealed = await encryptPayloadBlob(key, blobKind, roomId, keyEpoch, opened.payload, {
				iv,
			});
			expect(Array.from(resealed)).toEqual(Array.from(body));
			// The same bytes as a bare ArrayBuffer open too.
			expect((await decryptPayloadBlob(key, blobKind, roomId, keyEpoch, body.buffer)).ok).toBe(
				true
			);
		});

		it('rejects a blob with a tampered tag', async () => {
			const key = await importRoomKey(vector.key);
			const ct = fromBase64url(flipLastByte(vector.ct));
			const body = new Uint8Array(IV_BYTES + ct.length);
			body.set(fromBase64url(vector.iv), 0);
			body.set(ct, IV_BYTES);
			expect(await decryptPayloadBlob(key, blobKind, roomId, keyEpoch, body)).toEqual({
				ok: false,
				error: 'decrypt failed',
			});
		});
	}
});

describe.each(negatives.map((negative) => [negative.name, negative] as const))(
	'negative vector: %s',
	(_, negative) => {
		it('fails to open at the byte level', async () => {
			const key = await importRoomKey(negative.key);
			await expect(
				openBytes(
					key,
					encoder.encode(negative.aad),
					fromBase64url(negative.iv),
					fromBase64url(negative.ct)
				)
			).rejects.toThrow();
		});

		it('fails to decrypt as a payload, without throwing', async () => {
			const key = await importRoomKey(negative.key);
			const { roomId, keyEpoch, kind } = parseAad(negative.aad);
			const result = await decryptPayload(key, kind, roomId, keyEpoch, {
				iv: negative.iv,
				ct: negative.ct,
			});
			expect(result).toEqual({ ok: false, error: 'decrypt failed' });
		});
	}
);

describe('fresh IVs', () => {
	it('never shares an IV between two encryptions of the same payload', async () => {
		const key = await importRoomKey(generateRoomKey());
		const payload = { v: 1 as const, text: 'same message every time' };
		const sealed = await Promise.all(
			Array.from({ length: 64 }, () => encryptPayload(key, 'chat', 'room-1', 0, payload))
		);
		const ivs = new Set(sealed.map((s) => s.iv));
		const cts = new Set(sealed.map((s) => s.ct));
		expect(ivs.size).toBe(sealed.length);
		expect(cts.size).toBe(sealed.length);
		for (const s of sealed) expect(fromBase64url(s.iv)).toHaveLength(IV_BYTES);
	});

	it('never shares an IV between two blob bodies', async () => {
		const key = await importRoomKey(generateRoomKey());
		const vector = vectors.find((v) => v.kind === 'snapshot');
		if (!vector) throw new Error('fixture has no snapshot vector');
		const { roomId, keyEpoch } = parseAad(vector.aad);
		const fixtureKey = await importRoomKey(vector.key);
		const opened = await decryptPayload(fixtureKey, 'snapshot', roomId, keyEpoch, vector);
		if (!opened.ok) throw new Error(opened.error);

		const first = await encryptPayloadBlob(key, 'snapshot', roomId, keyEpoch, opened.payload);
		const second = await encryptPayloadBlob(key, 'snapshot', roomId, keyEpoch, opened.payload);
		expect(toBase64url(first.slice(0, IV_BYTES))).not.toBe(toBase64url(second.slice(0, IV_BYTES)));
	});
});

describe('room keys', () => {
	it('generates a 22-character base64url key of 16 bytes', () => {
		const key = generateRoomKey();
		expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(fromBase64url(key)).toHaveLength(ROOM_KEY_BYTES);
		expect(generateRoomKey()).not.toBe(key);
	});

	it('refuses a key of the wrong length or alphabet', async () => {
		await expect(importRoomKey(toBase64url(new Uint8Array(32)))).rejects.toThrow();
		await expect(importRoomKey('not+base64url/key=====')).rejects.toThrow();
	});
});
