/**
 * Tests for shared/local-models/background-requests: the stored setting as
 * every reader parses it, and the message a client is answered with when the
 * target cannot be used.
 */

import { describe, it, expect } from 'vitest';
import {
	backgroundRequestsUnavailable,
	parseBackgroundRequests,
} from '../../../shared/local-models/background-requests';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import type { RunOnSourceTarget } from '../../../shared/local-models/run-on';

const ON_SERVER: RunOnSourceTarget = {
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model: 'qwen3.5-4b',
};
const ON_OLLAMA: RunOnSourceTarget = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' };
const OLLAMA = { id: 'ep-ollama', name: 'Ollama' };

describe('parseBackgroundRequests', () => {
	it('reads an absent setting as not routed', () => {
		expect(parseBackgroundRequests(undefined)).toEqual({ ok: true, backgroundRequests: undefined });
		expect(parseBackgroundRequests(null)).toEqual({ ok: true, backgroundRequests: undefined });
	});

	it('reads a provider target as not routed', () => {
		expect(parseBackgroundRequests({ target: { type: 'provider' } })).toEqual({
			ok: true,
			backgroundRequests: undefined,
		});
	});

	it('keeps a source target in the one stored form', () => {
		expect(
			parseBackgroundRequests({
				target: { type: 'source', endpointId: ' ep-ollama ', model: ' qwen3:4b ', extra: 1 },
				stray: true,
			})
		).toEqual({ ok: true, backgroundRequests: { target: ON_OLLAMA } });
	});

	it('does not store a context size: a request states its own limits', () => {
		const parsed = parseBackgroundRequests({ target: { ...ON_SERVER, contextTokens: 65_536 } });

		expect(parsed).toEqual({ ok: true, backgroundRequests: { target: ON_SERVER } });
	});

	it('refuses anything that is not a target, and never reads it as not routed', () => {
		for (const value of [
			'maestro-server:qwen3.5-4b',
			[],
			{},
			{ target: null },
			{ target: 'provider' },
			{ target: { type: 'source', endpointId: 'ep-ollama' } },
			{ target: { type: 'source', model: 'qwen3:4b' } },
			{ target: { type: 'elsewhere' } },
		]) {
			const parsed = parseBackgroundRequests(value);
			expect(parsed.ok, JSON.stringify(value)).toBe(false);
			if (!parsed.ok) expect(parsed.error).not.toBe('');
		}
	});
});

describe('backgroundRequestsUnavailable', () => {
	it('always says the request did not go to the provider, and how to recover', () => {
		const messages = [
			backgroundRequestsUnavailable('background-invalid-target', null, null, 'It names no model.'),
			backgroundRequestsUnavailable('background-source-missing', ON_OLLAMA, null),
			backgroundRequestsUnavailable('background-source-disabled', ON_OLLAMA, OLLAMA),
			backgroundRequestsUnavailable('background-source-not-anthropic', ON_OLLAMA, OLLAMA),
			backgroundRequestsUnavailable('background-server-failed', ON_SERVER, null, 'out of memory.'),
		];
		for (const message of messages) {
			expect(message).toContain('The request was not sent to the provider.');
			expect(message).toContain('turn Background requests off');
			// No dash a person did not type.
			expect(message).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
		}
	});

	it('names the target and what is wrong with it', () => {
		expect(backgroundRequestsUnavailable('background-source-missing', ON_OLLAMA, null)).toContain(
			'its source (ep-ollama) is no longer configured'
		);
		expect(
			backgroundRequestsUnavailable('background-source-disabled', ON_OLLAMA, OLLAMA)
		).toContain(
			'sends background requests to qwen3:4b on Ollama, but the source "Ollama" is disabled'
		);
		expect(
			backgroundRequestsUnavailable('background-source-not-anthropic', ON_OLLAMA, {
				id: 'ep-ollama',
				name: 'Workstation',
			})
		).toContain('cannot tell that the source "Workstation" serves the Anthropic Messages route');
		expect(
			backgroundRequestsUnavailable('background-server-failed', ON_SERVER, null, 'out of memory.')
		).toContain('Maestro model server could not serve it (out of memory)');
	});

	it('carries what is wrong with a stored value that is not a target', () => {
		expect(
			backgroundRequestsUnavailable('background-invalid-target', null, null, 'It names no model.')
		).toContain("This agent's Background requests target cannot be used: It names no model.");
	});
});
