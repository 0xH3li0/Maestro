// Covers the sketch_command WebSocket message that backs `maestro-cli sketch`.
// Each action is one SketchService method (the service the `sketch:*` IPC
// handlers call), its fields come from the message, every reply carries the
// request id so the CLI never hangs, and only the CLI's own connection is
// answered: Sketch Book is desktop only (Q13). The sharing verbs name the
// agent caller so the service can raise the desktop confirmation (A1).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const service = {
	newSketch: vi.fn(),
	listSketches: vi.fn(),
	openSketch: vi.fn(),
	readSketch: vi.fn(),
	exportSketch: vi.fn(),
	shareSketch: vi.fn(),
	unshareSketch: vi.fn(),
	revokeSketchLink: vi.fn(),
	rotateSketch: vi.fn(),
	ownerStatus: vi.fn(),
	registerOwner: vi.fn(),
	waitForOwner: vi.fn(),
	signOutOwner: vi.fn(),
};

vi.mock('../../../../main/sketch/sketch-service', () => ({
	getSketchService: () => service,
}));

const consent = {
	status: vi.fn(),
	revokeConsent: vi.fn(),
	requestGrant: vi.fn(),
};

vi.mock('../../../../main/sketch/sketch-cloud-consent', () => ({
	getSketchCloudConsent: () => consent,
}));

