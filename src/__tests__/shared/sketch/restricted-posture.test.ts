import { describe, expect, it } from 'vitest';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import {
	SKETCH_NO_READ_ONLY_MODE_REASON,
	SKETCH_RESTRICTED_EXCLUDED_TOOLS,
	SKETCH_RESTRICTED_POSTURE_BLOCKERS,
	SKETCH_RESTRICTED_RECIPES,
	hasSketchRestrictedRecipe,
	sketchRestrictedPostureBlocker,
	sketchRestrictedReadOnlyArgs,
	sketchRestrictedToolNames,
	type SketchRestrictedMcpServer,
} from '../../../shared/sketch/restricted-posture';

/** The provider's own `readOnlyArgs`, as the guardrail reads them. */
function blockerFor(toolType: string): string | null {
	return sketchRestrictedPostureBlocker(toolType, getAgentDefinition(toolType)?.readOnlyArgs);
}

describe('sketchRestrictedPostureBlocker', () => {
	it('blocks the providers whose read-only mode failed the live check (risk K1)', () => {
		expect(blockerFor('opencode')).toBe(SKETCH_RESTRICTED_POSTURE_BLOCKERS.opencode);
		expect(blockerFor('opencode')).toContain('shell');
	});

	it('allows a verified provider whose read-only mode runs the sketch tools', () => {
		expect(blockerFor('codex')).toBeNull();
	});

	it('allows a provider with its own restricted recipe, whatever its read-only mode', () => {
		expect(hasSketchRestrictedRecipe('claude-code')).toBe(true);
		expect(blockerFor('claude-code')).toBeNull();
		expect(sketchRestrictedPostureBlocker('claude-code', [])).toBeNull();
	});

	it('refuses a provider with no read-only mode', () => {
		expect(blockerFor('factory-droid')).toBe(SKETCH_NO_READ_ONLY_MODE_REASON);
		expect(sketchRestrictedPostureBlocker('codex', [])).toBe(SKETCH_NO_READ_ONLY_MODE_REASON);
		expect(sketchRestrictedPostureBlocker('codex', undefined)).toBe(
			SKETCH_NO_READ_ONLY_MODE_REASON
		);
	});

	it('names only providers that have a read-only mode to fail', () => {
		for (const toolType of Object.keys(SKETCH_RESTRICTED_POSTURE_BLOCKERS)) {
			expect(getAgentDefinition(toolType)?.readOnlyArgs?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

const SERVER: SketchRestrictedMcpServer = {
	name: 'maestro-sketch',
	command: '/usr/bin/node',
	args: ['/data/sketch-mcp-server.js'],
	env: { MAESTRO_SKETCH_SOCKET: '/data/sketch.sock', MAESTRO_SKETCH_AGENT_ID: 'agent-1' },
	tools: ['sketch_list', 'sketch_add_elements'],
};

/** The value after `flag` in `args`. */
function valueOf(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

describe('sketchRestrictedReadOnlyArgs', () => {
	it('gives a provider without a recipe its own read-only mode', () => {
		expect(sketchRestrictedReadOnlyArgs('codex', SERVER)).toBeNull();
		expect(hasSketchRestrictedRecipe('codex')).toBe(false);
	});

	it('runs Claude Code under --restricted with read and search tools only, never plan mode', () => {
		const args = sketchRestrictedReadOnlyArgs('claude-code', SERVER)!;
		expect(args).toContain('--restricted');
		expect(valueOf(args, '--tools')).toBe('Read,Grep,Glob');
		expect(valueOf(args, '--permission-mode')).toBe('dontAsk');
		expect(args).not.toContain('plan');
		expect(args).not.toContain('--dangerously-skip-permissions');
	});

	it('hands Claude Code the sketch server as its only MCP server, bound to the owner', () => {
		const args = sketchRestrictedReadOnlyArgs('claude-code', SERVER)!;
		expect(args).toContain('--strict-mcp-config');
		const config = JSON.parse(valueOf(args, '--mcp-config')!);
		expect(Object.keys(config.mcpServers)).toEqual(['maestro-sketch']);
		expect(config.mcpServers['maestro-sketch']).toEqual({
			command: SERVER.command,
			args: SERVER.args,
			env: SERVER.env,
		});
	});

	it('allows each sketch tool by name and denies the excluded ones', () => {
		const args = sketchRestrictedReadOnlyArgs('claude-code', SERVER)!;
		expect(valueOf(args, '--allowedTools')).toBe(
			'mcp__maestro-sketch__sketch_list,mcp__maestro-sketch__sketch_add_elements'
		);
		expect(valueOf(args, '--disallowedTools')).toBe('mcp__maestro-sketch__sketch_export');
	});

	it('names no flag twice, since buildAgentArgs drops a repeated flag', () => {
		const args = sketchRestrictedReadOnlyArgs('claude-code', SERVER)!;
		const flags = args.filter((arg) => arg.startsWith('--'));
		expect(new Set(flags).size).toBe(flags.length);
	});

	it('has a recipe only for providers that have a definition', () => {
		for (const toolType of Object.keys(SKETCH_RESTRICTED_RECIPES)) {
			expect(getAgentDefinition(toolType)).toBeTruthy();
		}
	});
});

describe('sketchRestrictedToolNames', () => {
	it('keeps sketch_export out of a restricted turn', () => {
		expect(SKETCH_RESTRICTED_EXCLUDED_TOOLS).toContain('sketch_export');
		expect(
			sketchRestrictedToolNames(['sketch_list', 'sketch_export', 'sketch_add_elements'])
		).toEqual(['sketch_list', 'sketch_add_elements']);
	});
});
