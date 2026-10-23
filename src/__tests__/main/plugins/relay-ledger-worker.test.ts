import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { RelayLedgerClient } from '../../../main/plugins/relay-ledger-client';
let dir: string;
let script: string;
beforeAll(async () => {
	fs.mkdirSync('.maestro/scratch', { recursive: true });
	dir = fs.mkdtempSync(path.resolve('.maestro/scratch/relay-worker-'));
	script = path.join(dir, 'worker.cjs');
	const anchor = path.join(dir, 'fixture-anchor.cjs');
	fs.writeFileSync(
		anchor,
		`const fs=require('fs'); const file=${JSON.stringify(path.join(dir, 'fixture-checkpoint.json'))}; exports.createKeyringAnchor=()=>({available:()=>true,read:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,write:(v)=>fs.writeFileSync(file,JSON.stringify(v))});`
	);
	await build({
		entryPoints: ['src/main/plugins/relay-ledger-worker.ts'],
		outfile: script,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['better-sqlite3'],
		plugins: [
			{
				name: 'test-checkpoint',
				setup(b) {
					b.onResolve({ filter: /keyring-anchor$/ }, () => ({ path: anchor }));
				},
			},
		],
	});
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
describe('real Relay worker transport', () => {
	it('persists through worker restart and bounds its pending queue without inline fallback', async () => {
		const base = path.join(dir, 'receipts');
		const first = new RelayLedgerClient(base, { responseCount: 1 }, script);
		try {
			await first.set(
				'm1',
				JSON.stringify({
					promptHash: 'h',
					messageId: '1',
					result: { success: true, response: 'one' },
				})
			);
			await first.set(
				'm2',
				JSON.stringify({
					promptHash: 'h',
					messageId: '2',
					result: { success: true, response: 'two' },
				})
			);
		} finally {
			await first.dispose();
		}
		const restarted = new RelayLedgerClient(base, undefined, script);
		try {
			expect(JSON.parse((await restarted.get('m1'))!).result).toMatchObject({
				success: true,
				response: null,
			});
			const pending = Array.from({ length: 129 }, () => restarted.get('m1'));
			const results = await Promise.allSettled(pending);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(128);
			expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
		} finally {
			await restarted.dispose();
		}
	});
	it('rejects worker loading failure instead of resetting stored execution state', async () => {
		const client = new RelayLedgerClient(
			path.join(dir, 'receipts'),
			undefined,
			path.join(dir, 'missing.cjs')
		);
		try {
			await expect(client.get('m1')).rejects.toThrow(/worker unavailable/);
		} finally {
			await client.dispose();
		}
	});
});