vi.mock('../../../../main/stores/getters', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLiveSessions: () => [{ id: 'agent-1', name: 'Builder' }],
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(cli = false): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		...(cli ? { cli: true } : {}),
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';

describe('sketch_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const send = async (message: Record<string, unknown>) => {
		handler.handleMessage(client, { type: 'sketch_command', requestId: 'r1', ...message });
		await flush();
		return lastResponse(client);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		service.newSketch.mockResolvedValue({ record: { sketchId: SKETCH_ID }, tabId: 'tab-1' });
		service.listSketches.mockResolvedValue([]);
		service.openSketch.mockResolvedValue({ record: { sketchId: SKETCH_ID }, tabId: 'tab-1' });
		service.readSketch.mockResolvedValue({ format: 'summary' });
		service.exportSketch.mockResolvedValue({ file: { format: 'json' } });
		consent.status.mockResolvedValue({ consent: {}, rooms: [] });
		consent.revokeConsent.mockResolvedValue({ consent: {}, rooms: [] });
		consent.requestGrant.mockResolvedValue({ consent: { jev: { grantedAt: 1 } }, rooms: [] });
		handler = new WebSocketMessageHandler();
		client = createMockClient(true);
	});

	it('creates a sketch with the agent, name and background bit', async () => {
		const reply = await send({ action: 'new', agentId: 'agent-1', name: 'Plan', background: true });

		expect(service.newSketch).toHaveBeenCalledWith({
			ownerAgentId: 'agent-1',
			name: 'Plan',
			background: true,
		});
		expect(reply).toEqual({
			type: 'sketch_result',
			success: true,
			response: { record: { sketchId: SKETCH_ID }, tabId: 'tab-1' },
			requestId: 'r1',
			timestamp: expect.any(Number),
		});
	});

	it('reads only a literal true as background', async () => {
		await send({ action: 'open', sketchId: SKETCH_ID, background: 'true' });
		expect(service.openSketch).toHaveBeenCalledWith(SKETCH_ID, { background: false });
	});

	it('lists every sketch, or one owner', async () => {
		await send({ action: 'list' });
		expect(service.listSketches).toHaveBeenLastCalledWith(undefined);
		await send({ action: 'list', agentId: 'agent-1' });
		expect(service.listSketches).toHaveBeenLastCalledWith({ ownerAgentId: 'agent-1' });
	});

	it('reads with the summary format unless another is named', async () => {
		await send({ action: 'read', sketchId: SKETCH_ID });
		expect(service.readSketch).toHaveBeenLastCalledWith(SKETCH_ID, 'summary');
		await send({ action: 'read', sketchId: SKETCH_ID, format: 'elements' });
		expect(service.readSketch).toHaveBeenLastCalledWith(SKETCH_ID, 'elements');
	});

	it('exports in the requested format', async () => {
		const reply = await send({ action: 'export', sketchId: SKETCH_ID, format: 'png' });
		expect(service.exportSketch).toHaveBeenCalledWith(SKETCH_ID, 'png');
		expect(reply).toMatchObject({ success: true, response: { file: { format: 'json' } } });
	});

	it('replies with the service refusal, keeping the request id', async () => {
		service.openSketch.mockRejectedValue(new Error('Sketch Book is turned off.'));
		const reply = await send({ action: 'open', sketchId: SKETCH_ID });

		expect(reply).toEqual({
			type: 'sketch_result',
			success: false,
			error: 'Sketch Book is turned off.',
			requestId: 'r1',
			timestamp: expect.any(Number),
		});
	});

	it('reads the screening consent status', async () => {
		const reply = await send({ action: 'screening-consent', op: 'status' });
		expect(consent.status).toHaveBeenCalled();
		expect(reply).toMatchObject({ success: true, response: { consent: {} } });
	});

	it('revokes a consent for the named engine', async () => {
		await send({ action: 'screening-consent', op: 'revoke', engine: 'openjev' });
		expect(consent.revokeConsent).toHaveBeenCalledWith('openjev');
	});

	it('grants for a person directly, and names the agent caller for the desktop confirmation', async () => {
		await send({ action: 'screening-consent', op: 'grant', engine: 'jev' });
		expect(consent.requestGrant).toHaveBeenLastCalledWith('jev', {});

		await send({
			action: 'screening-consent',
			op: 'grant',
			engine: 'jev',
			fromSessionId: 'agent-1',
		});
		expect(consent.requestGrant).toHaveBeenLastCalledWith('jev', { fromAgent: 'Builder' });
	});

	it('refuses a bad screening-consent op or engine', async () => {
		const badOp = await send({ action: 'screening-consent', op: 'allow', engine: 'jev' });
		expect(badOp).toMatchObject({ success: false });
		expect(String(badOp.error)).toContain('grant, revoke or status');

		const badEngine = await send({ action: 'screening-consent', op: 'grant', engine: 'gpt' });
		expect(badEngine).toMatchObject({ success: false });
		expect(String(badEngine.error)).toContain('jev or openjev');
		expect(consent.requestGrant).not.toHaveBeenCalled();
	});

	it('shares with the link options, and names the agent caller for the desktop confirmation', async () => {
		service.shareSketch.mockResolvedValue({ createdRoom: true });
		const reply = await send({
			action: 'share',
			sketchId: SKETCH_ID,
			role: 'ro',
			expiresInDays: 3,
			label: 'Review',
		});
		expect(service.shareSketch).toHaveBeenLastCalledWith(
			SKETCH_ID,
			{ role: 'ro', expiresInDays: 3, label: 'Review' },
			{}
		);
		expect(reply).toMatchObject({ success: true, response: { createdRoom: true } });

		await send({ action: 'share', sketchId: SKETCH_ID, fromSessionId: 'agent-1' });
		expect(service.shareSketch).toHaveBeenLastCalledWith(
			SKETCH_ID,
			{ role: undefined, expiresInDays: undefined, label: undefined },
			{ requestedBy: 'Builder' }
		);
	});

	it('passes unshare, revoke-link and rotate through with the caller', async () => {
		await send({ action: 'unshare', sketchId: SKETCH_ID, fromSessionId: 'agent-1' });
		expect(service.unshareSketch).toHaveBeenCalledWith(SKETCH_ID, { requestedBy: 'Builder' });
		await send({ action: 'revoke-link', sketchId: SKETCH_ID, capId: 'cap-1' });
		expect(service.revokeSketchLink).toHaveBeenCalledWith(SKETCH_ID, 'cap-1', {});
		await send({ action: 'rotate', sketchId: SKETCH_ID, fromSessionId: 'gone-agent' });
		// An agent no longer in the list is named by its id.
		expect(service.rotateSketch).toHaveBeenCalledWith(SKETCH_ID, { requestedBy: 'gone-agent' });
	});

	it('reads, registers (waiting only when asked) and signs out the owner', async () => {
		const pending = { state: 'pending', email: 'a@example.com' };
		const confirmed = { state: 'confirmed', email: 'a@example.com' };
		service.ownerStatus.mockResolvedValue(confirmed);
		service.registerOwner.mockResolvedValue({ status: pending, email: 'sent' });
		service.waitForOwner.mockResolvedValue(confirmed);
		service.signOutOwner.mockResolvedValue({ state: 'signed-out' });

		expect(await send({ action: 'owner', op: 'status' })).toMatchObject({
			response: { status: confirmed },
		});
		expect(await send({ action: 'owner', op: 'register', email: 'a@example.com' })).toMatchObject({
			response: { status: pending, email: 'sent' },
		});
		expect(service.waitForOwner).not.toHaveBeenCalled();
		expect(
			await send({ action: 'owner', op: 'register', email: 'a@example.com', wait: true })
		).toMatchObject({ response: { status: confirmed, email: 'sent' } });
		expect(service.registerOwner).toHaveBeenCalledWith('a@example.com');
		expect(await send({ action: 'owner', op: 'sign-out' })).toMatchObject({
			response: { status: { state: 'signed-out' } },
		});

		const bad = await send({ action: 'owner', op: 'login' });
		expect(bad).toMatchObject({ success: false });
		expect(String(bad.error)).toContain('status, register or sign-out');
	});

	it('refuses an unknown action', async () => {
		const reply = await send({ action: 'kick', sketchId: SKETCH_ID });
		expect(reply).toMatchObject({ success: false, error: 'Unknown Sketch Book action: kick' });
		expect(service.openSketch).not.toHaveBeenCalled();
	});

	it('refuses a browser client before the service is reached', async () => {
		client = createMockClient(false);
		const reply = await send({ action: 'list' });

		expect(reply).toMatchObject({
			success: false,
			error: 'Sketch Book is not available over the web interface',
			requestId: 'r1',
		});
		expect(service.listSketches).not.toHaveBeenCalled();
	});
});
