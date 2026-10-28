/**
 * resolveSketchRestrictedLaunch: a restricted sketch turn on a provider with a
 * recipe (Claude Code) gets the recipe in place of its read-only args. Any
 * other spawn, or a provider whose own read-only mode is its posture, gets
 * null, and the mark counts only on a read-only spawn.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const install = vi.hoisted(() => ({ sketchRestrictedMcpServer: vi.fn() }));
vi.mock('../../../main/sketch/sketch-mcp-install', () => install);

import { resolveSketchRestrictedLaunch } from '../../../main/sketch/sketch-restricted-launch';

const SERVER = {
	name: 'maestro-sketch',
	command: 'node',
	args: ['/data/sketch-mcp-server.js'],
	env: { MAESTRO_SKETCH_AGENT_ID: 'agent-1' },
	tools: ['sketch_list'],
};

describe('resolveSketchRestrictedLaunch', () => {
	beforeEach(() => {
		install.sketchRestrictedMcpServer.mockReset();
		install.sketchRestrictedMcpServer.mockResolvedValue(SERVER);
	});

	it("gives a Claude Code restricted turn its recipe, bound to the owner's server", async () => {
		const launch = await resolveSketchRestrictedLaunch({
			sketchRestricted: true,
			readOnly: true,
			toolType: 'claude-code',
			agentId: 'agent-1',
		});
		expect(install.sketchRestrictedMcpServer).toHaveBeenCalledWith('agent-1');
		expect(launch?.readOnlyArgsOverride).toContain('--restricted');
		expect(launch?.readOnlyArgsOverride).not.toContain('plan');
	});

	it('leaves a provider whose read-only mode is its posture on that mode', async () => {
		expect(
			await resolveSketchRestrictedLaunch({
				sketchRestricted: true,
				readOnly: true,
				toolType: 'codex',
				agentId: 'agent-1',
			})
		).toBeNull();
	});

	it('ignores the mark on a spawn that is not read-only, and a spawn without it', async () => {
		expect(
			await resolveSketchRestrictedLaunch({
				sketchRestricted: true,
				readOnly: false,
				toolType: 'claude-code',
				agentId: 'agent-1',
			})
		).toBeNull();
		expect(
			await resolveSketchRestrictedLaunch({
				sketchRestricted: undefined,
				readOnly: true,
				toolType: 'claude-code',
				agentId: 'agent-1',
			})
		).toBeNull();
		expect(install.sketchRestrictedMcpServer).not.toHaveBeenCalled();
	});
});
