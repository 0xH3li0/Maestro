/** Indexed host-private Relay receipts. Responses expire; execution fences do not. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { AnchorStore } from '../utils/keyring-anchor';

export interface RelayLedgerLimits {
	messages: number;
	mappings: number;
	responseBytes: number;
	responseCount: number;
	valueBytes: number;
}
export const RELAY_LEDGER_LIMITS: Readonly<RelayLedgerLimits> = Object.freeze({
	messages: 1_000_000,
	mappings: 10_000,
	responseBytes: 32 * 1024 * 1024,
	responseCount: 256,
	valueBytes: 256 * 1024,
});
interface Row {
	key: string;
	kind: string;
	value: string;
	proof: string;
	agent_id: string | null;
	provider_id: string | null;
}
interface Checkpoint {
	key: string;
	root: string;
}

/** Owns one connection per synchronous operation: no open handle survives app shutdown.
 * An independent credential-store checkpoint detects file rollback/deletion. It never
 * reads or changes plugin grants, their epoch, or provider authorization.
 */
export class RelayLedger {
	private readonly file: string;
	private readonly limits: RelayLedgerLimits;
	private failed = false;
	private readonly empty: string[] = [];
	constructor(
		private readonly baseDir: string,
		private readonly anchor: AnchorStore,
		limits: Partial<RelayLedgerLimits> = {}
	) {
		this.empty[16] = createHash('sha256').update('relay-empty-leaf-v1').digest('hex');
		for (let depth = 15; depth >= 0; depth--)
			this.empty[depth] = this.node(this.empty[depth + 1], this.empty[depth + 1]);
		this.file = path.join(baseDir, 'receipts.sqlite');
		this.limits = { ...RELAY_LEDGER_LIMITS, ...limits };
		for (const value of Object.values(this.limits))
			if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid Relay ledger limit');
	}
	private digest(checkpoint: Checkpoint, key: string, kind: string, value: string): string {
		return createHmac('sha256', checkpoint.key)
			.update(canonicalJson(['relay-ledger-v1', key, kind, value]))
			.digest('hex');
	}
	private node(left: string, right: string): string {
		return createHash('sha256')
			.update('relay-node-v1:' + left + right)
			.digest('hex');
	}
	private route(key: string): string {
		return [...createHash('sha256').update(key).digest().subarray(0, 2)]
			.map((n) => n.toString(2).padStart(8, '0'))
			.join('');
	}
	private bucket(db: Database.Database, checkpoint: Checkpoint, bucket: number): string {
		const rows = db
			.prepare('SELECT key,kind,value,proof FROM entries WHERE bucket=? ORDER BY key LIMIT 257')
			.all(bucket) as Row[];
		if (rows.length > 256) throw Error('Relay receipt index bucket capacity reached');
		if (!rows.length) return this.empty[16];
		for (const row of rows) {
			if (
				parseInt(this.route(row.key), 2) !== bucket ||
				this.digest(checkpoint, row.key, row.kind, row.value) !== row.proof
			)
				throw Error('Relay receipt integrity failure');
		}
		return createHash('sha256')
			.update(canonicalJson(['relay-bucket-v1', rows.map((row) => [row.key, row.proof])]))
			.digest('hex');
	}
	private verify(db: Database.Database, checkpoint: Checkpoint, key: string): Row | undefined {
		const row = db.prepare('SELECT * FROM entries WHERE key=?').get(key) as Row | undefined;
		if (row && this.digest(checkpoint, row.key, row.kind, row.value) !== row.proof)
			throw Error('Relay receipt integrity failure');
		const route = this.route(key);
		let root = this.bucket(db, checkpoint, parseInt(route, 2));
		for (let depth = 15; depth >= 0; depth--) {
			const bit = route[depth],
				sibling = route.slice(0, depth) + (bit === '0' ? '1' : '0');
			const other = db.prepare('SELECT hash FROM tree WHERE prefix=?').get(sibling) as
				| { hash: string }
				| undefined;
			const hash = other?.hash ?? this.empty[depth + 1];
			root = bit === '0' ? this.node(root, hash) : this.node(hash, root);
		}
		if (root !== checkpoint.root) {
			this.failed = true;
			throw Error('Relay receipt rollback or deletion detected');
		}
		return row;
	}
	private updateTree(db: Database.Database, key: string): string {
		const route = this.route(key);
		const anchor = this.anchor.read();
		if (!anchor) throw Error('Relay receipt checkpoint unavailable');
		const checkpoint = JSON.parse(anchor.installSecret) as Checkpoint;
		const rootBucket = this.bucket(db, checkpoint, parseInt(route, 2));
		let root = rootBucket;
		const write = (prefix: string, hash: string, depth: number) => {
			if (hash === this.empty[depth]) db.prepare('DELETE FROM tree WHERE prefix=?').run(prefix);
			else
				db.prepare(
					'INSERT INTO tree VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET hash=excluded.hash'
				).run(prefix, hash);
		};
		write(route, root, 16);
		for (let depth = 15; depth >= 0; depth--) {
			const bit = route[depth],
				sibling = route.slice(0, depth) + (bit === '0' ? '1' : '0');
			const other = db.prepare('SELECT hash FROM tree WHERE prefix=?').get(sibling) as
				| { hash: string }
				| undefined;
			const hash = other?.hash ?? this.empty[depth + 1];
			root = bit === '0' ? this.node(root, hash) : this.node(hash, root);
			write(route.slice(0, depth), root, depth);
		}
		return root;
	}
	private use<T>(action: (db: Database.Database, checkpoint: Checkpoint, epoch: number) => T): T {
		if (this.failed || !this.anchor.available())
			throw Error('Relay receipt checkpoint unavailable');
		let db: Database.Database | undefined;
		try {
			for (const candidate of [this.baseDir, this.file, this.file + '-wal', this.file + '-shm']) {
				try {
					const stat = fs.lstatSync(candidate);
					if (
						stat.isSymbolicLink() ||
						(candidate === this.baseDir ? !stat.isDirectory() : !stat.isFile())
					)
						throw Error('Relay receipt path must be a private directory or regular file');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
			const anchor = this.anchor.read();
			if (!anchor) {
				// Never bless an existing unauthenticated database or legacy JSON as empty.
				if (
					fs.existsSync(this.file) ||
					fs.existsSync(path.join(this.baseDir, 'sh.maestro.relay', 'store.json'))
				)
					throw Error('Relay receipts require authenticated migration before admission');
				fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
				this.anchor.write({
					installSecret: JSON.stringify({
						key: randomBytes(32).toString('hex'),
						root: this.empty[0],
					}),
					epoch: 0,
				});
			} else if (
				!fs.existsSync(this.file) &&
				!(anchor.epoch === 0 && JSON.parse(anchor.installSecret).root === this.empty[0])
			)
				throw Error('Relay receipt database was removed');
			const current = this.anchor.read();
			if (!current) throw Error('Relay receipt checkpoint unavailable');
			const checkpoint = JSON.parse(current.installSecret) as Checkpoint;
			if (
				!/^[0-9a-f]{64}$/.test(checkpoint.key) ||
				!/^[0-9a-f]{64}$/.test(checkpoint.root) ||
				!Number.isSafeInteger(current.epoch) ||
				current.epoch < 0
			)
				throw Error('Relay receipt checkpoint invalid');
			db = new Database(this.file);
			if (db.pragma('page_size', { simple: true }) !== 4096)
				throw Error('Relay receipt database page size unsupported');
			db.pragma('journal_mode = WAL');
			db.pragma('synchronous = FULL');
			db.pragma('max_page_count = 65536');
			db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,root TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,proof TEXT NOT NULL,agent_id TEXT,provider_id TEXT,bucket INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_bucket ON entries(bucket);
    CREATE INDEX IF NOT EXISTS relay_kind ON entries(kind);
    CREATE INDEX IF NOT EXISTS relay_provider ON entries(agent_id,provider_id) WHERE kind='mapping';
    CREATE TABLE IF NOT EXISTS tree(prefix TEXT PRIMARY KEY,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY,body TEXT NOT NULL,bytes INTEGER NOT NULL,seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_response_order ON responses(seq);`);
			const meta = db.prepare('SELECT epoch,root FROM meta WHERE id=1').get() as
				| { epoch: number; root: string }
				| undefined;
			if (!meta && current.epoch === 0 && checkpoint.root === this.empty[0])
				db.prepare('INSERT INTO meta VALUES (1,0,?)').run(checkpoint.root);
			else if (!meta || meta.epoch !== current.epoch || meta.root !== checkpoint.root)
				throw Error('Relay receipt rollback detected');
			return action(db, checkpoint, current.epoch);
		} finally {
			db?.close();
		}
	}
	get(key: string): string | null {
		return this.use((db, checkpoint) => {
			const row = this.verify(db, checkpoint, key);
			if (!row) return null;
			const value = JSON.parse(row.value);
			if (row.kind === 'receipt' && value.result) {
				const body = db.prepare('SELECT body FROM responses WHERE key=?').get(key) as
					| { body: string }
					| undefined;
				if (body && this.digest(checkpoint, key, 'response', body.body) === value.responseProof)
					value.result.response = body.body;
				else value.result.response = null;
			}
			return JSON.stringify(value);
		});
	}
	mappingKeys(): string[] {
		return this.use((db, checkpoint) => {
			const state = this.verify(db, checkpoint, 'system:counts');
			const counts = state ? JSON.parse(state.value) : {};
			const rows = db
				.prepare("SELECT key FROM entries WHERE kind='mapping' LIMIT ?")
				.all(this.limits.mappings + 1) as { key: string }[];
			if (rows.length !== (counts.mapping ?? 0))
				throw Error('Relay mapping index integrity failure');
			return rows.map((row) => {
				const item = this.verify(db, checkpoint, row.key);
				if (!item || item.kind !== 'mapping') throw Error('Relay mapping integrity failure');
				return row.key;
			});
		});
	}
	private providerKey(agentId: string, providerId: string): string {
		return (
			'binding:' +
			createHash('sha256')
				.update(canonicalJson([agentId, providerId]))
				.digest('hex')
		);
	}
	assertProviderAvailable(agentId: string, providerId: string, conversationId: string): void {
		const prior = this.get(this.providerKey(agentId, providerId));
		if (prior && JSON.parse(prior).conversationId !== conversationId)
			throw Error('Provider session already maps to another Relay conversation');
	}
	private mutate(key: string, value: string | null): void {
		this.use((db, checkpoint, epoch) => {
			if (epoch >= Number.MAX_SAFE_INTEGER) throw Error('Relay receipt checkpoint exhausted');
			const old = this.verify(db, checkpoint, key);
			let kind = '',
				stored = value,
				body: string | undefined,
				agentId: string | null = null,
				providerId: string | null = null;
			if (value !== null) {
				const parsed = JSON.parse(value);
				kind =
					typeof parsed.tabId === 'string' && typeof parsed.agentId === 'string'
						? 'mapping'
						: parsed.providerBinding === true
							? 'binding'
							: 'receipt';
				if (kind === 'mapping') {
					agentId = parsed.agentId;
					providerId = parsed.providerSessionId ?? null;
				} else if (parsed.result) {
					body = typeof parsed.result.response === 'string' ? parsed.result.response : undefined;
					parsed.result = {
						success: parsed.result.success === true,
						response: null,
						sessionId: parsed.result.sessionId ?? null,
						...(parsed.result.error ? { error: String(parsed.result.error).slice(0, 2000) } : {}),
						...(parsed.result.tabId ? { tabId: parsed.result.tabId } : {}),
						...(parsed.result.conversationId
							? { conversationId: parsed.result.conversationId }
							: {}),
					};
					if (body && Buffer.byteLength(body) <= this.limits.valueBytes)
						parsed.responseProof = this.digest(checkpoint, key, 'response', body);
					else body = undefined;
				}
				stored = JSON.stringify(parsed);
				if (Buffer.byteLength(stored) > 64 * 1024) throw Error('Relay ledger metadata too large');
			}
			const countsRow = this.verify(db, checkpoint, 'system:counts');
			const counts: Record<string, number> = countsRow ? JSON.parse(countsRow.value) : {};
			if (old && old.kind !== kind && value !== null)
				throw Error('Relay ledger entry kind conflict');
			if (!old && value !== null) {
				if (
					(counts[kind] ?? 0) >= (kind === 'receipt' ? this.limits.messages : this.limits.mappings)
				)
					throw Error('Relay receipt capacity reached; new admission refused');
				counts[kind] = (counts[kind] ?? 0) + 1;
			} else if (old && value === null) counts[old.kind] = (counts[old.kind] ?? 0) - 1;
			db.transaction(() => {
				let root = checkpoint.root;
				if (stored === null) {
					db.prepare('DELETE FROM entries WHERE key=?').run(key);
					db.prepare('DELETE FROM responses WHERE key=?').run(key);
				} else {
					const proof = this.digest(checkpoint, key, kind, stored);
					db.prepare(
						'INSERT INTO entries VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,value=excluded.value,proof=excluded.proof,agent_id=excluded.agent_id,provider_id=excluded.provider_id,bucket=excluded.bucket'
					).run(key, kind, stored, proof, agentId, providerId, parseInt(this.route(key), 2));
					if (body !== undefined)
						db.prepare(
							'INSERT INTO responses VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,bytes=excluded.bytes,seq=excluded.seq'
						).run(key, body, Buffer.byteLength(body), epoch + 1);
					else db.prepare('DELETE FROM responses WHERE key=?').run(key);
					let total = db
						.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM responses')
						.get() as { n: number; bytes: number };
					while (total.n > this.limits.responseCount || total.bytes > this.limits.responseBytes) {
						const oldest = db
							.prepare('SELECT key,bytes FROM responses ORDER BY seq LIMIT 1')
							.get() as { key: string; bytes: number };
						db.prepare('DELETE FROM responses WHERE key=?').run(oldest.key);
						total = { n: total.n - 1, bytes: total.bytes - oldest.bytes };
					}
				}
				root = this.updateTree(db, key);
				const countValue = JSON.stringify(counts),
					countKey = 'system:counts';
				const countProof = this.digest(checkpoint, countKey, 'system', countValue);
				db.prepare(
					'INSERT INTO entries VALUES (?,?,?,?,NULL,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,proof=excluded.proof'
				).run(countKey, 'system', countValue, countProof, parseInt(this.route(countKey), 2));
				root = this.updateTree(db, countKey);
				db.prepare('UPDATE meta SET epoch=?,root=? WHERE id=1').run(epoch + 1, root);
				const next = { installSecret: JSON.stringify({ ...checkpoint, root }), epoch: epoch + 1 };
				this.anchor.write(next);
				if (canonicalJson(this.anchor.read()) !== canonicalJson(next))
					throw Error('Relay receipt checkpoint write failed');
			})();
		});
	}
	set(key: string, value: string): void {
		const mapping = JSON.parse(value);
		if (
			typeof mapping.agentId === 'string' &&
			typeof mapping.tabId === 'string' &&
			mapping.providerSessionId
		) {
			this.assertProviderAvailable(
				mapping.agentId,
				mapping.providerSessionId,
				mapping.conversationId
			);
			const binding = this.providerKey(mapping.agentId, mapping.providerSessionId);
			if (!this.get(binding))
				this.mutate(
					binding,
					JSON.stringify({ providerBinding: true, conversationId: mapping.conversationId })
				);
		}
		this.mutate(key, value);
	}
	deletePending(key: string): void {
		const value = this.get(key);
		if (!value) return;
		if (value && JSON.parse(value).result) throw Error('Cannot delete an executed Relay receipt');
		this.mutate(key, null);
	}
	/** Uninstall removes mappings and payloads, preserving permanent execution tombstones. */
	purgeMappings(): void {
		for (const key of this.mappingKeys()) this.mutate(key, null);
		this.use((db) => {
			db.prepare('DELETE FROM responses').run();
		});
	}
}
