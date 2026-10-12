/**
 * Background requests: where an agent's SIDE requests go.
 *
 * Claude Code sends work that is not the conversation (a tab title, a summary,
 * a topic check) on its small model. An agent on the Maestro token proxy can
 * send exactly those requests to a model on a Local Models source, while its
 * own turns keep going to the provider. The proxy decides per request
 * (`src/main/local-models/proxy/background-route.ts`). This module holds what
 * every surface shares: the stored setting, and the wording of a target that
 * cannot be used.
 *
 * Three rules every caller inherits:
 *
 * 1. Only a request that is unmistakably a side request is routed. Anything
 *    that could be the agent's own turn goes to the provider untouched, so the
 *    agent's main loop never changes model in the middle of a session.
 * 2. A target that cannot be used fails the request by name. The request is
 *    not sent to the provider instead: that would hide the failure and spend
 *    the money the user chose to save.
 * 3. Only the Anthropic Messages route is routed, and only to a source that
 *    serves it (`endpointServesAnthropicMessages`).
 */

import type { LocalModelEndpoint } from './endpoints';
import { MODEL_SERVER_NAME } from './model-server';
import { parseRunOnTarget, runOnTargetLabel, type RunOnSourceTarget } from './run-on';

/** The agent setting. Absent on the agent record means every request goes to the provider. */
export interface BackgroundRequests {
	/**
	 * The model on a Local Models source that background requests are sent to.
	 * Its `contextTokens` is not stored: a request states its own limits.
	 */
	target: RunOnSourceTarget;
}

export type BackgroundRequestsParse =
	| { ok: true; backgroundRequests: BackgroundRequests | undefined }
	| { ok: false; error: string };

/**
 * Read the setting from anything that may hold one (the stored agent record, a
 * bridge message) and put it in the one form that is stored. A blank value and
 * a `provider` target both read as "not routed", which is the setting's
 * absence. Shared by the proxy and by every writer, so none can store a value
 * the proxy would then refuse as malformed.
 */
export function parseBackgroundRequests(value: unknown): BackgroundRequestsParse {
	if (value === undefined || value === null) return { ok: true, backgroundRequests: undefined };
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'Background requests is an object with a target.' };
	}
	const raw = (value as Record<string, unknown>).target;
	if (raw === undefined || raw === null) {
		return { ok: false, error: 'Background requests names a target.' };
	}
	const parsed = parseRunOnTarget(raw);
	if (!parsed.ok) return parsed;
	if (parsed.target.type === 'provider') return { ok: true, backgroundRequests: undefined };
	const { endpointId, model } = parsed.target;
	return { ok: true, backgroundRequests: { target: { type: 'source', endpointId, model } } };
}

/**
 * Why a background request could not be sent to its target.
 *
 *   - `background-invalid-target`: the stored setting is not a source and a model.
 *   - `background-source-missing`: the source is no longer configured.
 *   - `background-source-disabled`: the source is switched off.
 *   - `background-source-not-anthropic`: the source is not known to serve the
 *     Anthropic Messages route.
 *   - `background-server-failed`: the Maestro model server could not serve the model.
 */
export type BackgroundRequestsRefusalCode =
	| 'background-invalid-target'
	| 'background-source-missing'
	| 'background-source-disabled'
	| 'background-source-not-anthropic'
	| 'background-server-failed';

const NOT_SENT = 'The request was not sent to the provider.';
const TURN_OFF = 'turn Background requests off';

/**
 * The message for a background request whose target cannot be used, which is
 * what the client is answered with (rule 2). `target` is null only for
 * `background-invalid-target`, where `detail` says what is wrong with the
 * stored value; elsewhere `detail` is what the source or the server said.
 */
export function backgroundRequestsUnavailable(
	code: BackgroundRequestsRefusalCode,
	target: RunOnSourceTarget | null,
	endpoint: Pick<LocalModelEndpoint, 'id' | 'name'> | null,
	detail?: string
): string {
	const said = detail?.trim() ?? '';
	if (code === 'background-invalid-target' || !target) {
		return `This agent's Background requests target cannot be used${said ? `: ${said}` : '.'} ${NOT_SENT} Pick a model again, or ${TURN_OFF}.`;
	}
	const label = runOnTargetLabel(target, endpoint ? [endpoint] : []);
	const name = endpoint?.name ?? target.endpointId;
	const what: Record<
		Exclude<BackgroundRequestsRefusalCode, 'background-invalid-target'>,
		string
	> = {
		'background-source-missing': `its source (${target.endpointId}) is no longer configured. ${NOT_SENT} Pick a model again, or ${TURN_OFF}.`,
		'background-source-disabled': `the source "${name}" is disabled. ${NOT_SENT} Enable it, or ${TURN_OFF}.`,
		'background-source-not-anthropic': `Maestro cannot tell that the source "${name}" serves the Anthropic Messages route (/v1/messages), which a background request uses. ${NOT_SENT} Pick a model on the ${MODEL_SERVER_NAME}, Ollama or LM Studio, or ${TURN_OFF}.`,
		'background-server-failed': `the ${MODEL_SERVER_NAME} could not serve it${said ? ` (${said.replace(/\.$/, '')})` : ''}. ${NOT_SENT} Fix the model server, or ${TURN_OFF}.`,
	};
	return `This agent sends background requests to ${label}, but ${what[code]}`;
}
