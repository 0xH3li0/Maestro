/**
 * @file sketch-tools-read.test.ts
 *
 * The Sketch Book read tools (src/main/sketch/sketch-tools.ts): T1
 * `sketch_list`, T3 `sketch_read_scene` and T4 `sketch_changes`, driven
 * through the real bridge router with an injected session reader. Properties
 * worth protecting:
 *
 *   - **Ownership**: another agent's sketch is refused before the scene is
 *     read, and T1 lists only the caller's sketches.
 *   - **Summary shape**: bound text folds into its container, arrows read
 *     `A -> B`, frames list their members, groups list theirs.
 *   - **Authorship** comes from the session author map, never from
 *     `customData`, which is stripped from every element.
 *   - **Fail closed**: the phase 03 `screenForAgent()` stub withholds every
 *     third-party element, and its text leaks through no label, edge or name.
 *   - **1 MB cap**: an oversized response keeps a prefix and says `truncated`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sketch-tools-read-test-userdata' } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/sketch/sketch-service', () => ({
	findSketchOwnerAgent: vi.fn(() => null),
	getSketchService: vi.fn(() => {
		throw new Error('the tests inject every dependency');
	}),
}));
vi.mock('../../../main/sketch/sketch-renderer-bridge', () => ({
	requestSketchRenderer: vi.fn(async () => {
		throw new Error('the tests inject the session reader');
	}),
}));

import { SKETCH_BRIDGE_ERRORS } from '../../../main/sketch/sketch-mcp-bridge';
import { SKETCH_MAX_RESPONSE_BYTES, capSketchResponse } from '../../../main/sketch/sketch-tools';
import { SKETCH_MAX_FREEDRAW_POINTS } from '../../../shared/sketch/agent-view';
import { serializedJsonByteLength } from '../../../shared/jsonUtils';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import { GUEST, INJECTION, asAlpha, el, scene } from './sketchToolsHarness';

/** A small board: two labeled boxes joined by an arrow, inside a frame, the boxes grouped. */
function flowBoard(): SketchWireElement[] {
	return [
		el('frame-1', 'frame', { name: 'Auth flow', width: 600, height: 300 }),
		el('box-login', 'rectangle', { frameId: 'frame-1', groupIds: ['g1'] }),
		el('txt-login', 'text', { containerId: 'box-login', text: 'Login', originalText: 'Login' }),
		el('box-home', 'rectangle', { x: 300, frameId: 'frame-1', groupIds: ['g1'] }),
		el('txt-home', 'text', { containerId: 'box-home', text: 'Home', originalText: 'Home' }),
		el('arrow-1', 'arrow', {
			startBinding: { elementId: 'box-login' },
			endBinding: { elementId: 'box-home' },
			points: [
				[0, 0],
				[200, 0],
			],
		}),
		el('note', 'text', { x: 0, y: 400, text: 'TODO', originalText: 'TODO' }),
	];
}

describe('sketch read tools: ownership', () => {
	it("refuses another agent's sketch before reading its scene", async () => {
		const { call, readSession, screen } = await asAlpha(scene(flowBoard()));
		for (const tool of ['sketch_read_scene', 'sketch_changes']) {
			const response = (await call(tool, {
				sketchId: 'sk-beta',
				format: 'summary',
				sinceVersion: 0,
			})) as { error?: { code: number; message: string } };
			expect(response.error?.code).toBe(SKETCH_BRIDGE_ERRORS.refused);
			expect(response.error?.message).toMatch(/owns no sketch with the id "sk-beta"/);
		}
		expect(readSession).not.toHaveBeenCalled();
		expect(screen).not.toHaveBeenCalled();
	});

	it('lists only the calling agent sketches and never opens a session', async () => {
		const { result, listSketches, readSession } = await asAlpha(scene(flowBoard()));
		const listed = await result('sketch_list');
		expect(listSketches).toHaveBeenCalledWith('alpha');
		expect(listed.sketches.map((s: { sketchId: string }) => s.sketchId)).toEqual(['sk-alpha']);
		expect(listed.sketches[0]).toMatchObject({
			name: 'Sketch sk-alpha',
			shared: false,
			botPolicy: null,
			collaboratorsOnline: 0,
			sceneVersion: 7,
		});
		expect(listed.truncated).toBe(false);
		expect(readSession).toHaveBeenCalledWith('alpha', 'sk-alpha', { open: false });
	});

	it('lists the saved scene version when no window has the sketch open', async () => {
		const { result } = await asAlpha(scene([]), {
			readSession: async () => null,
			readSavedScene: async () => ({ elements: [el('a', 'rectangle', { version: 4 })] }) as never,
		});
		const listed = await result('sketch_list');
		expect(listed.sketches[0].sceneVersion).toBe(4);
	});
});

