/**
 * The Dataview service (D2, DV-3 to DV-7): the one owner of every open `VaultIndex` in the main process.
 *
 * - One index per `(root, sshRemoteId)`, opened on first use. `getIndex(filePath, agent)` resolves the
 *   file's vault root (DV-4) and returns that root's index, ready to query.
 * - An index nobody queried for {@link DATAVIEW_INDEX_IDLE_MS} is disposed: its watcher or poller stops
 *   and its pending cache write lands. At most {@link DATAVIEW_MAX_OPEN_ROOTS} roots stay open; opening
 *   one more disposes the least recently queried.
 * - Revisions never go back for a root. A reopened index (after idle disposal, eviction, or a rebuild)
 *   counts on from where the last one stopped, so a consumer that keyed a result by `(root, revision)`
 *   never mistakes a new answer for an old one.
 * - `onChange` relays every index's changes with the root they belong to (DV-7).
 *
 * IPC handlers and the WS bridge (the CLI) both call this one instance (`getDataviewService()`), so every
 * surface reads the same index. The request methods (`query`, `queryInline`, `indexStatus`, `rebuildIndex`)
 * are the handler bodies: they take the wire requests, resolve the agent in main, and answer in wire form.
 * The quit handler calls `shutdownDataviewService()`.
 */

import * as path from 'path';
import { app } from 'electron';
import { getSshRemoteById } from '../stores/getters';
import { sshUnresolvedRemoteMessage } from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import { isAbsolutePath } from '../../shared/formatters';
import {
	executeDql,
	executeInlineDql,
	extractDataviewBlocks,
	type DataviewChangeEvent,
	type DataviewErrorResult,
	type DataviewFileBlock,
	type DataviewFileQueryRequest,
	type DataviewFileQueryResult,
	type DataviewIndexStatus,
	type DataviewInlineQueryRequest,
	type DataviewInlineResult,
	type DataviewQueryRequest,
	type DataviewQueryResponse,
	type DataviewRebuildRequest,
	type DataviewResult,
	type DataviewStatusRequest,
} from '../../shared/dataview';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { DATAVIEW_CACHE_DIR_NAME, dataviewCacheFilePath, deleteVaultCache } from './vault-cache';
import { createLocalVaultFs, createRemoteVaultFs, type VaultFs } from './vault-fs';
import { VaultIndex } from './vault-index';
import { resolveVaultRoot } from './vault-root';
import { toVaultRelativePath } from './vault-watcher';
import { resolveDataviewAgentContext } from './agent-context';

const LOG_CONTEXT = 'Dataview';

/** An index with no query for this long is disposed (watcher stopped, cache flushed). */
export const DATAVIEW_INDEX_IDLE_MS = 10 * 60 * 1000;

/** Most roots indexed at once. Opening one more disposes the least recently queried. */
export const DATAVIEW_MAX_OPEN_ROOTS = 8;

/** The agent a query runs for: where a file outside any vault is rooted, and which remote it lives on. */
export interface DataviewAgentContext {
	agentCwd: string;
	sshRemoteId?: string | null;
}

// The wire shapes live in `src/shared/dataview/types.ts`, so the preload and the CLI can name them.
export type { DataviewChangeEvent, DataviewIndexStatus };

export type DataviewChangeListener = (event: DataviewChangeEvent) => void;

export interface DataviewServiceOptions {
	/** The folder holding cache files. Null keeps nothing on disk. Defaults to `<userData>/dataview-cache`. */
	cacheDir?: () => string | null;
	/** Defaults to `resolveVaultRoot`. */
	resolveRoot?: typeof resolveVaultRoot;
	/** Defaults to a local `VaultFs`, or a remote one for a configured SSH remote. */
	createVaultFs?: (root: string, sshRemoteId: string | null) => VaultFs;
	/** Whether indexes watch (local) or poll (remote) once open. Defaults to true. */
	watch?: boolean;
	/** Defaults to `resolveDataviewAgentContext` (the stored agent record). */
	resolveAgent?: (agentId: string) => DataviewAgentContext;
}

interface IndexEntry {
	key: string;
	index: VaultIndex;
	/** Settles when the index has opened; rejects when it could not. */
	ready: Promise<void>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	unsubscribe: () => void;
}

function defaultCacheDir(): string {
	return path.join(app.getPath('userData'), DATAVIEW_CACHE_DIR_NAME);
}

function defaultVaultFs(root: string, sshRemoteId: string | null): VaultFs {
	if (!sshRemoteId) return createLocalVaultFs(root);
	const sshRemote = getSshRemoteById(sshRemoteId);
	// Never fall back to the local disk: the same path there is a different folder.
	if (!sshRemote)
		throw new Error(sshUnresolvedRemoteMessage({ enabled: true, remoteId: sshRemoteId }));
	return createRemoteVaultFs(root, sshRemote);
}

