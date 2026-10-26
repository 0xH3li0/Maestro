/**
 * Tests for the renderer half of `maestro-cli sketch`: `open` shows the sketch
 * through the same tab helper the UI uses (background leaves the view alone),
 * `export` draws SVG as text and PNG as base64 with Excalidraw's exporters, and
 * every failure comes back as a reply instead of a throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const excalidraw = vi.hoisted(() => ({
	exportToSvg: vi.fn(),
	exportToBlob: vi.fn(),
}));
vi.mock('../../../renderer/components/SketchBook/excalidrawAssets', () => ({
	loadExcalidraw: vi.fn(async () => excalidraw),
}));

import {
	exportSketchImage,
	runRemoteSketchCommand,
} from '../../../renderer/services/sketchRemoteCommands';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { SketchScene } from '../../../shared/sketch/types';
import { createMockSession } from '../../helpers/mockSession';

const scene: SketchScene = {
	type: 'excalidraw',
	version: 2,
	elements: [
		{ id: 'live', version: 1, type: 'rectangle' },
		{ id: 'gone', version: 2, type: 'ellipse', isDeleted: true },
	],
	appState: { viewBackgroundColor: '#fafafa' },
	files: {},
};

const agent = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;

describe('runRemoteSketchCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-1', name: 'Planner' }),
				createMockSession({ id: 'agent-2', name: 'Builder' }),
			],
			activeSessionId: 'agent-1',
		});
	});

	it('opens the sketch focused on its agent, switching to that agent', async () => {
		const result = await runRemoteSketchCommand({
			action: 'open',
			sessionId: 'agent-2',
			sketchId: 'sketch-1',
			name: 'Board',
			background: false,
		});

		const tabs = agent('agent-2').sketchTabs ?? [];
		expect(result).toEqual({ success: true, tabId: tabs[0].id });
		expect(tabs[0]).toMatchObject({ sketchId: 'sketch-1', name: 'Board' });
		expect(agent('agent-2').activeSketchTabId).toBe(tabs[0].id);
		expect(useSessionStore.getState().activeSessionId).toBe('agent-2');
	});

	it('adds a background tab without moving the agent or the tab', async () => {
		const result = await runRemoteSketchCommand({
			action: 'open',
			sessionId: 'agent-2',
			sketchId: 'sketch-1',
			name: 'Board',
			background: true,
		});

		expect(result.success).toBe(true);
		expect(agent('agent-2').sketchTabs).toHaveLength(1);
		expect(agent('agent-2').activeSketchTabId ?? null).toBeNull();
		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
	});

	it('reuses the tab a sketch already has', async () => {
		const request = {
			action: 'open' as const,
			sessionId: 'agent-1',
			sketchId: 'sketch-1',
			name: 'Board',
			background: true,
		};
		const first = await runRemoteSketchCommand(request);
		const second = await runRemoteSketchCommand(request);

		expect(second).toEqual(first);
		expect(agent('agent-1').sketchTabs).toHaveLength(1);
	});

	it('fails for an agent this window does not hold', async () => {
		await expect(
			runRemoteSketchCommand({
				action: 'open',
				sessionId: 'missing',
				sketchId: 'sketch-1',
				name: 'Board',
				background: false,
			})
		).resolves.toEqual({
			success: false,
			error: 'The agent that owns this sketch is not in this window.',
		});
		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
	});

	it('answers an export failure instead of throwing', async () => {
		excalidraw.exportToSvg.mockRejectedValue(new Error('font load failed'));
		await expect(
			runRemoteSketchCommand({ action: 'export', format: 'svg', scene })
		).resolves.toEqual({ success: false, error: 'font load failed' });
	});
});

describe('exportSketchImage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('draws SVG as UTF-8 text from the live elements, with the background', async () => {
		excalidraw.exportToSvg.mockResolvedValue({ outerHTML: '<svg>board</svg>' });

		await expect(exportSketchImage(scene, 'svg')).resolves.toEqual({
			format: 'svg',
			mimeType: 'image/svg+xml',
			encoding: 'utf8',
			data: '<svg>board</svg>',
		});
		const options = excalidraw.exportToSvg.mock.calls[0][0];
		expect(options.elements.map((e: { id: string }) => e.id)).toEqual(['live']);
		expect(options.appState).toMatchObject({
			viewBackgroundColor: '#fafafa',
			exportBackground: true,
		});
	});

	it('draws PNG as base64 without the data URL prefix', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		excalidraw.exportToBlob.mockResolvedValue(new Blob([bytes], { type: 'image/png' }));

		const file = await exportSketchImage(scene, 'png');

		expect(file).toMatchObject({ format: 'png', mimeType: 'image/png', encoding: 'base64' });
		expect(file.data).toBe(btoa(String.fromCharCode(...bytes)));
		expect(excalidraw.exportToBlob.mock.calls[0][0]).toMatchObject({ mimeType: 'image/png' });
	});
});