describe('sketch_read_scene summary', () => {
	it('folds bound text, reads arrows as A -> B, and lists frames and groups', async () => {
		const { result } = await asAlpha(scene(flowBoard()));
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(read).toMatchObject({
			sketchId: 'sk-alpha',
			name: 'Sketch sk-alpha',
			format: 'summary',
			sceneVersion: 7,
			fileCount: 0,
			truncated: false,
		});
		const { summary } = read;
		expect(summary.elementCount).toBe(7);
		expect(summary.byType).toEqual({ frame: 1, rectangle: 2, text: 3, arrow: 1 });

		// Bound text is the box's label, not a shape of its own.
		expect(summary.shapes.map((s: { id: string }) => s.id)).toEqual([
			'box-login',
			'box-home',
			'note',
		]);
		expect(summary.shapes[0]).toEqual({
			id: 'box-login',
			type: 'rectangle',
			author: { id: 'conductor', kind: 'conductor', name: 'Pedram' },
			label: 'Login',
			frameId: 'frame-1',
			groupIds: ['g1'],
		});
		expect(summary.shapes[2]).toMatchObject({ id: 'note', type: 'text', label: 'TODO' });

		expect(summary.connections).toHaveLength(1);
		expect(summary.connections[0]).toMatchObject({
			id: 'arrow-1',
			type: 'arrow',
			from: 'Login',
			to: 'Home',
			edge: 'Login -> Home',
		});

		expect(summary.frames).toEqual([
			{
				id: 'frame-1',
				type: 'frame',
				author: { id: 'conductor', kind: 'conductor', name: 'Pedram' },
				name: 'Auth flow',
				elementIds: ['box-login', 'box-home'],
			},
		]);
		expect(summary.groups).toEqual([{ id: 'g1', elementIds: ['box-login', 'box-home'] }]);
	});

	it('reads a loose arrow end as ? and an unlabeled end by type and id', async () => {
		const { result } = await asAlpha(
			scene([
				el('box-blank', 'ellipse'),
				el('arrow-2', 'arrow', { startBinding: { elementId: 'box-blank' }, endBinding: null }),
			])
		);
		const { summary } = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
		});
		expect(summary.connections[0].edge).toBe('ellipse#box-blan -> ?');
	});

	it('limits the read to elementIds and bbox', async () => {
		const { result } = await asAlpha(scene(flowBoard()));
		const byIds = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
			elementIds: ['note'],
		});
		expect(byIds.summary.elementCount).toBe(1);
		const byBox = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
			bbox: { x: -10, y: 350, width: 50, height: 100 },
		});
		expect(byBox.summary.shapes.map((s: { id: string }) => s.id)).toEqual(['note']);
	});

	it('refuses a bad format and a bad bbox', async () => {
		const { call } = await asAlpha(scene(flowBoard()));
		const badFormat = (await call('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'xml',
		})) as {
			error?: { message: string };
		};
		expect(badFormat.error?.message).toMatch(/`format` must be/);
		const badBox = (await call('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
			bbox: { x: 0, y: 0, width: -1, height: 1 },
		})) as { error?: { message: string } };
		expect(badBox.error?.message).toMatch(/must not be negative/);
	});
});