/** One spelling per root: a local root resolved and without a trailing separator, a remote one normalized. */
export function normalizeVaultRoot(root: string, sshRemoteId: string | null): string {
	if (!sshRemoteId) return path.resolve(root);
	const normalized = path.posix.normalize(root);
	return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function rootKey(root: string, sshRemoteId: string | null): string {
	return `${sshRemoteId ?? ''}\0${root}`;
}

export class DataviewService {
	/** Open indexes in least-recently-queried order: the first entry is the next to evict. */
	private readonly entries = new Map<string, IndexEntry>();
	/** A root being disposed or having its cache deleted. A new index for it waits for this first. */
	private readonly closing = new Map<string, Promise<void>>();
	/** The revision each root's last index ended at, so a reopened one counts on from there. */
	private readonly revisionFloors = new Map<string, number>();
	private readonly listeners = new Set<DataviewChangeListener>();
	private readonly cacheDir: () => string | null;
	private readonly resolveRoot: typeof resolveVaultRoot;
	private readonly createVaultFs: (root: string, sshRemoteId: string | null) => VaultFs;
	private readonly watch: boolean;
	private readonly resolveAgent: (agentId: string) => DataviewAgentContext;

	constructor(options: DataviewServiceOptions = {}) {
		this.cacheDir = options.cacheDir ?? defaultCacheDir;
		this.resolveRoot = options.resolveRoot ?? resolveVaultRoot;
		this.createVaultFs = options.createVaultFs ?? defaultVaultFs;
		this.watch = options.watch ?? true;
		this.resolveAgent = options.resolveAgent ?? resolveDataviewAgentContext;
	}

	/** How many roots are open right now. */
	get openRootCount(): number {
		return this.entries.size;
	}

	/**
	 * The ready index of the vault `filePath` belongs to (DV-4: the nearest `.obsidian/` ancestor, else the
	 * agent's cwd), opening it on first use. Counts as a query: it keeps the root open for another
	 * {@link DATAVIEW_INDEX_IDLE_MS}. Throws when the root cannot be resolved or opened; a later call
	 * tries again.
	 */
	async getIndex(filePath: string, agent: DataviewAgentContext): Promise<VaultIndex> {
		const sshRemoteId = agent.sshRemoteId ?? null;
		const root = await this.resolveRoot(filePath, { agentCwd: agent.agentCwd, sshRemoteId });
		return this.openRoot(root, sshRemoteId);
	}

	/**
	 * Run one `dataview` block with `this` bound to the note at `filePath` (`dataview:query`). Query
	 * problems come back as an error result (DV-9); a bad request, an unknown agent, an unresolvable SSH
	 * remote, or a root that cannot be opened throws.
	 */
	async query(request: DataviewQueryRequest): Promise<DataviewQueryResponse<DataviewResult>> {
		const source = requireString(request?.source, 'source');
		return this.runForNote(request, (index, thisPath) => executeDql(source, thisPath, index));
	}

	/** Evaluate one inline `` `= expr` `` against the note at `filePath` (`dataview:queryInline`). */
	async queryInline(
		request: DataviewInlineQueryRequest
	): Promise<DataviewQueryResponse<DataviewInlineResult>> {
		const expression = requireString(request?.expression, 'expression');
		return this.runForNote(request, async (index, thisPath) =>
			executeInlineDql(expression, thisPath, index)
		);
	}

	/**
	 * Run the `dataview` blocks of the note at `filePath` (`maestro-cli dataview query`): the one at
	 * position `block` among them, or every one. The note is read through the vault's own file system, so
	 * an SSH note is read on its remote. A `dataviewjs` fence is listed without a result. A `block` past
	 * the last fence answers with no blocks and the real `blockCount`.
	 */
	async queryFile(
		request: DataviewFileQueryRequest
	): Promise<DataviewQueryResponse<DataviewFileQueryResult>> {
		const wanted = request?.block;
		if (wanted !== undefined && (!Number.isInteger(wanted) || wanted < 1)) {
			throw new Error('Dataview: block must be a whole number from 1');
		}
		return this.runForNote(request, async (index, thisPath): Promise<DataviewFileQueryResult> => {
			const fences = extractDataviewBlocks(await index.fs.readText(thisPath));
			const blocks: DataviewFileBlock[] = [];
			let position = 0;
			for (const fence of fences) {
				const block = fence.language === 'dataview' ? ++position : null;
				if (wanted !== undefined && block !== wanted) continue;
				blocks.push({
					...fence,
					block,
					...(block === null ? {} : { result: await executeDql(fence.source, thisPath, index) }),
				});
			}
			return { kind: 'blocks', blockCount: position, blocks };
		});
	}

	/**
	 * The open roots `dataview:status` reports: the named root (none when it is not open), or every open
	 * root. Never opens anything.
	 */
	indexStatus(request: DataviewStatusRequest = {}): DataviewIndexStatus[] {
		if (request.root === undefined) return this.statuses();
		const root = requireString(request.root, 'root');
		const status = this.status(root, this.remoteIdFor(request.agentId));
		return status ? [status] : [];
	}

	/** Rebuild one root from scratch (`dataview:rebuild`). */
	async rebuildIndex(request: DataviewRebuildRequest): Promise<DataviewIndexStatus> {
		const root = requireAbsolutePath(request?.root, 'root');
		return this.rebuild(root, this.remoteIdFor(request.agentId));
	}

	/** The state of an open root, or null when it is not open. */
	status(root: string, sshRemoteId: string | null = null): DataviewIndexStatus | null {
		const entry = this.entries.get(rootKey(normalizeVaultRoot(root, sshRemoteId), sshRemoteId));
		return entry ? statusOf(entry.index) : null;
	}

	/** The state of every open root, most recently queried last. */
	statuses(): DataviewIndexStatus[] {
		return Array.from(this.entries.values(), (entry) => statusOf(entry.index));
	}

	/**
	 * Drop a root's disk cache and index it again from scratch. Works whether or not the root is open, and
	 * leaves it open. Resolves with the new status once the full scan has finished.
	 */
	async rebuild(root: string, sshRemoteId: string | null = null): Promise<DataviewIndexStatus> {
		const normalized = normalizeVaultRoot(root, sshRemoteId);
		const key = rootKey(normalized, sshRemoteId);
		const entry = this.entries.get(key);
		if (entry) {
			this.detach(entry);
			this.trackClosing(key, () => this.disposeEntry(entry).then(() => this.dropCache(key)));
		} else {
			this.trackClosing(key, () => this.dropCache(key));
		}
		await this.closing.get(key);
		return statusOf(await this.openRoot(normalized, sshRemoteId));
	}

	/** Subscribe to every open index's changes. Returns the unsubscribe function. */
	onChange(listener: DataviewChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Dispose every open index: stop every watcher, poller, and idle timer, and flush pending cache
	 * writes. The service stays usable; the next query opens its root again.
	 */
	async disposeAll(): Promise<void> {
		for (const entry of [...this.entries.values()]) this.close(entry);
		await Promise.all(this.closing.values());
	}

	/** Open the note's index and run `run` with the note's vault-relative path bound as `this`. */
	private async runForNote<R>(
		request: { filePath: string; agentId: string },
		run: (index: VaultIndex, thisPath: string) => Promise<R>
	): Promise<DataviewQueryResponse<R | DataviewErrorResult>> {
		const filePath = requireAbsolutePath(request.filePath, 'filePath');
		const agent = this.resolveAgent(requireString(request.agentId, 'agentId'));
		const index = await this.getIndex(filePath, agent);
		const sshRemoteId = index.fs.sshRemoteId;
		// Read before running: a change that lands mid-query then carries a newer revision, and the
		// consumer re-runs instead of keeping a result that might predate it.
		const revision = index.revision;
		const thisPath = toVaultRelativePath(index.root, filePath, sshRemoteId ? path.posix : path);
		if (thisPath === null) {
			// The agent's cwd roots the note, but the note sits outside it: `this` has no page.
			return {
				root: index.root,
				sshRemoteId,
				revision,
				path: filePath,
				result: {
					kind: 'error',
					message: `Dataview: ${filePath} is outside the vault root ${index.root}`,
				},
			};
		}
		return {
			root: index.root,
			sshRemoteId,
			revision,
			path: thisPath,
			result: await run(index, thisPath),
		};
	}

	/** The SSH remote of the agent that names a root; a local root without one. */
	private remoteIdFor(agentId: string | undefined): string | null {
		if (agentId === undefined) return null;
		return this.resolveAgent(requireString(agentId, 'agentId')).sshRemoteId ?? null;
	}

	private async openRoot(root: string, sshRemoteId: string | null): Promise<VaultIndex> {
		const normalized = normalizeVaultRoot(root, sshRemoteId);
		const key = rootKey(normalized, sshRemoteId);
		let entry = this.entries.get(key);
		if (entry) {
			// Re-insert, so the map's order stays least recently queried first.
			this.entries.delete(key);
		} else {
			entry = this.createEntry(key, normalized, sshRemoteId);
		}
		this.entries.set(key, entry);
		this.armIdleTimer(entry);
		this.evictOverCap();
		await entry.ready;
		return entry.index;
	}

	private createEntry(key: string, root: string, sshRemoteId: string | null): IndexEntry {
		const index = new VaultIndex(this.createVaultFs(root, sshRemoteId), {
			cacheDir: this.cacheDir() ?? undefined,
			watch: this.watch,
		});
		const unsubscribe = index.onChange((change) =>
			this.emit({ root, sshRemoteId, revision: change.revision, changedPaths: change.changedPaths })
		);
		const entry: IndexEntry = {
			key,
			index,
			ready: Promise.resolve(),
			idleTimer: null,
			unsubscribe,
		};
		// Wait for the root's previous index to finish closing: its last cache write lands first, and
		// its final revision is the floor this one counts on from.
		const previous = this.closing.get(key) ?? Promise.resolve();
		entry.ready = previous
			.then(() => {
				index.revision = Math.max(index.revision, this.revisionFloors.get(key) ?? 0);
				return index.open();
			})
			.catch((error: unknown) => {
				// Forget the failed index, so the next query tries again.
				if (this.entries.get(key) === entry) this.close(entry);
				throw error;
			});
		return entry;
	}

	private armIdleTimer(entry: IndexEntry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			if (this.entries.get(entry.key) !== entry) return;
			logger.debug(`Dataview closed the idle index of ${entry.index.root}`, LOG_CONTEXT);
			this.close(entry);
		}, DATAVIEW_INDEX_IDLE_MS);
		entry.idleTimer.unref?.();
	}

	private evictOverCap(): void {
		while (this.entries.size > DATAVIEW_MAX_OPEN_ROOTS) {
			const oldest = this.entries.values().next().value as IndexEntry;
			logger.debug(
				`Dataview closed the index of ${oldest.index.root}: more than ${DATAVIEW_MAX_OPEN_ROOTS} roots open`,
				LOG_CONTEXT
			);
			this.close(oldest);
		}
	}

	/** Take an entry out of service now and dispose it in the background. */
	private close(entry: IndexEntry): void {
		this.detach(entry);
		this.trackClosing(entry.key, () => this.disposeEntry(entry));
	}

	/** Stop routing queries and events to an entry. Synchronous, so the next query opens a new one. */
	private detach(entry: IndexEntry): void {
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
		entry.unsubscribe();
	}

	/** Run `work` after anything already closing this root, and record it as the root's closing step. */
	private trackClosing(key: string, work: () => Promise<void>): void {
		const step = (this.closing.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
			logger.warn(`Dataview could not close an index cleanly: ${String(error)}`, LOG_CONTEXT);
			void captureException(error, { operation: 'dataview:closeIndex' });
		});
		const done = step.finally(() => {
			if (this.closing.get(key) === done) this.closing.delete(key);
		});
		this.closing.set(key, done);
	}

	private async disposeEntry(entry: IndexEntry): Promise<void> {
		// An index still opening finishes first (or fails), so dispose sees its final state.
		await entry.ready.catch(() => undefined);
		await entry.index.dispose();
		const floor = this.revisionFloors.get(entry.key) ?? 0;
		this.revisionFloors.set(entry.key, Math.max(floor, entry.index.revision));
	}

	private async dropCache(key: string): Promise<void> {
		const cacheDir = this.cacheDir();
		if (!cacheDir) return;
		const separator = key.indexOf('\0');
		const sshRemoteId = key.slice(0, separator) || null;
		await deleteVaultCache(dataviewCacheFilePath(cacheDir, key.slice(separator + 1), sshRemoteId));
	}

	private emit(event: DataviewChangeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn(`Dataview change listener failed: ${String(error)}`, LOG_CONTEXT);
			}
		}
	}
}

