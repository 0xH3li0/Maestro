/**
 * Codex installer - writes a Maestro MCP server entry (default `maestro-coworking`) into
 * `~/.codex/config.toml` using a sentinel-delimited block so we can
 * locate it on uninstall without parsing TOML (which would lose
 * user comments and key ordering).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

/** The markers around one server's block. Named per server so two blocks coexist. */
function sentinels(serverName: string): { begin: string; end: string } {
	return {
		begin: `# >>> ${serverName} BEGIN - managed by Maestro, do not edit`,
		end: `# <<< ${serverName} END`,
	};
}

function configPath(): string {
	return path.join(os.homedir(), '.codex', 'config.toml');
}

async function readConfig(): Promise<string | null> {
	try {
		return await fs.promises.readFile(configPath(), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw err;
	}
}

async function writeConfig(content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(configPath()), { recursive: true });
	// Atomic write so a crash mid-write can't truncate the user's config.toml.
	await atomicWriteFile(configPath(), content);
}

function tomlString(value: string): string {
	// Conservative escape: backslashes and double quotes.
	return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function tomlStringArray(values: string[]): string {
	return '[' + values.map(tomlString).join(', ') + ']';
}

function tomlInlineEnv(env: Record<string, string>): string {
	const entries = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
	return '{ ' + entries.join(', ') + ' }';
}

function buildBlock(spec: CoworkingMcpServerSpec, serverName: string): string {
	const { begin, end } = sentinels(serverName);
	const lines: string[] = [
		begin,
		`[mcp_servers.${serverName}]`,
		`command = ${tomlString(spec.command)}`,
		`args = ${tomlStringArray(spec.args)}`,
	];
	if (Object.keys(spec.env).length > 0) {
		lines.push(`env = ${tomlInlineEnv(spec.env)}`);
	}
	if (spec.autoApproveTools) {
		lines.push('default_tools_approval_mode = "approve"');
	}
	lines.push(end);
	return lines.join('\n');
}

function findBlock(content: string, serverName: string): { start: number; end: number } | null {
	const { begin, end } = sentinels(serverName);
	const start = content.indexOf(begin);
	if (start === -1) return null;
	const endMarker = content.indexOf(end, start);
	if (endMarker === -1) return null;
	return { start, end: endMarker + end.length };
}

export const codexInstaller: AgentMcpInstaller = {
	agentId: 'codex',
	configPath,

	async isInstalled(serverName = COWORKING_MCP_SERVER_NAME) {
		const content = await readConfig();
		if (!content) return false;
		return findBlock(content, serverName) !== null;
	},

	async install(spec: CoworkingMcpServerSpec, serverName = COWORKING_MCP_SERVER_NAME) {
		const block = buildBlock(spec, serverName);
		const existing = await readConfig();
		if (existing == null) {
			await writeConfig(block + '\n');
			return;
		}
		const found = findBlock(existing, serverName);
		if (found) {
			const replaced = existing.slice(0, found.start) + block + existing.slice(found.end);
			await writeConfig(replaced);
			return;
		}
		// Append, ensuring exactly one blank line between user content and our block.
		const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
		await writeConfig(existing + sep + block + '\n');
	},

	async uninstall(serverName = COWORKING_MCP_SERVER_NAME) {
		const existing = await readConfig();
		if (!existing) return;
		const found = findBlock(existing, serverName);
		if (!found) return;
		// Trim a single trailing newline (and at most one blank-line separator we may have added).
		let endTrim = found.end;
		if (existing[endTrim] === '\n') endTrim += 1;
		// If a blank line precedes our block, drop one (mirror the install spacing).
		let startTrim = found.start;
		if (startTrim >= 2 && existing[startTrim - 1] === '\n' && existing[startTrim - 2] === '\n') {
			startTrim -= 1;
		}
		const updated = existing.slice(0, startTrim) + existing.slice(endTrim);
		await writeConfig(updated);
	},
};
