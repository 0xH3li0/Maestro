/**
 * Tests for the main-process `VaultIndex` (src/main/dataview/vault-index.ts): the full scan over a temp copy
 * of the fixture vault, the `FullIndex` members the vendored engine reads, and source resolution.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('../../../main/utils/remote-fs', () => ({
	listFilesWithStatsRemote: vi.fn(),
	readFileRemote: vi.fn(),
}));

import { EXPRESSION } from '../../../shared/dataview';
import type { Source } from '../../../shared/dataview';
import {
	createLocalVaultFs,
	type VaultFs,
	type VaultListing,
} from '../../../main/dataview/vault-fs';
import {
	DATAVIEW_MAX_INDEXED_FILE_BYTES,
	DATAVIEW_PARSE_BATCH_SIZE,
	VaultIndex,
	type VaultIndexChange,
} from '../../../main/dataview/vault-index';

const FIXTURE_VAULT = path.resolve(__dirname, '..', '..', 'fixtures', 'dataview-vault');

const source = (text: string): Source => EXPRESSION.source.tryParse(text);
const sorted = (paths: Iterable<string>) => [...paths].sort();

/** The markdown files a full scan of the fixture vault indexes (dot folders skipped, README counted). */
function fixturePages(dir = FIXTURE_VAULT): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...fixturePages(full));
		else if (entry.name.endsWith('.md'))
			out.push(path.relative(FIXTURE_VAULT, full).split(path.sep).join('/'));
	}
	return out;
}

/** An in-memory `VaultFs` for the unit cases. */
function memoryFs(files: Record<string, string>, overrides: Partial<VaultFs> = {}): VaultFs {
	return {
		root: '/vault',
		sshRemoteId: null,
		async list(): Promise<VaultListing> {
			const stats = new Map();
			for (const [file, text] of Object.entries(files)) {
				if (file.endsWith('.md')) stats.set(file, { size: text.length, mtime: 2000, ctime: 1000 });
			}
			return { files: Object.keys(files).filter((f) => !f.startsWith('.')), folders: [], stats };
		},
		async readText(relPath) {
			if (!(relPath in files)) throw new Error(`ENOENT: ${relPath}`);
			return files[relPath];
		},
		...overrides,
	};
}

