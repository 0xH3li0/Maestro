// Covers the open_modal WebSocket message that backs `maestro-cli open`. The
// renderer acts on whatever this hop hands it, so the surface, the tab, and
// whether the surface opens on a group are all refused HERE, by the same
// `resolveUiSurfaceTarget` the CLI ran. A group is passed through as given:
// this hop knows no groups, and the graph falls back to every agent when the
// group is gone.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

/** Flush the promise chain the handler's `.then(...)` reply rides on. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('open_modal handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let openModal: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		openModal = vi.fn().mockResolvedValue(true);
		handler.setCallbacks({ openModal } as never);
	});

	it('opens a surface with no tab and no group', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-1',
			surface: 'delegation-graph',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith({
			surface: 'delegation-graph',
			tab: undefined,
			subTab: undefined,
			group: undefined,
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'open_modal_result',
			success: true,
			requestId: 'req-1',
		});
	});

	it('hands the group to the renderer for the Delegation Graph', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-2',
			// An alias, so the id the renderer gets is the registry's.
			surface: 'delegation',
			group: 'group-1',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'delegation-graph', group: 'group-1' })
		);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'req-2' });
	});

	it('refuses a group on a surface that does not open on one, and opens nothing', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-3',
			surface: 'cue',
			group: 'group-1',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'open_modal_result',
			success: false,
			requestId: 'req-3',
		});
		expect(lastResponse(client).error).toContain('--group does not apply');
	});

	it('reads an empty group as no group', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-4',
			surface: 'cue',
			group: '',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'cue', group: undefined })
		);
	});

	it('still refuses a tab the surface does not have when a group is given', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-5',
			surface: 'delegation-graph',
			tab: 'peers',
			group: 'group-1',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client).error).toContain('has no tabs');
	});
});
