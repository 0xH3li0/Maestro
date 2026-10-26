/**
 * @file sketch-owner-auth.test.ts
 *
 * Sketch Book owner auth (spec section 6, hosted spec section 4, M1). Properties
 * worth protecting:
 *
 *   - **register() sends a fresh clientToken** to `/api/owners/register` and
 *     stores nothing when the server refuses.
 *   - **Status checks are at least 5 s apart**, however they are called.
 *   - **pending, then confirmed**: the owner token is sealed, never readable on
 *     disk, never logged, never in a status.
 *   - **A token belongs to its server**: the dev override changes where the
 *     desktop asks, and a token from another server is not offered.
 *
 * Every test gets a temp dir, a fake seal, a fake clock and a mocked fetch.
 * Paths are built with `path.join`: the Windows CI leg runs this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(),
}));
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => 'sketch-owner-auth-unused') },
	safeStorage: {
		isEncryptionAvailable: vi.fn(() => false),
		encryptString: vi.fn(),
		decryptString: vi.fn(),
	},
}));
const settings = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => settings.value }),
}));

import {
	configuredSketchServerUrl,
	createSketchOwnerAuth,
	SKETCH_OWNER_FILE,
	type SketchOwnerAuthDeps,
} from '../../../main/sketch/sketch-owner-auth';
import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import {
	OWNER_CLIENT_TOKEN_MAX_CHARS,
	OWNER_CLIENT_TOKEN_MIN_CHARS,
	OWNER_STATUS_MIN_INTERVAL_MS,
	SKETCH_DEFAULT_SERVER_URL,
} from '../../../shared/sketch/server';

const EMAIL = 'Owner@Example.com';
const OWNER_TOKEN = 'A'.repeat(40) + 'b'.repeat(39) + '7';
const DEV_SERVER = 'http://localhost:8787';

/** A reversible seal whose output never contains the plaintext. */
function fakeSeal(available = true): SealProvider & { seal: ReturnType<typeof vi.fn> } {
	const flip = (text: string) => [...text].reverse().join('');
	return {
		available: () => available,
		seal: vi.fn((plaintext: string) => Buffer.from(`sealed:${flip(plaintext)}`, 'utf8')),
		unseal: (blob: Buffer) => flip(blob.toString('utf8').slice('sealed:'.length)),
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

interface Harness {
	auth: ReturnType<typeof createSketchOwnerAuth>;
	/** Every request, as sent. */
	request: ReturnType<typeof vi.fn>;
	/** The server's answers: queue them here. */
	respond: ReturnType<typeof vi.fn>;
	seal: ReturnType<typeof fakeSeal>;
	clock: { now: number };
	/** The clock at each request, by path. */
	requestTimes: { url: string; at: number }[];
	server: { url: string };
}

describe('sketch owner auth', () => {
	let dataDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		settings.value = undefined;
		dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-owner-auth-'));
	});

	afterEach(async () => {
		await fs.rm(dataDir, { recursive: true, force: true });
	});

	function harness(options: { seal?: ReturnType<typeof fakeSeal> } = {}): Harness {
		const clock = { now: 1_000_000 };
		const server = { url: SKETCH_DEFAULT_SERVER_URL };
		const requestTimes: Harness['requestTimes'] = [];
		const respond = vi.fn(async () => json({ success: true, status: 'sent' }));
		const request = vi.fn(async (url: string, init?: RequestInit) => {
			requestTimes.push({ url, at: clock.now });
			return respond(url, init);
		});
		const seal = options.seal ?? fakeSeal();
		let tokens = 0;
		const deps: SketchOwnerAuthDeps = {
			dataDir: () => dataDir,
			osSeal: () => seal,
			serverUrl: () => server.url,
			request: request as unknown as SketchOwnerAuthDeps['request'],
			now: () => clock.now,
			sleep: async (ms) => {
				clock.now += ms;
			},
			newClientToken: () => `client-token-${++tokens}-${'x'.repeat(32)}`,
		};
		return {
			auth: createSketchOwnerAuth(deps),
			request,
			respond,
			seal,
			clock,
			requestTimes,
			server,
		};
	}

	const fileText = () => fs.readFile(path.join(dataDir, SKETCH_OWNER_FILE), 'utf-8');

	/** Everything the logger was given, as one string. */
	const loggedText = () =>
		JSON.stringify(
			[logger.debug, logger.info, logger.warn, logger.error].flatMap((fn) => fn.mock.calls)
		);

	describe('register', () => {
		it('posts the email and a fresh clientToken, then reports pending', async () => {
			const h = harness();
			const result = await h.auth.register(` ${EMAIL} `);

			expect(h.request).toHaveBeenCalledTimes(1);
			const [url, init] = h.request.mock.calls[0];
			expect(url).toBe(`${SKETCH_DEFAULT_SERVER_URL}/api/owners/register`);
			expect(init.method).toBe('POST');
			const body = JSON.parse(init.body);
			expect(body.email).toBe('owner@example.com');
			expect(body.clientToken.length).toBeGreaterThanOrEqual(OWNER_CLIENT_TOKEN_MIN_CHARS);
			expect(body.clientToken.length).toBeLessThanOrEqual(OWNER_CLIENT_TOKEN_MAX_CHARS);

			expect(result.email).toBe('sent');
			expect(result.status).toMatchObject({
				state: 'pending',
				email: 'owner@example.com',
				serverUrl: SKETCH_DEFAULT_SERVER_URL,
				requestedAt: h.clock.now,
				otherServer: false,
			});
			// The clientToken collects the owner token, so it is sealed too.
			expect(await fileText()).not.toContain(body.clientToken);
		});

		it('uses a new clientToken on every registration', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			await h.auth.register(EMAIL);

			const tokens = h.request.mock.calls.map(([, init]) => JSON.parse(init.body).clientToken);
			expect(new Set(tokens).size).toBe(2);
		});

		it('the default clientToken is random and within the server bounds', async () => {
			const h = harness();
			const auth = createSketchOwnerAuth({
				dataDir: () => dataDir,
				osSeal: () => h.seal,
				serverUrl: () => SKETCH_DEFAULT_SERVER_URL,
				request: h.request as unknown as SketchOwnerAuthDeps['request'],
			});
			await auth.register(EMAIL);
			await auth.register(EMAIL);

			const tokens = h.request.mock.calls.map(([, init]) => JSON.parse(init.body).clientToken);
			expect(tokens[0]).not.toBe(tokens[1]);
			for (const token of tokens) {
				expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
				expect(token.length).toBeGreaterThanOrEqual(OWNER_CLIENT_TOKEN_MIN_CHARS);
				expect(token.length).toBeLessThanOrEqual(OWNER_CLIENT_TOKEN_MAX_CHARS);
			}
		});

		it('reports an address that had confirmed before', async () => {
			const h = harness();
			h.respond.mockResolvedValueOnce(json({ success: true, status: 'already_confirmed' }));

			expect((await h.auth.register(EMAIL)).email).toBe('already-confirmed');
		});

		it('refuses a malformed email without asking the server', async () => {
			const h = harness();

			await expect(h.auth.register('not-an-email')).rejects.toMatchObject({
				code: 'invalid-email',
			});
			expect(h.request).not.toHaveBeenCalled();
		});

		it.each([
			[{ success: false, error: 'invalid_email' }, 400, 'invalid-email'],
			[{ success: false, error: 'email_failed' }, 502, 'email-failed'],
			[{ error: 'method_not_allowed' }, 405, 'server'],
		])('a refusal (%j, %i) stores nothing', async (body, status, code) => {
			const h = harness();
			h.respond.mockResolvedValueOnce(json(body, status));

			await expect(h.auth.register(EMAIL)).rejects.toMatchObject({ code, status });
			expect((await h.auth.status()).state).toBe('signed-out');
		});

		it('a refused re-registration keeps the confirmed token', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));
			await h.auth.pollStatus();

			h.respond.mockResolvedValueOnce(json({ success: false, error: 'email_failed' }, 502));
			await expect(h.auth.register(EMAIL)).rejects.toMatchObject({ code: 'email-failed' });

			expect(await h.auth.ownerToken()).toBe(OWNER_TOKEN);
		});
	});

	describe('pollStatus', () => {
		it('polls while pending, then seals the confirmed token', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			const clientToken = JSON.parse(h.request.mock.calls[0][1].body).clientToken;
			h.request
				.mockResolvedValueOnce(json({ status: 'pending' }))
				.mockResolvedValueOnce(json({ status: 'pending' }))
				.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			const status = await h.auth.pollStatus();

			expect(status).toMatchObject({
				state: 'confirmed',
				email: 'owner@example.com',
				serverUrl: SKETCH_DEFAULT_SERVER_URL,
				storage: 'os',
				otherServer: false,
			});
			const polls = h.requestTimes.filter(({ url }) => url.includes('/api/owners/status'));
			expect(polls).toHaveLength(3);
			for (const { url } of polls) {
				expect(url).toBe(
					`${SKETCH_DEFAULT_SERVER_URL}/api/owners/status?clientToken=${encodeURIComponent(clientToken)}`
				);
			}
			// The token went through the OS seal, and only the seal's output is on disk.
			expect(h.seal.seal).toHaveBeenCalledWith(OWNER_TOKEN);
			const text = await fileText();
			expect(text).not.toContain(OWNER_TOKEN);
			expect(text).not.toContain(clientToken);
			expect(JSON.stringify(status)).not.toContain(OWNER_TOKEN);
			expect(await h.auth.ownerToken()).toBe(OWNER_TOKEN);
		});

		it('never asks twice within 5 s, from register onward', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			const registeredAt = h.clock.now;
			h.request
				.mockResolvedValueOnce(json({ status: 'pending' }))
				.mockResolvedValueOnce(json({ status: 'pending' }))
				.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			await h.auth.pollStatus();

			const times = [registeredAt, ...h.requestTimes.slice(1).map(({ at }) => at)];
			for (let i = 1; i < times.length; i++) {
				expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(OWNER_STATUS_MIN_INTERVAL_MS);
			}
		});

		it('spaces direct checkStatus calls the same way', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockImplementation(async () => json({ status: 'pending' }));

			await h.auth.checkStatus();
			await h.auth.checkStatus();

			const [first, second] = h.requestTimes.slice(1);
			expect(second.at - first.at).toBeGreaterThanOrEqual(OWNER_STATUS_MIN_INTERVAL_MS);
		});

		it('never logs the owner token, the clientToken or the email', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			const clientToken = JSON.parse(h.request.mock.calls[0][1].body).clientToken;
			h.request
				.mockRejectedValueOnce(new TypeError('fetch failed'))
				.mockResolvedValueOnce(json({ error: 'internal' }, 503))
				.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			await h.auth.pollStatus();

			expect(logger.info).toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledTimes(2);
			const logged = loggedText();
			expect(logged).not.toContain(OWNER_TOKEN);
			expect(logged).not.toContain(clientToken);
			expect(logged.toLowerCase()).not.toContain('owner@example.com');
		});

		it('asks again after a network failure or a 5xx', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.request
				.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
				.mockResolvedValueOnce(json({ error: 'internal' }, 500))
				.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			expect((await h.auth.pollStatus()).state).toBe('confirmed');
			expect(h.request).toHaveBeenCalledTimes(4);
		});

		it('stops on a 400: the server does not know the clientToken', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ error: 'invalid_client_token' }, 400));

			await expect(h.auth.pollStatus()).rejects.toMatchObject({ code: 'not-registered' });
		});

		it('refuses a malformed token rather than storing it', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: 'short' }));

			await expect(h.auth.pollStatus()).rejects.toMatchObject({ code: 'bad-response' });
			expect(await h.auth.ownerToken()).toBeNull();
			expect((await h.auth.status()).state).toBe('pending');
		});

		it('hands back pending when the time runs out', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockImplementation(async () => json({ status: 'pending' }));

			const status = await h.auth.pollStatus({ timeoutMs: 30_000 });

			expect(status.state).toBe('pending');
			const polls = h.requestTimes.length - 1;
			expect(polls).toBeGreaterThan(0);
			expect(polls).toBeLessThanOrEqual(30_000 / OWNER_STATUS_MIN_INTERVAL_MS);
		});

		it('stops when its signal aborts', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			const controller = new AbortController();
			h.respond.mockImplementation(async () => {
				controller.abort();
				return json({ status: 'pending' });
			});

			await expect(h.auth.pollStatus({ signal: controller.signal })).rejects.toMatchObject({
				code: 'aborted',
			});
		});

		it('returns at once when nothing is pending', async () => {
			const h = harness();

			expect((await h.auth.pollStatus()).state).toBe('signed-out');
			expect(h.request).not.toHaveBeenCalled();
		});

		it('picks a pending registration up after a restart', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			const restarted = createSketchOwnerAuth({
				dataDir: () => dataDir,
				osSeal: () => h.seal,
				serverUrl: () => SKETCH_DEFAULT_SERVER_URL,
				request: h.request as unknown as SketchOwnerAuthDeps['request'],
				now: () => h.clock.now,
				sleep: async (ms) => {
					h.clock.now += ms;
				},
			});
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			expect((await restarted.pollStatus()).state).toBe('confirmed');
			expect(await restarted.ownerToken()).toBe(OWNER_TOKEN);
		});

		it('keeps the token obscured, not readable, where the OS has no key store', async () => {
			const h = harness({ seal: fakeSeal(false) });
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));

			expect(await h.auth.pollStatus()).toMatchObject({ state: 'confirmed', storage: 'obscured' });
			expect(h.seal.seal).not.toHaveBeenCalled();
			expect(await fileText()).not.toContain(OWNER_TOKEN);
			expect(await h.auth.ownerToken()).toBe(OWNER_TOKEN);
		});
	});

	describe('the server', () => {
		it('asks the dev server when one is configured', async () => {
			const h = harness();
			h.server.url = DEV_SERVER;
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));
			await h.auth.pollStatus();

			for (const [url] of h.request.mock.calls) expect(url.startsWith(`${DEV_SERVER}/`)).toBe(true);
		});

		it('polls the server the registration was made on, even after a switch', async () => {
			const h = harness();
			h.server.url = DEV_SERVER;
			await h.auth.register(EMAIL);
			h.server.url = SKETCH_DEFAULT_SERVER_URL;
			h.respond.mockResolvedValueOnce(json({ status: 'pending' }));

			await h.auth.checkStatus();

			expect(h.request.mock.calls[1][0].startsWith(`${DEV_SERVER}/api/owners/status`)).toBe(true);
		});

		it('never offers a token to another server', async () => {
			const h = harness();
			h.server.url = DEV_SERVER;
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));
			await h.auth.pollStatus();

			h.server.url = SKETCH_DEFAULT_SERVER_URL;

			expect(await h.auth.ownerToken()).toBeNull();
			expect(await h.auth.status()).toMatchObject({ state: 'confirmed', otherServer: true });
		});

		it('reads the override from sketchBook.serverUrl, and ignores a bad one', () => {
			expect(configuredSketchServerUrl()).toBe(SKETCH_DEFAULT_SERVER_URL);
			settings.value = { serverUrl: 'http://localhost:8787/' };
			expect(configuredSketchServerUrl()).toBe(DEV_SERVER);
			settings.value = { serverUrl: 'http://evil.example' };
			expect(configuredSketchServerUrl()).toBe(SKETCH_DEFAULT_SERVER_URL);
		});
	});

	describe('signOut', () => {
		it('forgets the registration and the token', async () => {
			const h = harness();
			await h.auth.register(EMAIL);
			h.respond.mockResolvedValueOnce(json({ status: 'confirmed', authToken: OWNER_TOKEN }));
			await h.auth.pollStatus();

			await h.auth.signOut();

			expect(await h.auth.status()).toEqual({
				state: 'signed-out',
				email: null,
				serverUrl: null,
				otherServer: false,
			});
			expect(await h.auth.ownerToken()).toBeNull();
			expect(await fileText()).not.toContain('sealed');
		});
	});
});
