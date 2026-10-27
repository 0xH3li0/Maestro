/**
 * Tests for the renderer half of `maestro-cli sketch`: `open` shows the sketch
 * through the same tab helper the UI uses (background leaves the view alone),
 * `export` draws SVG as text and PNG as base64 with Excalidraw's exporters,
 * `agentWrite` and `convertMermaid` reach the agent write service,
 * `renderForAgent` draws only the elements main picked (with only the files
 * they name), `snapshotScene` hands main the live scene with the room's seq,
 * `syncRoom` joins or leaves the room, `botPolicy` sends `policy.set`
 * through it, and every failure comes back as a
 * reply instead of a throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const excalidraw = vi.hoisted(() => ({
	exportToSvg: vi.fn(),
	exportToBlob: vi.fn(),
}));
vi.mock('../../../renderer/components/SketchBook/excalidrawAssets', () => ({
	loadExcalidraw: vi.fn(async () => excalidraw),
}));

const agentWrites = vi.hoisted(() => ({
	applySketchAgentWrite: vi.fn(),
	convertMermaidToSkeletons: vi.fn(),
}));
vi.mock('../../../renderer/services/sketchAgentWrites', () => agentWrites);

const roomClient = vi.hoisted(() => ({
	getSketchRoomClient: vi.fn(),
	connectSketchRoom: vi.fn(),
	disconnectSketchRoom: vi.fn(),
}));
vi.mock('../../../renderer/services/sketchRoomClient', () => roomClient);

const botRelay = vi.hoisted(() => ({
	attachSketchBotRelay: vi.fn(),
	detachSketchBotRelay: vi.fn(),
}));
vi.mock('../../../renderer/services/sketchBotRelay', () => botRelay);

const botPolicy = vi.hoisted(() => ({
	applySketchBotPolicy: vi.fn(),
	attachSketchBotPolicySync: vi.fn(),
	detachSketchBotPolicySync: vi.fn(),
	dismissSketchBotPolicyNotice: vi.fn(),
}));
vi.mock('../../../renderer/services/sketchBotPolicy', () => botPolicy);

import {
	exportSketchImage,
	runRemoteSketchCommand,
} from '../../../renderer/services/sketchRemoteCommands';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSketchSessionStore } from '../../../renderer/stores/sketchSessionStore';
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

describe('runRemoteSketchCommand readSession', () => {
	const readScene = vi.fn<(id: string) => Promise<SketchScene>>();

	beforeEach(() => {
		vi.clearAllMocks();
		useSketchSessionStore.setState({ sessions: {} });
		(window.maestro as unknown as { sketch: { readScene: typeof readScene } }).sketch = {
			readScene,
		};
	});

	it('answers null for a sketch no view has open when asked not to open it', async () => {
		await expect(
			runRemoteSketchCommand({ action: 'readSession', sketchId: 'sketch-1', open: false })
		).resolves.toEqual({ success: true, session: null });
		expect(readScene).not.toHaveBeenCalled();
	});

	it('opens the session when asked and hands back the elements, author map and file count', async () => {
		readScene.mockResolvedValueOnce({ ...scene, files: { f1: {} } });
		const result = await runRemoteSketchCommand({
			action: 'readSession',
			sketchId: 'sketch-1',
			open: true,
		});
		expect(result).toEqual({
			success: true,
			session: { elements: scene.elements, authors: {}, fileCount: 1, approvedImages: {} },
		});
		expect(useSketchSessionStore.getState().sessions['sketch-1'].status).toBe('ready');
	});

	it('reads an open session without touching disk, unsaved edits included', async () => {
		const author = {
			version: 1,
			actor: {
				id: 'conductor',
				kind: 'conductor' as const,
				name: 'Me',
				role: 'conductor' as const,
			},
			textHash: 'h',
			guestTouched: false,
		};
		useSketchSessionStore.setState({
			sessions: {
				'sketch-1': {
					sketchId: 'sketch-1',
					status: 'ready',
					loadError: null,
					scene,
					authors: { live: author },
					dirty: true,
					revision: 4,
					saveError: null,
					externalRevision: 0,
					focusRequest: null,
					chat: [],
					botRequests: [],
					approvedImages: {},
				},
			},
		});
		const result = await runRemoteSketchCommand({
			action: 'readSession',
			sketchId: 'sketch-1',
			open: false,
		});
		expect(result).toEqual({
			success: true,
			session: {
				elements: scene.elements,
				authors: { live: author },
				fileCount: 0,
				approvedImages: {},
			},
		});
		expect(readScene).not.toHaveBeenCalled();
	});

	it('answers the load error when the scene cannot be read', async () => {
		readScene.mockRejectedValueOnce(new Error('scene-unreadable'));
		const result = await runRemoteSketchCommand({
			action: 'readSession',
			sketchId: 'sketch-1',
			open: true,
		});
		expect(result.success).toBe(false);
		expect(result.success === false && result.error).toContain('scene-unreadable');
	});
});

describe('runRemoteSketchCommand agent writes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('hands an agent write to the write service and returns its report', async () => {
		const report = {
			sceneVersion: 3,
			elements: [{ id: 'r1', type: 'rectangle' }],
			missing: [],
			conflicts: { elements: [], authors: {}, fileCount: 0, approvedImages: {} },
		};
		agentWrites.applySketchAgentWrite.mockResolvedValue(report);
		const write = { op: 'delete' as const, ids: ['r1'] };
		const result = await runRemoteSketchCommand({
			action: 'agentWrite',
			sketchId: 'sketch-1',
			agent: { id: 'agent-1', name: 'Planner' },
			write,
		});
		expect(result).toEqual({ success: true, write: report });
		expect(agentWrites.applySketchAgentWrite).toHaveBeenCalledWith(
			'sketch-1',
			{ id: 'agent-1', name: 'Planner' },
			write
		);
	});

	it('converts Mermaid to skeletons', async () => {
		agentWrites.convertMermaidToSkeletons.mockResolvedValue([{ type: 'rectangle', id: 'A' }]);
		await expect(
			runRemoteSketchCommand({ action: 'convertMermaid', mermaid: 'flowchart LR; A-->B' })
		).resolves.toEqual({ success: true, skeletons: [{ type: 'rectangle', id: 'A' }] });
	});

	it('answers a failed write instead of throwing', async () => {
		agentWrites.applySketchAgentWrite.mockRejectedValue(new Error('id taken'));
		await expect(
			runRemoteSketchCommand({
				action: 'agentWrite',
				sketchId: 'sketch-1',
				agent: { id: 'agent-1', name: 'Planner' },
				write: { op: 'chat', text: 'hi' },
			})
		).resolves.toEqual({ success: false, error: 'id taken' });
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

describe('runRemoteSketchCommand renderForAgent', () => {
	const files = {
		kept: { id: 'kept', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
		guest: { id: 'guest', mimeType: 'image/png', dataURL: 'data:image/png;base64,BBBB' },
	};
	const sessionScene: SketchScene = {
		type: 'excalidraw',
		version: 2,
		source: 'maestro',
		elements: [
			{ id: 'box', version: 1, type: 'rectangle' },
			{ id: 'secret', version: 1, type: 'text', text: 'withheld words' },
			{ id: 'img', version: 1, type: 'image', fileId: 'kept' },
			{ id: 'guest-img', version: 1, type: 'image', fileId: 'guest' },
		],
		appState: { viewBackgroundColor: '#123456', gridSize: 20, name: 'not copied' },
		files,
	};
	const picked = [
		{ id: 'box', version: 1, type: 'rectangle' },
		{ id: 'img', version: 1, type: 'image', fileId: 'kept' },
	];

	beforeEach(() => {
		vi.clearAllMocks();
		useSketchSessionStore.setState({
			sessions: {
				'sketch-1': {
					sketchId: 'sketch-1',
					status: 'ready',
					loadError: null,
					scene: sessionScene,
					authors: {},
					dirty: false,
					revision: 1,
					saveError: null,
					externalRevision: 0,
					focusRequest: null,
					chat: [],
					botRequests: [],
					approvedImages: {},
				},
			},
		});
	});

	it('draws only the elements main picked, with only the files they name', async () => {
		excalidraw.exportToBlob.mockResolvedValue(
			new Blob([new Uint8Array([1])], { type: 'image/png' })
		);
		const result = await runRemoteSketchCommand({
			action: 'renderForAgent',
			sketchId: 'sketch-1',
			format: 'png',
			elements: picked,
			scale: 2,
		});

		expect(result).toMatchObject({ success: true, file: { format: 'png', encoding: 'base64' } });
		const options = excalidraw.exportToBlob.mock.calls[0][0];
		expect(options.elements.map((e: { id: string }) => e.id)).toEqual(['box', 'img']);
		expect(Object.keys(options.files)).toEqual(['kept']);
		expect(options.appState).toEqual({
			viewBackgroundColor: '#123456',
			gridSize: 20,
			exportBackground: true,
		});
		expect(options.getDimensions(100, 50)).toEqual({ width: 200, height: 100, scale: 2 });
	});

	it('writes JSON from the picked elements alone', async () => {
		const result = await runRemoteSketchCommand({
			action: 'renderForAgent',
			sketchId: 'sketch-1',
			format: 'json',
			elements: picked,
		});

		expect(result.success).toBe(true);
		const file = result.success ? result.file : undefined;
		expect(file).toMatchObject({ format: 'json', mimeType: 'application/json', encoding: 'utf8' });
		const written = JSON.parse(file!.data) as SketchScene;
		expect(written.elements).toEqual(picked);
		expect(Object.keys(written.files)).toEqual(['kept']);
		expect(file!.data).not.toContain('withheld words');
		expect(file!.data).not.toContain('BBBB');
	});
});

describe('runRemoteSketchCommand: sharing', () => {
	const live: SketchScene = { ...scene, elements: [{ id: 'unsaved', version: 4, type: 'text' }] };
	const join = {
		sketchId: 'sketch-1',
		roomId: 'R'.repeat(22),
		roomKey: 'k'.repeat(22),
		ownerToken: 'token',
		serverUrl: 'https://sketch.runmaestro.ai',
		bot: null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useSketchSessionStore.setState({
			sessions: {
				'sketch-1': {
					sketchId: 'sketch-1',
					status: 'ready',
					loadError: null,
					scene: live,
					authors: {},
					dirty: true,
					revision: 1,
					saveError: null,
					externalRevision: 0,
					focusRequest: null,
					chat: [],
					botRequests: [],
					approvedImages: {},
				},
			},
		});
	});

	it('hands main the live scene, unsaved edits included, with the room seq', async () => {
		roomClient.getSketchRoomClient.mockReturnValue({ currentSeq: () => 12 });
		await expect(
			runRemoteSketchCommand({ action: 'snapshotScene', sketchId: 'sketch-1' })
		).resolves.toEqual({ success: true, snapshot: { scene: live, baseSeq: 12 } });
	});

	it('reports seq 0 when no room client runs', async () => {
		roomClient.getSketchRoomClient.mockReturnValue(undefined);
		const result = await runRemoteSketchCommand({ action: 'snapshotScene', sketchId: 'sketch-1' });
		expect(result).toMatchObject({ success: true, snapshot: { baseSeq: 0 } });
	});

	it('joins the room with the baseline, and leaves it for a null connection', async () => {
		const baseline = [{ id: 'unsaved', version: 3 }];
		const client = { subscribe: vi.fn() };
		roomClient.connectSketchRoom.mockResolvedValueOnce(client);
		await expect(
			runRemoteSketchCommand({
				action: 'syncRoom',
				sketchId: 'sketch-1',
				connection: join,
				baseline,
			})
		).resolves.toEqual({ success: true });
		expect(roomClient.connectSketchRoom).toHaveBeenCalledWith({
			sketchId: 'sketch-1',
			roomId: join.roomId,
			roomKey: join.roomKey,
			ownerToken: 'token',
			serverUrl: join.serverUrl,
			baseline,
		});
		// The bot relay answers the joined room's `@bot` requests.
		expect(botRelay.attachSketchBotRelay).toHaveBeenCalledWith('sketch-1', client);
		// Main hears the room's policy, to mirror it and demote writers when B2 is gone.
		expect(botPolicy.attachSketchBotPolicySync).toHaveBeenCalledWith('sketch-1', client);

		await runRemoteSketchCommand({ action: 'syncRoom', sketchId: 'sketch-1', connection: null });
		expect(botRelay.detachSketchBotRelay).toHaveBeenCalledWith('sketch-1');
		expect(botPolicy.detachSketchBotPolicySync).toHaveBeenCalledWith('sketch-1');
		expect(roomClient.disconnectSketchRoom).toHaveBeenCalledWith('sketch-1');
	});

	it('sends the bot policy through the room, with a demotion notice when main gives one', async () => {
		await expect(
			runRemoteSketchCommand({
				action: 'botPolicy',
				sketchId: 'sketch-1',
				botPolicy: 'conductor',
				notice: 'Collaborators can no longer ask the agent: off.',
			})
		).resolves.toEqual({ success: true });
		expect(botPolicy.applySketchBotPolicy).toHaveBeenCalledWith(
			'sketch-1',
			'conductor',
			'Collaborators can no longer ask the agent: off.'
		);
	});

	it('answers a bot policy the room cannot send instead of throwing', async () => {
		botPolicy.applySketchBotPolicy.mockImplementationOnce(() => {
			throw new Error('Sketch Book: the room is not connected yet. Try again once it is.');
		});
		await expect(
			runRemoteSketchCommand({ action: 'botPolicy', sketchId: 'sketch-1', botPolicy: 'writers' })
		).resolves.toEqual({
			success: false,
			error: 'Sketch Book: the room is not connected yet. Try again once it is.',
		});
	});

	it('answers a failed join instead of throwing', async () => {
		roomClient.connectSketchRoom.mockRejectedValueOnce(new Error('bad key'));
		await expect(
			runRemoteSketchCommand({ action: 'syncRoom', sketchId: 'sketch-1', connection: join })
		).resolves.toEqual({ success: false, error: 'bad key' });
	});
});
