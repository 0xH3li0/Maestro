/**
 * Tests for the main-process `DataviewService` (src/main/dataview/dataview-service.ts): one index per
 * `(root, sshRemoteId)`, idle disposal, the open-root cap, monotonic revisions across reopens, rebuild,
 * change relay, and failure handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../main/utils/remote-fs', () => ({
	findAncestorWithDirRemote: vi.fn(),
	listFilesWithStatsRemote: vi.fn(),
	readFileRemote: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById: vi.fn(() => undefined) }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	DATAVIEW_INDEX_IDLE_MS,
	DATAVIEW_MAX_OPEN_ROOTS,
	DataviewService,
	getDataviewService,
	normalizeVaultRoot,
	setDataviewServiceForTests,
	shutdownDataviewService,
	type DataviewChangeEvent,
} from '../../../main/dataview/dataview-service';
import type { VaultFs, VaultListing } from '../../../main/dataview/vault-fs';

/** In-memory vaults by root. Each file is `{ text, mtime }` so a test can edit one in place. */
type MemoryVault = Record<string, string>;

function memoryFs(root: string, files: MemoryVault, sshRemoteId: string | null): VaultFs {
	return {
		root,
		sshRemoteId,
		async list(): Promise<VaultListing> {
			const stats = new Map();
			for (const [file, text] of Object.entries(files)) {
				stats.set(file, { size: text.length, mtime: text.length, ctime: 1 });
			}
			return { files: Object.keys(files), folders: [], stats };
		},
		async readText(relPath) {
			if (!(relPath in files)) throw new Error(`ENOENT: ${relPath}`);
			return files[relPath];
		},
	};
}

/** Roots on the local platform, so `normalizeVaultRoot` leaves them as they are. */
const rootAt = (name: string) => path.resolve(os.tmpdir(), 'dataview-service-test', name);