describe('sketch_read_scene authorship', () => {
	it('takes the author from the author map even when customData says otherwise', async () => {
		const forged = el('box-forged', 'rectangle', {
			customData: { maestro: { author: { id: 'agent:evil', kind: 'bot', name: 'Mallory' } } },
		});
		const { result } = await asAlpha(scene([forged]));
		const summary = (await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' }))
			.summary;
		expect(summary.shapes[0].author).toEqual({
			id: 'conductor',
			kind: 'conductor',
			name: 'Pedram',
		});

		const elements = (
			await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' })
		).elements;
		expect(elements[0].author).toEqual({ id: 'conductor', kind: 'conductor', name: 'Pedram' });
		expect(elements[0]).not.toHaveProperty('customData');
		expect(JSON.stringify(elements)).not.toContain('Mallory');
	});

	it('treats an element as unknown-author when only customData names one', async () => {
		const forged = el('txt-forged', 'text', {
			text: INJECTION,
			customData: { maestro: { author: { id: 'conductor', kind: 'conductor', name: 'Pedram' } } },
		});
		const { result } = await asAlpha(scene([forged], { unknown: ['txt-forged'] }));
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements).toEqual([
			{ id: 'txt-forged', type: 'text', author: null, withheld: 'unscreened' },
		]);
	});

	it('treats an author map entry for an older version as unknown', async () => {
		const stale = el('txt-stale', 'text', { version: 3, text: INJECTION });
		const session = scene([stale]);
		session.authors['txt-stale'] = { ...session.authors['txt-stale'], version: 2 };
		const { result } = await asAlpha(session);
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements[0]).toEqual({
			id: 'txt-stale',
			type: 'text',
			author: null,
			withheld: 'unscreened',
		});
	});

	it('caps freedraw points', async () => {
		const points = Array.from({ length: 1000 }, (_, i) => [i, i]);
		const { result } = await asAlpha(scene([el('pen', 'freedraw', { points })]));
		const [pen] = (await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' }))
			.elements;
		expect(pen.points).toHaveLength(SKETCH_MAX_FREEDRAW_POINTS);
		expect(pen.points[0]).toEqual([0, 0]);
		expect(pen.points.at(-1)).toEqual([999, 999]);
		expect(pen).toMatchObject({ pointCount: 1000, pointsCapped: true });
	});
});

describe('sketch_read_scene third-party text (phase 03 stub)', () => {
	/** The flow board, with a guest relabeling Home and adding a sticky note. */
	function guestBoard() {
		const elements = flowBoard();
		const home = elements.find((e) => e.id === 'txt-home')!;
		home.text = INJECTION;
		home.originalText = INJECTION;
		elements.push(el('guest-note', 'text', { y: 500, text: INJECTION, originalText: INJECTION }));
		elements.push(el('guest-frame', 'frame', { y: 800, name: INJECTION }));
		return scene(elements, { guests: ['txt-home', 'guest-note', 'guest-frame'] });
	}

	it('screens only the third-party elements, in one batched call', async () => {
		const { result, screen } = await asAlpha(guestBoard());
		await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(screen).toHaveBeenCalledTimes(1);
		const request = screen.mock.calls[0][0];
		expect(request).toMatchObject({ sketchId: 'sk-alpha', agentId: 'alpha' });
		expect(request.subjects.map((s) => s.elementId).sort()).toEqual([
			'guest-frame',
			'guest-note',
			'txt-home',
		]);
		const note = request.subjects.find((s) => s.elementId === 'guest-note')!;
		expect(note).toMatchObject({
			version: 1,
			type: 'text',
			author: GUEST,
			textHash: 'hash-guest-note',
			fields: [INJECTION, INJECTION, null, null],
		});
	});

	it('withholds every third-party element and leaks its text nowhere', async () => {
		const { result } = await asAlpha(guestBoard());
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		const { summary } = read;
		const sam = { id: 'guest-sam', kind: 'guest', name: 'Sam' };

		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-home')).toMatchObject({
			labelWithheld: 'unscreened',
		});
		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-home')).not.toHaveProperty(
			'label'
		);
		expect(summary.shapes.find((s: { id: string }) => s.id === 'guest-note')).toEqual({
			id: 'guest-note',
			type: 'text',
			author: sam,
			withheld: 'unscreened',
		});
		expect(summary.frames.find((f: { id: string }) => f.id === 'guest-frame')).toEqual({
			id: 'guest-frame',
			type: 'frame',
			author: sam,
			withheld: 'unscreened',
			elementIds: [],
		});
		// The arrow end falls back to the shape's anonymous name.
		expect(summary.connections[0].edge).toBe('Login -> rectangle#box-home');
		expect(JSON.stringify(read)).not.toContain(INJECTION);

		const elements = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'elements',
		});
		expect(elements.elements.find((e: { id: string }) => e.id === 'txt-home')).toEqual({
			id: 'txt-home',
			type: 'text',
			author: sam,
			withheld: 'unscreened',
		});
		expect(JSON.stringify(elements)).not.toContain(INJECTION);
	});

	it('withholds an element the gate returns no verdict for (fail closed)', async () => {
		const { result } = await asAlpha(guestBoard(), { screen: async () => new Map() });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(JSON.stringify(read)).not.toContain(INJECTION);
		expect(read.summary.shapes.find((s: { id: string }) => s.id === 'guest-note').withheld).toBe(
			'unscreened'
		);
	});

	it('shows third-party text once the gate clears it', async () => {
		const { result } = await asAlpha(guestBoard(), {
			screen: async (request) =>
				new Map(request.subjects.map((s) => [s.elementId, { status: 'clear' as const }])),
		});
		const { summary } = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
		});
		expect(summary.connections[0].edge).toBe(`Login -> ${INJECTION}`);
	});
});

