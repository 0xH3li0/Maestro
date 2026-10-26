/**
 * The Sketch Book hop from main to a window: the request goes to the window the
 * resolver names for the agent, on `remote:sketchCommand`, with a longer wait
 * for an export (Excalidraw loads first); with no resolver or no live window it
 * fails at once instead of hanging the CLI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	requestFromRenderer: vi.fn(),
	available: true,
}));

vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: h.requestFromRenderer,
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => !!win && h.available,
}));

import {
	SKETCH_REMOTE_COMMAND_CHANNEL,
	requestSketchRenderer,
	setSketchWindowResolver,
} from '../../../main/sketch/sketch-renderer-bridge';
import { normalizeSketchRendererResult } from '../../../shared/sketch/commands';
import type { SketchScene } from '../../../shared/sketch/types';

const win = { id: 'window-1' } as never;
const scene: SketchScene = {
	type: 'excalidraw',
	version: 2,
	elements: [],
	appState: {},
	files: {},
};
const open = {
	action: 'open' as const,
	sessionId: 'agent-1',
	sketchId: 'sketch-1',
	name: 'Board',
	background: true,
};

describe('requestSketchRenderer', () => {
	beforeEach(() => {
		h.requestFromRenderer.mockReset();
		h.requestFromRenderer.mockResolvedValue({ success: true, tabId: 'tab-1' });
		h.available = true;
		setSketchWindowResolver(null);
	});

	it('fails at once before a resolver is set', async () => {
		await expect(requestSketchRenderer('agent-1', open)).resolves.toEqual({
			success: false,
			error: 'No Maestro window is open to show the sketch.',
		});
		expect(h.requestFromRenderer).not.toHaveBeenCalled();
	});

	it('fails at once when the window is gone', async () => {
		setSketchWindowResolver(() => win);
		h.available = false;
		await expect(requestSketchRenderer('agent-1', open)).resolves.toMatchObject({
			success: false,
		});
		expect(h.requestFromRenderer).not.toHaveBeenCalled();
	});

	it("sends an open to the agent's window and returns its reply", async () => {
		const resolver = vi.fn(() => win);
		setSketchWindowResolver(resolver);

		await expect(requestSketchRenderer('agent-1', open)).resolves.toEqual({
			success: true,
			tabId: 'tab-1',
		});
		expect(resolver).toHaveBeenCalledWith('agent-1');
		expect(h.requestFromRenderer).toHaveBeenCalledWith(win, SKETCH_REMOTE_COMMAND_CHANNEL, {
			args: [open],
			fallback: { success: false, error: 'The Maestro window did not answer in time.' },
			parse: normalizeSketchRendererResult,
			timeoutMs: 10_000,
		});
	});

	it('gives an export longer, and lets the primary window draw for no agent', async () => {
		const resolver = vi.fn(() => win);
		setSketchWindowResolver(resolver);

		await requestSketchRenderer(null, { action: 'export', format: 'png', scene });

		expect(resolver).toHaveBeenCalledWith(null);
		expect(h.requestFromRenderer.mock.calls[0][2].timeoutMs).toBeGreaterThan(10_000);
	});

	it("answers an agent write or render before the maestro-sketch script's 30 s call timeout", async () => {
		setSketchWindowResolver(() => win);

		await requestSketchRenderer('agent-1', {
			action: 'agentWrite',
			sketchId: 'sketch-1',
			agent: { id: 'agent-1', name: 'Planner' },
			write: { op: 'delete', ids: ['r1'] },
		});
		await requestSketchRenderer('agent-1', { action: 'convertMermaid', mermaid: 'flowchart LR' });
		await requestSketchRenderer('agent-1', {
			action: 'renderForAgent',
			sketchId: 'sketch-1',
			format: 'png',
			elements: [],
		});

		expect(h.requestFromRenderer).toHaveBeenCalledTimes(3);
		for (const call of h.requestFromRenderer.mock.calls) {
			expect(call[2].timeoutMs).toBeGreaterThan(10_000);
			expect(call[2].timeoutMs).toBeLessThan(30_000);
		}
	});
});