describe('DataviewService', () => {
	let vaults: Map<string, MemoryVault>;
	let lists: Map<string, number>;
	let cacheDir: string | null;
	let service: DataviewService;

	/** Every file resolves to the vault named by its first segment under the test root. */
	const resolveRoot = vi.fn(async (filePath: string) => path.dirname(filePath));

	function vault(name: string, files: MemoryVault = { 'A.md': `# ${name}` }): string {
		const root = rootAt(name);
		vaults.set(root, files);
		return root;
	}

	function createService(): DataviewService {
		return new DataviewService({
			cacheDir: () => cacheDir,
			resolveRoot,
			watch: false,
			createVaultFs: (root, sshRemoteId) => {
				const files = vaults.get(root);
				if (!files) throw new Error(`no vault at ${root}`);
				const vaultFs = memoryFs(root, files, sshRemoteId);
				const list = vaultFs.list.bind(vaultFs);
				vaultFs.list = () => {
					lists.set(root, (lists.get(root) ?? 0) + 1);
					return list();
				};
				return vaultFs;
			},
		});
	}

	const fileIn = (root: string) => path.join(root, 'A.md');
	const agent = { agentCwd: rootAt('cwd') };

	beforeEach(() => {
		vaults = new Map();
		lists = new Map();
		cacheDir = null;
		resolveRoot.mockClear();
		service = createService();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await service.disposeAll();
		if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
	});

	it('opens one index per root on first use and reuses it, concurrent callers included', async () => {
		const root = vault('one');

		const [first, second] = await Promise.all([
			service.getIndex(fileIn(root), agent),
			service.getIndex(fileIn(root), agent),
		]);
		const third = await service.getIndex(fileIn(root), agent);

		expect(first).toBe(second);
		expect(third).toBe(first);
		expect(lists.get(root)).toBe(1);
		expect(first.getPage('A.md')).toBeDefined();
		expect(resolveRoot).toHaveBeenCalledWith(fileIn(root), {
			agentCwd: agent.agentCwd,
			sshRemoteId: null,
		});
		expect(service.openRootCount).toBe(1);
	});

	it('keeps a local and a remote root with the same path apart', async () => {
		const root = vault('shared');

		const local = await service.getIndex(fileIn(root), agent);
		const remote = await service.getIndex(fileIn(root), { ...agent, sshRemoteId: 'remote-1' });

		expect(remote).not.toBe(local);
		expect(remote.fs.sshRemoteId).toBe('remote-1');
		expect(service.status(root)?.sshRemoteId).toBeNull();
		expect(service.status(root, 'remote-1')?.sshRemoteId).toBe('remote-1');
	});

	it('reports the status of an open root and null for one that is not open', async () => {
		const root = vault('status', { 'A.md': 'a', 'B.md': 'b' });
		expect(service.status(root)).toBeNull();

		await service.getIndex(fileIn(root), agent);

		expect(service.status(`${root}${path.sep}`)).toMatchObject({
			root,
			sshRemoteId: null,
			pageCount: 2,
			revision: 1,
			cacheHit: false,
			watchMode: 'none',
		});
		expect(service.status(root)!.lastScanDurationMs).toEqual(expect.any(Number));
		expect(service.statuses().map((status) => status.root)).toEqual([root]);
	});

	it(`disposes an index nobody queried for ${DATAVIEW_INDEX_IDLE_MS / 60000} minutes`, async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const root = vault('idle');
		const index = await service.getIndex(fileIn(root), agent);
		const dispose = vi.spyOn(index, 'dispose');

		// A query restarts the clock.
		vi.advanceTimersByTime(DATAVIEW_INDEX_IDLE_MS - 1);
		await service.getIndex(fileIn(root), agent);
		vi.advanceTimersByTime(DATAVIEW_INDEX_IDLE_MS - 1);
		expect(service.status(root)).not.toBeNull();
		expect(dispose).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(service.status(root)).toBeNull();
		await service.disposeAll();
		expect(dispose).toHaveBeenCalledTimes(1);

		// The next query opens the root again.
		const reopened = await service.getIndex(fileIn(root), agent);
		expect(reopened).not.toBe(index);
		expect(lists.get(root)).toBe(2);
	});

	it(`keeps at most ${DATAVIEW_MAX_OPEN_ROOTS} roots open and evicts the least recently queried`, async () => {
		const roots = Array.from({ length: DATAVIEW_MAX_OPEN_ROOTS + 1 }, (_, i) => vault(`r${i}`));
		const first = await service.getIndex(fileIn(roots[0]), agent);
		const dispose = vi.spyOn(first, 'dispose');
		for (const root of roots.slice(1, DATAVIEW_MAX_OPEN_ROOTS)) {
			await service.getIndex(fileIn(root), agent);
		}
		// Querying r0 again makes r1 the least recently used.
		await service.getIndex(fileIn(roots[0]), agent);

		await service.getIndex(fileIn(roots[DATAVIEW_MAX_OPEN_ROOTS]), agent);

		expect(service.openRootCount).toBe(DATAVIEW_MAX_OPEN_ROOTS);
		expect(service.status(roots[0])).not.toBeNull();
		expect(service.status(roots[1])).toBeNull();
		expect(dispose).not.toHaveBeenCalled();
		expect(service.statuses().at(-1)?.root).toBe(roots[DATAVIEW_MAX_OPEN_ROOTS]);
	});

	it('never lets a root revision go back when its index is reopened', async () => {
		const files: MemoryVault = { 'A.md': 'a' };
		const root = vault('revisions', files);
		const first = await service.getIndex(fileIn(root), agent);
		files['A.md'] = 'a, edited';
		await first.scan();
		expect(first.revision).toBe(2);

		await service.disposeAll();
		const second = await service.getIndex(fileIn(root), agent);

		expect(second).not.toBe(first);
		expect(second.revision).toBe(3);
	});

	it('relays every index change with its root, and stops relaying for a closed index', async () => {
		const files: MemoryVault = { 'A.md': 'a' };
		const root = vault('events', files);
		const events: DataviewChangeEvent[] = [];
		const unsubscribe = service.onChange((event) => events.push(event));

		const index = await service.getIndex(fileIn(root), agent);
		files['B.md'] = 'b';
		await index.scan();
		await service.disposeAll();
		files['C.md'] = 'c';
		await index.scan();
		unsubscribe();

		expect(events).toEqual([
			{ root, sshRemoteId: null, revision: 1, changedPaths: ['A.md'] },
			{ root, sshRemoteId: null, revision: 2, changedPaths: ['B.md'] },
		]);
	});

	it('rebuilds a root from scratch: the cache is dropped and every page parsed again', async () => {
		cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-service-cache-'));
		const root = vault('rebuild', { 'A.md': 'a', 'B.md': 'b' });
		await service.getIndex(fileIn(root), agent);
		await service.disposeAll();

		const warm = await service.getIndex(fileIn(root), agent);
		expect(warm.cacheHit).toBe(true);

		const status = await service.rebuild(root);

		// Revision 1 was the first scan, 2 the warm cache; the rebuild counts on from there.
		expect(status).toMatchObject({ root, pageCount: 2, cacheHit: false, revision: 3 });
		const rebuilt = await service.getIndex(fileIn(root), agent);
		expect(rebuilt).not.toBe(warm);
		expect(rebuilt.lastScan!.parsedCount).toBe(2);
	});

	it('rebuilds a root that is not open', async () => {
		const root = vault('cold');

		const status = await service.rebuild(root);

		expect(status).toMatchObject({ root, pageCount: 1, revision: 1 });
		expect(service.openRootCount).toBe(1);
	});

	it('forgets an index that could not open, so the next query tries again', async () => {
		const files: MemoryVault = { 'A.md': 'a' };
		const root = vault('flaky', files);
		let fail = true;
		const failing = new DataviewService({
			resolveRoot,
			watch: false,
			cacheDir: () => null,
			createVaultFs: (vaultRoot, sshRemoteId) => {
				const vaultFs = memoryFs(vaultRoot, files, sshRemoteId);
				const list = vaultFs.list.bind(vaultFs);
				vaultFs.list = () => (fail ? Promise.reject(new Error('Directory not found')) : list());
				return vaultFs;
			},
		});

		await expect(failing.getIndex(fileIn(root), agent)).rejects.toThrow('Directory not found');
		expect(failing.openRootCount).toBe(0);

		fail = false;
		const index = await failing.getIndex(fileIn(root), agent);
		expect(index.getPage('A.md')).toBeDefined();
		await failing.disposeAll();
	});

	it('refuses an SSH remote that is not configured instead of reading the local disk', async () => {
		const defaults = new DataviewService({ resolveRoot, watch: false, cacheDir: () => null });

		await expect(
			defaults.getIndex('/remote/vault/A.md', { agentCwd: '/remote', sshRemoteId: 'gone' })
		).rejects.toThrow(/gone/);
		expect(defaults.openRootCount).toBe(0);
	});
});

