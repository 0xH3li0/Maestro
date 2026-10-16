// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/lite.discovery-probe.test.ts
//   - src/__tests__/main/lite.discovery-tailscale.test.ts

import { MdnsBrowser } from '../../main/lite/discovery/mdns';
import { probeService, validateManifest } from '../../main/lite/discovery/probe';
import {
	readTailscaleServices,
	readTailscaleStatus,
	tailscaleCandidates,
	tailscalePeerDiscovery,
} from '../../main/lite/discovery/tailscale';
import { candidate } from '../../main/lite/discovery/types';
import type { Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { request } from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

// ===== from src/__tests__/main/lite.discovery-probe.test.ts =====

const appVersion: string = require('../../../package.json').version;

const row = candidate('aster-id', 'Aster', 'https://aster.example.test', 'lan', Date.now() + 60000);

const manifest = {
	protocol: 'maestro-discovery',
	version: 1,
	instanceId: 'aster-id',
	name: 'Aster',
	appVersion: appVersion,
	setupRevision: 6,

	pairing: { protocol: 'maestro-device-pairing/1', scope: 'host.control', enabled: true },
	capabilities: ['host.control'],
	connection: {
		path: '/.well-known/maestro/connect',
		authentication: 'device-pairing',
		admission: 'device',
		capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
	},
};

describe('service compatibility before PIN selection', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		[{ version: 2 }, 'incompatible'],
		[{ setupRevision: undefined }, 'incompatible'],
		[{ setupRevision: 3 }, 'incompatible'],
		[{ appVersion: '0.18.5' }, 'incompatible'],
		[{ protocol: 'unrelated-service' }, 'incompatible'],
		[{ instanceId: 'substituted-id' }, 'incompatible'],
		[{ capabilities: ['agents.execute'] }, 'incompatible'],
		[{ pairing: { ...manifest.pairing, enabled: false } }, 'pairing-disabled'],
	] as const)('refuses incompatible or mismatched advertisement %#', (change, expected) => {
		expect(validateManifest(row, { ...manifest, ...change }).availability).toBe(expected);
	});
	it('adopts a named Service identity only after a compatible manifest, without authorizing full access', () => {
		const checked = validateManifest(
			{ ...row, id: 'maestro-service', identityHint: undefined },
			manifest
		);
		expect(checked).toMatchObject({
			id: 'aster-id',
			identityHint: 'aster-id',

			availability: 'ready',
		});
	});
	it.each([401, 403, 302])(
		'does not follow or bypass an authorization response %s',
		async (statusCode) => {
			let calls = 0;
			const send = ((
				_url: string,
				_options: unknown,
				callback: (response: PassThrough & { statusCode: number }) => void
			) => {
				calls++;
				return Object.assign(new EventEmitter(), {
					destroy() {},
					end() {
						const response = Object.assign(new PassThrough(), { statusCode });
						callback(response);
					},
				});
			}) as unknown as typeof request;
			const result = await probeService(row, new AbortController().signal, send);
			expect(result.availability).toBe('auth-required');
			expect(calls).toBe(1);
		}
	);
	it('bounds response bodies and total time even when headers arrive', async () => {
		vi.useFakeTimers();
		let response!: PassThrough & { statusCode: number };
		const destroyed = vi.fn();
		const send = ((
			_url: string,
			_options: unknown,
			callback: (response: PassThrough & { statusCode: number }) => void
		) =>
			Object.assign(new EventEmitter(), {
				destroy: destroyed,
				end() {
					response = Object.assign(new PassThrough(), { statusCode: 200 });
					callback(response);
				},
			})) as unknown as typeof request;
		const oversized = probeService(row, new AbortController().signal, send);
		response.write(Buffer.alloc(16385));
		expect((await oversized).availability).toBe('unreachable');
		expect(response.destroyed).toBe(true);
		const stalled = probeService(row, new AbortController().signal, send);
		await vi.advanceTimersByTimeAsync(4000);
		expect((await stalled).availability).toBe('unreachable');
		expect(destroyed).toHaveBeenCalledOnce();
	});
	it('reports multicast permission denial and closes the refused socket', async () => {
		let closed = false;
		class DeniedSocket extends EventEmitter {
			bind() {
				this.emit('error', Object.assign(new Error('no access'), { code: 'EACCES' }));
			}
			close() {
				closed = true;
			}
			dropMembership() {}
		}
		const failed = vi.fn();
		const browser = new MdnsBrowser('192.0.2.10', () => new DeniedSocket() as unknown as Socket);
		await expect(browser.start(() => undefined, failed)).rejects.toThrow('permission denied');
		expect(failed).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
		expect(closed).toBe(true);
	});
});

// ===== from src/__tests__/main/lite.discovery-tailscale.test.ts =====

