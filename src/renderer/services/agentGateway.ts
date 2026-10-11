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
 */

import { parseGatewayUrlEdit } from '../../shared/local-models/gateway';
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

	updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl }));
	await flushAgentToStore(sessionId);
	return { ok: true, gatewayUrl };
}