describe('normalizeVaultRoot', () => {
	it('resolves a local root and normalizes a remote one', () => {
		expect(normalizeVaultRoot(path.join(rootAt('x'), '.'), null)).toBe(rootAt('x'));
		expect(normalizeVaultRoot('/home/me/vault/', 'remote-1')).toBe('/home/me/vault');
		expect(normalizeVaultRoot('/home/me//vault/./', 'remote-1')).toBe('/home/me/vault');
		expect(normalizeVaultRoot('/', 'remote-1')).toBe('/');
	});
});

describe('the Dataview service singleton', () => {
	afterEach(() => {
		setDataviewServiceForTests(null);
	});

	it('creates the service on first use and disposes it on shutdown without creating one', async () => {
		setDataviewServiceForTests(null);
		await expect(shutdownDataviewService()).resolves.toBeUndefined();

		const created = getDataviewService();
		expect(getDataviewService()).toBe(created);
		const disposeAll = vi.spyOn(created, 'disposeAll');
		await shutdownDataviewService();
		expect(disposeAll).toHaveBeenCalledTimes(1);
	});
});

/**
 * The request methods the IPC handlers and the CLI's WS verbs call: they validate the wire request,
 * resolve the agent, run the query against the note's index, and answer with the index state it read.
 */
describe('DataviewService requests', () => {
	const localRoot = rootAt('requests');
	const remoteRoot = '/remote/vault';
	const files: MemoryVault = {
		'People/A.md': '---\nRole: Engineer\n---\n# A\n',
		'People/B.md': '---\nRole: Designer\n---\n# B\n',
		'Notes/C.md': '# C\n',
	};
	const agents: Record<string, { agentCwd: string; sshRemoteId: string | null }> = {
		local: { agentCwd: localRoot, sshRemoteId: null },
		remote: { agentCwd: remoteRoot, sshRemoteId: 'remote-1' },
	};
	const resolveAgent = vi.fn((agentId: string) => {
		const context = agents[agentId];
		if (!context) throw new Error(`Dataview: no agent with id "${agentId}"`);
		return context;
	});
	// Every note in these tests belongs to its agent's cwd: no `.obsidian` anywhere.
	const resolveRoot = vi.fn(
		async (_filePath: string, options: { agentCwd: string }) => options.agentCwd
	);
	let service: DataviewService;

	beforeEach(() => {
		resolveAgent.mockClear();
		service = new DataviewService({
			resolveRoot,
			resolveAgent,
			watch: false,
			cacheDir: () => null,
			createVaultFs: (root, sshRemoteId) => memoryFs(root, files, sshRemoteId),
		});
	});

	afterEach(async () => {
		await service.disposeAll();
	});

	it('runs a block with `this` bound to the note, and reports the root and revision it read', async () => {
		const response = await service.query({
			filePath: path.join(localRoot, 'People', 'A.md'),
			source: 'LIST WHERE file.path = this.file.path',
			agentId: 'local',
		});

		expect(response).toMatchObject({
			root: localRoot,
			sshRemoteId: null,
			revision: 1,
			path: 'People/A.md',
		});
		expect(response.result.kind).toBe('list');
		if (response.result.kind !== 'list') return;
		expect(response.result.items).toHaveLength(1);
		expect(resolveAgent).toHaveBeenCalledWith('local');
	});

	it('runs a TABLE over a folder source and returns wire values', async () => {
		const response = await service.query({
			filePath: path.join(localRoot, 'Notes', 'C.md'),
			source: 'TABLE Role FROM "People" SORT Role ASC',
			agentId: 'local',
		});

		expect(response.result).toMatchObject({ kind: 'table', headers: ['File', 'Role'] });
		if (response.result.kind !== 'table') return;
		expect(response.result.rows.map((row) => row[1])).toEqual(['Designer', 'Engineer']);
		// The answer is plain JSON: it crosses IPC and the WS bridge unchanged.
		expect(JSON.parse(JSON.stringify(response))).toEqual(response);
	});

	it('evaluates an inline expression against the note', async () => {
		const response = await service.queryInline({
			filePath: path.join(localRoot, 'People', 'B.md'),
			expression: '= this.Role',
			agentId: 'local',
		});

		expect(response.path).toBe('People/B.md');
		expect(response.result).toEqual({ kind: 'value', value: 'Designer' });
	});

	it('returns query errors as an error result (DV-9)', async () => {
		const response = await service.query({
			filePath: path.join(localRoot, 'People', 'A.md'),
			source: 'TABLE FROM',
			agentId: 'local',
		});

		expect(response.result.kind).toBe('error');
	});

	it("resolves a remote agent's note against its remote root with POSIX paths", async () => {
		const response = await service.query({
			filePath: `${remoteRoot}/People/A.md`,
			source: 'LIST WHERE file.path = this.file.path',
			agentId: 'remote',
		});

		expect(response).toMatchObject({
			root: remoteRoot,
			sshRemoteId: 'remote-1',
			path: 'People/A.md',
		});
		expect(service.status(remoteRoot, 'remote-1')).not.toBeNull();
		expect(service.status(remoteRoot)).toBeNull();
	});

	it('answers with an error result for a note outside the root it was given', async () => {
		const outside = path.join(rootAt('elsewhere'), 'X.md');
		const response = await service.query({
			filePath: outside,
			source: 'LIST',
			agentId: 'local',
		});

		expect(response.path).toBe(outside);
		expect(response.result).toEqual({
			kind: 'error',
			message: `Dataview: ${outside} is outside the vault root ${localRoot}`,
		});
	});

	it('refuses a malformed request and an unknown agent', async () => {
		const filePath = path.join(localRoot, 'People', 'A.md');
		await expect(
			service.query({ filePath: 'People/A.md', source: 'LIST', agentId: 'local' })
		).rejects.toThrow('Dataview: filePath must be an absolute path');
		await expect(service.query({ filePath, source: '  ', agentId: 'local' })).rejects.toThrow(
			'Dataview: source must be a non-empty string'
		);
		await expect(
			service.queryInline({
				filePath,
				expression: undefined as unknown as string,
				agentId: 'local',
			})
		).rejects.toThrow('Dataview: expression must be a non-empty string');
		await expect(service.query({ filePath, source: 'LIST', agentId: 'nobody' })).rejects.toThrow(
			'Dataview: no agent with id "nobody"'
		);
		expect(service.openRootCount).toBe(0);
	});

	it('reports every open root, one named root, or none for a root that is not open', async () => {
		expect(service.indexStatus()).toEqual([]);
		await service.query({
			filePath: path.join(localRoot, 'People', 'A.md'),
			source: 'LIST',
			agentId: 'local',
		});
		await service.query({
			filePath: `${remoteRoot}/People/A.md`,
			source: 'LIST',
			agentId: 'remote',
		});

		expect(service.indexStatus().map((status) => status.root)).toEqual([localRoot, remoteRoot]);
		expect(service.indexStatus({ root: localRoot })).toMatchObject([
			{ root: localRoot, pageCount: 3 },
		]);
		expect(service.indexStatus({ root: remoteRoot, agentId: 'remote' })).toMatchObject([
			{ root: remoteRoot, sshRemoteId: 'remote-1' },
		]);
		// The same path with no agent names the local root, which is not open.
		expect(service.indexStatus({ root: remoteRoot })).toEqual([]);
	});

	it('rebuilds a root on the remote of the agent that names it, and refuses a relative root', async () => {
		const status = await service.rebuildIndex({ root: remoteRoot, agentId: 'remote' });

		expect(status).toMatchObject({ root: remoteRoot, sshRemoteId: 'remote-1', pageCount: 3 });
		await expect(service.rebuildIndex({ root: 'vault' })).rejects.toThrow(
			'Dataview: root must be an absolute path'
		);
	});
});
