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
	sketchRoomSocketUrl,
	sketchServerUrlProblem,
	sketchShareLinkUrl,
	sketchShareThemeId,
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

describe('sketchRoomSocketUrl', () => {
	it('is wss on the hosted server and ws only on a loopback dev server', () => {
		expect(sketchRoomSocketUrl(undefined, 'room1')).toBe('wss://sketch.runmaestro.ai/ws/room1');
		expect(sketchRoomSocketUrl('https://staging.example:8443', 'room1')).toBe(
			'wss://staging.example:8443/ws/room1'
		);
		expect(sketchRoomSocketUrl('http://localhost:8787', 'room1')).toBe(
			'ws://localhost:8787/ws/room1'
		);
	});

	it('falls back to the hosted server for an unusable override and escapes the room id', () => {
		expect(sketchRoomSocketUrl('http://evil.example', 'a/b')).toBe(
			'wss://sketch.runmaestro.ai/ws/a%2Fb'
		);
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

describe('sketchShareLinkUrl', () => {
	it('puts the key and the cap in the fragment, never in the path or query (contract 2)', () => {
		const url = sketchShareLinkUrl(undefined, 'R'.repeat(22), 'k'.repeat(22), 'c'.repeat(43));
		expect(url).toBe(
			`https://sketch.runmaestro.ai/s/${'R'.repeat(22)}#${'k'.repeat(22)}.${'c'.repeat(43)}`
		);
		const parsed = new URL(url);
		expect(parsed.search).toBe('');
		expect(parsed.pathname).not.toContain('k'.repeat(22));
	});

	it('follows a usable dev server and falls back on an unusable one', () => {
		expect(sketchShareLinkUrl('http://localhost:8787', 'room1', 'key', 'cap')).toBe(
			'http://localhost:8787/s/room1#key.cap'
		);
		expect(sketchShareLinkUrl('http://evil.example', 'room1', 'key', 'cap')).toBe(
			'https://sketch.runmaestro.ai/s/room1#key.cap'
		);
	});

	it('puts the theme in the query, before the fragment, and keeps the key and cap out of it', () => {
		const url = sketchShareLinkUrl(undefined, 'room1', 'key', 'cap', 'github-light');
		expect(url).toBe('https://sketch.runmaestro.ai/s/room1?theme=github-light#key.cap');
		const parsed = new URL(url);
		expect(parsed.searchParams.get('theme')).toBe('github-light');
		expect(parsed.search).not.toContain('key');
		expect(parsed.search).not.toContain('cap');
		expect(parsed.hash).toBe('#key.cap');
	});

	it('leaves the query off when there is no theme', () => {
		expect(sketchShareLinkUrl(undefined, 'room1', 'key', 'cap', null)).toBe(
			'https://sketch.runmaestro.ai/s/room1#key.cap'
		);
		expect(sketchShareLinkUrl(undefined, 'room1', 'key', 'cap', '')).toBe(
			'https://sketch.runmaestro.ai/s/room1#key.cap'
		);
	});

	it('encodes the theme id', () => {
		expect(sketchShareLinkUrl(undefined, 'room1', 'key', 'cap', 'a b&c')).toBe(
			'https://sketch.runmaestro.ai/s/room1?theme=a%20b%26c#key.cap'
		);
	});
});

describe('sketchShareThemeId', () => {
	it('passes a known theme id through', () => {
		expect(sketchShareThemeId('pedurple')).toBe('pedurple');
		expect(sketchShareThemeId('dracula', 'nord')).toBe('dracula');
	});

	it('maps a retired id to its replacement', () => {
		expect(sketchShareThemeId('inquest')).toBe('dracula');
	});

	it('is null for an unknown or missing id', () => {
		expect(sketchShareThemeId('no-such-theme')).toBeNull();
		expect(sketchShareThemeId(undefined)).toBeNull();
		expect(sketchShareThemeId(42)).toBeNull();
	});

	it('sends the base theme for a Custom theme, or nothing when the base is unusable', () => {
		expect(sketchShareThemeId('custom', 'solarized-dark')).toBe('solarized-dark');
		expect(sketchShareThemeId('custom', undefined)).toBeNull();
		expect(sketchShareThemeId('custom', 'custom')).toBeNull();
		expect(sketchShareThemeId('custom', 'no-such-theme')).toBeNull();
	});
});
