/**
 * @file server.test.ts
 *
 * Where the Sketch Book server is (`sketchBook.serverUrl`, a dev setting): only
 * an https origin, or http on a loopback host, so a typo can never send an
 * owner token over the open network.
 */

import { describe, it, expect } from 'vitest';

import {
	normalizeSketchBookSettings,
	sketchBookSettingPathProblem,
	sketchBookSettingProblem,
} from '../../../shared/sketch/cloud-consent';
import {
	normalizeSketchServerUrl,
	resolveSketchServerUrl,
	SKETCH_DEFAULT_SERVER_URL,
	sketchServerUrlProblem,
} from '../../../shared/sketch/server';

describe('normalizeSketchServerUrl', () => {
	it.each([
		['https://sketch.runmaestro.ai', 'https://sketch.runmaestro.ai'],
		['https://sketch.runmaestro.ai/', 'https://sketch.runmaestro.ai'],
		['  http://localhost:8787  ', 'http://localhost:8787'],
		['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
		['http://[::1]:8787', 'http://[::1]:8787'],
		['https://staging.example:8443', 'https://staging.example:8443'],
	])('accepts %s as %s', (raw, origin) => {
		expect(normalizeSketchServerUrl(raw)).toBe(origin);
	});

	it.each([
		['plain http off loopback', 'http://sketch.runmaestro.ai'],
		['a path', 'https://sketch.runmaestro.ai/api'],
		['a query', 'https://sketch.runmaestro.ai/?x=1'],
		['a fragment', 'https://sketch.runmaestro.ai/#key'],
		['credentials', 'https://user:pass@sketch.runmaestro.ai'],
		['another scheme', 'ws://localhost:8787'],
		['not a URL', 'localhost:8787:x'],
		['empty text', '   '],
		['a number', 8787],
	])('refuses %s', (_label, raw) => {
		expect(normalizeSketchServerUrl(raw)).toBeNull();
	});
});

describe('resolveSketchServerUrl', () => {
	it('uses a valid override and falls back to the hosted server', () => {
		expect(resolveSketchServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
		expect(resolveSketchServerUrl(undefined)).toBe(SKETCH_DEFAULT_SERVER_URL);
		expect(resolveSketchServerUrl('http://evil.example')).toBe(SKETCH_DEFAULT_SERVER_URL);
	});
});

describe('the serverUrl field of the sketchBook setting', () => {
	it('a clear is always allowed; a bad URL is refused by name', () => {
		expect(sketchServerUrlProblem(undefined)).toBeNull();
		expect(sketchServerUrlProblem('')).toBeNull();
		expect(sketchServerUrlProblem('http://evil.example')).toContain('sketchBook.serverUrl');
	});

	it('is a known path, checked on write', () => {
		expect(sketchBookSettingPathProblem('serverUrl')).toBeNull();
		expect(sketchBookSettingProblem('serverUrl', 'http://localhost:8787')).toBeNull();
		expect(sketchBookSettingProblem('serverUrl', 'http://evil.example')).not.toBeNull();
	});

	it('a whole-object write is checked field by field', () => {
		expect(sketchBookSettingProblem('', { serverUrl: 'http://localhost:8787' })).toBeNull();
		expect(sketchBookSettingProblem('', { serverUrl: 'ftp://x' })).not.toBeNull();
		expect(sketchBookSettingProblem('', { botPolicy: 'writers' })).toContain(
			'is not a Sketch Book setting'
		);
	});

	it('normalizes to the origin and drops a bad one', () => {
		expect(normalizeSketchBookSettings({ serverUrl: 'http://localhost:8787/' })).toEqual({
			serverUrl: 'http://localhost:8787',
		});
		expect(normalizeSketchBookSettings({ serverUrl: 'http://evil.example' })).toEqual({});
	});
});
