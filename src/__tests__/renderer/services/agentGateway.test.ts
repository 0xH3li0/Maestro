/**
 * Tests for the agentGateway service - validating an agent's Local Models
 * gateway and getting it to the main process before the next spawn reads it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushAgentToStore, setAgentGatewayUrl } from '../../../renderer/services/agentGateway';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}): Session {
	const session = {
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		aiTabs: [],
		...overrides,
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] });
	return session;
}

function stored(): Session {
	return useSessionStore.getState().sessions[0];
}

beforeEach(() => {
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
});

describe('setAgentGatewayUrl', () => {
	it('stores the normalized URL and flushes the agent to main', async () => {
		seed();

		const result = await setAgentGatewayUrl('agent-1', ' http://127.0.0.1:8787/anthropic/ ');

		expect(result).toEqual({ ok: true, gatewayUrl: 'http://127.0.0.1:8787/anthropic' });
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787/anthropic');
		// The desktop spawn reads the gateway from main's store; the debounced
		// persistence would leave it stale for a message sent straight after.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', gatewayUrl: 'http://127.0.0.1:8787/anthropic' })],
			[]
		);
	});

	it.each(['', 'none'])('clears the gateway for %j', async (raw) => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentGatewayUrl('agent-1', raw);

		expect(result).toEqual({ ok: true, gatewayUrl: undefined });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('writes nothing when the value did not change', async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787/');

		expect(result).toEqual({ ok: true, gatewayUrl: 'http://127.0.0.1:8787' });
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a value that is not a URL and leaves the agent alone', async () => {
		seed();

		const result = await setAgentGatewayUrl('agent-1', 'nope');

		expect(result.ok).toBe(false);
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a provider that cannot use a gateway, with the reason', async () => {
		seed({ toolType: 'copilot-cli' } as Partial<Session>);

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining('ignores base-URL variables'),
		});
	});

	it('reports an agent that does not exist', async () => {
		seed();

		expect(await setAgentGatewayUrl('missing', 'http://127.0.0.1:8787')).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});

	it('still reports success when the flush fails: the renderer store holds the value', async () => {
		seed();
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValue(new Error('disk full'));

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(result.ok).toBe(true);
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787');
	});
});

describe('flushAgentToStore', () => {
	it('does nothing for an agent that does not exist', async () => {
		seed();

		await flushAgentToStore('missing');

		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});
});
