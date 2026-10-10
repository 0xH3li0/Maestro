/**
 * Tests for main/cot-export/layout.ts.
 *
 * Every test that writes uses its own fresh directory under the OS temp
 * dir and builds paths with `path.join`. None of them reads or writes the
 * user's real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { turnFilePath, validateAgentFolder } from '../../../main/cot-export/layout';

describe('turnFilePath', () => {
	const base = path.join(os.tmpdir(), 'agent-log');

	it('buckets by LOCAL time, zero-padded, under the hour the turn started', () => {
		// Built from local components, so the assertion holds in any time zone.
		const start = new Date(2026, 0, 2, 3, 4, 5);
		const file = turnFilePath(base, start, 'tab-12345678-extra', 'turn-abcdefgh-extra');
		expect(file).toBe(path.join(base, '2026', '01', '02', '03', '030405-tab-1234-turn-abc.jsonl'));
	});

	it('cuts the tab id and the turn id to eight characters each', () => {
		const start = new Date(2026, 9, 10, 14, 30, 59);
		const file = turnFilePath(base, start, 'abcdefghijkl', '0123456789ab');
		expect(path.basename(file)).toBe('143059-abcdefgh-01234567.jsonl');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '10', '10', '14'));
	});

	it('names a turn with no tab "notab"', () => {
		const start = new Date(2026, 9, 10, 0, 0, 0);
		const file = turnFilePath(base, start, undefined, 'turn0001-rest');
		expect(path.basename(file)).toBe('000000-notab-turn0001.jsonl');
	});

	it('falls back to "notab" for a tab id with nothing safe in it', () => {
		const start = new Date(2026, 9, 10, 0, 0, 0);
		const file = turnFilePath(base, start, '../..', 'turn0001');
		expect(path.basename(file)).toBe('000000-notab-turn0001.jsonl');
	});

	it('keeps a hostile id inside the hour folder', () => {
		const start = new Date(2026, 9, 10, 9, 8, 7);
		const file = turnFilePath(base, start, '../../etc', '..\\..\\x');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '10', '10', '09'));
		expect(path.basename(file)).not.toMatch(/[\\/]/);
	});

	it('files a turn under the hour it started, not the hour it ends', () => {
		const lateInHour = new Date(2026, 5, 15, 23, 59, 59);
		const file = turnFilePath(base, lateInHour, 'tab', 'turn');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '06', '15', '23'));
	});
});

describe('validateAgentFolder', () => {
	let sandbox: string;
	let workspace: string;
	let userData: string;
	let home: string;

	const context = (extra: string[] = []) => ({
		agentDirs: [workspace, ...extra],
		userDataPath: userData,
		homeDir: home,
	});

	beforeEach(() => {
		sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-layout-')));
		workspace = path.join(sandbox, 'workspace');
		userData = path.join(sandbox, 'userdata');
		home = path.join(sandbox, 'home');
		fs.mkdirSync(workspace);
		fs.mkdirSync(userData);
		fs.mkdirSync(home);
	});

	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it('accepts a folder outside every workspace and returns its real path', () => {
		const target = path.join(sandbox, 'logs', 'agent-a');
		const result = validateAgentFolder(target, context());
		expect(result).toEqual({ ok: true, resolved: target });
		expect(fs.statSync(target).isDirectory()).toBe(true);
	});

	it('accepts a folder inside the home folder', () => {
		const target = path.join(home, 'cot-logs');
		const result = validateAgentFolder(target, context());
		expect(result.ok).toBe(true);
	});

	it('leaves an accepted folder free of the probe file', () => {
		const target = path.join(sandbox, 'logs');
		expect(validateAgentFolder(target, context()).ok).toBe(true);
		expect(fs.readdirSync(target)).toEqual([]);
	});

	it('rejects a relative path', () => {
		const result = validateAgentFolder(path.join('relative', 'logs'), context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/absolute/i);
	});

	it('rejects an empty path', () => {
		const result = validateAgentFolder('   ', context());
		expect(result.ok).toBe(false);
	});

	it('rejects the root of the file system', () => {
		const root = path.parse(os.tmpdir()).root;
		const result = validateAgentFolder(root, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/root/i);
	});

	it('rejects the home folder itself', () => {
		const result = validateAgentFolder(home, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/home/i);
	});

	it('rejects a folder equal to an agent cwd', () => {
		const result = validateAgentFolder(workspace, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/workspace/i);
	});

	it('rejects a folder inside an agent cwd and does not create it', () => {
		const target = path.join(workspace, 'logs', 'deep');
		const result = validateAgentFolder(target, context());
		expect(result.ok).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("rejects a folder inside ANOTHER agent's projectRoot", () => {
		const otherRoot = path.join(sandbox, 'other-project');
		fs.mkdirSync(otherRoot);
		const result = validateAgentFolder(path.join(otherRoot, 'logs'), context([otherRoot]));
		expect(result.ok).toBe(false);
	});

	it('does not treat a sibling with a shared name prefix as inside', () => {
		const sibling = path.join(sandbox, 'workspace-logs');
		const result = validateAgentFolder(sibling, context());
		expect(result).toEqual({ ok: true, resolved: sibling });
	});

	it('rejects a folder equal to or inside the Maestro data folder', () => {
		expect(validateAgentFolder(userData, context()).ok).toBe(false);
		const inside = validateAgentFolder(path.join(userData, 'logs'), context());
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.reason).toMatch(/data folder/i);
	});

	it('rejects a symlink that points into an agent cwd', (ctx) => {
		const link = path.join(sandbox, 'innocent-link');
		try {
			fs.symlinkSync(workspace, link, 'dir');
		} catch {
			// Windows without the symlink privilege cannot build this fixture.
			ctx.skip();
			return;
		}
		const result = validateAgentFolder(link, context());
		expect(result.ok).toBe(false);
		const through = validateAgentFolder(path.join(link, 'logs'), context());
		expect(through.ok).toBe(false);
		expect(fs.existsSync(path.join(workspace, 'logs'))).toBe(false);
	});

	it('returns the real path when the folder is reached through a symlink', (ctx) => {
		const realLogs = path.join(sandbox, 'real-logs');
		fs.mkdirSync(realLogs);
		const link = path.join(sandbox, 'logs-link');
		try {
			fs.symlinkSync(realLogs, link, 'dir');
		} catch {
			ctx.skip();
			return;
		}
		const result = validateAgentFolder(link, context());
		expect(result).toEqual({ ok: true, resolved: realLogs });
	});

	it('rejects a path that is a file', () => {
		const file = path.join(sandbox, 'a-file');
		fs.writeFileSync(file, 'x');
		const result = validateAgentFolder(file, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/file/i);
	});

	it('rejects a folder that is not writable', (ctx) => {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		if (process.platform === 'win32' || getuid?.() === 0) {
			// Windows ignores mode bits, and root writes anywhere.
			ctx.skip();
			return;
		}
		const readOnly = path.join(sandbox, 'read-only');
		fs.mkdirSync(readOnly);
		fs.chmodSync(readOnly, 0o500);
		try {
			const result = validateAgentFolder(readOnly, context());
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/write/i);
		} finally {
			fs.chmodSync(readOnly, 0o700);
		}
	});

	describe('case-insensitive platforms', () => {
		const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

		afterEach(() => {
			if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
		});

		it('treats a differently-cased path as the same workspace on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			const shouted = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
			const result = validateAgentFolder(path.join(shouted, 'logs'), context());
			expect(result.ok).toBe(false);
		});

		it('treats a differently-cased path as the same workspace on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const shouted = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
			const result = validateAgentFolder(path.join(shouted, 'logs'), context());
			expect(result.ok).toBe(false);
		});
	});
});
