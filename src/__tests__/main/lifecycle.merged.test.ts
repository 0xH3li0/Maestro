// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/auto-updater.test.ts
//   - src/__tests__/main/memory-manager.test.ts

import {
	createMemoryEntry,
	deleteMemoryEntry,
	findOrphanMemories,
	getMemoryDirectoryPath,
	listMemoryEntries,
	readMemoryEntry,
	searchMemoryEntries,
	writeMemoryEntry,
} from '../../main/memory-manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	BrowserWindow: class {},
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => mockHandle(channel, fn),
	},
}));
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => false),
}));
vi.mock('../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// ===== from src/__tests__/main/auto-updater.test.ts =====

// Capture IPC handler registrations so we can invoke them from tests.
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

const mockHandle = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
	ipcHandlers.set(channel, fn);
});

const mockCaptureException = vi.fn().mockResolvedValue(undefined);

// electron-updater is loaded via dynamic `require` inside auto-updater.ts to
// defer electron.app access - that bypasses vitest's module mocker. We use the
// __setAutoUpdaterForTesting escape hatch instead.
const mockAutoUpdater = {
	autoDownload: false,
	autoInstallOnAppQuit: false,
	allowPrerelease: false,
	on: vi.fn(),
	checkForUpdates: vi.fn(),
	downloadUpdate: vi.fn(),
	quitAndInstall: vi.fn(),
	setFeedURL: vi.fn(),
};

describe('main/auto-updater', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		ipcHandlers.clear();
		mockAutoUpdater.quitAndInstall.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('updates:install handler', () => {
		it('invokes onBeforeQuitAndInstall before quitAndInstall', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const callOrder: string[] = [];
			const onBeforeQuitAndInstall = vi.fn(() => {
				callOrder.push('onBeforeQuitAndInstall');
			});
			mockAutoUpdater.quitAndInstall.mockImplementation(() => {
				callOrder.push('quitAndInstall');
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(callOrder).toEqual(['onBeforeQuitAndInstall', 'quitAndInstall']);
		});

		it('still calls quitAndInstall when no onBeforeQuitAndInstall is provided', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0]);

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});

		it('still calls quitAndInstall if onBeforeQuitAndInstall throws and reports to Sentry', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const hookError = new Error('hook blew up');
			const onBeforeQuitAndInstall = vi.fn(() => {
				throw hookError;
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			expect(() => installHandler!()).not.toThrow();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(mockCaptureException).toHaveBeenCalledWith(
				hookError,
				expect.objectContaining({
					module: 'AutoUpdater',
					hook: 'onBeforeQuitAndInstall',
					operation: 'updates:install',
				})
			);
		});

		it('wraps non-Error throws from onBeforeQuitAndInstall before reporting to Sentry', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const onBeforeQuitAndInstall = vi.fn(() => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw 'string-thrown';
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			installHandler!();

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'string-thrown' }),
				expect.any(Object)
			);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});
	});

	describe('updates:download handler - transient retry + error sanitization', () => {
		// The raw blob electron-updater throws on a GitHub 504: an HTTP status,
		// an HTML error page, and a dump of response headers + cookies.
		const raw504 =
			'504 "method: GET url: https://github.com/RunMaestro/Maestro/releases.atom\n\n' +
			' Data:\n <html><body><h1>504 Gateway Time-out</h1>\nThe server didn\'t respond in time.\n</body></html>\n\n " ' +
			'Headers: { "set-cookie": [ "_gh_sess=secret-cookie-value", "logged_in=no" ] }';

		beforeEach(() => {
			vi.useFakeTimers();
			mockAutoUpdater.checkForUpdates.mockReset();
			mockAutoUpdater.downloadUpdate.mockReset();
			mockAutoUpdater.setFeedURL.mockReset();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		async function getDownloadHandler() {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0]);
			const handler = ipcHandlers.get('updates:download');
			expect(handler).toBeTruthy();
			return handler!;
		}

		it('retries a transient 504 on the pre-download check and then succeeds', async () => {
			mockAutoUpdater.checkForUpdates
				.mockRejectedValueOnce(new Error(raw504))
				.mockResolvedValueOnce({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(result).toEqual({ success: true });
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
			expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		});

		it('gives up after max attempts and returns a friendly, sanitized error', async () => {
			mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error(raw504));

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = (await resultPromise) as { success: boolean; error: string };

			expect(result.success).toBe(false);
			// Three attempts: 1 initial + 2 retries.
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
			// Friendly message, not the raw HTML/header/cookie blob.
			expect(result.error).toContain('GitHub is temporarily unavailable');
			expect(result.error).toContain('HTTP 504');
			expect(result.error).not.toContain('<html>');
			expect(result.error).not.toContain('set-cookie');
			expect(result.error).not.toContain('_gh_sess');
		});

		it('points electron-updater at the CDN release assets when given a target tag', async () => {
			mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler({}, 'v1.2.3');
			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(result).toEqual({ success: true });
			// Generic provider pointed at the release's CDN-served asset directory,
			// bypassing releases.atom entirely.
			expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
				provider: 'generic',
				url: 'https://github.com/RunMaestro/Maestro/releases/download/v1.2.3/',
			});
		});

		it('falls back to the default GitHub provider when no tag is supplied', async () => {
			mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3' } });
			mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			await resultPromise;

			expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
		});

		it('does not retry a non-transient error', async () => {
			mockAutoUpdater.checkForUpdates.mockRejectedValue(
				new Error('ENOSPC: no space left on device')
			);

			const handler = await getDownloadHandler();
			const resultPromise = handler();
			await vi.runAllTimersAsync();
			const result = (await resultPromise) as { success: boolean; error: string };

			expect(result.success).toBe(false);
			expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
			expect(result.error).toContain('ENOSPC');
		});
	});
});

