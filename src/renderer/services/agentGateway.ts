/**
 * Setting an agent's Local Models gateway from the renderer.
 *
 * One entry for the Local Models gateway table and the Edit Agent dialog, so
 * both validate with `parseGatewayUrlEdit` and both FLUSH. The flush is the
 * part that is easy to skip and fails silently: the desktop spawn reads an
 * agent's gateway from the main-process sessions store, and the renderer's
 * ordinary persistence is debounced by two seconds, so a gateway that was only
 * written to the renderer store is not in force for a message sent straight
 * after it. A turn the user believes is proxied would go direct.
 *
 * `setAgentTokenProxyMode` is the same kind of write for the Maestro token
 * proxy: `off | passthrough | compress`. Turning the proxy on IS setting the
 * agent's gateway to the proxy's address, and turning it off is clearing that
 * gateway, so the mode and the URL are written together and flushed together.
 * The server reads the mode from the main-process store on every request.
 */

import { agentGatewaySupport, parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import {
	gatewayPointsAtTokenProxy,
	TOKEN_PROXY_NAME,
	tokenProxyGatewayUrl,
	tokenProxyRouteForAgent,
	type TokenProxyMode,
} from '../../shared/local-models/token-proxy';
import { effectiveAgentCustomEnvVars } from '../../shared/providerProfiles';
import { useSettingsStore } from '../stores/settingsStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { logger } from '../utils/logger';

export type SetAgentGatewayResult =
	| { ok: true; gatewayUrl: string | undefined }
	| { ok: false; error: string };

/**
 * Write the main-process copy of one agent now. Never throws: the renderer
 * store already holds the value and the debounced flush will follow.
 */
export async function flushAgentToStore(sessionId: string): Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return;
	try {
		await window.maestro.sessions.setMany([session as any], []);
	} catch (err) {
		logger.error('[AgentGateway] Failed to persist agent gateway', undefined, err);
	}
}

/**
 * Validate and store an agent's gateway. Blank or `none` clears it. Resolves
 * once main holds the new value, so the next spawn uses it.
 */
export async function setAgentGatewayUrl(
	sessionId: string,
	raw: string
): Promise<SetAgentGatewayResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };

	const edit = parseGatewayUrlEdit(session.toolType, raw);
	if (!edit.ok) return edit;

	const gatewayUrl = edit.gatewayUrl ?? undefined;
	if (gatewayUrl === session.gatewayUrl) return { ok: true, gatewayUrl };

	// A proxy mode describes the gateway it was chosen for. A different gateway
	// starts from the default, so compression is never carried onto a URL the
	// user typed afterwards.
	updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, tokenProxyMode: undefined }));
	await flushAgentToStore(sessionId);
	return { ok: true, gatewayUrl };
}

export type SetAgentTokenProxyModeResult =
	| { ok: true; mode: TokenProxyMode; gatewayUrl: string | undefined }
	| { ok: false; error: string };

/** The agent's effective environment, merged the way the desktop spawn merges it. */
async function agentEffectiveEnv(session: Session): Promise<Record<string, string>> {
	let providerVars: Record<string, string> | null = null;
	try {
		providerVars = (await window.maestro.agents?.getCustomEnvVars?.(session.toolType)) ?? null;
	} catch {
		// Without the provider-level vars the agent's own still decide the route.
	}
	return {
		...(useSettingsStore.getState().shellEnvVars ?? {}),
		...(effectiveAgentCustomEnvVars(session.customEnvVars, providerVars ?? undefined) ?? {}),
	};
}

/**
 * Set how the Maestro token proxy carries one agent's requests.
 *
 * - `off` clears the agent's gateway when it is the proxy. A gateway that
 *   points somewhere else (Headroom, LiteLLM) is left alone: it is already off.
 * - `passthrough` and `compress` point the agent's gateway at the proxy (on the
 *   route its provider and credential need) unless it is there already, and
 *   store the mode. They are refused for a provider that cannot use a gateway
 *   and for an agent on an SSH remote, which cannot reach this machine's
 *   loopback address.
 *
 * Resolves once main holds the new values, so the next request uses them.
 */
export async function setAgentTokenProxyMode(
	sessionId: string,
	mode: TokenProxyMode
): Promise<SetAgentTokenProxyModeResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };
	const proxy = window.maestro.localModels.proxy;

	if (mode === 'off') {
		const port = (await proxy.report()).status.port;
		const onProxy = port !== null && gatewayPointsAtTokenProxy(session.gatewayUrl, port);
		const gatewayUrl = onProxy ? undefined : session.gatewayUrl;
		if (gatewayUrl !== session.gatewayUrl || session.tokenProxyMode !== undefined) {
			updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, tokenProxyMode: undefined }));
			await flushAgentToStore(sessionId);
		}
		return { ok: true, mode, gatewayUrl };
	}

	const support = agentGatewaySupport(session.toolType);
	if (!support.supported) return { ok: false, error: support.reason };
	if (session.sessionSshRemoteConfig?.enabled) {
		return {
			ok: false,
			error: `The ${TOKEN_PROXY_NAME} listens on this machine's loopback address, which an agent on an SSH remote cannot reach.`,
		};
	}

	const port = await proxy.ensurePort();
	let gatewayUrl = session.gatewayUrl;
	if (!gatewayPointsAtTokenProxy(gatewayUrl, port)) {
		const route = tokenProxyRouteForAgent(session.toolType, await agentEffectiveEnv(session));
		if (!route.ok) return route;
		gatewayUrl = tokenProxyGatewayUrl(port, route.route);
	}
	if (gatewayUrl !== session.gatewayUrl || session.tokenProxyMode !== mode) {
		updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, tokenProxyMode: mode }));
		await flushAgentToStore(sessionId);
	}
	return { ok: true, mode, gatewayUrl };
}
