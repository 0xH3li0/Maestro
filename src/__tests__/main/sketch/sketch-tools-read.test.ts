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
 *   - **The real gate** (`realGate()` in the harness, the guardrail over a
 *     mocked classifier): flagged guest text is withheld and leaks through no
 *     label, edge or name; with the screen off every third-party element is
 *     withheld `unscreened` (fail closed); clean guest text passes through,
 *     marked `untrusted` where it shows, with `untrustedNotice`.
 *   - **Guest images** are withheld unless the session approved that file.
 *   - **The change digest** runs the same gated path as T4, counts as a read,
 *     and hands the turn's posture to the gate.
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
import {
	SKETCH_MAX_RESPONSE_BYTES,
	capSketchResponse,
	createSketchToolRuntime,
} from '../../../main/sketch/sketch-tools';
import {
	SKETCH_MAX_FREEDRAW_POINTS,
	SKETCH_UNTRUSTED_NOTICE,
} from '../../../shared/sketch/agent-view';
import { DIGEST_UNTRUSTED_NOTE } from '../../../shared/sketch/digest';
import { serializedJsonByteLength } from '../../../shared/jsonUtils';
import type { SketchSessionSnapshot } from '../../../shared/sketch/commands';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import { GUEST, INJECTION, SKETCHES, asAlpha, el, realGate, scene } from './sketchToolsHarness';

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

describe('sketch_read_scene third-party text (the real gate)', () => {
	/** The flow board, with a guest relabeling Home and adding a sticky note and a frame. */
	function guestBoard(homeText = INJECTION) {
		const elements = flowBoard();
		const home = elements.find((e) => e.id === 'txt-home')!;
		home.text = homeText;
		home.originalText = homeText;
		elements.push(el('guest-note', 'text', { y: 500, text: INJECTION, originalText: INJECTION }));
		elements.push(el('guest-frame', 'frame', { y: 800, name: INJECTION }));
		return scene(elements, { guests: ['txt-home', 'guest-note', 'guest-frame'] });
	}

	const sam = { id: 'guest-sam', kind: 'guest', name: 'Sam' };

	it('screens only the third-party elements, in one batched call', async () => {
		const gate = realGate();
		const { screen } = gate;
		const { result } = await asAlpha(guestBoard(), { screen });
		await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(screen).toHaveBeenCalledTimes(1);
		const request = screen.mock.calls[0][0];
		expect(request).toMatchObject({ sketchId: 'sk-alpha', agentId: 'alpha' });
		// The tools pass no posture: D2 never applies to a tool call.
		expect(request).not.toHaveProperty('posture');
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
		// Conductor text never reaches the classifier.
		const scored = gate.score.mock.calls.map(([request]) => request.text);
		expect(scored).toHaveLength(3);
		expect(scored.every((text) => text.includes(INJECTION))).toBe(true);
	});

	it('withholds flagged guest text and leaks it nowhere', async () => {
		const { result } = await asAlpha(guestBoard(), { screen: realGate().screen });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		const { summary } = read;

		const home = summary.shapes.find((s: { id: string }) => s.id === 'box-home');
		expect(home).toMatchObject({ labelWithheld: 'flagged' });
		expect(home).not.toHaveProperty('label');
		expect(summary.shapes.find((s: { id: string }) => s.id === 'guest-note')).toEqual({
			id: 'guest-note',
			type: 'text',
			author: sam,
			withheld: 'flagged',
		});
		expect(summary.frames.find((f: { id: string }) => f.id === 'guest-frame')).toEqual({
			id: 'guest-frame',
			type: 'frame',
			author: sam,
			withheld: 'flagged',
			elementIds: [],
		});
		// The arrow end falls back to the shape's anonymous name.
		expect(summary.connections[0].edge).toBe('Login -> rectangle#box-home');
		expect(JSON.stringify(read)).not.toContain(INJECTION);
		// Nothing third-party reached the agent, so there is nothing to warn about.
		expect(read).not.toHaveProperty('untrustedNotice');

		const elements = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'elements',
		});
		expect(elements.elements.find((e: { id: string }) => e.id === 'txt-home')).toEqual({
			id: 'txt-home',
			type: 'text',
			author: sam,
			withheld: 'flagged',
		});
		expect(JSON.stringify(elements)).not.toContain(INJECTION);
	});

	it('withholds every third-party element unscreened while the screen is off (fail closed)', async () => {
		const { result } = await asAlpha(guestBoard('Checkout'), {
			screen: realGate({ off: true }).screen,
		});
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		for (const id of ['txt-home', 'guest-note', 'guest-frame']) {
			expect(read.elements.find((e: { id: string }) => e.id === id)).toEqual({
				id,
				type: id === 'guest-frame' ? 'frame' : 'text',
				author: sam,
				withheld: 'unscreened',
			});
		}
		expect(JSON.stringify(read)).not.toContain(INJECTION);
		expect(JSON.stringify(read)).not.toContain('Checkout');
	});

	it('withholds an element the gate returns no verdict for (fail closed)', async () => {
		const { result } = await asAlpha(guestBoard(), { screen: async () => new Map() });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(JSON.stringify(read)).not.toContain(INJECTION);
		expect(read.summary.shapes.find((s: { id: string }) => s.id === 'guest-note').withheld).toBe(
			'unscreened'
		);
	});

	it('passes clean guest text through, marked untrusted, with the notice', async () => {
		const { result } = await asAlpha(guestBoard('Checkout'), { screen: realGate().screen });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(read.untrustedNotice).toBe(SKETCH_UNTRUSTED_NOTICE);
		const { summary } = read;

		// The conductor's box, labelled by the guest's (clean) text.
		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-home')).toMatchObject({
			label: 'Checkout',
			labelUntrusted: true,
		});
		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-home')).not.toHaveProperty(
			'untrusted'
		);
		expect(summary.connections[0]).toMatchObject({
			edge: 'Login -> Checkout',
			endsUntrusted: true,
		});
		expect(summary.connections[0]).not.toHaveProperty('endsUnscreened');
		// Conductor text carries no mark.
		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-login')).not.toHaveProperty(
			'labelUntrusted'
		);
		// The injection on the same board is still withheld.
		expect(JSON.stringify(read)).not.toContain(INJECTION);

		const elements = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'elements',
		});
		expect(elements.untrustedNotice).toBe(SKETCH_UNTRUSTED_NOTICE);
		expect(elements.elements.find((e: { id: string }) => e.id === 'txt-home')).toMatchObject({
			text: 'Checkout',
			author: sam,
			untrusted: true,
		});
		expect(elements.elements.find((e: { id: string }) => e.id === 'txt-login')).not.toHaveProperty(
			'untrusted'
		);
	});

	it('marks a D2 clear unscreened', async () => {
		const { result } = await asAlpha(guestBoard('Checkout'), {
			screen: async (request) =>
				new Map(
					request.subjects.map((s) => [s.elementId, { status: 'clear', unscreened: true } as const])
				),
		});
		const elements = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'elements',
		});
		expect(elements.elements.find((e: { id: string }) => e.id === 'txt-home')).toMatchObject({
			untrusted: true,
			unscreened: true,
		});
		const { summary } = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
		});
		expect(summary.shapes.find((s: { id: string }) => s.id === 'box-home')).toMatchObject({
			labelUntrusted: true,
			labelUnscreened: true,
		});
		expect(summary.connections[0]).toMatchObject({ endsUntrusted: true, endsUnscreened: true });
	});

	it('adds no notice to a board with only conductor text', async () => {
		const { screen } = realGate();
		const { result } = await asAlpha(scene(flowBoard()), { screen });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		expect(screen).not.toHaveBeenCalled();
		expect(read).not.toHaveProperty('untrustedNotice');
	});
});

