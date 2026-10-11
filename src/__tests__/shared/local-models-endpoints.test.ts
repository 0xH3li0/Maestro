/**
 * Tests for shared/local-models/endpoints - the endpoint record, its base URL
 * rules, the settings reader, and API-key resolution from Settings -> Environment.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_ENDPOINT_BASE_URLS,
	endpointBaseUrlProblem,
	isLocalModelEndpointKind,
	normalizeEndpointBaseUrl,
	parseLocalModelEndpoints,
	resolveEndpointApiKey,
	validateLocalModelEndpoint,
	type LocalModelEndpoint,
} from '../../shared/local-models/endpoints';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

const valid: LocalModelEndpoint = {
	id: 'ep-1',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

describe('endpointBaseUrlProblem', () => {
	it('accepts http and https base URLs, with or without a path prefix', () => {
		expect(endpointBaseUrlProblem('http://127.0.0.1:11434')).toBeNull();
		expect(endpointBaseUrlProblem('https://llm.example.com/v1')).toBeNull();
		expect(endpointBaseUrlProblem('  http://localhost:1234/  ')).toBeNull();
		expect(endpointBaseUrlProblem('http://[::1]:8080')).toBeNull();
	});

	it('requires a value', () => {
		expect(endpointBaseUrlProblem('')).toMatch(/required/);
		expect(endpointBaseUrlProblem('   ')).toMatch(/required/);
	});

	it('rejects text that does not parse as a URL', () => {
		expect(endpointBaseUrlProblem('127.0.0.1:11434')).not.toBeNull();
		expect(endpointBaseUrlProblem('not a url')).toMatch(/not a valid URL/);
	});

	it('rejects schemes other than http and https', () => {
		expect(endpointBaseUrlProblem('ftp://host')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('file:///tmp/model')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('javascript:alert(1)')).toMatch(/Only http and https/);
		expect(endpointBaseUrlProblem('ws://127.0.0.1:1234')).toMatch(/Only http and https/);
	});

	it('refuses credentials embedded in the URL instead of storing them', () => {
		expect(endpointBaseUrlProblem('https://user:secret@llm.example.com')).toMatch(/credentials/);
		expect(endpointBaseUrlProblem('https://token@llm.example.com')).toMatch(/credentials/);
	});

	it('rejects a query string or fragment, which would swallow appended paths', () => {
		expect(endpointBaseUrlProblem('http://host/v1?key=abc')).toMatch(/query string/);
		expect(endpointBaseUrlProblem('http://host/#x')).toMatch(/query string/);
	});
});

describe('normalizeEndpointBaseUrl', () => {
	it('trims and drops trailing slashes', () => {
		expect(normalizeEndpointBaseUrl(' http://127.0.0.1:11434/ ')).toBe('http://127.0.0.1:11434');
		expect(normalizeEndpointBaseUrl('https://host/proxy//')).toBe('https://host/proxy');
	});

	it('keeps an explicit port and path prefix', () => {
		expect(normalizeEndpointBaseUrl('http://host:8000/openai/v1')).toBe(
			'http://host:8000/openai/v1'
		);
	});
});

describe('validateLocalModelEndpoint', () => {
	it('accepts a valid record and returns a normalized copy', () => {
		const result = validateLocalModelEndpoint({
			...valid,
			name: '  Ollama  ',
			baseUrl: 'http://127.0.0.1:11434/',
			apiKeyEnvVar: ' OLLAMA_KEY ',
		});
		expect(result).toEqual({
			ok: true,
			endpoint: { ...valid, apiKeyEnvVar: 'OLLAMA_KEY' },
		});
	});

	it('drops a blank apiKeyEnvVar rather than storing an empty name', () => {
		const result = validateLocalModelEndpoint({ ...valid, apiKeyEnvVar: '  ' });
		expect(result.ok).toBe(true);
		if (result.ok) expect('apiKeyEnvVar' in result.endpoint).toBe(false);
	});

	it('reports every bad field at once', () => {
		const result = validateLocalModelEndpoint({
			id: '',
			name: '',
			kind: 'llamafile',
			baseUrl: 'ftp://host',
			apiKeyEnvVar: 'MY-KEY',
			enabled: 'yes',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((i) => i.field).sort()).toEqual(
				['apiKeyEnvVar', 'baseUrl', 'enabled', 'id', 'kind', 'name'].sort()
			);
		}
	});

	it('rejects something that is not an object', () => {
		expect(validateLocalModelEndpoint(null).ok).toBe(false);
		expect(validateLocalModelEndpoint('http://127.0.0.1:11434').ok).toBe(false);
		expect(validateLocalModelEndpoint([valid]).ok).toBe(false);
	});

	it('accepts each supported kind', () => {
		for (const kind of ['ollama', 'lmstudio', 'openai-compatible'] as const) {
			expect(validateLocalModelEndpoint({ ...valid, kind }).ok).toBe(true);
			expect(isLocalModelEndpointKind(kind)).toBe(true);
		}
		expect(isLocalModelEndpointKind('vllm')).toBe(false);
	});
});

describe('parseLocalModelEndpoints', () => {
	it('reads anything that is not a list as empty', () => {
		expect(parseLocalModelEndpoints(undefined)).toEqual([]);
		expect(parseLocalModelEndpoints({})).toEqual([]);
		expect(parseLocalModelEndpoints('[]')).toEqual([]);
	});

	it('drops invalid records and keeps the first record for a repeated id', () => {
		const second = { ...valid, id: 'ep-2', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' };
		const parsed = parseLocalModelEndpoints([
			valid,
			{ ...valid, baseUrl: 'https://u:p@host' },
			{ ...valid, name: 'Duplicate' },
			second,
		]);
		expect(parsed).toEqual([valid, second]);
	});
});

describe('resolveEndpointApiKey', () => {
	it('reads the named variable from Settings -> Environment', () => {
		expect(
			resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, { LLM_KEY: ' sk-123 ', OTHER: 'x' })
		).toBe('sk-123');
	});

	it('is undefined when no variable is named, it is missing, or it is blank', () => {
		expect(resolveEndpointApiKey({}, { LLM_KEY: 'sk' })).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, {})).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, undefined)).toBeUndefined();
		expect(resolveEndpointApiKey({ apiKeyEnvVar: 'LLM_KEY' }, { LLM_KEY: '  ' })).toBeUndefined();
	});
});

describe('localModelEndpoints setting', () => {
	it('defaults to an empty list', () => {
		expect(SETTINGS_METADATA.localModelEndpoints.default).toEqual([]);
		expect(SETTINGS_METADATA.localModelEndpoints.type).toBe('array');
	});

	it('ships default base URLs that pass validation', () => {
		for (const url of Object.values(DEFAULT_ENDPOINT_BASE_URLS)) {
			expect(endpointBaseUrlProblem(url!)).toBeNull();
		}
	});
});
