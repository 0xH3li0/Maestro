import { nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { RelayLedger } from '../../../main/plugins/relay-ledger';
import { fakeAnchor } from '../../helpers/mockAnchor';
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(limits = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ledger-'));
	dirs.push(base);
	const anchor = fakeAnchor({ value: null });
	return {
		base,
		anchor,
		store: new RelayLedger(base, anchor, limits),
		reopen: () => new RelayLedger(base, anchor, limits),
	};
}
const receipt = (text: string) =>
	JSON.stringify({
		promptHash: 'hash',
		messageId: 'message',
		result: { success: true, response: text, sessionId: 'provider', tabId: 'tab' },
	});
describe('indexed durable Relay receipts', () => {
	it('persists outcomes and permanent tombstones after response eviction and uninstall', () => {
		const f = fixture({ responseCount: 1 });
		f.store.set('m1', receipt('first'));
		f.store.set('m2', receipt('second'));
		expect(JSON.parse(f.reopen().get('m1')!).result).toMatchObject({
			success: true,
			response: null,
			sessionId: 'provider',
		});
		expect(JSON.parse(f.reopen().get('m2')!).result.response).toBe('second');
		f.store.set(
			'mapping',
			JSON.stringify({
				agentId: 'agent',
				tabId: 'tab',
				conversationId: 'conversation',
				providerSessionId: 'provider',
			})
		);
		expect(f.store.mappingKeys()).toEqual(['mapping']);
		f.store.purgeMappings();
		expect(f.reopen().mappingKeys()).toEqual([]);
		expect(JSON.parse(f.reopen().get('m1')!).result.success).toBe(true);
		expect(f.reopen().get('m2')).not.toBeNull();
	});
	it('refuses new admissions at capacity while existing outcomes and replays remain available', () => {
		const f = fixture({ messages: 2 });
		f.store.set('m1', receipt('first'));
		f.store.set('m2', receipt('second'));
		expect(() => f.store.set('m3', receipt('third'))).toThrow(/capacity/);
		expect(f.store.get('m1')).not.toBeNull();
		expect(f.reopen().get('m2')).not.toBeNull();
		expect(() => f.store.deletePending('m1')).toThrow();
	});
	it('fails closed on rollback, deletion, authenticated-row removal and checkpoint failure', () => {
		const f = fixture();
		f.store.set('m1', receipt('first'));
		const snapshot = fs.readFileSync(path.join(f.base, 'receipts.sqlite'));
		f.store.set('m2', receipt('second'));
		fs.writeFileSync(path.join(f.base, 'receipts.sqlite'), snapshot);
		expect(() => f.reopen().get('m2')).toThrow(/rollback/);
		const g = fixture();
		g.store.set('m1', receipt('one'));
		const db = new Database(path.join(g.base, 'receipts.sqlite'));
		db.prepare('DELETE FROM entries WHERE key=?').run('m1');
		db.close();
		expect(() => g.reopen().get('m1')).toThrow(/deletion/);
		const h = fixture();
		h.store.set('m1', receipt('one'));
		fs.unlinkSync(path.join(h.base, 'receipts.sqlite'));
		expect(() => h.reopen().get('m1')).toThrow(/removed/);
	});
	it('never silently adopts an existing unauthenticated legacy JSON store', () => {
		const f = fixture();
		fs.mkdirSync(path.join(f.base, 'sh.maestro.relay'));
		fs.writeFileSync(path.join(f.base, 'sh.maestro.relay', 'store.json'), '{}');
		expect(() => f.store.get('new')).toThrow(/authenticated migration/);
	});
	it('checks committed counts and refuses a hidden mapping index instead of trusting SQL selectors', () => {
		const f = fixture();
		f.store.set('map', JSON.stringify({ agentId: 'a', tabId: 't', conversationId: 'c' }));
		const db = new Database(path.join(f.base, 'receipts.sqlite'));
		db.prepare("UPDATE entries SET kind='receipt' WHERE key='map'").run();
		db.close();
		expect(() => f.reopen().mappingKeys()).toThrow(/index integrity/);
	});
	it('keeps uncertain admissions fenced when checkpoint writing fails before or after the external write', () => {
		const f = fixture();
		f.store.set('pending', JSON.stringify({ promptHash: 'hash', messageId: 'message' }));
		const original = f.anchor.write;
		f.anchor.write = () => {
			throw Error('locked fixture checkpoint');
		};
		expect(() => f.store.set('second', receipt('two'))).toThrow(/locked/);
		f.anchor.write = original;
		expect(f.reopen().get('pending')).not.toBeNull();
		expect(f.reopen().get('second')).toBeNull();
		f.anchor.write = (value) => {
			original(value);
			throw Error('crash after checkpoint');
		};
		expect(() => f.store.set('second', receipt('two'))).toThrow(/crash/);
		f.anchor.write = original;
		expect(() => f.reopen().get('second')).toThrow(/rollback/);
	});
	it('rejects dangling receipt symlinks before creating a checkpoint or following the target', () => {
		const f = fixture();
		const outside = path.join(f.base, 'outside.sqlite');
		fs.symlinkSync(outside, path.join(f.base, 'receipts.sqlite'));
		expect(() => f.store.get('new')).toThrow(/private directory or regular file/);
		expect(f.anchor.read()).toBeNull();
		expect(fs.existsSync(outside)).toBe(false);
	});
	it('discards a tampered response without erasing its execution fence', () => {
		const f = fixture();
		f.store.set('m1', receipt('one'));
		const db = new Database(path.join(f.base, 'receipts.sqlite'));
		db.prepare("UPDATE responses SET body='forged' WHERE key='m1'").run();
		db.close();
		expect(JSON.parse(f.reopen().get('m1')!).result).toMatchObject({
			success: true,
			response: null,
		});
	});
});
