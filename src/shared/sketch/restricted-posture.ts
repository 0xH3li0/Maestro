/**
 * Whether a provider can run a Sketch Book restricted turn (spec section 5,
 * Turn posture; risk K1). Restricted = the provider's `readOnlyArgs` for the
 * turn plus the `maestro-sketch` MCP server. That only works when the
 * read-only mode both lets the sketch write tools run and keeps shell and
 * file writes out (risk R3).
 *
 * The blockers below were found live on 2026-10-27, one headless read-only
 * turn per installed provider with the real `maestro-sketch` server script
 * attached (results table in docs/sketch-book-spec.md section 5). Do not
 * "fix" a blocker by changing the provider's `readOnlyArgs`: other features
 * rely on them. Re-run the check and update the table instead.
 */

import type { AgentId } from '../agentIds';

/** Why each verified provider cannot run restricted turns. */
export const SKETCH_RESTRICTED_POSTURE_BLOCKERS: Readonly<Partial<Record<AgentId, string>>> = {
	'claude-code':
		"Claude Code's read-only mode (plan mode) refuses the sketch write tools, so guest requests cannot run restricted.",
	opencode:
		"OpenCode's read-only mode (the plan agent) still runs shell commands, so guest requests cannot run restricted.",
};

/** The reason for a provider with no read-only mode at all. */
export const SKETCH_NO_READ_ONLY_MODE_REASON =
	"This agent's provider has no read-only mode, so guest requests cannot run restricted.";

/**
 * Why `toolType` cannot run a restricted turn, or null when it can.
 * `readOnlyArgs` is the provider definition's own list.
 */
export function sketchRestrictedPostureBlocker(
	toolType: string,
	readOnlyArgs: readonly string[] | undefined
): string | null {
	if (!readOnlyArgs || readOnlyArgs.length === 0) return SKETCH_NO_READ_ONLY_MODE_REASON;
	return SKETCH_RESTRICTED_POSTURE_BLOCKERS[toolType as AgentId] ?? null;
}
