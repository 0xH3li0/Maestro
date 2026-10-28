/**
 * The command line of a Sketch Book restricted turn (spec section 5, Turn
 * posture), decided in main at spawn time.
 *
 * The renderer marks a restricted sketch turn `sketchRestricted` on its
 * read-only spawn (`sketchBotTurns.ts`). For a provider with its own recipe
 * (`SKETCH_RESTRICTED_RECIPES`, Claude Code), the recipe replaces the
 * provider's `readOnlyArgs` and is handed the `maestro-sketch` server bound to
 * the owner agent. The turn then also runs:
 *
 * - without the user's custom args, which could add a directory, an MCP
 *   server or a permission flag the posture leaves out;
 * - without the agent's Additional Directories, so the file tools stay in the
 *   agent's own working directory;
 * - on `claude --print`, never the maestro-p TUI, so the arguments reach the
 *   CLI as they are.
 *
 * The mark fails closed. A spawn that lost it runs the provider's own
 * read-only mode, which for Claude Code is plan mode: it refuses the sketch
 * write tools, so the turn does less, never more.
 */

import { sketchRestrictedReadOnlyArgs } from '../../shared/sketch/restricted-posture';
import { sketchRestrictedMcpServer } from './sketch-mcp-install';

export interface SketchRestrictedLaunch {
	/** Stands in for the provider's `readOnlyArgs` (`buildAgentArgs`). */
	readOnlyArgsOverride: string[];
}

/**
 * The launch of one restricted sketch turn, or null when the spawn is not one,
 * or the provider's own read-only mode is its posture (Codex).
 */
export async function resolveSketchRestrictedLaunch(input: {
	sketchRestricted: boolean | undefined;
	readOnly: boolean;
	toolType: string;
	agentId: string;
}): Promise<SketchRestrictedLaunch | null> {
	if (input.sketchRestricted !== true || !input.readOnly) return null;
	const server = await sketchRestrictedMcpServer(input.agentId);
	const readOnlyArgsOverride = sketchRestrictedReadOnlyArgs(input.toolType, server);
	return readOnlyArgsOverride ? { readOnlyArgsOverride } : null;
}
