/**
 * The owner's HTTP routes on the Sketch Book server (hosted spec section 5,
 * wire contract section 5a): create and archive a room, mint and revoke a
 * link, reset all access, and upload snapshot and file blobs.
 *
 * Every request carries `Authorization: Bearer <ownerToken>` and goes through
 * `fetchWithTimeout()`. Blob bodies are raw `iv || ct` as
 * `application/octet-stream` (Y2), never base64 or JSON. Each failure becomes
 * a {@link SketchRoomApiError} with the server's `{error}` code and a sentence
 * a person can act on. Nothing here logs a token, a cap or a URL that holds
 * one.
 */

import {
	FILE_MAX_BYTES,
	isSketchCap,
	isSketchCapId,
	isSketchRoomId,
	MIN_BLOB_BYTES,
	ROOMS_PATH,
	roomFilePath,
	roomLinkPath,
	roomLinksPath,
	roomPath,
	roomRotatePath,
	SNAPSHOT_MAX_BYTES,
	snapshotUploadPath,
} from '../../shared/sketch/protocol';
import type { SketchLinkRole } from '../../shared/sketch/types';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

/** A JSON route answers fast; a stalled socket must not hang the Collaborate panel. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A snapshot can be 25 MiB on a slow uplink. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Who is asking, and where. The token is the one registered on that server. */
export interface SketchRoomAuth {
	serverUrl: string;
	ownerToken: string;
}

export interface MintedCap {
	capId: string;
	/** The link secret. Returned once by the server; never stored on this side. */
	cap: string;
	expiresAt: number;
}

export interface SketchRoomApi {
	createRoom(auth: SketchRoomAuth, input?: { name?: string }): Promise<{ roomId: string }>;
	/** Archive the room for good. A room already gone counts as done. */
	deleteRoom(auth: SketchRoomAuth, roomId: string): Promise<void>;
	createLink(
		auth: SketchRoomAuth,
		roomId: string,
		input: { role: SketchLinkRole; label?: string; expiresInDays?: number }
	): Promise<MintedCap>;
	/** Revoke one link. A link the server no longer knows counts as revoked. */
	revokeLink(auth: SketchRoomAuth, roomId: string, capId: string): Promise<void>;
	rotate(auth: SketchRoomAuth, roomId: string): Promise<{ keyEpoch: number }>;
	putSnapshot(
		auth: SketchRoomAuth,
		roomId: string,
		baseSeq: number,
		body: Uint8Array<ArrayBuffer>
	): Promise<void>;
	/** `exists` when the room already holds the file (`409 file_exists`). */
	putFile(
		auth: SketchRoomAuth,
		roomId: string,
		fileId: string,
		body: Uint8Array<ArrayBuffer>
	): Promise<'stored' | 'exists'>;
}

export class SketchRoomApiError extends Error {
	/** The server's `{error}` code, or `network` / `bad-response` / `too-large`. */
	readonly code: string;
	readonly status?: number;

	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = 'SketchRoomApiError';
		this.code = code;
		if (status !== undefined) this.status = status;
	}
}

export function isSketchRoomApiError(error: unknown): error is SketchRoomApiError {
	return error instanceof SketchRoomApiError;
}

/** The sentence for a refusal. `what` names the request ("create the room"). */
function refusalMessage(what: string, status: number, code: string | null): string {
	switch (code ?? status) {
		case 'unauthorized':
		case 401:
			return `Could not ${what}: the Sketch Book server did not accept this device's sign-in. Sign in again.`;
		case 'forbidden':
		case 403:
			return `Could not ${what}: the room belongs to another owner.`;
		case 'not_found':
		case 404:
			return `Could not ${what}: the room no longer exists on the server.`;
		case 'room_limit':
			return `Could not ${what}: you already have as many active rooms as your plan allows. Stop sharing one first.`;
		case 'stale_epoch':
			return `Could not ${what}: the room's access was reset meanwhile. Try again.`;
		case 'base_seq_ahead':
			return `Could not ${what}: the snapshot claims ops the room does not have yet.`;
		case 'files_limit':
			return `Could not ${what}: the room holds as many images as it can.`;
		case 'too_large':
		case 413:
			return `Could not ${what}: it is larger than the server accepts.`;
		default:
			return `Could not ${what}: the Sketch Book server answered HTTP ${status}${code ? ` (${code})` : ''}.`;
	}
}

async function errorCode(res: Response): Promise<string | null> {
	try {
		const body: unknown = await res.json();
		if (
			body &&
			typeof body === 'object' &&
			typeof (body as { error?: unknown }).error === 'string'
		) {
			return (body as { error: string }).error;
		}
	} catch {
		// Not JSON: the status alone speaks.
	}
	return null;
}

async function readObject(res: Response, what: string): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new SketchRoomApiError(
			'bad-response',
			`Could not ${what}: the Sketch Book server sent an unexpected answer.`,
			res.status
		);
	}
	return body as Record<string, unknown>;
}