/** A request field that must be a non-empty string. Requests cross IPC and the WS bridge unchecked. */
function requireString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`Dataview: ${name} must be a non-empty string`);
	}
	return value;
}

/** A request path that must be absolute: main has no meaningful cwd to resolve a relative one against. */
function requireAbsolutePath(value: unknown, name: string): string {
	const text = requireString(value, name);
	if (!isAbsolutePath(text)) throw new Error(`Dataview: ${name} must be an absolute path`);
	return text;
}

function statusOf(index: VaultIndex): DataviewIndexStatus {
	return {
		root: index.root,
		sshRemoteId: index.fs.sshRemoteId,
		pageCount: index.pages.size,
		revision: index.revision,
		lastScanDurationMs: index.lastScan?.durationMs ?? null,
		lastScanAt: index.lastScan?.finishedAt ?? null,
		cacheHit: index.cacheHit,
		watchMode: index.watchMode,
	};
}

let service: DataviewService | null = null;

/** The singleton, created on first use. */
export function getDataviewService(): DataviewService {
	service ??= new DataviewService();
	return service;
}

/**
 * Dispose every open index on app quit. Never creates the service. Quit force-exits shortly after
 * cleanup, so a cache write cut off here is lost; the next open reconciles the root by `mtime` and `size`.
 */
export function shutdownDataviewService(): Promise<void> {
	return service?.disposeAll() ?? Promise.resolve();
}

/** Test seam. */
export function setDataviewServiceForTests(next: DataviewService | null): void {
	service = next;
}
