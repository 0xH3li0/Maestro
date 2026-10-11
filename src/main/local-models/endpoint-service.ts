/**
 * The endpoint half of the Local Models service: what the IPC channels and the
 * CLI bridge call for user-run model servers. Both transports go through these
 * functions, so a Test from Settings and `maestro-cli models endpoints test`
 * cannot disagree about which record they used or where the key came from.
 *
 * The client (`endpoint-client.ts`) is pure transport and takes everything as
 * arguments. This layer is where the persisted state comes in: the configured
 * list (`localModelEndpoints`) and Settings -> Environment (`shellEnvVars`),
 * the only place an endpoint's API key is resolved from.
 */

import {
	findLocalModelEndpoint,
	parseLocalModelEndpoints,
	validateLocalModelEndpoint,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import { getSettingsStore } from '../stores/getters';
import {
	detectLocalEndpoints,
	listEndpointModelsResult,
	testEndpoint,
	type DetectedEndpoint,
	type EndpointFailure,
	type EndpointModelsResult,
	type EndpointTestResult,
} from './endpoint-client';

/** The saved endpoints, read through the same validator that saves them. */
export function getConfiguredLocalModelEndpoints(): LocalModelEndpoint[] {
	return parseLocalModelEndpoints(getSettingsStore().get('localModelEndpoints', []));
}

function shellEnvVars(): Record<string, string> {
	return getSettingsStore().get('shellEnvVars', {}) as Record<string, string>;
}

/**
 * Turn what a caller handed in into an endpoint. A string names a saved
 * endpoint by id, id prefix, or name (the CLI's `test <ref>`, resolved by the
 * same lookup `remove` uses); an object is a record that may not be saved yet
 * (Settings' Test button runs before the user commits the form).
 */
function resolveEndpointRef(
	ref: unknown
): { ok: true; endpoint: LocalModelEndpoint } | { ok: false; error: EndpointFailure } {
	if (typeof ref === 'string') {
		const found = findLocalModelEndpoint(getConfiguredLocalModelEndpoints(), ref);
		return found.ok ? found : { ok: false, error: { kind: 'invalid', message: found.message } };
	}
	const validation = validateLocalModelEndpoint(ref);
	if (validation.ok) return validation;
	return {
		ok: false,
		error: {
			kind: 'invalid',
			message: validation.issues.map((issue) => issue.message).join(' '),
		},
	};
}

/** Running loopback servers that are not configured yet. Saves nothing. */
export async function detectNewLocalModelEndpoints(): Promise<DetectedEndpoint[]> {
	return detectLocalEndpoints(getConfiguredLocalModelEndpoints());
}

/** The models one endpoint serves, by saved id or by record. */
export async function listLocalModelEndpointModels(ref: unknown): Promise<EndpointModelsResult> {
	const resolved = resolveEndpointRef(ref);
	if (!resolved.ok) return resolved;
	return listEndpointModelsResult(resolved.endpoint, { shellEnvVars: shellEnvVars() });
}

/** A one-token chat against one endpoint, by saved id or by record, with its latency. */
export async function testLocalModelEndpoint(
	ref: unknown,
	model?: unknown
): Promise<EndpointTestResult> {
	const resolved = resolveEndpointRef(ref);
	if (!resolved.ok) return resolved;
	return testEndpoint(resolved.endpoint, {
		shellEnvVars: shellEnvVars(),
		...(typeof model === 'string' && model.trim() !== '' ? { model: model.trim() } : {}),
	});
}