const status = JSON.stringify({
	BackendState: 'Running',
	CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
	Peer: { a: { ID: 'not-a-maestro-id', Online: true, PeerAPIURL: ['http://100.64.0.1:12345'] } },
});

const advertised = {
	Name: 'svc:maestro',
	DisplayName: 'Synthetic Maestro',
	Hostname: 'maestro.synthetic.ts.net',
	Addrs: ['100.64.0.10'],
	Ports: ['tcp:443', 'tcp:8443'],
	Actions: [{ Type: 'http', Port: 443 }],
};

describe('read-only existing Tailscale CLI readers', () => {
	beforeEach(() => {
		execFile.mockReset();
	});

	it.each([
		['ENOENT', 'private executable path', 'unavailable'],
		[1, 'unknown subcommand: service; secret', 'unavailable'],
		[1, 'Failed to connect to local Tailscale daemon; secret', 'offline'],
		[1, 'not logged in; secret', 'offline'],
		[1, 'no netmap; secret', 'offline'],
		['EACCES', 'permission denied; secret', 'permission-denied'],
		[1, 'Access denied; secret', 'permission-denied'],
		[1, 'private diagnostic secret', 'unavailable'],
	])('classifies %s/%s without disclosing diagnostics', async (code, stderr, expectedStatus) => {
		execFile.mockImplementation((_file, _args, _options, callback) =>
			callback(Object.assign(new Error('secret'), { code }), '', stderr)
		);
		const error = await readTailscaleServices(new AbortController().signal).catch(
			(failure: unknown) => failure
		);
		expect(error).toMatchObject({ status: expectedStatus });
		expect((error as Error).message).not.toContain('secret');
	});

	it('handles synchronous launch failure and aborted successful callbacks', async () => {
		execFile.mockImplementation(() => {
			throw Object.assign(new Error('private path'), { code: 'ENOENT' });
		});
		await expect(readTailscaleStatus(new AbortController().signal)).rejects.toMatchObject({
			status: 'unavailable',
		});
		const controller = new AbortController();
		controller.abort();
		execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '[]', ''));
		await expect(readTailscaleServices(controller.signal)).rejects.toMatchObject({
			status: 'stopped',
		});
	});
});

describe('already-advertised named Maestro service candidates', () => {
	beforeEach(() => {
		execFile.mockReset();
	});

	it('consumes actual array/string-port schema without inferring a Maestro instance identity', () => {
		const rows = tailscaleCandidates(status, JSON.stringify([advertised]), 1000);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			id: 'maestro',
			name: 'Synthetic Maestro',
			endpoint: 'https://maestro.synthetic.ts.net',
			availability: 'unmeasured',
			identityHint: undefined,
			expiresAt: 61000,
		});
		expect(rows[1].endpoint).toBe('https://maestro.synthetic.ts.net:8443');
	});

	it('ignores arbitrary peers, PeerAPI URLs, unrelated services and status capability hints', () => {
		expect(tailscaleCandidates(status, '[]')).toEqual([]);
		expect(
			tailscaleCandidates(status, JSON.stringify([{ ...advertised, Name: 'svc:web' }]))
		).toEqual([]);
		const hints = JSON.stringify({
			BackendState: 'Running',
			Self: { CapMap: { invented: [advertised] } },
			Peer: {
				a: {
					Hostinfo: { Services: [{ Proto: 'tcp', Port: 443 }] },
					PeerAPIURL: ['https://maestro.synthetic.ts.net'],
				},
			},
		});
		expect(tailscaleCandidates(hints, '[]')).toEqual([]);
	});

	it.each([
		'http://maestro.synthetic.ts.net',
		'maestro.synthetic.ts.net@evil.test',
		'maestro.synthetic.ts.net/secret',
		'maestro.synthetic.ts.net.evil.test',
		'evil.synthetic.ts.net',
		'127.0.0.1',
		'[::1]',
		'localhost',
		'maestro.synthetic.ts.net:443',
	])('rejects malicious or mismatched hostname %s', (Hostname) => {
		expect(tailscaleCandidates(status, JSON.stringify([{ ...advertised, Hostname }]))).toEqual([]);
	});

	it('normalizes DNS case/trailing dot and bounds invalid display name fallback', () => {
		const rows = tailscaleCandidates(
			status,
			JSON.stringify([
				{ ...advertised, Hostname: 'MAESTRO.SYNTHETIC.TS.NET.', DisplayName: 'x'.repeat(65) },
			])
		);
		expect(rows[0].name).toBe('maestro');
		expect(rows[0].availability).toBe('unmeasured');
	});

	it('does not expand wildcards/ranges, accept UDP or infer HTTPS from actions', () => {
		const Ports = [
			'*',
			'443',
			'tcp:*',
			'tcp:80-90',
			'udp:443',
			'tcp:0',
			'tcp:65536',
			'tcp:0443',
			{ Proto: 6, Ports: { First: 443, Last: 443 } },
		];
		expect(tailscaleCandidates(status, JSON.stringify([{ ...advertised, Ports }]))).toEqual([]);
	});

	it('deduplicates ports and caps four ports per host and 32 hosts', () => {
		const services = Array.from({ length: 40 }, (_, i) => ({
			...advertised,
			Name: 'svc:maestro-' + i,
			Hostname: 'maestro-' + i + '.synthetic.ts.net',
			Ports: ['tcp:443', 'tcp:443', 'tcp:8443', 'tcp:9443', 'tcp:10443', 'tcp:11443'],
		}));
		const rows = tailscaleCandidates(status, JSON.stringify(services));
		expect(rows).toHaveLength(128);
		expect(new Set(rows.map((row) => new URL(row.endpoint).hostname)).size).toBe(32);
		expect(rows.filter((row) => row.id === 'maestro-0')).toHaveLength(4);
	});

	it.each(['Stopped', 'NeedsLogin', 'Starting'])('reports %s as offline', (BackendState) => {
		expect(() => tailscaleCandidates(JSON.stringify({ BackendState }), '[]')).toThrow(
			expect.objectContaining({ status: 'offline' })
		);
	});

	it('rejects malformed/oversized JSON and incompatible service/status shapes with fixed messages', () => {
		for (const [state, services] of [
			[status, '{private secret'],
			[status, '{}'],
			['null', '[]'],
			[status, ' '.repeat(2097153)],
			[
				JSON.stringify({
					BackendState: 'Running',
					CurrentTailnet: { MagicDNSSuffix: 'invalid/suffix' },
				}),
				'[]',
			],
		]) {
			expect(() => tailscaleCandidates(state, services)).toThrow(
				expect.objectContaining({ status: 'unavailable' })
			);
		}
	});
});

