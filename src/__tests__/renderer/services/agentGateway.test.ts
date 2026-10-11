/**
 * Tests for the agentGateway service - validating an agent's Local Models
 * gateway and getting it to the main process before the next spawn reads it.
 * Also the Maestro token proxy mode switch, which is the same kind of write:
 * the mode and the gateway URL it implies are stored and flushed together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	flushAgentToStore,
	setAgentGatewayUrl,
	setAgentTokenProxyMode,
} from '../../../renderer/services/agentGateway';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
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

const PROXY_PORT = 48123;
const proxyUrl = (path: string) => `http://127.0.0.1:${PROXY_PORT}${path}`;

/** What `proxy.report()` answers, for a proxy with or without a port. */
function proxyReport(port: number | null) {
	return {
		status: { port, running: false, agentIds: [], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
	};
}

beforeEach(() => {
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	const proxy = window.maestro.localModels.proxy;
	vi.mocked(proxy.ensurePort).mockReset();
	vi.mocked(proxy.ensurePort).mockResolvedValue(PROXY_PORT);
	vi.mocked(proxy.report).mockReset();
	vi.mocked(proxy.report).mockResolvedValue(proxyReport(PROXY_PORT) as never);
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockReset();
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue(null);
	useSettingsStore.setState({ shellEnvVars: {} });
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

describe('setAgentTokenProxyMode', () => {
	it('points the agent at the proxy and stores the mode, in one flushed write', async () => {
		seed();

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result).toEqual({ ok: true, mode: 'compress', gatewayUrl: proxyUrl('/anthropic') });
		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(stored().tokenProxyMode).toBe('compress');
		// The proxy reads the mode from main's store on the next request.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					id: 'agent-1',
					gatewayUrl: proxyUrl('/anthropic'),
					tokenProxyMode: 'compress',
				}),
			],
			[]
		);
	});

	it('replaces a gateway that points somewhere else', async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		await setAgentTokenProxyMode('agent-1', 'passthrough');

		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(stored().tokenProxyMode).toBe('passthrough');
	});

	it('keeps the route of a gateway that is already the proxy, and changes only the mode', async () => {
		// The user picked the API-key route by hand; a mode switch must not undo it.
		seed({ toolType: 'codex', gatewayUrl: proxyUrl('/openai/v1') } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result).toEqual({ ok: true, mode: 'compress', gatewayUrl: proxyUrl('/openai/v1') });
		expect(stored().tokenProxyMode).toBe('compress');
	});

	it('routes Codex by its credential, read from the environment the spawn would use', async () => {
		seed({ toolType: 'codex' } as Partial<Session>);
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/chatgpt'));

		// A key in the provider-level vars is in force when the agent has none.
		seed({ toolType: 'codex' } as Partial<Session>);
		vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue({ OPENAI_API_KEY: 'sk-1' });
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/openai/v1'));
		expect(window.maestro.agents.getCustomEnvVars).toHaveBeenCalledWith('codex');

		// The agent's own vars replace the provider-level set.
		seed({ toolType: 'codex', customEnvVars: { OTHER: '1' } } as Partial<Session>);
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/chatgpt'));

		// A key in Settings -> Environment reaches every agent.
		seed({ toolType: 'codex', customEnvVars: { OTHER: '1' } } as Partial<Session>);
		useSettingsStore.setState({ shellEnvVars: { OPENAI_API_KEY: 'sk-global' } });
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/openai/v1'));
	});

	it('writes nothing when the mode did not change', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result.ok).toBe(true);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('off clears a gateway that is the proxy, and the stored mode with it', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		const result = await setAgentTokenProxyMode('agent-1', 'off');

		expect(result).toEqual({ ok: true, mode: 'off', gatewayUrl: undefined });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(stored().tokenProxyMode).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
		// Turning the proxy off must never be what creates its port.
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
	});

	it("off leaves somebody else's gateway alone", async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentTokenProxyMode('agent-1', 'off');

		expect(result).toEqual({ ok: true, mode: 'off', gatewayUrl: 'http://127.0.0.1:8787' });
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('off changes nothing before the proxy has a port', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(
			proxyReport(null) as never
		);
		seed({ gatewayUrl: proxyUrl('/anthropic') });

		await setAgentTokenProxyMode('agent-1', 'off');

		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
	});

	it('refuses a provider that cannot use a gateway, and chooses no port for it', async () => {
		seed({ toolType: 'copilot-cli' } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('Copilot CLI ignores base-URL variables');
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
		expect(stored().gatewayUrl).toBeUndefined();
	});

	it('refuses an agent on an SSH remote, which cannot reach loopback here', async () => {
		seed({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'passthrough');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('SSH remote');
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('reports an agent that does not exist', async () => {
		seed();
		expect(await setAgentTokenProxyMode('missing', 'compress')).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});
});

describe('setAgentGatewayUrl and the proxy mode', () => {
	it('drops the stored mode when the gateway changes, so it starts from the default', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(stored().tokenProxyMode).toBeUndefined();
	});
});
