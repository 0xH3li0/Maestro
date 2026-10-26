/**
 * Where the Sketch Book server is, and the owner routes on it (hosted spec
 * section 4, M1).
 *
 * The server is `https://sketch.runmaestro.ai`. `sketchBook.serverUrl` points
 * the desktop at another one, for a local `wrangler dev`; only an `https`
 * origin, or plain `http` on a loopback host, is accepted, so a typo can never
 * send an owner token over the open network.
 *
 * Bundled into the renderer and the CLI, so it imports nothing from Electron
 * or Node.
 */

import type { SecretStorage } from '../secretStorage';

/** The hosted Sketch Book server. */
export const SKETCH_DEFAULT_SERVER_URL = 'https://sketch.runmaestro.ai';

/** The field of the `sketchBook` setting that overrides the server (a dev setting). */
export const SKETCH_SERVER_URL_FIELD = 'serverUrl';

/** Hosted spec section 4: the owner registration routes. */
export const SKETCH_OWNER_ROUTES = {
	register: '/api/owners/register',
	status: '/api/owners/status',
} as const;

/** The server asks the desktop to poll `/api/owners/status` no faster than this. */
export const OWNER_STATUS_MIN_INTERVAL_MS = 5_000;

/** The server accepts a `clientToken` of this many characters. */
export const OWNER_CLIENT_TOKEN_MIN_CHARS = 32;
export const OWNER_CLIENT_TOKEN_MAX_CHARS = 128;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origin of a usable server URL, or null. A URL with a path, a query, a
 * fragment or credentials is refused rather than trimmed: the person meant
 * something we would be guessing at.
 */
export function normalizeSketchServerUrl(raw: unknown): string | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.username || url.password || url.search || url.hash) return null;
	if (url.pathname !== '/' && url.pathname !== '') return null;
	if (url.protocol === 'https:') return url.origin;
	if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
	return null;
}

/** Why `value` cannot be stored as `sketchBook.serverUrl`, or null when it can. */
export function sketchServerUrlProblem(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (normalizeSketchServerUrl(value) !== null) return null;
	return `sketchBook.${SKETCH_SERVER_URL_FIELD} must be an https origin, or http on localhost, with no path (for example http://localhost:8787).`;
}

/** The server to use: the override when it is valid, else the hosted one. */
export function resolveSketchServerUrl(override: unknown): string {
	return normalizeSketchServerUrl(override) ?? SKETCH_DEFAULT_SERVER_URL;
}

/**
 * Wire contract section 1: the room's WebSocket, `wss://<host>/ws/<roomId>`
 * (plain `ws` only for a loopback `http` dev server). `serverUrl` goes through
 * `resolveSketchServerUrl()`, so an unusable override falls back to the hosted
 * server, as every other route does.
 */
export function sketchRoomSocketUrl(serverUrl: unknown, roomId: string): string {
	const origin = resolveSketchServerUrl(serverUrl);
	const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:';
	return `${scheme}${origin.slice(origin.indexOf('//'))}/ws/${encodeURIComponent(roomId)}`;
}

/** Where this device's Sketch Book owner registration stands. */
export type SketchOwnerState = 'signed-out' | 'pending' | 'confirmed';

/** The owner registration as main reports it. Never carries a token. */
export interface SketchOwnerStatus {
	state: SketchOwnerState;
	/** The address the registration was made for, or null when signed out. */
	email: string | null;
	/** The server the registration belongs to, or null when signed out. */
	serverUrl: string | null;
	/** When the confirmation email was asked for (pending only), ms since the epoch. */
	requestedAt?: number;
	/** When the owner token arrived (confirmed only), ms since the epoch. */
	confirmedAt?: number;
	/** How the owner token is kept on disk (confirmed only). */
	storage?: SecretStorage;
	/**
	 * The registration belongs to another server than the one configured now
	 * (`sketchBook.serverUrl` changed), so its token is not used.
	 */
	otherServer: boolean;
}
