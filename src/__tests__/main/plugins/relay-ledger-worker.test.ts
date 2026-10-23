import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { RelayLedgerClient } from '../../../main/plugins/relay-ledger-client';
let dir: string;
let script: string;
let killFile: string;
beforeAll(async () => {
	fs.mkdirSync('.maestro/scratch', { recursive: true });
	dir = fs.mkdtempSync(path.resolve('.maestro/scratch/relay-worker-'));
	script = path.join(dir, 'worker.cjs');
	const anchor = path.join(dir, 'fixture-anchor.cjs');
	killFile = path.join(dir, 'kill-mode');
	fs.writeFileSync(
		anchor,
		`const fs=require('fs'),path=require('path'); const root=${JSON.stringify(dir)}; exports.createKeyringAnchor=(_service,account)=>{const file=path.join(root,account+'.json');return {available:()=>true,read:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,write:(v)=>{const mode=fs.existsSync(path.join(root,'kill-mode'))?fs.readFileSync(path.join(root,'kill-mode'),'utf8'):''; const pending=!!JSON.parse(v.installSecret).pending;if(mode==='stable-before'&&!pending)process.exit(71);fs.writeFileSync(file,JSON.stringify(v));if((mode==='prepared-after'&&pending)||(mode==='stable-after'&&!pending))process.exit(72);}};};`
	);
	await build({
		entryPoints: ['src/main/plugins/relay-ledger-worker.ts'],
		outfile: script,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		plugins: [
			{
				name: 'test-checkpoint',
				setup(b) {
					b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
						path: 'node-sqlite-adapter',
						namespace: 'test-sqlite',
					}));
					b.onLoad({ filter: /.*/, namespace: 'test-sqlite' }, () => ({
						contents: `import { nodeSqliteBetterSqlite3Mock } from ${JSON.stringify(path.resolve('src/__tests__/helpers/nodeSqlite.ts'))}; export default nodeSqliteBetterSqlite3Mock().default;`,
						resolveDir: process.cwd(),
					}));
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
	it.each(['prepared-after', 'stable-before', 'stable-after'])(
		'recovers real worker termination at %s without acknowledging an unsafe admission',
		async (stage) => {
			const base = path.join(dir, stage);
			const client = new RelayLedgerClient(base, undefined, script);
			await client.set(
				'baseline',
				JSON.stringify({
					promptHash: 'h',
					messageId: 'old',
					result: { success: true, response: 'old' },
				})
			);
			fs.writeFileSync(killFile, stage);
			let providerStarts = 0;
			try {
				await expect(
					client
						.reserveTurn('pending', JSON.stringify({ promptHash: 'h', messageId: 'new' }))
						.then(() => {
							providerStarts++;
						})
				).rejects.toThrow(/worker unavailable/);
			} finally {
				fs.rmSync(killFile, { force: true });
				await client.dispose();
			}
			expect(providerStarts).toBe(0);
			const restarted = new RelayLedgerClient(base, undefined, script);
			try {
				const receipt = await restarted.get('pending');
				if (stage === 'prepared-after') expect(receipt).toBeNull();
				else
					expect(JSON.parse(receipt!)).toMatchObject({
						providerReservation: true,
						messageId: 'new',
					});
				expect(await restarted.get('baseline')).not.toBeNull();
			} finally {
				await restarted.dispose();
			}
		}
	);
});
