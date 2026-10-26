/**
 * @file sketch-mcp-install.test.ts
 *
 * Putting the `maestro-sketch` server in front of the agents with the
 * `sketchBook` flag. Properties worth protecting:
 *
 *   - **Flag on writes the script and the entries**: the bundled script lands
 *     under userData, and each set-up provider's config gets a `maestro-sketch`
 *     entry that runs that script with the sketch socket.
 *   - **Small footprint**: a provider whose config directory does not exist is
 *     skipped, not created.
 *   - **Flag off removes the entries** and leaves `maestro-coworking` alone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { paths } = vi.hoisted(() => ({ paths: { userData: '' } }));

vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
// No system node: the spec falls back to this binary in Node mode.
vi.mock('child_process', () => {
	const execFile = () => {
		throw new Error('use the promisified execFile');
	};
	(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
		async () => {
			throw new Error('which: node not found');
		};
	return { execFile, default: { execFile } };
});

import {
	SKETCH_SERVER_SCRIPT_FILENAME,
	installSketchMcpServer,
	uninstallSketchMcpServer,
} from '../../../main/sketch/sketch-mcp-install';
import { getSketchServerScript } from '../../../main/sketch/sketch-mcp-server-script';
import { claudeCodeInstaller } from '../../../main/coworking/installers/claude-code';

describe('sketch MCP install', () => {
	let tmp: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sketch-install-'));
		paths.userData = path.join(tmp, 'userData');
		for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) saved[key] = process.env[key];
		process.env.HOME = path.join(tmp, 'home');
		process.env.USERPROFILE = process.env.HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmp, 'home', '.config');
		// Claude Code's config lives in HOME itself; Codex is set up; OpenCode and
		// Factory Droid are not.
		fs.mkdirSync(path.join(tmp, 'home', '.codex'), { recursive: true });
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('writes the script and an entry for each set-up provider, skipping the rest', async () => {
		const results = await installSketchMcpServer();

		expect(Object.fromEntries(results.map((r) => [r.agentId, r.outcome]))).toEqual({
			'claude-code': 'installed',
			codex: 'installed',
			opencode: 'skipped',
			'factory-droid': 'skipped',
		});

		const scriptPath = path.join(paths.userData, SKETCH_SERVER_SCRIPT_FILENAME);
		expect(fs.readFileSync(scriptPath, 'utf8')).toBe(getSketchServerScript());

		const claude = JSON.parse(fs.readFileSync(path.join(tmp, 'home', '.claude.json'), 'utf8'));
		const entry = claude.mcpServers['maestro-sketch'];
		expect(entry.args).toEqual([scriptPath]);
		expect(entry.env.MAESTRO_SKETCH_SOCKET).toEqual(expect.any(String));
		expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1');

		const codex = fs.readFileSync(path.join(tmp, 'home', '.codex', 'config.toml'), 'utf8');
		expect(codex).toContain('[mcp_servers.maestro-sketch]');

		// Skipped providers get no config directory created.
		expect(fs.existsSync(path.join(tmp, 'home', '.factory'))).toBe(false);
		expect(fs.existsSync(path.join(tmp, 'home', '.config', 'opencode'))).toBe(false);
	});

	it('removes the entries on flag off and leaves maestro-coworking in place', async () => {
		await claudeCodeInstaller.install({ command: 'node', args: ['cw.js'], env: {} });
		await installSketchMcpServer();

		const results = await uninstallSketchMcpServer();
		expect(results.every((r) => r.outcome === 'removed')).toBe(true);

		const claude = JSON.parse(fs.readFileSync(path.join(tmp, 'home', '.claude.json'), 'utf8'));
		expect(Object.keys(claude.mcpServers)).toEqual(['maestro-coworking']);
		const codex = fs.readFileSync(path.join(tmp, 'home', '.codex', 'config.toml'), 'utf8');
		expect(codex).not.toContain('maestro-sketch');
	});
});
