/**
 * Puts the `maestro-sketch` MCP server in front of the agents while the
 * `sketchBook` flag is on, and takes it away when it turns off (spec section 3:
 * "Flag off: no MCP server").
 *
 * Reuses Coworking's two pieces instead of a second mechanism:
 * - the bundled script file and the runtime that launches it
 *   (`ensureBundledServerScript()`, `buildMcpServerSpec()` in
 *   coworking/coworking-server-paths.ts), and
 * - the per-provider config writers (coworking/installers/), called with the
 *   server name `maestro-sketch`, so the entry lands beside `maestro-coworking`
 *   in Claude Code, Codex, OpenCode and Factory Droid configs.
 *
 * The entry auto-approves the server's tools (`autoApproveTools`): a Sketch
 * Book restricted turn runs Codex in its read-only sandbox, which otherwise
 * fails every sketch tool call for want of an approval (risk K1). The tools
 * reach only the calling agent's own sketches, and every write passes the
 * outbound screen, so no per-call approval is lost that guarded anything else.
 *
 * Coworking installs only when the user presses Install in its settings panel.
 * Sketch Book has no such panel: switching the Encore flag on IS the user's
 * request. To keep that footprint small, an entry is written only into a
 * provider whose config directory already exists (the provider was set up on
 * this machine). Removal runs for every provider and is a no-op where there is
 * no entry.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { buildMcpServerSpec, ensureBundledServerScript } from '../coworking/coworking-server-paths';
import { COWORKING_SUPPORTED_AGENTS, getInstaller } from '../coworking/installers';
import { getSketchServerScript } from './sketch-mcp-server-script';
import {
	SKETCH_MCP_SERVER_NAME,
	SKETCH_SOCKET_ENV_VAR,
	getSketchBridgeSocketPath,
} from './sketch-mcp-types';

const LOG_CTX = '[SketchBook][Install]';

/** File name of the bundled server script under userData. */
export const SKETCH_SERVER_SCRIPT_FILENAME = 'sketch-mcp-server.js';

/** One provider's outcome. `skipped` means its config directory does not exist. */
export interface SketchMcpInstallResult {
	agentId: string;
	outcome: 'installed' | 'removed' | 'skipped' | 'failed';
	error?: string;
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw err;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Refresh the bundled script and write the `maestro-sketch` entry into every
 * set-up provider's MCP config. Continues past a failing provider and reports
 * each outcome.
 */
export async function installSketchMcpServer(): Promise<SketchMcpInstallResult[]> {
	const scriptPath = await ensureBundledServerScript({
		filename: SKETCH_SERVER_SCRIPT_FILENAME,
		contents: getSketchServerScript(),
		logCategory: 'SketchBook',
	});
	const spec = {
		...(await buildMcpServerSpec(
			{ [SKETCH_SOCKET_ENV_VAR]: getSketchBridgeSocketPath() },
			scriptPath
		)),
		autoApproveTools: true,
	};
	const results: SketchMcpInstallResult[] = [];
	for (const agentId of COWORKING_SUPPORTED_AGENTS) {
		const installer = getInstaller(agentId);
		if (!installer) continue;
		try {
			if (!(await directoryExists(path.dirname(installer.configPath())))) {
				results.push({ agentId, outcome: 'skipped' });
				continue;
			}
			await installer.install(spec, SKETCH_MCP_SERVER_NAME);
			results.push({ agentId, outcome: 'installed' });
		} catch (err) {
			results.push({ agentId, outcome: 'failed', error: errorMessage(err) });
		}
	}
	return results;
}

/** Remove the `maestro-sketch` entry from every provider's MCP config. */
export async function uninstallSketchMcpServer(): Promise<SketchMcpInstallResult[]> {
	const results: SketchMcpInstallResult[] = [];
	for (const agentId of COWORKING_SUPPORTED_AGENTS) {
		const installer = getInstaller(agentId);
		if (!installer) continue;
		try {
			await installer.uninstall(SKETCH_MCP_SERVER_NAME);
			results.push({ agentId, outcome: 'removed' });
		} catch (err) {
			results.push({ agentId, outcome: 'failed', error: errorMessage(err) });
		}
	}
	return results;
}

/** Log and report the providers a run could not settle. */
function reportFailures(operation: string, results: SketchMcpInstallResult[]): void {
	for (const result of results) {
		if (result.outcome !== 'failed') continue;
		logger.warn(
			`${LOG_CTX} ${operation} failed for ${result.agentId}: ${result.error}`,
			'SketchBook'
		);
		void captureException(new Error(result.error ?? 'unknown error'), {
			operation: `sketchBook:${operation}`,
			agentId: result.agentId,
		});
	}
}

/** Flag on: write the entries. Never throws; a failure is logged and reported. */
export async function syncSketchMcpServerOn(): Promise<void> {
	try {
		reportFailures('installMcpServer', await installSketchMcpServer());
	} catch (err) {
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'sketchBook:installMcpServer',
		});
		logger.warn(`${LOG_CTX} Failed to install: ${errorMessage(err)}`, 'SketchBook');
	}
}

/** Flag off: remove the entries. Never throws; a failure is logged and reported. */
export async function syncSketchMcpServerOff(): Promise<void> {
	reportFailures('uninstallMcpServer', await uninstallSketchMcpServer());
}