describe('bounded same-tailnet peer locations, not service identities', () => {
	beforeEach(() => {
		execFile.mockReset();
	});

	const peer = {
		ID: 'n-one',
		DNSName: 'ASTER.SYNTHETIC.TS.NET.',
		Online: true,
		TailscaleIPs: ['100.64.0.10'],
		PeerAPIURL: ['http://100.64.0.10:12345'],
	};
	const metadata = (Peer: object, extra = {}) =>
		JSON.stringify({
			BackendState: 'Running',
			CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
			Self: { ID: 'self', DNSName: 'self.synthetic.ts.net.' },
			Peer,
			...extra,
		});
	it('uses only eligible peer IPv4 addresses on the Maestro port, not HTTPS or PeerAPI URLs', () => {
		const invalid = [
			{ Online: false },
			{ Expired: true },
			{ InNetworkMap: false },
			{ ID: 'self' },
			{ ID: '../bad' },
			{ DNSName: 'self.synthetic.ts.net' },
			{ DNSName: 'aster.synthetic.ts.net.evil.test' },
			{ DNSName: 'nested.aster.synthetic.ts.net' },
			{ DNSName: 'aster.synthetic.ts.net:8443' },
			{ DNSName: '100.64.0.10' },
			{ DNSName: 'aster.synthetic.ts.net/token' },
			{ TailscaleIPs: ['192.0.2.1'] },
			{ TailscaleIPs: ['100.128.0.1'] },
			{ TailscaleIPs: [] },
		];
		const peers = Object.fromEntries(
			invalid.map((change, i) => ['bad-' + i, { ...peer, ...change }])
		);
		const rows = tailscalePeerDiscovery(
			metadata({
				...peers,
				good: peer,
				duplicate: { ...peer, ID: 'n-duplicate' },
				ipv6: {
					...peer,
					ID: 'n-six',
					DNSName: 'six.synthetic.ts.net',
					TailscaleIPs: ['fd7a:115c:a1e0::2'],
				},
			}),
			1000
		).candidates;
		expect(rows.map((row) => row.endpoint)).toEqual(['http://100.64.0.10:56036']);
		expect(rows[0]).toMatchObject({
			availability: 'unmeasured',
			identityHint: undefined,
			requiresManifest: true,
			expiresAt: 61000,
		});
	});
	it('caps each refresh at 32 unique peers and requires a supported tailnet DNS suffix', () => {
		const peers = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [
				String(i),
				{
					...peer,
					ID: 'n-' + i,
					DNSName: 'host-' + i + '.synthetic.ts.net',
					TailscaleIPs: ['100.64.1.' + (i + 1)],
				},
			])
		);
		const rows = tailscalePeerDiscovery(metadata(peers)).candidates;
		expect(rows).toHaveLength(32);
		expect(new Set(rows.map((row) => row.endpoint)).size).toBe(32);
		for (const CurrentTailnet of [{}, { MagicDNSSuffix: 'evil.test' }])
			expect(tailscalePeerDiscovery(metadata(peers, { CurrentTailnet })).candidates).toEqual([]);
	});
});
