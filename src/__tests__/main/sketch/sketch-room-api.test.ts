/**
 * The owner's room routes (hosted spec section 5, wire contract section 5a)
 * over a mocked `fetchWithTimeout`: every request carries the owner's Bearer
 * token, JSON routes send JSON, blobs go as raw `application/octet-stream`
 * bytes (Y2), malformed answers and refusals become a `SketchRoomApiError`
 * with the server's code, and a room or link the server no longer knows
 * counts as already gone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/fetchWithTimeout', () => ({
	fetchWithTimeout: vi.fn(),
}));

import {
	createSketchRoomApi,
	isSketchRoomApiError,
	type SketchRoomAuth,
} from '../../../main/sketch/sketch-room-api';
import { FILE_MAX_BYTES, SNAPSHOT_MAX_BYTES } from '../../../shared/sketch/protocol';

const ROOM_ID = 'R'.repeat(22);
const CAP_ID = 'abcDEF123456';
const CAP = 'c'.repeat(43);
const auth: SketchRoomAuth = { serverUrl: 'https://sketch.example', ownerToken: 'T'.repeat(80) };

type Request = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('createSketchRoomApi', () => {
	let request: ReturnType<typeof vi.fn<Request>>;
	let api: ReturnType<typeof createSketchRoomApi>;

	beforeEach(() => {
		request = vi.fn<Request>();
		api = createSketchRoomApi({ request: request as never });
	});

	function call(index = 0): { url: string; init: RequestInit; timeoutMs?: number } {
		const [url, init, timeoutMs] = request.mock.calls[index];
		return { url, init: init ?? {}, timeoutMs };
	}

	function headers(index = 0): Record<string, string> {
		return call(index).init.headers as Record<string, string>;
	}

	it('creates a room with the Bearer token and returns its id', async () => {
		request.mockResolvedValueOnce(json({ roomId: ROOM_ID }, 201));
		await expect(api.createRoom(auth)).resolves.toEqual({ roomId: ROOM_ID });
		expect(call().url).toBe('https://sketch.example/api/rooms');
		expect(call().init.method).toBe('POST');
		expect(headers().Authorization).toBe(`Bearer ${auth.ownerToken}`);
		expect(headers()['Content-Type']).toBe('application/json');
		expect(call().init.body).toBe('{}');
	});

	it('refuses a room id that is not 22 base62 characters', async () => {
		request.mockResolvedValueOnce(json({ roomId: '../x' }, 201));
		await expect(api.createRoom(auth)).rejects.toMatchObject({ code: 'bad-response' });
	});

	it('names the plan limit and a stale sign-in in words a person can act on', async () => {
		request.mockResolvedValueOnce(json({ error: 'room_limit' }, 409));
		const limit = await api.createRoom(auth).catch((error: unknown) => error);
		expect(isSketchRoomApiError(limit) && limit.code).toBe('room_limit');
		expect((limit as Error).message).toMatch(/as many active rooms as your plan allows/);

		request.mockResolvedValueOnce(json({ error: 'unauthorized' }, 401));
		await expect(api.createRoom(auth)).rejects.toThrow(/Sign in again/);
	});

	it('wraps a transport failure without the token', async () => {
		request.mockRejectedValueOnce(new TypeError('fetch failed'));
		const error = await api.createRoom(auth).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'network' });
		expect((error as Error).message).not.toContain(auth.ownerToken);
	});

	it('mints a link with its role, label and expiry, and returns the cap once', async () => {
		request.mockResolvedValueOnce(json({ capId: CAP_ID, cap: CAP, expiresAt: 99 }, 201));
		await expect(
			api.createLink(auth, ROOM_ID, { role: 'ro', label: 'Review', expiresInDays: 3 })
		).resolves.toEqual({ capId: CAP_ID, cap: CAP, expiresAt: 99 });
		expect(call().url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}/links`);
		expect(JSON.parse(call().init.body as string)).toEqual({
			role: 'ro',
			label: 'Review',
			expiresInDays: 3,
		});
	});

	it('leaves the label and expiry out when unset', async () => {
		request.mockResolvedValueOnce(json({ capId: CAP_ID, cap: CAP, expiresAt: 99 }, 201));
		await api.createLink(auth, ROOM_ID, { role: 'rw' });
		expect(JSON.parse(call().init.body as string)).toEqual({ role: 'rw' });
	});

	it('refuses a malformed link answer', async () => {
		request.mockResolvedValueOnce(json({ capId: CAP_ID, cap: 'short', expiresAt: 99 }, 201));
		await expect(api.createLink(auth, ROOM_ID, { role: 'rw' })).rejects.toMatchObject({
			code: 'bad-response',
		});
	});

	it('revokes a link and archives a room, treating 404 as already done', async () => {
		request.mockResolvedValueOnce(json({ ok: true }));
		await api.revokeLink(auth, ROOM_ID, CAP_ID);
		expect(call(0).url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}/links/${CAP_ID}`);
		expect(call(0).init.method).toBe('DELETE');

		request.mockResolvedValueOnce(json({ error: 'not_found' }, 404));
		await expect(api.revokeLink(auth, ROOM_ID, CAP_ID)).resolves.toBeUndefined();

		request.mockResolvedValueOnce(json({ error: 'not_found' }, 404));
		await expect(api.deleteRoom(auth, ROOM_ID)).resolves.toBeUndefined();
		expect(call(2).url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}`);
		expect(call(2).init.method).toBe('DELETE');

		request.mockResolvedValueOnce(json({ error: 'delete_failed' }, 502));
		await expect(api.deleteRoom(auth, ROOM_ID)).rejects.toMatchObject({
			code: 'delete_failed',
			status: 502,
		});
	});

	it('rotates and returns the new key epoch', async () => {
		request.mockResolvedValueOnce(json({ keyEpoch: 3 }));
		await expect(api.rotate(auth, ROOM_ID)).resolves.toEqual({ keyEpoch: 3 });
		expect(call().url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}/rotate`);
		expect(call().init.method).toBe('POST');

		request.mockResolvedValueOnce(json({ keyEpoch: 0 }));
		await expect(api.rotate(auth, ROOM_ID)).rejects.toMatchObject({ code: 'bad-response' });
	});

	it('uploads a snapshot as raw octet-stream bytes with its baseSeq (Y2)', async () => {
		request.mockResolvedValueOnce(json({ seq: 7 }, 201));
		const body = new Uint8Array(64).fill(7);
		await api.putSnapshot(auth, ROOM_ID, 7, body);
		expect(call().url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}/snapshots?baseSeq=7`);
		expect(call().init.method).toBe('PUT');
		expect(headers()['Content-Type']).toBe('application/octet-stream');
		expect(call().init.body).toBe(body);
	});

	it('refuses a snapshot over the cap or under the minimum without a request', async () => {
		await expect(
			api.putSnapshot(auth, ROOM_ID, 0, new Uint8Array(SNAPSHOT_MAX_BYTES + 1))
		).rejects.toMatchObject({ code: 'too-large' });
		await expect(api.putSnapshot(auth, ROOM_ID, 0, new Uint8Array(27))).rejects.toMatchObject({
			code: 'invalid_body',
		});
		expect(request).not.toHaveBeenCalled();
	});

	it('names a stale epoch on a snapshot', async () => {
		request.mockResolvedValueOnce(json({ error: 'stale_epoch' }, 409));
		await expect(api.putSnapshot(auth, ROOM_ID, 0, new Uint8Array(64))).rejects.toMatchObject({
			code: 'stale_epoch',
			status: 409,
		});
	});

	it('uploads a file, and reports one the room holds already as exists', async () => {
		request.mockResolvedValueOnce(json({ fileId: 'f1', bytes: 64 }, 201));
		await expect(api.putFile(auth, ROOM_ID, 'f1', new Uint8Array(64))).resolves.toBe('stored');
		expect(call().url).toBe(`https://sketch.example/api/rooms/${ROOM_ID}/files/f1`);
		expect(headers()['Content-Type']).toBe('application/octet-stream');

		request.mockResolvedValueOnce(json({ error: 'file_exists' }, 409));
		await expect(api.putFile(auth, ROOM_ID, 'f1', new Uint8Array(64))).resolves.toBe('exists');

		request.mockResolvedValueOnce(json({ error: 'files_limit' }, 409));
		await expect(api.putFile(auth, ROOM_ID, 'f2', new Uint8Array(64))).rejects.toMatchObject({
			code: 'files_limit',
		});
	});

	it('refuses a file over the cap without a request', async () => {
		await expect(
			api.putFile(auth, ROOM_ID, 'f1', new Uint8Array(FILE_MAX_BYTES + 1))
		).rejects.toMatchObject({ code: 'too-large' });
		expect(request).not.toHaveBeenCalled();
	});
});