// ===== from src/__tests__/main/memory-manager.test.ts =====

let tempHome: string;

describe('memory-manager', () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('resolves the memory directory using the Claude project-path encoding', () => {
		const projectPath = '/Users/me/Projects/My App';
		const dir = getMemoryDirectoryPath(projectPath, 'claude-code', tempHome);
		expect(dir).toBe(
			path.join(tempHome, '.claude', 'projects', '-Users-me-Projects-My-App', 'memory')
		);
	});

	it('refuses non-claude-code agents', () => {
		expect(() => getMemoryDirectoryPath('/p', 'codex', tempHome)).toThrow(/not supported/);
	});

	it('returns exists:false with empty entries when the directory is missing', async () => {
		const result = await listMemoryEntries('/Users/me/Projects/Empty', 'claude-code', tempHome);
		expect(result.exists).toBe(false);
		expect(result.entries).toEqual([]);
		expect(result.stats.fileCount).toBe(0);
		expect(result.stats.totalBytes).toBe(0);
	});

	it('pins MEMORY.md to the top and sorts the rest alphabetically', async () => {
		const projectPath = '/Users/me/Projects/Pinning';
		await writeMemoryEntry(projectPath, 'zebra.md', 'z', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'alpha.md', 'a', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'MEMORY.md', '- index', 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.entries.map((e) => e.name)).toEqual(['MEMORY.md', 'alpha.md', 'zebra.md']);
	});

	it('round-trips write/read/delete for a single entry', async () => {
		const projectPath = '/Users/me/Projects/Rw';
		await writeMemoryEntry(projectPath, 'note.md', 'hello', 'claude-code', tempHome);
		expect(await readMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome)).toBe('hello');
		await deleteMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome);
		const after = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(after.entries.find((e) => e.name === 'note.md')).toBeUndefined();
	});

	it('createMemoryEntry fails if the file already exists', async () => {
		const projectPath = '/Users/me/Projects/Create';
		await createMemoryEntry(projectPath, 'dup.md', 'first', 'claude-code', tempHome);
		await expect(
			createMemoryEntry(projectPath, 'dup.md', 'second', 'claude-code', tempHome)
		).rejects.toThrow(/already exists/);
	});

	it('refuses filenames that would escape the memory directory', async () => {
		const projectPath = '/Users/me/Projects/Safety';
		await expect(
			writeMemoryEntry(projectPath, '../evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'sub/evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'no-extension', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/must end with \.md/);
	});

	it('refuses to delete MEMORY.md via the viewer', async () => {
		const projectPath = '/Users/me/Projects/Protect';
		await writeMemoryEntry(projectPath, 'MEMORY.md', 'index', 'claude-code', tempHome);
		await expect(
			deleteMemoryEntry(projectPath, 'MEMORY.md', 'claude-code', tempHome)
		).rejects.toThrow(/cannot be deleted/);
	});

	it('reports aggregate stats across all entries', async () => {
		const projectPath = '/Users/me/Projects/Stats';
		await writeMemoryEntry(projectPath, 'a.md', 'a'.repeat(100), 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'b.md', 'b'.repeat(250), 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.stats.fileCount).toBe(2);
		expect(result.stats.totalBytes).toBe(350);
		expect(result.stats.firstCreatedAt).toBeTruthy();
		expect(result.stats.lastModifiedAt).toBeTruthy();
	});
	describe('searchMemoryEntries', () => {
		const projectPath = '/Users/me/Projects/Search';

		beforeEach(async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '- index line', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'project_widgets.md',
				'The widget pipeline runs nightly.',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'user_prefs.md',
				'Prefers tabs over spaces.',
				'claude-code',
				tempHome
			);
		});

		it('returns every entry for an empty query', async () => {
			const matches = await searchMemoryEntries(projectPath, '   ', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual([
				'MEMORY.md',
				'project_widgets.md',
				'user_prefs.md',
			]);
		});

		it('matches on the filename', async () => {
			const matches = await searchMemoryEntries(projectPath, 'PREFS', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['user_prefs.md']);
			expect(matches[0].matchedName).toBe(true);
		});

		it('matches on the body and reports the matching line', async () => {
			const matches = await searchMemoryEntries(projectPath, 'nightly', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['project_widgets.md']);
			expect(matches[0].matchedName).toBe(false);
			expect(matches[0].snippet).toBe('The widget pipeline runs nightly.');
		});

		it('returns nothing when neither name nor body matches', async () => {
			const matches = await searchMemoryEntries(projectPath, 'zzzznope', 'claude-code', tempHome);
			expect(matches).toEqual([]);
		});

		it('caps the snippet and keeps the pinned/alphabetical order', async () => {
			await writeMemoryEntry(
				projectPath,
				'aaa_long.md',
				`prefix ${'x'.repeat(400)}`,
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'prefix in the index',
				'claude-code',
				tempHome
			);
			const matches = await searchMemoryEntries(projectPath, 'prefix', 'claude-code', tempHome);
			expect(matches.map((m) => m.name)).toEqual(['MEMORY.md', 'aaa_long.md']);
			const long = matches.find((m) => m.name === 'aaa_long.md');
			expect(long?.snippet?.length).toBeLessThanOrEqual(121);
			expect(long?.snippet?.endsWith('\u2026')).toBe(true);
		});
	});
	describe('findOrphanMemories', () => {
		const projectPath = '/Users/me/Projects/Orphans';

		it('reports entries that nothing references', async () => {
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'- [Indexed](project_indexed.md) - hook',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_indexed.md', 'body', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'project_lonely.md', 'body', 'claude-code', tempHome);

			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['project_lonely.md']);
		});

		it('never reports MEMORY.md, which nothing is expected to point at', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by filename stem as a reference', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[a_note]]', 'claude-code', tempHome);
			await writeMemoryEntry(projectPath, 'a_note.md', 'body', 'claude-code', tempHome);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('counts a wiki link by frontmatter name as a reference', async () => {
			// The memory instructions tell the agent to link by the `name:` slug,
			// which is often NOT the filename. A checker that only knew filenames
			// would report almost every entry as an orphan.
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[the-slug]]', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'---\nname: the-slug\n---\n\nbody',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual([]);
		});

		it('treats hyphen and underscore spellings as the same target', async () => {
			// One character apart, invisible in rendered markdown, and the single
			// biggest source of silently-dead pointers in a real memory dir.
			await writeMemoryEntry(
				projectPath,
				'MEMORY.md',
				'see [[project-my-note]]',
				'claude-code',
				tempHome
			);
			await writeMemoryEntry(projectPath, 'project_my_note.md', 'body', 'claude-code', tempHome);
			const { orphans, brokenLinks } = await findOrphanMemories(
				projectPath,
				'claude-code',
				tempHome
			);
			expect(orphans).toEqual([]);
			expect(brokenLinks).toEqual([]);
		});

		it('reports a link whose target does not exist', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', 'see [[nope]]', 'claude-code', tempHome);
			const { brokenLinks } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(brokenLinks).toEqual([{ source: 'MEMORY.md', target: 'nope' }]);
		});

		it('does not let a self-link rescue an entry from being an orphan', async () => {
			await writeMemoryEntry(projectPath, 'MEMORY.md', '# index', 'claude-code', tempHome);
			await writeMemoryEntry(
				projectPath,
				'a_note.md',
				'I link to [[a_note]] only',
				'claude-code',
				tempHome
			);
			const { orphans } = await findOrphanMemories(projectPath, 'claude-code', tempHome);
			expect(orphans).toEqual(['a_note.md']);
		});
	});
});
