/**
 * OpenCode installer - writes a Maestro MCP server entry (default `maestro-coworking`) into
 * `~/.config/opencode/opencode.json` (XDG-style location). OpenCode's stdio
 * MCP shape uses `type: "local"` and a single combined `command` array.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const commentJson = require('comment-json');
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg && xdg.trim().length > 0) return path.join(xdg, 'opencode');
	return path.join(os.homedir(), '.config', 'opencode');
}

function configPath(): string {
	return path.join(configDir(), 'opencode.json');
}

async function readConfig(): Promise<unknown> {
	try {
		const raw = await fs.promises.readFile(configPath(), 'utf8');
		return commentJson.parse(raw);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return commentJson.parse('{}');
		}
		throw err;
	}
}

async function writeConfig(config: unknown): Promise<void> {
	await fs.promises.mkdir(configDir(), { recursive: true });
	const out = commentJson.stringify(config, null, 2) + '\n';
	// Atomic write so a crash mid-write can't truncate the user's opencode.json.
	await atomicWriteFile(configPath(), out);
}

export const opencodeInstaller: AgentMcpInstaller = {
	agentId: 'opencode',
	configPath,

	async isInstalled(serverName = COWORKING_MCP_SERVER_NAME) {
		const cfg = (await readConfig()) as Record<string, unknown>;
		const mcp = cfg?.mcp as Record<string, unknown> | undefined;
		return !!mcp && Object.prototype.hasOwnProperty.call(mcp, serverName);
	},

	async install(spec: CoworkingMcpServerSpec, serverName = COWORKING_MCP_SERVER_NAME) {
		const cfg = (await readConfig()) as Record<string, unknown>;
		if (!cfg.mcp || typeof cfg.mcp !== 'object') {
			cfg.mcp = commentJson.parse('{}');
		}
		const mcp = cfg.mcp as Record<string, unknown>;
		mcp[serverName] = {
			type: 'local',
			command: [spec.command, ...spec.args],
			environment: spec.env,
			enabled: true,
		};
		await writeConfig(cfg);
	},

	async uninstall(serverName = COWORKING_MCP_SERVER_NAME) {
		const cfg = (await readConfig()) as Record<string, unknown>;
		const mcp = cfg?.mcp as Record<string, unknown> | undefined;
		if (!mcp) return;
		if (!Object.prototype.hasOwnProperty.call(mcp, serverName)) return;
		delete mcp[serverName];
		if (Object.keys(mcp).length === 0) {
			delete cfg.mcp;
		}
		await writeConfig(cfg);
	},
};
