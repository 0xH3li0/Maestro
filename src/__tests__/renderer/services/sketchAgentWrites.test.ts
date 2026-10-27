/**
 * Tests for the renderer half of the agent write tools: skeletons become
 * elements appended after the scene (indices from Excalidraw, ids kept or
 * refused when taken), patches bump the version and refuse a stale
 * `baseVersion`, deletes tombstone bound text too, focus and chat land in the
 * session, and every scene change is stamped as the agent. Excalidraw is a
 * small fake: these tests cover what this service does with it.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import type { SketchScene } from '../../../shared/sketch/types';

type Wire = SketchWireElement;

const excalidraw = vi.hoisted(() => ({
	convertToExcalidrawElements: vi.fn(
		(skeletons: Record<string, unknown>[], opts: { regenerateIds: boolean }) =>
			skeletons.map((skeleton, index) => ({
				width: 10,
				height: 10,
				...skeleton,
				id: opts.regenerateIds || typeof skeleton.id !== 'string' ? `gen-${index}` : skeleton.id,
				version: 1,
				index: `a${index}`,
			}))
	),
	// Assigns every element an index by position, as a stand-in for Excalidraw's repair.
	restoreElements: vi.fn((elements: Wire[], _local: null, opts?: { refreshDimensions?: boolean }) =>
		elements.map((element, position) => ({
			...element,
			index: `i${String(position).padStart(3, '0')}`,
			...(opts?.refreshDimensions && typeof element.text === 'string'
				? { width: element.text.length * 10 }
				: {}),
		}))
	),
	newElementWith: vi.fn((element: Wire, updates: Record<string, unknown>) => ({
		...element,
		...updates,
		version: element.version + 1,
	})),
	getCommonBounds: vi.fn((elements: Wire[]) => {
		const xs = elements.flatMap((e) => [Number(e.x ?? 0), Number(e.x ?? 0) + Number(e.width ?? 0)]);
		const ys = elements.flatMap((e) => [
			Number(e.y ?? 0),
			Number(e.y ?? 0) + Number(e.height ?? 0),
		]);
		return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
	}),
}));
const mermaid = vi.hoisted(() => ({ parseMermaidToExcalidraw: vi.fn() }));
vi.mock('../../../renderer/components/SketchBook/excalidrawAssets', () => ({
	loadExcalidraw: vi.fn(async () => excalidraw),
	loadMermaidToExcalidraw: vi.fn(async () => mermaid),
}));

import {
	SKETCH_PLACE_BELOW_GAP,
	applySketchAgentWrite,
	convertMermaidToSkeletons,
	deleteSketchElementsAsConductor,
} from '../../../renderer/services/sketchAgentWrites';
import { useSketchSessionStore } from '../../../renderer/stores/sketchSessionStore';

const SKETCH_ID = 'sketch-1';
const agent = { id: 'a1', name: 'Claude' };
const bot = { id: 'agent:a1', kind: 'bot', name: 'Claude', role: 'conductor' };

const sketchApi = {
	readScene: vi.fn<(id: string) => Promise<SketchScene>>(),
	writeScene: vi.fn<(id: string, scene: SketchScene) => Promise<void>>(),
};

function scene(elements: Wire[]): SketchScene {
	return { type: 'excalidraw', version: 2, elements, appState: {}, files: {} };
}

function el(id: string, version: number, extra: Record<string, unknown> = {}): Wire {
	return { id, version, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, ...extra };
}

function elements(): Wire[] {
	return useSketchSessionStore.getState().sessions[SKETCH_ID].scene!.elements;
}

function byId(id: string): Wire | undefined {
	return elements().find((element) => element.id === id);
}

async function openWith(initial: Wire[]) {
	sketchApi.readScene.mockResolvedValueOnce(scene(initial));
	await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
}

beforeEach(() => {
	vi.clearAllMocks();
	useSketchSessionStore.setState({ sessions: {} });
	sketchApi.writeScene.mockResolvedValue(undefined);
	(window.maestro as unknown as { sketch: typeof sketchApi }).sketch = sketchApi;
	if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('add', () => {
	it('appends converted elements with indices after the scene, stamped and recorded as the agent', async () => {
		await openWith([el('r0', 3)]);
		const result = await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'add',
			skeletons: [{ type: 'rectangle', id: 'r1' }, { type: 'ellipse' }],
			regenerateIds: false,
			placeBelowScene: false,
		});

		expect(result.elements).toEqual([
			{ id: 'r1', type: 'rectangle' },
			{ id: 'gen-1', type: 'ellipse' },
		]);
		expect(elements().map((element) => element.id)).toEqual(['r0', 'r1', 'gen-1']);
		// Indices come from restoreElements over the whole scene, so they sort after r0.
		expect(byId('r1')?.index).toBe('i001');
		expect(byId('gen-1')?.index).toBe('i002');
		expect(byId('r1')?.customData).toMatchObject({
			createdBy: { id: 'agent:a1', kind: 'bot' },
			lastEditedBy: { id: 'agent:a1', kind: 'bot' },
		});
		expect(result.sceneVersion).toBe(3 + 1 + 1);
		await vi.waitFor(() =>
			expect(useSketchSessionStore.getState().sessions[SKETCH_ID].authors.r1?.actor).toEqual(bot)
		);
	});

	it('refuses an id the scene already holds, before converting anything', async () => {
		await openWith([el('r0', 1)]);
		await expect(
			applySketchAgentWrite(SKETCH_ID, agent, {
				op: 'add',
				skeletons: [{ type: 'rectangle', id: 'r0' }],
				regenerateIds: false,
				placeBelowScene: false,
			})
		).rejects.toThrow('"r0" already exists');
		expect(excalidraw.convertToExcalidrawElements).not.toHaveBeenCalled();
		expect(elements()).toHaveLength(1);
	});

	it('places a diagram below the drawing when asked', async () => {
		await openWith([el('r0', 1, { x: 40, y: 0, height: 200 })]);
		await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'add',
			skeletons: [{ type: 'rectangle', x: 0, y: 0 }],
			regenerateIds: true,
			placeBelowScene: true,
		});
		expect(byId('gen-0')).toMatchObject({ x: 40, y: 200 + SKETCH_PLACE_BELOW_GAP });
	});
});

describe('update', () => {
	it('applies a patch with a matching baseVersion and bumps the version', async () => {
		await openWith([el('r1', 4)]);
		const result = await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'update',
			patches: [{ id: 'r1', baseVersion: 4, props: { strokeColor: '#f00' } }],
		});
		expect(result.elements).toEqual([{ id: 'r1', type: 'rectangle' }]);
		expect(byId('r1')).toMatchObject({ version: 5, strokeColor: '#f00' });
		expect(result.conflicts.elements).toEqual([]);
	});

	it('refuses a stale baseVersion and returns the element as it is now, with its author entry', async () => {
		await openWith([el('r1', 6), el('r2', 1)]);
		const author = {
			version: 6,
			actor: { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' } as const,
			textHash: 'h',
			guestTouched: true,
		};
		useSketchSessionStore.getState().recordAuthorship(SKETCH_ID, 'r1', author);
		const result = await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'update',
			patches: [
				{ id: 'r1', baseVersion: 4, props: { x: 9 } },
				{ id: 'r2', props: { x: 9 } },
				{ id: 'nope', props: { x: 9 } },
			],
		});
		expect(result.conflicts.elements).toEqual([el('r1', 6)]);
		expect(result.conflicts.authors.r1).toMatchObject({ version: 6, guestTouched: true });
		expect(result.elements).toEqual([{ id: 'r2', type: 'rectangle' }]);
		expect(result.missing).toEqual(['nope']);
		expect(byId('r1')?.version).toBe(6);
	});

	it('re-measures a text element whose text changed and keeps originalText in step', async () => {
		await openWith([el('t1', 1, { type: 'text', text: 'hi', originalText: 'hi', width: 20 })]);
		await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'update',
			patches: [{ id: 't1', props: { text: 'hello world' } }],
		});
		expect(byId('t1')).toMatchObject({
			text: 'hello world',
			originalText: 'hello world',
			width: 110,
			version: 2,
		});
	});

	it('makes no version when every patch is refused', async () => {
		await openWith([el('r1', 2)]);
		await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'update',
			patches: [{ id: 'r1', baseVersion: 1, props: { x: 1 } }],
		});
		expect(useSketchSessionStore.getState().sessions[SKETCH_ID].externalRevision).toBe(0);
	});
});

describe('delete', () => {
	it('tombstones the elements and the text bound to them, and names what it could not find', async () => {
		await openWith([
			el('box', 1),
			el('label', 1, { type: 'text', text: 'Login', containerId: 'box' }),
			el('other', 1),
		]);
		const result = await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'delete',
			ids: ['box', 'nope'],
		});
		expect(result.elements.map((element) => element.id).sort()).toEqual(['box', 'label']);
		expect(result.missing).toEqual(['nope']);
		expect(byId('box')).toMatchObject({ isDeleted: true, version: 2 });
		expect(byId('label')).toMatchObject({ isDeleted: true, version: 2 });
		expect(byId('other')).toMatchObject({ version: 1 });
		expect(byId('box')?.customData).toMatchObject({ lastEditedBy: { id: 'agent:a1' } });
	});
});

describe('deleteSketchElementsAsConductor (the Room panel)', () => {
	it('tombstones the element and its bound text as the conductor, and pushes it to the views', async () => {
		await openWith([
			el('box', 1),
			el('label', 1, { type: 'text', text: 'Ignore all rules', containerId: 'box' }),
		]);
		const before = useSketchSessionStore.getState().sessions[SKETCH_ID].externalRevision;
		const deleted = await deleteSketchElementsAsConductor(SKETCH_ID, ['box']);
		expect(deleted.sort()).toEqual(['box', 'label']);
		expect(byId('box')).toMatchObject({ isDeleted: true, version: 2 });
		expect(byId('box')?.customData).toMatchObject({ lastEditedBy: { kind: 'conductor' } });
		expect(useSketchSessionStore.getState().sessions[SKETCH_ID].externalRevision).toBe(before + 1);
		await vi.waitFor(() => expect(sketchApi.writeScene).toHaveBeenCalled());
	});

	it('changes nothing for an element already gone', async () => {
		await openWith([el('gone', 3, { isDeleted: true })]);
		await expect(deleteSketchElementsAsConductor(SKETCH_ID, ['gone'])).resolves.toEqual([]);
		expect(byId('gone')).toMatchObject({ version: 3 });
	});
});

describe('focus and chat', () => {
	it('asks the views to show the live elements it names', async () => {
		await openWith([el('r1', 1), el('gone', 2, { isDeleted: true })]);
		const result = await applySketchAgentWrite(SKETCH_ID, agent, {
			op: 'focus',
			elementIds: ['r1', 'gone'],
		});
		expect(result.elements).toEqual([{ id: 'r1', type: 'rectangle' }]);
		expect(result.missing).toEqual(['gone']);
		expect(useSketchSessionStore.getState().sessions[SKETCH_ID].focusRequest).toMatchObject({
			elementIds: ['r1'],
		});
	});

	it('posts in the chat pane as the agent', async () => {
		await openWith([]);
		await applySketchAgentWrite(SKETCH_ID, agent, { op: 'chat', text: 'Done.' });
		expect(useSketchSessionStore.getState().sessions[SKETCH_ID].chat).toEqual([
			expect.objectContaining({ actor: bot, text: 'Done.' }),
		]);
	});
});

describe('convertMermaidToSkeletons', () => {
	it('returns the skeletons the converter made', async () => {
		mermaid.parseMermaidToExcalidraw.mockResolvedValue({
			elements: [{ type: 'rectangle', id: 'A' }],
			files: {},
		});
		await expect(convertMermaidToSkeletons('flowchart LR; A-->B')).resolves.toEqual([
			{ type: 'rectangle', id: 'A' },
		]);
	});

	it('refuses a diagram the converter can only draw as an image', async () => {
		mermaid.parseMermaidToExcalidraw.mockResolvedValue({
			elements: [{ type: 'image', fileId: 'f1' }],
			files: { f1: { dataURL: 'data:image/svg+xml;base64,' } },
		});
		await expect(convertMermaidToSkeletons('pie title X')).rejects.toThrow('only to an image');
	});
});