function blobTooLarge(what: string, bytes: number, max: number): SketchRoomApiError {
	const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
	return new SketchRoomApiError(
		'too-large',
		`Could not ${what}: it is ${mib(bytes)} MiB, over the ${mib(max)} MiB the server accepts.`
	);
}

export function createSketchRoomApi(
	deps: { request?: typeof fetchWithTimeout } = {}
): SketchRoomApi {
	const request = deps.request ?? fetchWithTimeout;

	async function call(
		auth: SketchRoomAuth,
		what: string,
		method: string,
		path: string,
		options: { json?: unknown; blob?: Uint8Array<ArrayBuffer>; timeoutMs?: number } = {}
	): Promise<Response> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.ownerToken}`,
			Accept: 'application/json',
		};
		let body: RequestInit['body'];
		if (options.blob) {
			headers['Content-Type'] = 'application/octet-stream';
			body = options.blob;
		} else if (options.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(options.json);
		}
		let res: Response;
		try {
			res = await request(
				`${auth.serverUrl}${path}`,
				{ method, headers, body },
				options.timeoutMs ?? REQUEST_TIMEOUT_MS
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new SketchRoomApiError(
				'network',
				`Could not ${what}: the Sketch Book server did not answer (${reason}).`
			);
		}
		return res;
	}

	async function expectOk(res: Response, what: string): Promise<Response> {
		if (res.ok) return res;
		const code = await errorCode(res);
		throw new SketchRoomApiError(
			code ?? `http-${res.status}`,
			refusalMessage(what, res.status, code),
			res.status
		);
	}

	return {
		async createRoom(auth, input = {}) {
			const what = 'create the room';
			const res = await expectOk(
				await call(auth, what, 'POST', ROOMS_PATH, {
					json: input.name ? { name: input.name } : {},
				}),
				what
			);
			const body = await readObject(res, what);
			if (!isSketchRoomId(body.roomId)) {
				throw new SketchRoomApiError(
					'bad-response',
					`Could not ${what}: the server sent no usable room id.`,
					res.status
				);
			}
			return { roomId: body.roomId };
		},

		async deleteRoom(auth, roomId) {
			const what = 'stop sharing the room';
			const res = await call(auth, what, 'DELETE', roomPath(roomId));
			if (res.status === 404) return;
			await expectOk(res, what);
		},

		async createLink(auth, roomId, input) {
			const what = 'create the link';
			const res = await expectOk(
				await call(auth, what, 'POST', roomLinksPath(roomId), {
					json: {
						role: input.role,
						...(input.label ? { label: input.label } : {}),
						...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
					},
				}),
				what
			);
			const body = await readObject(res, what);
			if (
				!isSketchCapId(body.capId) ||
				!isSketchCap(body.cap) ||
				typeof body.expiresAt !== 'number' ||
				!Number.isFinite(body.expiresAt)
			) {
				throw new SketchRoomApiError(
					'bad-response',
					`Could not ${what}: the server sent no usable link.`,
					res.status
				);
			}
			return { capId: body.capId, cap: body.cap, expiresAt: body.expiresAt };
		},

		async revokeLink(auth, roomId, capId) {
			const what = 'revoke the link';
			const res = await call(auth, what, 'DELETE', roomLinkPath(roomId, capId));
			if (res.status === 404) return;
			await expectOk(res, what);
		},

		async rotate(auth, roomId) {
			const what = 'reset access to the room';
			const res = await expectOk(await call(auth, what, 'POST', roomRotatePath(roomId)), what);
			const body = await readObject(res, what);
			if (!Number.isSafeInteger(body.keyEpoch) || (body.keyEpoch as number) < 1) {
				throw new SketchRoomApiError(
					'bad-response',
					`Could not ${what}: the server sent no usable key epoch.`,
					res.status
				);
			}
			return { keyEpoch: body.keyEpoch as number };
		},

		async putSnapshot(auth, roomId, baseSeq, body) {
			const what = 'upload the snapshot';
			if (body.length > SNAPSHOT_MAX_BYTES)
				throw blobTooLarge(what, body.length, SNAPSHOT_MAX_BYTES);
			if (body.length < MIN_BLOB_BYTES) {
				throw new SketchRoomApiError('invalid_body', `Could not ${what}: the body is too short.`);
			}
			await expectOk(
				await call(auth, what, 'PUT', snapshotUploadPath(roomId, baseSeq), {
					blob: body,
					timeoutMs: UPLOAD_TIMEOUT_MS,
				}),
				what
			);
		},

		async putFile(auth, roomId, fileId, body) {
			const what = 'upload an image';
			if (body.length > FILE_MAX_BYTES) throw blobTooLarge(what, body.length, FILE_MAX_BYTES);
			const res = await call(auth, what, 'PUT', roomFilePath(roomId, fileId), {
				blob: body,
				timeoutMs: UPLOAD_TIMEOUT_MS,
			});
			if (res.status === 409) {
				const code = await errorCode(res);
				if (code === 'file_exists') return 'exists';
				throw new SketchRoomApiError(code ?? 'http-409', refusalMessage(what, 409, code), 409);
			}
			await expectOk(res, what);
			return 'stored';
		},
	};
}