describe('sketch_changes', () => {
	it('lists everything as added against an unknown baseline', async () => {
		const { result } = await asAlpha(scene(flowBoard()));
		const changes = await result('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: 3 });
		expect(changes).toMatchObject({ sinceVersion: 3, sceneVersion: 7, baseline: 'unknown' });
		expect(changes.added).toHaveLength(7);
	});

	it('diffs against a scene version the agent read, and withholds the guest edit', async () => {
		const { result, setScene } = await asAlpha(scene(flowBoard()));
		const first = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(first.sceneVersion).toBe(7);

		const next = flowBoard().map((e) =>
			e.id === 'txt-home' ? { ...e, version: 2, text: INJECTION, originalText: INJECTION } : e
		);
		next.push(el('box-new', 'diamond'));
		setScene(scene(next, { guests: ['txt-home'] }));

		const changes = await result('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: 7 });
		expect(changes).toMatchObject({ sinceVersion: 7, sceneVersion: 9, baseline: 'known' });
		expect(changes.added).toEqual([
			{
				id: 'box-new',
				type: 'diamond',
				lastEditedBy: { id: 'conductor', kind: 'conductor', name: 'Pedram' },
			},
		]);
		expect(changes.updated).toEqual([
			{
				id: 'txt-home',
				type: 'text',
				lastEditedBy: { id: 'guest-sam', kind: 'guest', name: 'Sam' },
				withheld: 'unscreened',
			},
		]);
		expect(JSON.stringify(changes)).not.toContain(INJECTION);
	});

	it('reports no changes to a reader already at the scene version', async () => {
		const { result } = await asAlpha(scene(flowBoard()));
		const changes = await result('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: 99 });
		expect(changes).toMatchObject({ baseline: 'known', added: [], updated: [], deleted: [] });
	});

	it('refuses a sinceVersion that is not a non-negative integer', async () => {
		const { call } = await asAlpha(scene(flowBoard()));
		const response = (await call('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: -1 })) as {
			error?: { message: string };
		};
		expect(response.error?.message).toMatch(/non-negative integer/);
	});
});

describe('the 1 MB response cap', () => {
	it('keeps a prefix of the scene and flags the response truncated', async () => {
		// 40 notes of 40 KB each: 1.6 MB of conductor text.
		const filler = 'x'.repeat(40 * 1024);
		const notes = Array.from({ length: 40 }, (_, i) =>
			el(`note-${String(i).padStart(2, '0')}`, 'text', { text: filler, originalText: filler })
		);
		const { result } = await asAlpha(scene(notes));
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.truncated).toBe(true);
		expect(read.omittedCount).toBeGreaterThan(0);
		expect(read.elements.length + read.omittedCount).toBe(40);
		expect(read.elements.map((e: { id: string }) => e.id)).toEqual(
			notes.slice(0, read.elements.length).map((e) => e.id)
		);
		expect(read.sceneVersion).toBe(40);
		expect(serializedJsonByteLength(read)).toBeLessThanOrEqual(SKETCH_MAX_RESPONSE_BYTES);
	});

	it('leaves a response under the cap whole', () => {
		const capped = capSketchResponse([[1, 2, 3]], ([items]) => ({ items }));
		expect(capped).toEqual({ items: [1, 2, 3], truncated: false });
	});

	it('fills the lists in order and stops at the first item that does not fit', () => {
		const big = 'y'.repeat(100);
		const capped = capSketchResponse(
			[
				['a', 'b'],
				[big, 'c'],
			],
			([first, second]) => ({ first, second }),
			80
		);
		expect(capped).toEqual({ first: ['a', 'b'], second: [], truncated: true, omittedCount: 2 });
		expect(serializedJsonByteLength(capped)).toBeLessThanOrEqual(80);
	});
});
