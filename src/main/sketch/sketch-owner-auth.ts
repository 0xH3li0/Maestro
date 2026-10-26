/**
 * Sketch Book owner auth (spec section 6, hosted spec section 4, M1): the
 * confirm-by-email and poll flow that gives this device an owner token.
 *
 *   register(email)   POST /api/owners/register {email, clientToken} with a
 *                     fresh clientToken. The server mails a confirm link.
 *   pollStatus()      GET /api/owners/status?clientToken= at least
 *                     OWNER_STATUS_MIN_INTERVAL_MS apart until the person
 *                     clicks the link and the server hands the token over,
 *                     exactly once.
 *   ownerToken()      the sealed token, opened, for `hello.auth.owner` and the
 *                     owner HTTP routes.
 *
 * One owner per device, so the state is one private file in Maestro's data
 * folder (`sketch-owner.json`), not part of any sketch. The clientToken is a
 * secret as well (whoever holds it collects the owner token), so both are
 * sealed with `safeStorageSeal()` (obscured where the OS has no key store) and
 * neither is ever written as readable text, logged, or returned in a status.
 *
 * Every request goes through `fetchWithTimeout()` to `https://sketch.runmaestro.ai`,
 * or to `sketchBook.serverUrl` for a local `wrangler dev`. A registration
 * remembers the server it was made on: polling always asks that server, and a
 * token from one server is never offered to another.
 */

import { randomBytes } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { app, safeStorage } from 'electron';

import {
	OWNER_STATUS_MIN_INTERVAL_MS,
	resolveSketchServerUrl,
	SKETCH_OWNER_ROUTES,
	SKETCH_SERVER_URL_FIELD,
	type SketchOwnerStatus,
} from '../../shared/sketch/server';
import { SKETCH_BOOK_SETTINGS_KEY } from '../../shared/sketch/cloud-consent';
import { getSettingsStore } from '../stores/getters';
import { fetchWithTimeout, isFetchTimeoutError } from '../utils/fetchWithTimeout';
import { logger } from '../utils/logger';
import { safeStorageSeal, type SealProvider } from '../utils/safe-storage-seal';
import {
	createPrivateStateFile,
	isStoredSecret,
	sealSecret,
	unsealSecret,
	type StoredSecret,
} from '../utils/sealed-state-file';

const LOG_CONTEXT = 'SketchOwnerAuth';

export const SKETCH_OWNER_FILE = 'sketch-owner.json';

/** One owner request. The server answers fast; a stalled socket must not hang a poll. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How long `pollStatus()` keeps asking before it hands back `pending`. */
export const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

/** The hosted server's shapes (owners.ts): an auth token is 80 base62 chars. */
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9]{80}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why an owner request failed. */
export type SketchOwnerAuthErrorCode =
	| 'invalid-email'
	| 'email-failed'
	| 'not-registered'
	| 'server'
	| 'bad-response'
	| 'aborted';

export class SketchOwnerAuthError extends Error {
	readonly code: SketchOwnerAuthErrorCode;
	/** The HTTP status, when the server answered. */
	readonly status?: number;

	constructor(code: SketchOwnerAuthErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'SketchOwnerAuthError';
		this.code = code;
		if (status !== undefined) this.status = status;
	}
}

export function isSketchOwnerAuthError(error: unknown): error is SketchOwnerAuthError {
	return error instanceof SketchOwnerAuthError;
}