describe('sketch_read_scene guest images', () => {
	const image = (fileId: string, version = 1) =>
		el('img-1', 'image', { fileId, status: 'saved', version });

	it('withholds a guest image the conductor has not approved, in both formats', async () => {
		const { screen } = realGate();
		const { result } = await asAlpha(scene([image('file-a')], { guests: ['img-1'] }), { screen });
		const elements = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'elements',
		});
		expect(elements.elements).toEqual([
			{
				id: 'img-1',
				type: 'image',
				author: { id: 'guest-sam', kind: 'guest', name: 'Sam' },
				withheld: 'unscreened',
			},
		]);
		expect(JSON.stringify(elements)).not.toContain('file-a');
		const { summary } = await result('sketch_read_scene', {
			sketchId: 'sk-alpha',
			format: 'summary',
		});
		expect(summary.shapes[0]).toMatchObject({ id: 'img-1', withheld: 'unscreened' });
		// Pixels cannot be screened: the image never goes to the classifier.
		expect(screen).not.toHaveBeenCalled();
	});

	it('withholds an image whose author is unknown', async () => {
		const { result } = await asAlpha(scene([image('file-a')], { unknown: ['img-1'] }));
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements[0]).toMatchObject({ withheld: 'unscreened' });
	});

	it('shows a guest image the session approved, until the guest swaps the file', async () => {
		const approved = { ...scene([image('file-a')], { guests: ['img-1'] }) };
		approved.approvedImages = { 'img-1': 'file-a' };
		const { result, setScene } = await asAlpha(approved, { screen: realGate().screen });
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements[0]).toMatchObject({ id: 'img-1', fileId: 'file-a' });
		expect(read.elements[0]).not.toHaveProperty('withheld');

		const swapped = scene([image('file-b', 2)], { guests: ['img-1'] });
		swapped.approvedImages = { 'img-1': 'file-a' };
		setScene(swapped);
		const after = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(after.elements[0]).toMatchObject({ id: 'img-1', withheld: 'unscreened' });
		expect(JSON.stringify(after)).not.toContain('file-b');
	});

	it('shows a conductor image without approval', async () => {
		const { result } = await asAlpha(scene([image('file-a')]));
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements[0]).toMatchObject({ id: 'img-1', fileId: 'file-a' });
	});
});

