/**
 * Per-agent installer contract for Maestro's bundled MCP servers.
 *
 * Each strategy:
 *   - knows where its agent reads MCP config from (user-level path)
 *   - can answer "is the named server's entry currently installed?"
 *   - can install / uninstall the entry idempotently, preserving any
 *     unrelated user content (other MCP servers, comments, formatting).
 *
 * `serverName` defaults to `maestro-coworking`; Sketch Book passes
 * `maestro-sketch`, so both servers share one writer per provider.
 */

import type { CoworkingMcpServerSpec } from '../coworking-types';

export interface AgentMcpInstaller {
	readonly agentId: string;
	/** Absolute path of the user-level config file this strategy operates on. */
	configPath(): string;
	/** True iff a `serverName` entry is present in the config file. */
	isInstalled(serverName?: string): Promise<boolean>;
	/** Add the entry, replacing any existing `serverName` block. */
	install(spec: CoworkingMcpServerSpec, serverName?: string): Promise<void>;
	/** Remove the entry. No-op if not installed. */
	uninstall(serverName?: string): Promise<void>;
}
