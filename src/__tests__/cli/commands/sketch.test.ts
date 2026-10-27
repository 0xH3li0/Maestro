/**
 * @file sketch.test.ts
 * @description Tests for `maestro-cli sketch` (spec section 9): each verb sends the
 * `sketch_command` action the SketchService method behind it expects, `new` is
 * background by default and `open` focuses by default, `read` prints a summary or
 * the elements, `export` writes the returned bytes to the resolved `--output` path,
 * the sharing verbs pass an agent caller on (A1: the app confirms on the desktop,
 * so the CLI waits longer) and a person's request goes without one, and bad
 * arguments and app refusals exit with the documented codes. The `@bot` verbs
 * (`requests`, `approve`, `deny`, `escalate`, `publish`, `discard`) send their
 * action with the request id; an agent caller is passed on, and the CLI waits
 * on the desktop confirmation only for approve, escalate and publish (A1).
 * `bot-policy` reads the policy, asks a person at the terminal with the trust
 * warning before `writers`, and passes an agent caller on to the desktop
 * confirmation. The Room panel verbs (`stats`, `kick`, `unlock`, `unsuspend`,
 * `audit`) send their action with the target id, print the room and the
 * audit log, and wait on the desktop confirmation only for an agent's unlock
 * and unsuspend (A1).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	resolveAgentId: vi.fn((agent: string) => `resolved-${agent}`),
	readLiveSessions: vi.fn(() => [{ id: 'resolved-planner', name: 'Planner' }]),
}));

vi.mock('../../../cli/utils/confirm', () => ({
	canPrompt: vi.fn(() => true),
	confirmOnTerminal: vi.fn(async () => true),
}));

import {
	exportFileBytes,
	formatBotRequest,
	formatRoomAudit,
	formatRoomStats,
	formatSketchSummary,
	sketchAudit,
	sketchBotDecision,
	sketchBotPolicy,
	sketchExport,
	sketchKick,
	sketchList,
	sketchNew,
	sketchOpen,
	sketchRead,
	sketchRequests,
	sketchRevokeLink,
	sketchRotate,
	sketchScreeningConsent,
	sketchShare,
	sketchStats,
	sketchUnlock,
	sketchUnshare,
	sketchUnsuspend,
} from '../../../cli/commands/sketch';
import { canPrompt, confirmOnTerminal } from '../../../cli/utils/confirm';
import { CALLER_AGENT_ID_ENV_VAR } from '../../../shared/agentDelegation';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { encoreDisabledMessage } from '../../../shared/encoreFeatureDefaults';
import { summarizeSketchScene } from '../../../shared/sketch/commands';
import type { SketchRecord } from '../../../shared/sketch/types';
import type { SketchBotRequestInfo } from '../../../shared/sketch/bot-requests';
import type { SketchBotPolicyStatus } from '../../../shared/sketch/bot-policy';
import type { SketchRoomAudit, SketchRoomStatsReading } from '../../../shared/sketch/room-admin';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';

const record: SketchRecord = {
	sketchId: SKETCH_ID,
	ownerAgentId: 'resolved-planner',
	name: 'Architecture',
	filePath: path.join('/data', 'sketches', 'resolved-planner', `${SKETCH_ID}.excalidraw`),
	createdAt: Date.now() - 60_000,
	share: null,
	guestEdited: false,
};

function mockReply(reply: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					sent.push({ ...payload, responseType: rt, timeout });
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return sent;
}

const respond = (response: unknown) =>
	mockReply({ type: 'sketch_result', success: true, response });

describe('sketch command', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const errors = () => errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('new', () => {
		it('creates the sketch for the resolved agent in a background tab by default', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', name: '  Architecture  ' });

			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				action: 'new',
				agentId: 'resolved-planner',
				name: 'Architecture',
				background: true,
				responseType: 'sketch_result',
			});
			expect(logged()).toContain('Created sketch "Architecture" on Planner (background tab)');
			expect(logged()).toContain(`Sketch: ${SKETCH_ID}`);
			expect(logged()).toContain('Tab: tab-1');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('shows the sketch with --focus', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', focus: true });

			expect(sent[0]).toMatchObject({ background: false, name: undefined });
			expect(logged()).not.toContain('background tab');
		});

		it('prints the record, tab and placement under --json', async () => {
			respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', json: true });

			expect(json()).toEqual({ success: true, record, tabId: 'tab-1', background: true });
		});

		it('exits with the app refusal, an SSH agent for one', async () => {
			mockReply({
				type: 'sketch_result',
				success: false,
				error: 'Sketch Book runs on local agents only.',
			});
			await expect(sketchNew({ agent: 'planner' })).rejects.toThrow('__exit__');

			expect(errors()).toContain('Sketch Book runs on local agents only.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('gives the app refusal for a turned-off feature the gate code under --json', async () => {
			const message = encoreDisabledMessage('sketchBook');
			mockReply({ type: 'sketch_result', success: false, error: message });
			await expect(sketchNew({ agent: 'planner', json: true })).rejects.toThrow('__exit__');

			expect(json()).toEqual({ success: false, error: message, code: 'SKETCH_BOOK_DISABLED' });
		});
	});

	describe('list', () => {
		it('lists every sketch with its agent name', async () => {
			const sent = respond([record]);
			await sketchList({});

			expect(sent[0]).toMatchObject({ action: 'list', agentId: undefined });
			const out = logged();
			expect(out).toContain('ID');
			expect(out).toContain(SKETCH_ID);
			expect(out).toContain('Architecture');
			expect(out).toContain('Planner');
			expect(out).toContain('local');
		});

		it('filters by the resolved agent and says when it owns nothing', async () => {
			const sent = respond([]);
			await sketchList({ agent: 'planner' });

			expect(sent[0]).toMatchObject({ action: 'list', agentId: 'resolved-planner' });
			expect(logged()).toBe('Planner owns no sketches.');
		});

		it('names a removed owner instead of hiding the sketch', async () => {
			respond([{ ...record, ownerAgentId: 'gone' }]);
			await sketchList({});

			expect(logged()).toContain('(agent removed)');
		});

		it('prints the records under --json', async () => {
			respond([record]);
			await sketchList({ json: true });

			expect(json()).toEqual({ success: true, sketches: [record] });
		});
	});

	describe('open', () => {
		it('focuses the tab by default', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchOpen(` ${SKETCH_ID} `, {});

			expect(sent[0]).toMatchObject({ action: 'open', sketchId: SKETCH_ID, background: false });
			expect(logged()).toContain('Opened sketch "Architecture"');
			expect(logged()).not.toContain('background tab');
		});

		it('adds the tab without moving the view with --background', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchOpen(SKETCH_ID, { background: true });

			expect(sent[0]).toMatchObject({ background: true });
			expect(logged()).toContain('(background tab)');
		});

		it('refuses an empty id as a usage error before the bridge', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await expect(sketchOpen('   ', {})).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('read', () => {
		const scene = {
			type: 'excalidraw' as const,
			version: 2,
			elements: [
				{ id: 'box-a', version: 1, type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
				{ id: 'label-a', version: 1, type: 'text', text: 'API', containerId: 'box-a' },
				{ id: 'box-b', version: 1, type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
				{
					id: 'arrow-1',
					version: 1,
					type: 'arrow',
					x: 100,
					y: 25,
					width: 100,
					height: 0,
					startBinding: { elementId: 'box-a' },
					endBinding: { elementId: 'box-b' },
				},
			],
			appState: {},
			files: {},
		};
		const summary = summarizeSketchScene(scene);

		it('asks for the summary by default and prints shapes and connections', async () => {
			const sent = respond({ record, format: 'summary', summary });
			await sketchRead(SKETCH_ID, {});

			expect(sent[0]).toMatchObject({ action: 'read', sketchId: SKETCH_ID, format: 'summary' });
			const out = logged();
			expect(out).toContain(`Architecture (${SKETCH_ID})`);
			expect(out).toContain('rectangle box-a  "API"');
			expect(out).toContain('API -> ellipse#box-b');
		});

		it('prints the elements as JSON', async () => {
			const elements = scene.elements;
			respond({ record, format: 'elements', elements });
			await sketchRead(SKETCH_ID, { format: 'elements' });

			expect(JSON.parse(logged())).toEqual(elements);
		});

		it('refuses an unknown format as a usage error', async () => {
			const sent = respond({});
			await expect(sketchRead(SKETCH_ID, { format: 'xml' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('--format expects summary or elements');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('formats an empty board without a bounds line', () => {
			const text = formatSketchSummary(record, summarizeSketchScene({ ...scene, elements: [] }));
			expect(text).toContain('0 elements');
			expect(text).not.toContain('Bounds');
		});
	});

	describe('export', () => {
		let dir: string;

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sketch-export-'));
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('writes a base64 PNG to the resolved output path', async () => {
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const output = path.join(dir, 'board.png');
			const sent = respond({
				record,
				file: {
					format: 'png',
					mimeType: 'image/png',
					encoding: 'base64',
					data: png.toString('base64'),
				},
			});
			await sketchExport(SKETCH_ID, { format: 'png', output });

			expect(sent[0]).toMatchObject({ action: 'export', sketchId: SKETCH_ID, format: 'png' });
			expect(sent[0].timeout).toBeGreaterThan(10_000);
			expect(fs.readFileSync(output)).toEqual(png);
			expect(logged()).toContain(`Exported "Architecture" as PNG to ${output}`);
		});

		it('writes UTF-8 text and reports the path and size under --json', async () => {
			const output = path.join(dir, 'board.svg');
			respond({
				record,
				file: { format: 'svg', mimeType: 'image/svg+xml', encoding: 'utf8', data: '<svg>é</svg>' },
			});
			await sketchExport(SKETCH_ID, { format: 'svg', output, json: true });

			expect(fs.readFileSync(output, 'utf8')).toBe('<svg>é</svg>');
			expect(json()).toEqual({
				success: true,
				sketchId: SKETCH_ID,
				format: 'svg',
				mimeType: 'image/svg+xml',
				path: output,
				bytes: Buffer.byteLength('<svg>é</svg>'),
			});
		});

		it('requires a known format and an output path', async () => {
			const sent = respond({});
			await expect(sketchExport(SKETCH_ID, { format: 'gif', output: 'x.gif' })).rejects.toThrow(
				'__exit__'
			);
			await expect(sketchExport(SKETCH_ID, { format: 'png' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('--format expects png, svg or json');
			expect(errors()).toContain('--output <path> is required.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('reports a write failure', async () => {
			respond({
				record,
				file: { format: 'json', mimeType: 'application/json', encoding: 'utf8', data: '{}' },
			});
			const output = path.join(dir, 'missing-folder', 'board.json');
			await expect(sketchExport(SKETCH_ID, { format: 'json', output })).rejects.toThrow('__exit__');

			expect(errors()).toContain(`Could not write ${output}`);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('decodes the file encoding it was given', () => {
			expect(
				exportFileBytes({ format: 'json', mimeType: '', encoding: 'utf8', data: 'ab' })
			).toEqual(Buffer.from('ab'));
			expect(
				exportFileBytes({ format: 'png', mimeType: '', encoding: 'base64', data: 'YWI=' })
			).toEqual(Buffer.from('ab'));
		});
	});

	describe('screening-consent', () => {
		const status = {
			consent: { jev: { grantedAt: Date.now() - 60_000 } },
			source: {
				kind: 'jev',
				locality: 'cloud',
				host: 'api.typesafe.ai',
				label: 'Jev (TypeSafe cloud)',
			},
			sourceCovered: true,
			rooms: [
				{
					sketchId: SKETCH_ID,
					screening: 'cloud',
					liveConfirmed: true,
					serverScreening: 'cloud',
					serverSince: 1,
				},
			],
		};
		let savedCaller: string | undefined;

		beforeEach(() => {
			savedCaller = process.env[CALLER_AGENT_ID_ENV_VAR];
			delete process.env[CALLER_AGENT_ID_ENV_VAR];
			vi.mocked(canPrompt).mockReturnValue(true);
			vi.mocked(confirmOnTerminal).mockResolvedValue(true);
		});

		afterEach(() => {
			if (savedCaller === undefined) delete process.env[CALLER_AGENT_ID_ENV_VAR];
			else process.env[CALLER_AGENT_ID_ENV_VAR] = savedCaller;
		});

		it('prints the status: the screen, each consent and the live rooms', async () => {
			const sent = respond(status);
			await sketchScreeningConsent('status', {});

			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				action: 'screening-consent',
				op: 'status',
			});
			expect(sent[0].engine).toBeUndefined();
			expect(logged()).toContain('Screen: Jev (TypeSafe cloud) (cloud, api.typesafe.ai)');
			expect(logged()).toContain('Consent: OpenJev not granted');
			expect(logged()).toContain('covered by your consent');
			expect(logged()).toContain(`${SKETCH_ID}  cloud, confirmed  (server says cloud)`);
		});

		it('asks a person at the terminal with the disclosure before granting', async () => {
			const sent = respond(status);
			await sketchScreeningConsent('grant', { engine: 'jev' });

			expect(confirmOnTerminal).toHaveBeenCalledWith(
				'Screen Sketch Book guests with Jev (TypeSafe cloud)?'
			);
			expect(logged()).toContain('decrypted guest chat and canvas text');
			expect(sent[0]).toMatchObject({ op: 'grant', engine: 'jev' });
			expect(sent[0].fromSessionId).toBeUndefined();
			expect(logged()).toContain('Cloud screening allowed on Jev (TypeSafe cloud).');
		});

		it('changes nothing when the person declines', async () => {
			vi.mocked(confirmOnTerminal).mockResolvedValue(false);
			const sent = respond(status);
			await expect(sketchScreeningConsent('grant', { engine: 'jev' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('Nothing was changed.');
		});

		it('refuses a grant with no terminal and no --yes, and runs with --yes', async () => {
			vi.mocked(canPrompt).mockReturnValue(false);
			const sent = respond(status);
			await expect(sketchScreeningConsent('grant', { engine: 'jev' })).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);

			await sketchScreeningConsent('grant', { engine: 'jev', yes: true });
			expect(sent[0]).toMatchObject({ op: 'grant', engine: 'jev' });
			expect(confirmOnTerminal).not.toHaveBeenCalled();
		});

		it('sends an agent caller to the desktop confirmation, waiting on the conductor', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respond(status);
			await sketchScreeningConsent('grant', { engine: 'openjev', yes: true });

			expect(confirmOnTerminal).not.toHaveBeenCalled();
			expect(sent[0]).toMatchObject({ op: 'grant', engine: 'openjev', fromSessionId: 'agent-7' });
			expect(sent[0].timeout).toBe(5 * 60_000);
		});

		it('revokes without asking and prints JSON', async () => {
			const sent = respond({ ...status, consent: {} });
			await sketchScreeningConsent('revoke', { engine: 'jev', json: true });

			expect(confirmOnTerminal).not.toHaveBeenCalled();
			expect(sent[0]).toMatchObject({ op: 'revoke', engine: 'jev' });
			expect(json()).toMatchObject({ success: true, op: 'revoke', engine: 'jev', consent: {} });
		});

		it('requires a known op and engine', async () => {
			const sent = respond(status);
			await expect(sketchScreeningConsent('allow', {})).rejects.toThrow('__exit__');
			await expect(sketchScreeningConsent('grant', { engine: 'gpt' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('screening-consent expects grant, revoke or status');
			expect(errors()).toContain('--engine expects jev or openjev');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('sharing', () => {
		const SHARE_TIMEOUT_MS = 4 * 60_000;
		const AGENT_SHARE_TIMEOUT_MS = 5 * 60_000 + SHARE_TIMEOUT_MS;
		const share = {
			roomId: 'R'.repeat(22),
			keyEpoch: 0,
			botPolicy: 'conductor' as const,
			links: [
				{
					capId: 'capid0000001',
					role: 'rw' as const,
					label: '',
					createdAt: 1,
					expiresAt: Date.UTC(2026, 10, 3),
					revoked: false,
				},
			],
		};
		const shared: SketchRecord = { ...record, share };
		const link = {
			capId: 'capid0000001',
			role: 'rw' as const,
			label: 'Team',
			expiresAt: Date.UTC(2026, 10, 3),
			url: `https://sketch.example/s/${share.roomId}#key.cap`,
		};
		let savedCaller: string | undefined;

		beforeEach(() => {
			savedCaller = process.env[CALLER_AGENT_ID_ENV_VAR];
			delete process.env[CALLER_AGENT_ID_ENV_VAR];
		});

		afterEach(() => {
			if (savedCaller === undefined) delete process.env[CALLER_AGENT_ID_ENV_VAR];
			else process.env[CALLER_AGENT_ID_ENV_VAR] = savedCaller;
		});

		it('shares for a person with no caller and prints the link once', async () => {
			const sent = respond({ record: shared, createdRoom: true, link });
			await sketchShare(` ${SKETCH_ID} `, { role: 'rw', expiresDays: '3', label: '  Team  ' });

			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				action: 'share',
				sketchId: SKETCH_ID,
				role: 'rw',
				expiresInDays: 3,
				label: 'Team',
				timeout: SHARE_TIMEOUT_MS,
			});
			expect(sent[0].fromSessionId).toBeUndefined();
			const out = logged();
			expect(out).toContain('Shared "Architecture" (can edit, expires 2026-11-03)');
			expect(out).toContain(`Link: ${link.url}`);
			expect(out).toContain('Link id: capid0000001');
			expect(out.split(link.url)).toHaveLength(2);
		});

		it('says "New link for" when the room already existed, and defaults the role to rw', async () => {
			const sent = respond({ record: shared, createdRoom: false, link });
			await sketchShare(SKETCH_ID, {});

			expect(sent[0]).toMatchObject({ action: 'share', role: 'rw' });
			expect(sent[0].expiresInDays).toBeUndefined();
			expect(sent[0].label).toBeUndefined();
			expect(logged()).toContain('New link for "Architecture"');
		});

		it('passes an agent caller on so the app confirms on the desktop, and waits for it', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respond({ record: shared, createdRoom: true, link });
			await sketchShare(SKETCH_ID, { role: 'ro', json: true });

			expect(sent[0]).toMatchObject({ action: 'share', role: 'ro', fromSessionId: 'agent-7' });
			expect(sent[0].timeout).toBe(AGENT_SHARE_TIMEOUT_MS);
			expect(json()).toEqual({ success: true, record: shared, createdRoom: true, link });
		});

		it('exits with the conductor refusal when the desktop confirmation is denied', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			mockReply({
				type: 'sketch_result',
				success: false,
				error: 'Sketch Book: the conductor chose Deny, so nothing was changed.',
			});
			await expect(sketchShare(SKETCH_ID, {})).rejects.toThrow('__exit__');

			expect(errors()).toContain('the conductor chose Deny');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('refuses a bad role or expiry as a usage error before the bridge', async () => {
			const sent = respond({});
			await expect(sketchShare(SKETCH_ID, { role: 'admin' })).rejects.toThrow('__exit__');
			await expect(sketchShare(SKETCH_ID, { expiresDays: '1.5' })).rejects.toThrow('__exit__');
			await expect(sketchShare(SKETCH_ID, { expiresDays: '0' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('--role expects rw or ro, got "admin"');
			expect(errors()).toContain('--expires-days expects a whole number of days, got "1.5"');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it.each([
			[
				'unshare',
				() => sketchUnshare(SKETCH_ID, {}),
				{ action: 'unshare', sketchId: SKETCH_ID },
				{ ...record, share: null },
				'Stopped sharing "Architecture".',
			],
			[
				'revoke-link',
				() => sketchRevokeLink(SKETCH_ID, ' capid0000001 ', {}),
				{ action: 'revoke-link', sketchId: SKETCH_ID, capId: 'capid0000001' },
				{ ...shared, share: { ...share, links: [{ ...share.links[0], revoked: true }] } },
				'Revoked link capid0000001 on "Architecture". 0 link(s) still work.',
			],
			[
				'rotate',
				() => sketchRotate(SKETCH_ID, {}),
				{ action: 'rotate', sketchId: SKETCH_ID },
				{ ...shared, share: { ...share, keyEpoch: 1 } },
				'under a new key (epoch 1)',
			],
		])('%s runs for a person with no caller', async (_verb, call, payload, reply, message) => {
			const sent = respond(reply);
			await call();

			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				...payload,
				timeout: SHARE_TIMEOUT_MS,
			});
			expect(sent[0].fromSessionId).toBeUndefined();
			expect(logged()).toContain(message);
		});

		it.each([
			['unshare', () => sketchUnshare(SKETCH_ID, {})],
			['revoke-link', () => sketchRevokeLink(SKETCH_ID, 'capid0000001', {})],
			['rotate', () => sketchRotate(SKETCH_ID, {})],
		])('%s passes an agent caller on and waits for the confirmation', async (_verb, call) => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respond(shared);
			await call();

			expect(sent[0]).toMatchObject({ fromSessionId: 'agent-7', timeout: AGENT_SHARE_TIMEOUT_MS });
		});

		it('revoke-link needs a link id', async () => {
			const sent = respond(shared);
			await expect(sketchRevokeLink(SKETCH_ID, '  ', {})).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('A link id is required.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});
	describe('@bot requests', () => {
		const CONFIRM_TIMEOUT_MS = 5 * 60_000;
		const waiting: SketchBotRequestInfo = {
			sketchId: SKETCH_ID,
			replyTo: 'm1',
			actor: {
				id: 'g1',
				kind: 'guest',
				name: 'Sam',
				role: 'rw',
				capId: 'cap-3',
				capLabel: '#3',
			},
			text: 'draw a box',
			ts: Date.now() - 5_000,
			status: 'awaiting_approval',
			verdict: { status: 'clean', score: 0.04, sourceLabel: 'Prompt Guard 2', locality: 'local' },
			posture: 'restricted',
			canEscalate: false,
		};
		let savedCaller: string | undefined;

		beforeEach(() => {
			savedCaller = process.env[CALLER_AGENT_ID_ENV_VAR];
			delete process.env[CALLER_AGENT_ID_ENV_VAR];
		});

		afterEach(() => {
			if (savedCaller === undefined) delete process.env[CALLER_AGENT_ID_ENV_VAR];
			else process.env[CALLER_AGENT_ID_ENV_VAR] = savedCaller;
		});

		it('lists open requests with the actor line and the verdict', async () => {
			const sent = respond([waiting]);
			await sketchRequests({});

			expect(sent[0]).toMatchObject({ type: 'sketch_command', action: 'requests' });
			expect(logged()).toContain('m1  [awaiting approval]  restricted');
			expect(logged()).toContain('"Sam" · guest, read-write link #3, not verified');
			expect(logged()).toContain('"draw a box"');
			expect(logged()).toContain('Screened: clean, Prompt Guard 2, 0.04');
		});

		it('says so when nothing is open', async () => {
			respond([]);
			await sketchRequests({});
			expect(logged()).toBe('No open @bot requests.');
		});

		it('names a conductor message that can run with full access', () => {
			const text = formatBotRequest({
				...waiting,
				actor: { id: 'c1', kind: 'conductor', name: 'Pedram', role: 'conductor' },
				status: 'ended',
				verdict: null,
				canEscalate: true,
			});
			expect(text).toContain('[ended, can run with full access]');
			expect(text).not.toContain('Screened');
		});

		it.each(['approve', 'deny', 'escalate', 'publish', 'discard'] as const)(
			'%s sends the request id for a person, with no caller',
			async (op) => {
				const sent = respond({ ...waiting, status: 'running' });
				await sketchBotDecision(op, ' m1 ', {});

				expect(sent[0]).toMatchObject({ type: 'sketch_command', action: op, replyTo: 'm1' });
				expect(sent[0]).not.toHaveProperty('fromSessionId');
				expect(sent[0].timeout).toBeUndefined();
			}
		);

		it.each([
			['approve', CONFIRM_TIMEOUT_MS],
			['escalate', CONFIRM_TIMEOUT_MS],
			['publish', CONFIRM_TIMEOUT_MS],
			['deny', undefined],
			['discard', undefined],
		] as const)(
			'%s from an agent passes the caller on and waits only on a confirmation',
			async (op, timeout) => {
				process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
				const sent = respond({ ...waiting, status: 'ended' });
				await sketchBotDecision(op, 'm1', {});

				expect(sent[0]).toMatchObject({ action: op, replyTo: 'm1', fromSessionId: 'agent-7' });
				expect(sent[0].timeout).toBe(timeout);
			}
		);

		it('prints the request as JSON with --json', async () => {
			respond({ ...waiting, status: 'running' });
			await sketchBotDecision('approve', 'm1', { json: true });
			expect(json()).toMatchObject({
				success: true,
				op: 'approve',
				request: { replyTo: 'm1', status: 'running' },
			});
		});

		it('needs a request id', async () => {
			const sent = respond(waiting);
			await expect(sketchBotDecision('deny', '  ', {})).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('A request id is required.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('bot-policy', () => {
		const status: SketchBotPolicyStatus = {
			sketchId: SKETCH_ID,
			policy: 'conductor',
			availability: { ok: true },
		};
		let savedCaller: string | undefined;

		/** Answer `read` with the record and `bot-policy` with the status. */
		function respondPolicy(reply: SketchBotPolicyStatus) {
			const sent: Record<string, unknown>[] = [];
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi
						.fn()
						.mockImplementation(
							(payload: Record<string, unknown>, rt: string, timeout?: number) => {
								sent.push({ ...payload, responseType: rt, timeout });
								const response =
									payload.action === 'read' ? { record, format: 'summary', summary: {} } : reply;
								return Promise.resolve({ type: 'sketch_result', success: true, response });
							}
						),
				} as never)
			);
			return sent;
		}

		beforeEach(() => {
			savedCaller = process.env[CALLER_AGENT_ID_ENV_VAR];
			delete process.env[CALLER_AGENT_ID_ENV_VAR];
			vi.mocked(canPrompt).mockReturnValue(true);
			vi.mocked(confirmOnTerminal).mockResolvedValue(true);
		});

		afterEach(() => {
			if (savedCaller === undefined) delete process.env[CALLER_AGENT_ID_ENV_VAR];
			else process.env[CALLER_AGENT_ID_ENV_VAR] = savedCaller;
		});

		it('reads the policy and B2 availability without a policy argument', async () => {
			const sent = respondPolicy({
				...status,
				availability: { ok: false, reason: 'The screen is off.', offerScreenDownload: true },
			});
			await sketchBotPolicy(SKETCH_ID, undefined, {});

			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ action: 'bot-policy', sketchId: SKETCH_ID });
			expect(sent[0]).not.toHaveProperty('policy');
			expect(logged()).toContain('Bot policy: conductor (only you may ask the agent)');
			expect(logged()).toContain(
				'Let collaborators ask the agent: unavailable: The screen is off.'
			);
			expect(logged()).toContain('maestro-cli models install prompt-guard-2-22m');
			expect(confirmOnTerminal).not.toHaveBeenCalled();
		});

		it('asks a person at the terminal with the trust warning before writers', async () => {
			const sent = respondPolicy({ ...status, policy: 'writers' });
			await sketchBotPolicy(SKETCH_ID, 'writers', {});

			expect(confirmOnTerminal).toHaveBeenCalledWith('Let collaborators ask the agent?');
			expect(logged()).toContain('"Architecture"');
			expect(logged()).toContain('press Run');
			const policySent = sent.find((payload) => payload.action === 'bot-policy');
			expect(policySent).toMatchObject({ sketchId: SKETCH_ID, policy: 'writers' });
			expect(policySent).not.toHaveProperty('fromSessionId');
			expect(logged()).toContain('Read-write guests may now ask the agent.');
		});

		it('changes nothing when the person declines', async () => {
			vi.mocked(confirmOnTerminal).mockResolvedValue(false);
			const sent = respondPolicy(status);
			await expect(sketchBotPolicy(SKETCH_ID, 'writers', {})).rejects.toThrow('__exit__');

			expect(sent.some((payload) => payload.action === 'bot-policy')).toBe(false);
			expect(errors()).toContain('Nothing was changed.');
		});

		it('refuses writers with no terminal and no --yes, and runs with --yes', async () => {
			vi.mocked(canPrompt).mockReturnValue(false);
			const sent = respondPolicy({ ...status, policy: 'writers' });
			await expect(sketchBotPolicy(SKETCH_ID, 'writers', {})).rejects.toThrow('__exit__');
			expect(sent).toHaveLength(0);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);

			await sketchBotPolicy(SKETCH_ID, 'writers', { yes: true });
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ action: 'bot-policy', policy: 'writers' });
		});

		it("sends an agent's writers to the desktop confirmation, waiting on the conductor", async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respondPolicy({ ...status, policy: 'writers' });
			await sketchBotPolicy(SKETCH_ID, 'writers', {});

			expect(confirmOnTerminal).not.toHaveBeenCalled();
			expect(sent[0]).toMatchObject({
				action: 'bot-policy',
				policy: 'writers',
				fromSessionId: 'agent-7',
			});
			expect(sent[0].timeout).toBe(5 * 60_000);
		});

		it('runs conductor with no confirmation, from a person or an agent, and prints JSON', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respondPolicy(status);
			await sketchBotPolicy(SKETCH_ID, 'conductor', { json: true });

			expect(confirmOnTerminal).not.toHaveBeenCalled();
			expect(sent[0]).toMatchObject({ action: 'bot-policy', policy: 'conductor' });
			expect(sent[0].timeout).toBeUndefined();
			expect(json()).toMatchObject({ success: true, sketchId: SKETCH_ID, policy: 'conductor' });
		});

		it('requires a known policy and a sketch id', async () => {
			const sent = respondPolicy(status);
			await expect(sketchBotPolicy(SKETCH_ID, 'everyone', {})).rejects.toThrow('__exit__');
			await expect(sketchBotPolicy('  ', 'conductor', {})).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('bot-policy expects conductor or writers');
			expect(errors()).toContain('A sketch id is required.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('room', () => {
		const NOW = Date.UTC(2026, 9, 27);
		const reading: SketchRoomStatsReading = {
			sketchId: SKETCH_ID,
			connection: 'live',
			stats: {
				guestEdited: true,
				actors: [
					{
						actorId: 'guest-1',
						kind: 'guest',
						name: 'Sam',
						capId: 'Cap000000001',
						capLabel: '#3',
						role: 'rw',
						online: true,
						ops: 4,
						toBot: 3,
						denyStreak: 3,
						denialsTotal: 3,
						guardrailTotal: 3,
						guardrailByReason: { injection: 3, other: 0 },
						unavailableTotal: 2,
						lockedOut: true,
						lastSeen: NOW,
					},
				],
				caps: [
					{
						capId: 'Cap000000001',
						label: 'Review',
						role: 'rw',
						expiresAt: NOW + 2 * 86_400_000,
						revoked: false,
						botSuspended: true,
						guardrailTotal: 5,
						online: 1,
					},
				],
				flaggedActors: ['guest-1'],
				screening: 'cloud',
				screeningSince: NOW,
			},
		};
		const audit: SketchRoomAudit = {
			sketchId: SKETCH_ID,
			entries: [
				{
					ts: NOW,
					sketchId: SKETCH_ID,
					subject: { elementId: 'el-1', version: 2 },
					actor: { id: 'guest-1', kind: 'guest', capId: 'Cap000000001' },
					status: 'flagged',
					score: 0.97,
					source: 'Prompt Guard 2 22M',
					locality: 'local',
					reported: true,
				},
			],
			flagged: [
				{
					elementId: 'el-1',
					version: 2,
					actor: { id: 'guest-1', kind: 'guest', capId: 'Cap000000001' },
					score: 0.97,
					source: 'Prompt Guard 2 22M',
					locality: 'local',
					ts: NOW,
				},
			],
		};
		let savedCaller: string | undefined;

		beforeEach(() => {
			savedCaller = process.env[CALLER_AGENT_ID_ENV_VAR];
			delete process.env[CALLER_AGENT_ID_ENV_VAR];
		});

		afterEach(() => {
			if (savedCaller === undefined) delete process.env[CALLER_AGENT_ID_ENV_VAR];
			else process.env[CALLER_AGENT_ID_ENV_VAR] = savedCaller;
		});

		it('formats the room: screening, the Y4 count, members and links', () => {
			const text = formatRoomStats(reading, NOW);
			expect(text).toContain(
				'Room: live. Screening: Cloud screening. A guest has edited the board.'
			);
			expect(text).toContain('Your screen failed 2 guest requests');
			expect(text).toContain(
				'guest-1  "Sam" · guest, read-write link #3, not verified  [online, LOCKED OUT]'
			);
			expect(text).toContain('ops 4, @bot 3, deny streak 3, rejected 3, screen failed 2');
			expect(text).toContain(
				'Cap000000001  Review (can edit)  [@bot suspended, expires 2026-10-29]  1 online, rejected 5'
			);
			expect(formatRoomStats({ sketchId: SKETCH_ID, connection: null, stats: null })).toContain(
				'has not sent room stats yet'
			);
		});

		it('stats sends the sketch id and prints the room, or JSON', async () => {
			const sent = respond(reading);
			await sketchStats(` ${SKETCH_ID} `, {});
			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				action: 'stats',
				sketchId: SKETCH_ID,
			});
			expect(logged()).toContain('Members:');

			logSpy.mockClear();
			respond(reading);
			await sketchStats(SKETCH_ID, { json: true });
			expect(json()).toMatchObject({ success: true, sketchId: SKETCH_ID, connection: 'live' });
		});

		it('kick sends the actor and minutes with no confirmation wait, and says it is temporary', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respond(reading);
			await sketchKick(SKETCH_ID, ' guest-1 ', { minutes: '30' });
			expect(sent[0]).toMatchObject({
				action: 'kick',
				sketchId: SKETCH_ID,
				actorId: 'guest-1',
				minutes: 30,
				fromSessionId: 'agent-7',
			});
			expect(sent[0].timeout).toBeUndefined();
			expect(logged()).toContain('Kick is temporary');
		});

		it('unlock and unsuspend wait on the desktop confirmation for an agent caller', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-7';
			const sent = respond(reading);
			await sketchUnlock(SKETCH_ID, 'guest-1', {});
			await sketchUnsuspend(SKETCH_ID, 'Cap000000001', { json: true });
			expect(sent[0]).toMatchObject({ action: 'unlock', actorId: 'guest-1' });
			expect(sent[0].timeout).toBe(5 * 60_000);
			expect(sent[1]).toMatchObject({ action: 'unsuspend', capId: 'Cap000000001' });
			expect(sent[1]).not.toHaveProperty('actorId');
			expect(sent[1].timeout).toBe(5 * 60_000);
		});

		it('a person unlocks with no caller and no long wait', async () => {
			const sent = respond(reading);
			await sketchUnlock(SKETCH_ID, 'guest-1', {});
			expect(sent[0]).not.toHaveProperty('fromSessionId');
			expect(sent[0].timeout).toBeUndefined();
			expect(logged()).toContain('Unlocked');
		});

		it('refuses a missing target and a kick length that is not a number', async () => {
			const sent = respond(reading);
			await expect(sketchKick(SKETCH_ID, '  ', {})).rejects.toThrow('__exit__');
			await expect(sketchUnsuspend(SKETCH_ID, ' ', {})).rejects.toThrow('__exit__');
			await expect(sketchKick(SKETCH_ID, 'guest-1', { minutes: 'soon' })).rejects.toThrow(
				'__exit__'
			);
			expect(sent).toHaveLength(0);
			expect(errors()).toContain('An actor id is required.');
			expect(errors()).toContain('A link id is required.');
			expect(errors()).toContain('--minutes expects a whole number');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('audit prints every decision, or the flagged elements alone', async () => {
			const sent = respond(audit);
			await sketchAudit(SKETCH_ID, {});
			expect(sent[0]).toMatchObject({ action: 'audit', sketchId: SKETCH_ID });
			expect(logged()).toContain(
				'element el-1 v2  by guest guest-1 (link Cap000000001): Flagged by Prompt Guard 2 22M, 0.97 (on this computer), reported to the room'
			);
			expect(logged()).toContain('1 element(s) withheld as flagged');
			expect(formatRoomAudit(audit, true)).toBe(
				'el-1 v2  by guest guest-1: Flagged by Prompt Guard 2 22M, 0.97 (on this computer)'
			);
			expect(formatRoomAudit({ sketchId: SKETCH_ID, entries: [], flagged: [] })).toBe(
				'The gate has made no decision on this sketch yet.'
			);

			logSpy.mockClear();
			respond(audit);
			await sketchAudit(SKETCH_ID, { flagged: true, json: true });
			expect(json()).toEqual({ success: true, sketchId: SKETCH_ID, flagged: audit.flagged });
		});
	});
});