describe('VaultIndex over the fixture vault', () => {
	let tempDir: string;
	let index: VaultIndex;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-vault-index-'));
		fs.cpSync(FIXTURE_VAULT, tempDir, { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.obsidian', 'bookmarks.json'),
			JSON.stringify({
				items: [
					{
						type: 'group',
						title: 'People',
						items: [{ type: 'file', path: 'People/Rami Example.md', title: '' }],
					},
				],
			})
		);
		index = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {} });
		await index.scan();
	});

	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('indexes every markdown page outside dot folders', () => {
		expect(sorted(index.pages.keys())).toEqual(sorted(fixturePages()));
		expect(index.getPage('.trash/Deleted.md')).toBeUndefined();
		expect(index.lastScan).toMatchObject({ pageCount: fixturePages().length, failedCount: 0 });
		expect(index.revision).toBe(1);
		expect(index.root).toBe(tempDir);
	});

	it('resolves a tag source through the tag index, nested tags included', () => {
		const meeting = index.pagesForSource(source('#meeting'));
		expect(meeting.successful && sorted(meeting.value)).toEqual([
			'Notes/Standup.md',
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-20 Unrelated.md',
		]);
		const alpha = index.pagesForSource(source('#project'));
		expect(alpha.successful && sorted(alpha.value)).toEqual(['Projects/Alpha/Design/Spec.md']);
	});

	it('resolves folder sources recursively and joins sources with or, and, and negation', () => {
		const folder = index.pagesForSource(source('"Projects"'));
		expect(folder.successful && sorted(folder.value)).toEqual([
			'Projects/Alpha/Design/Spec.md',
			'Projects/Alpha/Other.md',
			'Projects/Links.md',
		]);

		const either = index.pagesForSource(source('#meeting or "meetings"'));
		expect(either.successful && sorted(either.value)).toEqual([
			'Notes/Standup.md',
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-15 Review.md',
			'meetings/2026-09-20 Unrelated.md',
		]);

		const both = index.pagesForSource(source('#meeting and "meetings"'));
		expect(both.successful && sorted(both.value)).toEqual([
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-20 Unrelated.md',
		]);

		const notMeeting = index.pagesForSource(source('-#meeting'));
		expect(notMeeting.successful && notMeeting.value.has('Notes/Standup.md')).toBe(false);
		expect(notMeeting.successful && notMeeting.value.size).toBe(index.pages.size - 3);
	});

	it('resolves [[link]] to its inlinks and outgoing([[link]]) to its resolved outlinks', () => {
		const incoming = index.pagesForSource(source('[[Pedram Amini]]'));
		expect(incoming.successful && incoming.value).toEqual(
			new Set(index.inlinks('People/Pedram Amini.md'))
		);
		expect(incoming.successful && sorted(incoming.value)).toEqual(
			expect.arrayContaining([
				'Notes/Standup.md',
				'People/Dana Sample.md',
				'People/Rami Example.md',
				'meetings/2026-09-01 Kickoff.md',
				'meetings/2026-09-15 Review.md',
			])
		);
		expect(incoming.successful && incoming.value.has('.trash/Deleted.md')).toBe(false);

		const outgoing = index.pagesForSource(source('outgoing([[Markdown Link]])'));
		expect(outgoing.successful && sorted(outgoing.value)).toEqual(['Notes/Other.md']);
	});

	it('falls back to unresolved links for a missing target, and fails outgoing() on one', () => {
		const missing = index.pagesForSource(source('[[Missing Note]]'));
		expect(missing.successful && sorted(missing.value)).toEqual(['Projects/Links.md']);

		const outgoing = index.pagesForSource(source('outgoing([[Nope Nope]])'));
		expect(outgoing.successful).toBe(true);
		expect(outgoing.successful && outgoing.value.size).toBe(0);
	});

	it('gives every page a resolvedLinks entry and resolves link paths like Obsidian', () => {
		const resolved = index.metadataCache.resolvedLinks;
		expect(sorted(Object.keys(resolved))).toEqual(sorted(index.pages.keys()));
		expect(resolved['Notes/Markdown Link.md']).toEqual({ 'Notes/Other.md': 1 });
		expect(index.metadataCache.getFirstLinkpathDest('Pedram Amini', 'Notes/Standup.md')).toEqual({
			path: 'People/Pedram Amini.md',
		});
		expect(
			index.metadataCache.getFirstLinkpathDest('Missing Note', 'Projects/Links.md')
		).toBeNull();
		expect(index.metadataCache.getFirstLinkpathDest('views/sample/view.js', '')).toEqual({
			path: 'views/sample/view.js',
		});
	});

	it('exposes the folder index, markdown files, and stars the way the engine reads them', () => {
		expect(index.prefix.nodeExists('Projects/Alpha')).toBe(true);
		expect(index.prefix.pathExists('data/people.csv')).toBe(true);
		expect(index.prefix.pathExists('.obsidian/app.json')).toBe(false);
		expect(sorted(index.vault.getMarkdownFiles().map((f) => f.path))).toEqual(
			sorted(index.pages.keys())
		);
		expect(index.starred.starred('People/Rami Example.md')).toBe(true);
		expect(index.starred.starred('People/Pedram Amini.md')).toBe(false);
		expect(index.getPage('People/Rami Example.md')!.serialize(index).file.starred).toBe(true);
	});

	it('serializes file.inlinks from the inlink index', () => {
		const other = index.getPage('Notes/Other.md')!.serialize(index);
		expect(other.file.inlinks.map((link: { path: string }) => link.path)).toContain(
			'Notes/Markdown Link.md'
		);
	});

	it('loads a vault-local CSV source and refuses URLs and paths outside the vault', async () => {
		const rows = await index.csv.get('data/people.csv');
		expect(rows.successful && rows.value.length).toBeGreaterThan(0);

		const url = await index.csv.get('https://example.com/data.csv');
		expect(url.successful).toBe(false);
		expect(!url.successful && url.error).toContain('not supported in Maestro');

		const outside = await index.csv.get('../secrets.csv');
		expect(outside).toMatchObject({
			successful: false,
			error: "Failed to load data from path '../secrets.csv'.",
		});

		const csvSource = index.pagesForSource(source('csv("people.csv")'), 'data/Note.md');
		expect(csvSource.successful && sorted(csvSource.value)).toEqual(['data/people.csv']);
	});
});

