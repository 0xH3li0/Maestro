/**
 * @file local-models-token-proxy.test.ts
 *
 * The token proxy's addressing rules: which upstream a request path names, that
 * the path and query are carried as text, which requests carry a message list,
 * and when an agent's gateway URL means "the Maestro proxy".
 */

import { describe, it, expect } from 'vitest';
import {
	classifyTokenProxyPath,
	defaultTokenProxyUpstreams,
	gatewayPointsAtTokenProxy,
	resolveTokenProxyTarget,
	TOKEN_PROXY_ROUTES,
	tokenProxyErrorBody,
	tokenProxyGatewayUrl,
} from '../../shared/local-models/token-proxy';
import { parseGatewayUrl } from '../../shared/local-models/gateway';

describe('resolveTokenProxyTarget', () => {
	it('routes by the first path segment to the real providers', () => {
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages')).toEqual({
			ok: true,
			route: 'anthropic',
			upstream: 'https://api.anthropic.com',
			path: '/v1/messages',
			query: '',
			kind: 'anthropic-messages',
		});
		expect(resolveTokenProxyTarget('POST', '/openai/v1/responses')).toMatchObject({
			route: 'openai',
			upstream: 'https://api.openai.com',
			path: '/v1/responses',
			kind: 'openai-responses',
		});
		expect(resolveTokenProxyTarget('POST', '/chatgpt/responses')).toMatchObject({
			route: 'chatgpt',
			upstream: 'https://chatgpt.com/backend-api/codex',
			path: '/responses',
			kind: 'openai-responses',
		});
	});

	it('carries the query string and an encoded path as the text they arrived as', () => {
		const target = resolveTokenProxyTarget('POST', '/anthropic/v1/messages?beta=true&x=a%20b');
		expect(target).toMatchObject({ path: '/v1/messages', query: '?beta=true&x=a%20b' });

		expect(resolveTokenProxyTarget('GET', '/openai/v1/files/a%2Fb')).toMatchObject({
			path: '/v1/files/a%2Fb',
			query: '',
		});
	});

	it('forwards every path under a route, not only the three message endpoints', () => {
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages/count_tokens')).toMatchObject({
			ok: true,
			path: '/v1/messages/count_tokens',
			kind: 'other',
		});
		expect(resolveTokenProxyTarget('GET', '/openai/v1/models')).toMatchObject({
			ok: true,
			kind: 'other',
		});
		expect(resolveTokenProxyTarget('GET', '/anthropic')).toMatchObject({ ok: true, path: '' });
	});

	it('refuses a path that names no route, and lists the routes', () => {
		for (const url of ['/', '/v1/messages', '/unknown/v1/messages', '']) {
			const target = resolveTokenProxyTarget('POST', url);
			expect(target.ok).toBe(false);
			if (!target.ok) {
				expect(target.error).toContain('Maestro token proxy');
				expect(target.error).toContain('/anthropic');
				expect(target.error).toContain('/openai');
			}
		}
	});

	it('does not treat an inherited object key as a route', () => {
		expect(resolveTokenProxyTarget('GET', '/constructor/x').ok).toBe(false);
		expect(resolveTokenProxyTarget('GET', '/__proto__/x').ok).toBe(false);
	});

	it('routes with the table it is given', () => {
		expect(
			resolveTokenProxyTarget('POST', '/fake/v1/messages', { fake: 'http://127.0.0.1:9' })
		).toMatchObject({ ok: true, route: 'fake', upstream: 'http://127.0.0.1:9' });
		expect(resolveTokenProxyTarget('POST', '/anthropic/v1/messages', { fake: 'x' }).ok).toBe(false);
	});
});

describe('classifyTokenProxyPath', () => {
	it('names the three APIs that carry a message list', () => {
		expect(classifyTokenProxyPath('POST', '/v1/messages')).toBe('anthropic-messages');
		expect(classifyTokenProxyPath('post', '/v1/messages/')).toBe('anthropic-messages');
		expect(classifyTokenProxyPath('POST', '/v1/chat/completions')).toBe('openai-chat-completions');
		expect(classifyTokenProxyPath('POST', '/v1/responses')).toBe('openai-responses');
		expect(classifyTokenProxyPath('POST', '/responses')).toBe('openai-responses');
	});

	it('calls everything else other, including a GET of the same path', () => {
		expect(classifyTokenProxyPath('GET', '/v1/responses')).toBe('other');
		expect(classifyTokenProxyPath('POST', '/v1/messages/count_tokens')).toBe('other');
		expect(classifyTokenProxyPath('POST', '/v1/embeddings')).toBe('other');
	});
});

describe('tokenProxyGatewayUrl', () => {
	it('builds a base URL the gateway field accepts unchanged, for every route', () => {
		for (const route of Object.keys(TOKEN_PROXY_ROUTES) as Array<keyof typeof TOKEN_PROXY_ROUTES>) {
			const url = tokenProxyGatewayUrl(41234, route);
			expect(parseGatewayUrl(url)).toEqual({ ok: true, url });
			expect(gatewayPointsAtTokenProxy(url, 41234)).toBe(true);
		}
	});

	it('resolves back to the route it was built for', () => {
		// What the provider CLI appends to its base URL, per route.
		const suffix = { anthropic: '/v1/messages', openai: '/responses', chatgpt: '/responses' };
		for (const route of Object.keys(suffix) as Array<keyof typeof suffix>) {
			const requestPath = new URL(tokenProxyGatewayUrl(41234, route) + suffix[route]).pathname;
			expect(resolveTokenProxyTarget('POST', requestPath)).toMatchObject({ ok: true, route });
		}
		expect(resolveTokenProxyTarget('POST', '/openai/v1/responses')).toMatchObject({
			path: '/v1/responses',
		});
	});

	it('has an upstream for every route', () => {
		expect(Object.keys(defaultTokenProxyUpstreams()).sort()).toEqual(
			Object.keys(TOKEN_PROXY_ROUTES).sort()
		);
	});
});

describe('gatewayPointsAtTokenProxy', () => {
	it('is true for any loopback spelling on the proxy port', () => {
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1:41234/anthropic', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('http://localhost:41234/openai/v1', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('http://[::1]:41234', 41234)).toBe(true);
		expect(gatewayPointsAtTokenProxy('  http://127.0.0.1:41234  ', 41234)).toBe(true);
	});

	it('is false for another port, another host, or no gateway', () => {
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1:8787', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('http://127.0.0.1', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('http://proxy.example.com:41234', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('', 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy(undefined, 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy(null, 41234)).toBe(false);
		expect(gatewayPointsAtTokenProxy('not a url', 41234)).toBe(false);
	});
});

describe('tokenProxyErrorBody', () => {
	it('is one JSON object both provider SDKs read a message from', () => {
		const body = JSON.parse(tokenProxyErrorBody('upstream-unreachable', 'could not reach it'));
		expect(body).toEqual({
			type: 'error',
			error: {
				type: 'maestro_token_proxy_error',
				code: 'upstream-unreachable',
				message: 'could not reach it',
			},
		});
	});
});