/** What `sketch-owner.json` holds. A state has at most one of `pending` and `confirmed`. */
interface OwnerFileState {
	version: 1;
	email?: string;
	serverUrl?: string;
	pending?: { clientToken: StoredSecret; requestedAt: number };
	confirmed?: { ownerToken: StoredSecret; confirmedAt: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Keep what is usable. A registration without its email and server is no registration. */
function normalizeOwnerFile(raw: unknown): OwnerFileState {
	if (!isRecord(raw) || typeof raw.email !== 'string' || typeof raw.serverUrl !== 'string') {
		return { version: 1 };
	}
	const base = { version: 1 as const, email: raw.email, serverUrl: raw.serverUrl };
	const confirmed = raw.confirmed;
	if (
		isRecord(confirmed) &&
		isStoredSecret(confirmed.ownerToken) &&
		isTime(confirmed.confirmedAt)
	) {
		return {
			...base,
			confirmed: { ownerToken: confirmed.ownerToken, confirmedAt: confirmed.confirmedAt },
		};
	}
	const pending = raw.pending;
	if (isRecord(pending) && isStoredSecret(pending.clientToken) && isTime(pending.requestedAt)) {
		return {
			...base,
			pending: { clientToken: pending.clientToken, requestedAt: pending.requestedAt },
		};
	}
	return { version: 1 };
}

const ownerFile = createPrivateStateFile<OwnerFileState>({
	fileName: SKETCH_OWNER_FILE,
	normalize: normalizeOwnerFile,
	logContext: LOG_CONTEXT,
	whenCorrupt: 'Sketch Book sharing needs the owner email confirmed again',
});

export interface SketchOwnerAuthDeps {
	/** Maestro's data directory. Called on every operation, never cached. */
	dataDir: () => string;
	/** The OS seal. Built lazily: `safeStorage` works only after `ready`. */
	osSeal: () => SealProvider;
	/** The server configured now (`sketchBook.serverUrl`, else the hosted one). */
	serverUrl: () => string;
	request?: typeof fetchWithTimeout;
	now?: () => number;
	/** Waits `ms`, or rejects when `signal` aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	newClientToken?: () => string;
}

export interface SketchOwnerRegistration {
	status: SketchOwnerStatus;
	/** The server's answer: a confirm email went out, or the address had confirmed before. */
	email: 'sent' | 'already-confirmed';
}

export interface PollStatusOptions {
	signal?: AbortSignal;
	/** Give up and return `pending` after this long. Defaults to 15 minutes. */
	timeoutMs?: number;
}

export interface SketchOwnerAuth {
	/** Ask for a confirm email. Replaces any earlier registration once the server accepts. */
	register(email: string): Promise<SketchOwnerRegistration>;
	/** One status check, at least OWNER_STATUS_MIN_INTERVAL_MS after the previous one. */
	checkStatus(signal?: AbortSignal): Promise<SketchOwnerStatus>;
	/** Check until the email is confirmed, the time runs out, or `signal` aborts. */
	pollStatus(options?: PollStatusOptions): Promise<SketchOwnerStatus>;
	status(): Promise<SketchOwnerStatus>;
	/** The owner token for the configured server, or null when there is none. */
	ownerToken(): Promise<string | null>;
	/** Forget the registration and the token on this device. */
	signOut(): Promise<void>;
}

/** A transport failure or a server-side hiccup: worth asking again on the next poll. */
function isTransientFailure(error: unknown): boolean {
	if (isFetchTimeoutError(error) || error instanceof TypeError) return true;
	return (
		isSketchOwnerAuthError(error) &&
		error.code === 'server' &&
		(error.status === undefined || error.status >= 500 || error.status === 429)
	);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return (
		signal?.aborted === true ||
		(error instanceof Error && error.name === 'AbortError') ||
		(error instanceof DOMException && error.name === 'AbortError')
	);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new SketchOwnerAuthError(
			'bad-response',
			'The Sketch Book server sent an answer that is not JSON.',
			res.status
		);
	}
	if (!isRecord(body)) {
		throw new SketchOwnerAuthError(
			'bad-response',
			'The Sketch Book server sent an unexpected answer.',
			res.status
		);
	}
	return body;
}

export function createSketchOwnerAuth(deps: SketchOwnerAuthDeps): SketchOwnerAuth {
	const now = deps.now ?? Date.now;
	const request = deps.request ?? fetchWithTimeout;
	const sleep =
		deps.sleep ??
		(async (ms: number, signal?: AbortSignal) => {
			await delay(ms, undefined, { signal });
		});
	const newClientToken = deps.newClientToken ?? (() => randomBytes(32).toString('base64url'));
	/** When the last status request went out, so two are never closer than the minimum. */
	let lastStatusRequestAt = Number.NEGATIVE_INFINITY;

	function statusOf(state: OwnerFileState): SketchOwnerStatus {
		if (!state.email || !state.serverUrl || (!state.pending && !state.confirmed)) {
			return { state: 'signed-out', email: null, serverUrl: null, otherServer: false };
		}
		const otherServer = state.serverUrl !== deps.serverUrl();
		if (state.confirmed) {
			return {
				state: 'confirmed',
				email: state.email,
				serverUrl: state.serverUrl,
				confirmedAt: state.confirmed.confirmedAt,
				storage: state.confirmed.ownerToken.storage,
				otherServer,
			};
		}
		return {
			state: 'pending',
			email: state.email,
			serverUrl: state.serverUrl,
			requestedAt: state.pending?.requestedAt,
			otherServer,
		};
	}

	async function register(rawEmail: string): Promise<SketchOwnerRegistration> {
		const email = rawEmail.trim().toLowerCase();
		if (!EMAIL_PATTERN.test(email)) {
			throw new SketchOwnerAuthError('invalid-email', 'Enter a valid email address.');
		}
		const serverUrl = deps.serverUrl();
		const clientToken = newClientToken();
		const res = await request(
			`${serverUrl}${SKETCH_OWNER_ROUTES.register}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({ email, clientToken }),
			},
			REQUEST_TIMEOUT_MS
		);
		const body = await readJson(res);
		if (!res.ok) {
			if (body.error === 'invalid_email') {
				throw new SketchOwnerAuthError(
					'invalid-email',
					'The Sketch Book server did not accept that email address.',
					res.status
				);
			}
			if (body.error === 'email_failed') {
				throw new SketchOwnerAuthError(
					'email-failed',
					'The Sketch Book server could not send the confirmation email. Try again later.',
					res.status
				);
			}
			throw new SketchOwnerAuthError(
				'server',
				`The Sketch Book server refused the registration (HTTP ${res.status}).`,
				res.status
			);
		}
		if (body.success !== true) {
			throw new SketchOwnerAuthError(
				'bad-response',
				'The Sketch Book server sent an unexpected answer.',
				res.status
			);
		}

		// Stored only once the server has the clientToken: a refused request
		// leaves the previous registration as it was.
		const sealed = sealSecret(clientToken, deps.osSeal());
		const requestedAt = now();
		const next = await ownerFile.update(deps.dataDir(), async (_current, save) => {
			const state: OwnerFileState = {
				version: 1,
				email,
				serverUrl,
				pending: { clientToken: sealed, requestedAt },
			};
			await save(state);
			return state;
		});
		// The person has to open their email first; the first check waits the minimum too.
		lastStatusRequestAt = requestedAt;
		logger.info('Sketch Book owner confirmation requested', LOG_CONTEXT, { serverUrl });
		return {
			status: statusOf(next),
			email: body.status === 'already_confirmed' ? 'already-confirmed' : 'sent',
		};
	}

	async function checkStatus(signal?: AbortSignal): Promise<SketchOwnerStatus> {
		const state = await ownerFile.read(deps.dataDir());
		const pending = state.pending;
		if (!pending || !state.serverUrl) return statusOf(state);

		const wait = lastStatusRequestAt + OWNER_STATUS_MIN_INTERVAL_MS - now();
		try {
			if (wait > 0) await sleep(wait, signal);
			if (signal?.aborted) throw signal.reason;
		} catch (error) {
			if (isAbort(error, signal)) {
				throw new SketchOwnerAuthError('aborted', 'Stopped waiting for the confirmation.');
			}
			throw error;
		}

		const clientToken = unsealSecret(pending.clientToken, deps.osSeal());
		lastStatusRequestAt = now();
		let res: Response;
		try {
			res = await request(
				`${state.serverUrl}${SKETCH_OWNER_ROUTES.status}?clientToken=${encodeURIComponent(clientToken)}`,
				{ method: 'GET', headers: { Accept: 'application/json' }, signal },
				REQUEST_TIMEOUT_MS
			);
		} catch (error) {
			if (isAbort(error, signal)) {
				throw new SketchOwnerAuthError('aborted', 'Stopped waiting for the confirmation.');
			}
			throw error;
		}
		if (!res.ok) {
			// 400 is the server refusing the clientToken itself: this registration cannot finish.
			throw new SketchOwnerAuthError(
				res.status === 400 ? 'not-registered' : 'server',
				res.status === 400
					? 'The Sketch Book server does not know this registration. Register the email again.'
					: `The Sketch Book server could not report the confirmation (HTTP ${res.status}).`,
				res.status
			);
		}
		const body = await readJson(res);
		if (body.status === 'pending') return statusOf(state);
		if (
			body.status !== 'confirmed' ||
			typeof body.authToken !== 'string' ||
			!OWNER_TOKEN_PATTERN.test(body.authToken)
		) {
			throw new SketchOwnerAuthError(
				'bad-response',
				'The Sketch Book server sent an unexpected answer.',
				res.status
			);
		}

		const sealed = sealSecret(body.authToken, deps.osSeal());
		const confirmedAt = now();
		const next = await ownerFile.update(deps.dataDir(), async (current, save) => {
			// A newer register() replaced this registration while the request was out.
			if (current.pending?.clientToken.sealed !== pending.clientToken.sealed) return current;
			const confirmed: OwnerFileState = {
				version: 1,
				email: current.email,
				serverUrl: current.serverUrl,
				confirmed: { ownerToken: sealed, confirmedAt },
			};
			await save(confirmed);
			return confirmed;
		});
		if (next.confirmed?.confirmedAt === confirmedAt) {
			logger.info('Sketch Book owner email confirmed', LOG_CONTEXT, {
				serverUrl: next.serverUrl,
				storage: sealed.storage,
			});
		}
		return statusOf(next);
	}

	async function pollStatus(options: PollStatusOptions = {}): Promise<SketchOwnerStatus> {
		const deadline = now() + (options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
		for (;;) {
			let current: SketchOwnerStatus;
			try {
				current = await checkStatus(options.signal);
			} catch (error) {
				if (!isTransientFailure(error)) throw error;
				// Never the request URL: it carries the clientToken.
				logger.warn('Sketch Book owner status check failed; asking again', LOG_CONTEXT, {
					reason: isSketchOwnerAuthError(error)
						? `HTTP ${error.status ?? 'unknown'}`
						: isFetchTimeoutError(error)
							? 'timeout'
							: 'network',
				});
				current = statusOf(await ownerFile.read(deps.dataDir()));
			}
			if (current.state !== 'pending') return current;
			if (Math.max(now(), lastStatusRequestAt + OWNER_STATUS_MIN_INTERVAL_MS) > deadline) {
				return current;
			}
		}
	}

	return {
		register,
		checkStatus,
		pollStatus,
		status: async () => statusOf(await ownerFile.read(deps.dataDir())),
		ownerToken: async () => {
			const state = await ownerFile.read(deps.dataDir());
			if (!state.confirmed || state.serverUrl !== deps.serverUrl()) return null;
			return unsealSecret(state.confirmed.ownerToken, deps.osSeal());
		},
		signOut: () =>
			ownerFile.update(deps.dataDir(), async (current, save) => {
				if (current.pending || current.confirmed) await save({ version: 1 });
				lastStatusRequestAt = Number.NEGATIVE_INFINITY;
				logger.info('Sketch Book owner signed out', LOG_CONTEXT);
			}),
	};
}

/** The server configured now, from `sketchBook.serverUrl`. */
export function configuredSketchServerUrl(): string {
	const settings = getSettingsStore().get(SKETCH_BOOK_SETTINGS_KEY) as unknown;
	return resolveSketchServerUrl(isRecord(settings) ? settings[SKETCH_SERVER_URL_FIELD] : undefined);
}

let defaultAuth: SketchOwnerAuth | null = null;

/** The app's owner auth, over `app.getPath('userData')`, the OS seal and the settings. */
export function getSketchOwnerAuth(): SketchOwnerAuth {
	defaultAuth ??= createSketchOwnerAuth({
		dataDir: () => app.getPath('userData'),
		osSeal: () => safeStorageSeal(safeStorage),
		serverUrl: configuredSketchServerUrl,
	});
	return defaultAuth;
}
