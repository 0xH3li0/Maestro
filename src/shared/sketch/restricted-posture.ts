/**
 * Whether a provider can run a Sketch Book restricted turn (spec section 5,
 * Turn posture; risk K1), and the command line it runs one with.
 *
 * Restricted means the sketch write tools run while shell and file writes stay
 * out (risk R3). Most providers get there with their own read-only mode (the
 * definition's `readOnlyArgs`) plus the `maestro-sketch` MCP server from their
 * config. A provider whose read-only mode fails that test has its own recipe
 * instead ({@link SKETCH_RESTRICTED_RECIPES}), used for restricted sketch turns
 * only, so every other read-only caller keeps the provider's `readOnlyArgs`.
 *
 * The blockers and recipes below were found live, one headless turn per
 * installed provider with the real `maestro-sketch` server script attached
 * (results table in docs/sketch-book-spec.md section 5). Do not "fix" a
 * blocker by changing the provider's `readOnlyArgs`: other features rely on
 * them. Re-run the check and update the table instead.
 */

import type { AgentId } from '../agentIds';

/** Why each verified provider cannot run restricted turns. */
export const SKETCH_RESTRICTED_POSTURE_BLOCKERS: Readonly<Partial<Record<AgentId, string>>> = {
	opencode:
		"OpenCode's read-only mode (the plan agent) still runs shell commands, so guest requests cannot run restricted.",
};

/** The reason for a provider with no read-only mode at all. */
export const SKETCH_NO_READ_ONLY_MODE_REASON =
	"This agent's provider has no read-only mode, so guest requests cannot run restricted.";

/**
 * Sketch tools a restricted turn never gets. `sketch_export` writes a file
 * into the agent's working directory and replaces whatever is there, so a
 * guest's request could overwrite project files with it.
 */
export const SKETCH_RESTRICTED_EXCLUDED_TOOLS: readonly string[] = ['sketch_export'];

/** The sketch tools a restricted turn may call, from the server's full list. */
export function sketchRestrictedToolNames(allTools: readonly string[]): string[] {
	return allTools.filter((tool) => !SKETCH_RESTRICTED_EXCLUDED_TOOLS.includes(tool));
}

/** The `maestro-sketch` server a restricted turn is handed, as an MCP config entry. */
export interface SketchRestrictedMcpServer {
	/** The server's name in the MCP config: `maestro-sketch`. */
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	/** The tools the turn may call ({@link sketchRestrictedToolNames}). */
	tools: readonly string[];
}

/** Builds a provider's restricted-turn arguments around the sketch server. */
export type SketchRestrictedRecipe = (server: SketchRestrictedMcpServer) => string[];

/**
 * Claude Code's read-only mode is plan mode, which refuses every MCP write
 * tool. Its restricted turn instead (verified live on 2.1.312, 2026-10-28; docs/sketch-book-spec.md section 5):
 *
 * - `--restricted`: removes Bash and the other code-running tools and
 *   WebFetch, ignores user, project and local settings files (so no hooks),
 *   confines the file tools to the working directory, and refuses
 *   `bypassPermissions` (a `--dangerously-skip-permissions` fails the turn).
 * - `--tools Read,Grep,Glob`: the only built-in tools. No Edit, Write,
 *   NotebookEdit, WebSearch or subagents.
 * - `--strict-mcp-config --mcp-config`: `maestro-sketch` is the only MCP
 *   server, so the user's other servers (a browser, a database) are not there.
 * - `--permission-mode dontAsk` with each allowed sketch tool named in
 *   `--allowedTools`: anything not named is denied, never asked, so a sketch
 *   tool added later stays out until it is added here. The excluded tools are
 *   also in `--disallowedTools`, which takes them out of the turn's tool list.
 *
 * A Claude Code too old to know `--restricted` refuses to start, so the turn
 * fails rather than running with more access.
 */
function claudeCodeRestrictedArgs(server: SketchRestrictedMcpServer): string[] {
	const mcpConfig = JSON.stringify({
		mcpServers: {
			[server.name]: { command: server.command, args: server.args, env: server.env },
		},
	});
	const mcpTool = (tool: string) => `mcp__${server.name}__${tool}`;
	const excluded = SKETCH_RESTRICTED_EXCLUDED_TOOLS.map(mcpTool);
	return [
		'--restricted',
		'--strict-mcp-config',
		'--mcp-config',
		mcpConfig,
		'--tools',
		'Read,Grep,Glob',
		'--permission-mode',
		'dontAsk',
		'--allowedTools',
		server.tools.map(mcpTool).join(','),
		...(excluded.length > 0 ? ['--disallowedTools', excluded.join(',')] : []),
	];
}

/** Providers whose restricted sketch turn is not their read-only mode. */
export const SKETCH_RESTRICTED_RECIPES: Readonly<Partial<Record<AgentId, SketchRestrictedRecipe>>> =
	{
		'claude-code': claudeCodeRestrictedArgs,
	};

/** Whether `toolType` runs restricted sketch turns with its own recipe. */
export function hasSketchRestrictedRecipe(toolType: string): boolean {
	return SKETCH_RESTRICTED_RECIPES[toolType as AgentId] !== undefined;
}

/**
 * The arguments that stand in for the provider's `readOnlyArgs` on a
 * restricted sketch turn, or null when its own read-only mode is the posture.
 */
export function sketchRestrictedReadOnlyArgs(
	toolType: string,
	server: SketchRestrictedMcpServer
): string[] | null {
	const recipe = SKETCH_RESTRICTED_RECIPES[toolType as AgentId];
	return recipe ? recipe(server) : null;
}

/**
 * Why `toolType` cannot run a restricted turn, or null when it can.
 * `readOnlyArgs` is the provider definition's own list.
 */
export function sketchRestrictedPostureBlocker(
	toolType: string,
	readOnlyArgs: readonly string[] | undefined
): string | null {
	if (hasSketchRestrictedRecipe(toolType)) return null;
	if (!readOnlyArgs || readOnlyArgs.length === 0) return SKETCH_NO_READ_ONLY_MODE_REASON;
	return SKETCH_RESTRICTED_POSTURE_BLOCKERS[toolType as AgentId] ?? null;
}
