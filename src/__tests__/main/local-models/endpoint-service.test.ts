/**
 * @file endpoint-service.test.ts
 *
 * The persisted-state layer over the endpoint client: which record a saved id
 * resolves to, that a not-yet-saved record is validated before anything is
 * sent, that the API key comes from Settings -> Environment, and that detection
 * is handed the configured list so it never offers a server twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

const client = vi.hoisted(() => ({
	detectLocalEndpoints: vi.fn(async () => []),
	listEndpointModelsResult: vi.fn(async () => ({ ok: true, models: [] })),
	testEndpoint: vi.fn(async () => ({ ok: true, model: 'm', latencyMs: 5 })),
}));

vi.mock('../../../main/local-models/endpoint-client', () => client);

import {
	detectNewLocalModelEndpoints,
	getConfiguredLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../main/local-models/endpoint-service';

const saved = {
	id: 'ep-1',
	name: 'Gateway',
	kind: 'openai-compatible',
	baseUrl: 'https://llm.example.com/',
	apiKeyEnvVar: 'LITELLM_KEY',
	enabled: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	settings.clear();
	settings.set('localModelEndpoints', [saved, { id: 'broken', baseUrl: 'ftp://x' }]);
	settings.set('shellEnvVars', { LITELLM_KEY: 'sk-test' });
});

describe('endpoint-service', () => {
	it('reads the saved list through the validator, dropping invalid records', () => {
		expect(getConfiguredLocalModelEndpoints()).toEqual([
			{ ...saved, baseUrl: 'https://llm.example.com' },
		]);
	});

	it('hands detection the configured list', async () => {
		await detectNewLocalModelEndpoints();

		expect(client.detectLocalEndpoints).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'ep-1', baseUrl: 'https://llm.example.com' }),
		]);
	});

	it('resolves a saved id and passes Settings -> Environment for the key', async () => {
		await testLocalModelEndpoint('ep-1', ' gpt-x ');

		expect(client.testEndpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'ep-1' }), {
			shellEnvVars: { LITELLM_KEY: 'sk-test' },
			model: 'gpt-x',
		});
	});

	it('tests an unsaved record without a model, letting the client pick one', async () => {
		const draft = { ...saved, id: 'draft', baseUrl: 'http://127.0.0.1:1234' };

		await testLocalModelEndpoint(draft);

		expect(client.testEndpoint).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'draft', baseUrl: 'http://127.0.0.1:1234' }),
			{ shellEnvVars: { LITELLM_KEY: 'sk-test' } }
		);
	});

	it('answers an unknown id as invalid without calling the client', async () => {
		const result = await listLocalModelEndpointModels('nope');

		expect(result).toEqual({
			ok: false,
			error: { kind: 'invalid', message: 'No endpoint with id "nope".' },
		});
		expect(client.listEndpointModelsResult).not.toHaveBeenCalled();
	});

	it('answers a record that fails validation as invalid, naming the problem', async () => {
		const result = await testLocalModelEndpoint({ ...saved, baseUrl: 'http://u:p@host' });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('invalid');
		expect(result.error.message).toContain('credentials');
		expect(client.testEndpoint).not.toHaveBeenCalled();
	});
});