describe('sketch_changes', () => {
	it('lists everything as added against an unknown baseline', async () => {
		const { result } = await asAlpha(scene(flowBoard()));
		const changes = await result('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: 3 });
		expect(changes).toMatchObject({ sinceVersion: 3, sceneVersion: 7, baseline: 'unknown' });
		expect(changes.added).toHaveLength(7);
	});

	it('diffs against a scene version the agent read, and withholds the flagged guest edit', async () => {
		const { result, setScene } = await asAlpha(scene(flowBoard()), { screen: realGate().screen });
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
				withheld: 'flagged',
			},
		]);
		expect(JSON.stringify(changes)).not.toContain(INJECTION);
		expect(changes).not.toHaveProperty('untrustedNotice');
	});

	it('passes a clean guest edit through, marked untrusted', async () => {
		const { result, setScene } = await asAlpha(scene(flowBoard()), { screen: realGate().screen });
		await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'summary' });
		const next = flowBoard().map((e) =>
			e.id === 'txt-home' ? { ...e, version: 2, text: 'Checkout', originalText: 'Checkout' } : e
		);
		setScene(scene(next, { guests: ['txt-home'] }));

		const changes = await result('sketch_changes', { sketchId: 'sk-alpha', sinceVersion: 7 });
		expect(changes.untrustedNotice).toBe(SKETCH_UNTRUSTED_NOTICE);
		expect(changes.updated).toEqual([
			{
				id: 'txt-home',
				type: 'text',
				lastEditedBy: { id: 'guest-sam', kind: 'guest', name: 'Sam' },
				label: 'Checkout',
				untrusted: true,
			},
		]);
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

describe('the change digest', () => {
	function digestRuntime(initial: SketchSessionSnapshot, gate = realGate()) {
		let live = initial;
		const runtime = createSketchToolRuntime({
			readSession: async () => live,
			screen: gate.screen,
		});
		return {
			runtime,
			screen: gate.screen,
			setScene: (next: SketchSessionSnapshot) => {
				live = next;
			},
		};
	}

	it('lists the whole board on the first turn and counts as a read', async () => {
		const { runtime, setScene } = digestRuntime(scene(flowBoard()));
		const first = await runtime.changeDigest({ agentId: 'alpha', sketchId: 'sk-alpha' });
		expect(first.sceneVersion).toBe(7);
		expect(first.changes.baseline).toBe('unknown');
		expect(first.digest).toContain('Board at sceneVersion 7');
		expect(first.digest).toContain('"Login"');

		const next = flowBoard().map((e) =>
			e.id === 'txt-home' ? { ...e, version: 2, text: 'Checkout', originalText: 'Checkout' } : e
		);
		next.push(el('guest-note', 'text', { y: 500, text: INJECTION, originalText: INJECTION }));
		setScene(scene(next, { guests: ['txt-home', 'guest-note'] }));

		const second = await runtime.changeDigest({ agentId: 'alpha', sketchId: 'sk-alpha' });
		expect(second.changes).toMatchObject({ sinceVersion: 7, sceneVersion: 9, baseline: 'known' });
		expect(second.digest).toContain('- Updated by "Sam" (guest): text "Checkout" (untrusted)');
		expect(second.digest).toContain('- 1 element by "Sam" (guest) withheld: flagged');
		expect(second.digest.split('\n').at(-1)).toBe(DIGEST_UNTRUSTED_NOTE);
		expect(second.digest).not.toContain(INJECTION);
	});

	it('shares its read baselines with sketch_changes', async () => {
		const { runtime } = digestRuntime(scene(flowBoard()));
		await runtime.tools.sketch_read_scene!({
			agent: { id: 'alpha', name: 'Alpha', sshRemote: false, cwd: '/work/alpha' },
			params: { sketchId: 'sk-alpha', format: 'summary' },
			sketch: SKETCHES['sk-alpha'],
		});
		const digest = await runtime.changeDigest({ agentId: 'alpha', sketchId: 'sk-alpha' });
		expect(digest.digest).toBe('No board changes since sceneVersion 7 (now 7).');
	});

	it('hands the turn posture to the gate: a restricted turn reads off-screen text labelled (D2)', async () => {
		const board = flowBoard().map((e) =>
			e.id === 'txt-home' ? { ...e, text: 'Checkout', originalText: 'Checkout' } : e
		);
		const { runtime, screen } = digestRuntime(
			scene(board, { guests: ['txt-home'] }),
			realGate({ off: true })
		);
		const restricted = await runtime.changeDigest({
			agentId: 'alpha',
			sketchId: 'sk-alpha',
			posture: 'restricted',
			sinceVersion: 0,
		});
		expect(screen.mock.calls[0][0].posture).toBe('restricted');
		expect(restricted.digest).toContain('text "Checkout" (untrusted, unscreened)');

		const full = await runtime.changeDigest({
			agentId: 'alpha',
			sketchId: 'sk-alpha',
			posture: 'full',
			sinceVersion: 0,
		});
		expect(full.digest).not.toContain('Checkout');
		expect(full.digest).toContain('withheld: unscreened');
	});
});