describe('VaultIndex scan behavior', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('indexes pages over the size cap with file.* fields only and never reads them', async () => {
		const big = 'Key:: value\n#tag\n'.padEnd(DATAVIEW_MAX_INDEXED_FILE_BYTES + 1, 'x');
		const vaultFs = memoryFs({ 'Big.md': big, 'Small.md': 'Key:: value' });
		const readText = vi.spyOn(vaultFs, 'readText');
		const index = new VaultIndex(vaultFs);

		const stats = await index.scan();

		expect(stats.oversizedCount).toBe(1);
		expect(readText).not.toHaveBeenCalledWith('Big.md');
		const page = index.getPage('Big.md')!;
		expect(page.size).toBe(big.length);
		expect(page.fields.size).toBe(0);
		expect(page.tags.size).toBe(0);
		expect(index.getPage('Small.md')!.fields.get('key')).toBe('value');
	});

	it('skips a page whose read fails and counts it', async () => {
		const index = new VaultIndex(
			memoryFs(
				{ 'A.md': 'a', 'B.md': 'b' },
				{
					readText: async (relPath) => {
						if (relPath === 'B.md') throw new Error('EACCES');
						if (relPath === 'A.md') return 'a';
						throw new Error('ENOENT');
					},
				}
			)
		);

		const stats = await index.scan();

		expect(stats).toMatchObject({ pageCount: 1, failedCount: 1 });
		expect(index.getPage('B.md')).toBeUndefined();
	});

	it('yields to the event loop between parse batches', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < DATAVIEW_PARSE_BATCH_SIZE * 2 + 1; i++) files[`N${i}.md`] = `n:: ${i}`;
		const index = new VaultIndex(memoryFs(files));
		let immediates = 0;
		const tick = () => {
			immediates++;
		};
		const scan = index.scan();
		// setImmediate callbacks queued after the scan starts run between its batches.
		for (let i = 0; i < 5; i++) setImmediate(tick);
		await scan;

		expect(index.pages.size).toBe(DATAVIEW_PARSE_BATCH_SIZE * 2 + 1);
		expect(immediates).toBeGreaterThan(0);
	});

	it('reports one change per scan with every set or removed page, and bumps the revision', async () => {
		const files: Record<string, string> = { 'A.md': 'a', 'B.md': 'b' };
		const index = new VaultIndex(memoryFs(files));
		const changes: VaultIndexChange[] = [];
		const unsubscribe = index.onChange((change) => changes.push(change));

		await index.scan();
		delete files['B.md'];
		files['C.md'] = 'c';
		await index.scan();
		unsubscribe();
		await index.scan();

		expect(changes).toHaveLength(2);
		expect(changes[0]).toEqual({ revision: 1, changedPaths: ['A.md', 'B.md'] });
		expect(changes[1].revision).toBe(2);
		expect(sorted(changes[1].changedPaths)).toEqual(['A.md', 'B.md', 'C.md']);
		expect(index.revision).toBe(3);
		expect(index.getPage('B.md')).toBeUndefined();
		expect(index.links.get('B.md').size).toBe(0);
	});

	it('shares one scan between concurrent callers', async () => {
		const vaultFs = memoryFs({ 'A.md': 'a' });
		const list = vi.spyOn(vaultFs, 'list');
		const index = new VaultIndex(vaultFs);

		const [first, second] = await Promise.all([index.scan(), index.scan()]);

		expect(first).toBe(second);
		expect(list).toHaveBeenCalledTimes(1);
		expect(index.revision).toBe(1);
	});

	it('keeps notifying other listeners when one throws', async () => {
		const index = new VaultIndex(memoryFs({ 'A.md': 'a' }));
		const after = vi.fn();
		index.onChange(() => {
			throw new Error('boom');
		});
		index.onChange(after);

		await index.scan();

		expect(after).toHaveBeenCalledTimes(1);
	});

	it('propagates a failure to list the root', async () => {
		const index = new VaultIndex(
			memoryFs({}, { list: async () => Promise.reject(new Error('Directory not found')) })
		);

		await expect(index.scan()).rejects.toThrow('Directory not found');
		expect(index.revision).toBe(0);
	});
});
