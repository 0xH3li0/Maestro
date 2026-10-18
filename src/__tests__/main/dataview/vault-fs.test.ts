import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const { listFilesWithStatsRemote, readFileRemote } = vi.hoisted(() => ({
	listFilesWithStatsRemote: vi.fn(),
	readFileRemote: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({ listFilesWithStatsRemote, readFileRemote }));

import {
	VAULT_PRUNED_NAMES,
	createLocalVaultFs,
	createRemoteVaultFs,
	isIndexedVaultPath,
} from '../../../main/dataview/vault-fs';

const FIXTURE_VAULT = path.resolve(__dirname, '..', '..', 'fixtures', 'dataview-vault');

const remote = {
	id: 'remote-1',
	name: 'Remote',
	host: 'dev.example.com',
	port: 22,
	username: 'u',
	privateKeyPath: '',
	enabled: true,
};

describe('isIndexedVaultPath', () => {
	it('skips dot segments, node_modules, and Windows system files', () => {
		expect(isIndexedVaultPath('People/Pedram Amini.md')).toBe(true);
		expect(isIndexedVaultPath('.obsidian/app.json')).toBe(false);
		expect(isIndexedVaultPath('.trash/Deleted.md')).toBe(false);
		expect(isIndexedVaultPath('a/.git/HEAD')).toBe(false);
		expect(isIndexedVaultPath('.maestro/playbooks/x.md')).toBe(false);
		expect(isIndexedVaultPath('a/.hidden.md')).toBe(false);
		expect(isIndexedVaultPath('proj/node_modules/pkg/README.md')).toBe(false);
		expect(isIndexedVaultPath('pagefile.sys')).toBe(false);
		expect(isIndexedVaultPath('')).toBe(false);
	});
});

describe('createLocalVaultFs', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-vault-fs-'));
		fs.cpSync(FIXTURE_VAULT, tempDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, 'proj', 'node_modules', 'pkg'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'proj', 'node_modules', 'pkg', 'README.md'), '# pkg');
		fs.mkdirSync(path.join(tempDir, '.maestro', 'playbooks'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, '.maestro', 'playbooks', 'Doc.md'), '- [ ] task');
		fs.mkdirSync(path.join(tempDir, 'Empty Folder'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('lists every indexed file and folder as POSIX paths, skipping dot folders and node_modules', async () => {
		const listing = await createLocalVaultFs(tempDir).list();

		expect(listing.files).toContain('People/Pedram Amini.md');
		expect(listing.files).toContain('Projects/Alpha/Design/Spec.md');
		expect(listing.files).toContain('data/people.csv');
		expect(listing.files).toContain('views/sample/view.js');
		expect(listing.files.some((file) => file.startsWith('.'))).toBe(false);
		expect(listing.files.some((file) => file.includes('node_modules'))).toBe(false);
		expect(listing.folders).toEqual(
			expect.arrayContaining(['Projects/Alpha/Design', 'Empty Folder'])
		);
		expect(listing.folders.some((folder) => folder.startsWith('.'))).toBe(false);
	});

	it('stats markdown pages only, with creation time from the birth time', async () => {
		const listing = await createLocalVaultFs(tempDir).list();
		const notePath = path.join(tempDir, 'People', 'Pedram Amini.md');
		const real = fs.statSync(notePath);

		expect(listing.stats.has('data/people.csv')).toBe(false);
		expect(listing.stats.get('People/Pedram Amini.md')).toEqual({
			size: real.size,
			mtime: real.mtimeMs,
			ctime: real.birthtimeMs > 0 ? real.birthtimeMs : real.ctimeMs,
		});
		expect([...listing.stats.keys()].sort()).toEqual(
			listing.files.filter((file) => file.endsWith('.md')).sort()
		);
	});

	it('reads a vault-relative path', async () => {
		const text = await createLocalVaultFs(tempDir).readText('People/Rami Example.md');

		expect(text).toBe(fs.readFileSync(path.join(tempDir, 'People', 'Rami Example.md'), 'utf8'));
	});

	it('throws when the root cannot be listed', async () => {
		await expect(createLocalVaultFs(path.join(tempDir, 'missing')).list()).rejects.toThrow();
	});
});

describe('createRemoteVaultFs', () => {
	beforeEach(() => {
		listFilesWithStatsRemote.mockReset();
		readFileRemote.mockReset();
	});

	it('lists in one call, derives folders, and keeps stats for markdown pages', async () => {
		listFilesWithStatsRemote.mockResolvedValue({
			success: true,
			data: [
				{ path: 'People/Pedram Amini.md', size: 10, mtime: 2000, birthtime: 1000, ctime: 3000 },
				{ path: 'a/b/No Birth.md', size: 4, mtime: 2000, birthtime: 0, ctime: 3000 },
				{ path: 'data/people.csv', size: 5, mtime: 2000, birthtime: 0, ctime: 3000 },
				{ path: 'x/node_modules/y.md', size: 1, mtime: 1, birthtime: 0, ctime: 1 },
			],
		});

		const vaultFs = createRemoteVaultFs('/srv/vault', remote);
		const listing = await vaultFs.list();

		expect(listFilesWithStatsRemote).toHaveBeenCalledWith(
			'/srv/vault',
			[...VAULT_PRUNED_NAMES],
			remote
		);
		expect(vaultFs.sshRemoteId).toBe('remote-1');
		expect(listing.files).toEqual(['People/Pedram Amini.md', 'a/b/No Birth.md', 'data/people.csv']);
		expect(listing.folders.sort()).toEqual(['People', 'a', 'a/b', 'data']);
		expect(listing.stats.get('People/Pedram Amini.md')).toEqual({
			size: 10,
			mtime: 2000,
			ctime: 1000,
		});
		expect(listing.stats.get('a/b/No Birth.md')).toEqual({ size: 4, mtime: 2000, ctime: 3000 });
		expect(listing.stats.has('data/people.csv')).toBe(false);
	});

	it('throws on a failed listing and never falls back to the local disk', async () => {
		listFilesWithStatsRemote.mockResolvedValue({
			success: false,
			error: 'ssh: connection refused',
		});

		await expect(createRemoteVaultFs('/srv/vault', remote).list()).rejects.toThrow(
			'ssh: connection refused'
		);
	});

	it('reads through readFileRemote with a POSIX join', async () => {
		readFileRemote.mockResolvedValue({ success: true, data: 'body' });

		await expect(createRemoteVaultFs('/srv/vault', remote).readText('People/A.md')).resolves.toBe(
			'body'
		);
		expect(readFileRemote).toHaveBeenCalledWith('/srv/vault/People/A.md', remote);

		readFileRemote.mockResolvedValue({ success: false, error: 'File not found: x' });
		await expect(createRemoteVaultFs('/srv/vault', remote).readText('x')).rejects.toThrow(
			'File not found: x'
		);
	});
});
