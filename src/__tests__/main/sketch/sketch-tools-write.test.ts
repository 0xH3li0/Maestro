/**
 * @file sketch-tools-write.test.ts
 *
 * The Sketch Book write and render tools (src/main/sketch/sketch-tools.ts):
 * T5-T8, T11, T12 and T9 `sketch_screenshot`, T10 `sketch_export`, driven
 * through the real bridge router. The window is a small fake that applies
 * writes to an in-memory scene and stamps them with the shared
 * `stampLocalEdits()` + `botEditor()` / `botActor()`, as
 * `sketchSessionStore.applyAgentChange()` does. Properties worth protecting:
 *
 *   - **Caps**: more than 500 skeletons, patches, ids or Mermaid elements per
 *     call, or an oversized chat post, is refused before anything is screened
 *     or written.
 *   - **Stale `baseVersion`**: the patch is refused and the element comes back
 *     as it is now, through the gate.
 *   - **Bot stamping**: every write is the handshake agent's, stamped
 *     `kind: 'bot'`, `id: 'agent:<agentId>'`; a stamp the agent supplies is
 *     dropped.
 *   - **Outbound redaction**: every label, text, link and chat post passes
 *     `redactSecrets()` before the window sees it; a refusal refuses the write.
 *   - **T10 path**: only inside the agent's working directory, symlinks
 *     resolved; nothing is rendered for a refused path.
 *   - **Pixels**: T9 and T10 hand the exporter no withheld element, no text
 *     bound to one, and no guest image.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sketch-tools-write-test-userdata' } }));
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
		throw new Error('the tests inject the window');
	}),
}));

import { screenOutbound } from '../../../main/sketch/sketch-outbound';
import {
	SKETCH_MAX_CHAT_POST_BYTES,
	SKETCH_MAX_ELEMENTS_PER_CALL,
} from '../../../main/sketch/sketch-mcp-server-script';
import {
	SKETCH_WRITE_LIMITS,
	type SketchMermaidConverter,
	type SketchRenderRequest,
	type SketchSessionRenderer,
	type SketchSessionWriter,
	type SketchToolDeps,
} from '../../../main/sketch/sketch-tools';
import { createSlidingWindowGuard } from '../../../main/utils/sliding-window-guard';
import {
	SKETCH_UNTRUSTED_RENDER_NOTICE,
	sketchSceneVersion,
} from '../../../shared/sketch/agent-view';
import {
	botActor,
	botEditor,
	stampLocalEdits,
	type ElementAuthorship,
} from '../../../shared/sketch/attribution';
import type {
	SketchElementSkeleton,
	SketchExportFile,
	SketchSessionSnapshot,
} from '../../../shared/sketch/commands';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import { CONDUCTOR, INJECTION, asAlpha, el, realGate, scene } from './sketchToolsHarness';

/** A credential `redactSecrets()` recognizes, and what it becomes. */
const SECRET = 'ghp_wxyzWXYZ0123456789abcd';
const REDACTED = '[REDACTED_API_KEY]';

const BOT = { id: 'agent:alpha', kind: 'bot', name: 'Alpha' };

/**
 * The window that owns agent alpha: a live scene and author map that agent
 * writes change, stamped the way `applyAgentChange()` stamps them. Handles
 * `add`, `update` and `chat`; the other ops are the renderer test's.
 */
function fakeWindow(initial: SketchSessionSnapshot) {
	let elements = [...initial.elements];
	const authors: Record<string, ElementAuthorship> = { ...initial.authors };
	const chat: { agentId: string; text: string }[] = [];
	let clock = 1_000;
	let generated = 0;

	function commit(agent: { id: string; name: string }, next: SketchWireElement[]) {
		const stamped = stampLocalEdits(elements, next, botEditor(agent.id, agent.name), clock++);
		elements = stamped.elements;
		for (const id of stamped.changedIds) {
			const element = elements.find((e) => e.id === id)!;
			authors[id] = {
				version: element.version,
				actor: botActor(agent.id, agent.name),
				textHash: `hash-${id}`,
				guestTouched: false,
			};
		}
	}

	const writeSession = vi.fn<SketchSessionWriter>(async (agent, _sketchId, write) => {
		const live = new Map(elements.filter((e) => e.isDeleted !== true).map((e) => [e.id, e]));
		const done: SketchWireElement[] = [];
		const missing: string[] = [];
		const conflicts: SketchWireElement[] = [];
		switch (write.op) {
			case 'add': {
				const added = write.skeletons.map(
					(skeleton) =>
						({
							x: 0,
							y: 0,
							width: 10,
							height: 10,
							...skeleton,
							id:
								write.regenerateIds || typeof skeleton.id !== 'string'
									? `gen-${generated++}`
									: skeleton.id,
							version: 1,
						}) as SketchWireElement
				);
				commit(agent, [...elements, ...added]);
				done.push(...added);
				break;
			}
			case 'update': {
				const replaced = new Map<string, SketchWireElement>();
				for (const patch of write.patches) {
					const current = live.get(patch.id);
					if (!current) missing.push(patch.id);
					else if (patch.baseVersion !== undefined && patch.baseVersion !== current.version) {
						conflicts.push(current);
					} else {
						const next = { ...current, ...patch.props, version: current.version + 1 };
						replaced.set(patch.id, next);
						done.push(next);
					}
				}
				commit(
					agent,
					elements.map((e) => replaced.get(e.id) ?? e)
				);
				break;
			}
			case 'chat':
				chat.push({ agentId: agent.id, text: write.text });
				break;
			default:
				throw new Error(`fake window: ${write.op} is not covered here`);
		}
		return {
			sceneVersion: sketchSceneVersion(elements),
			elements: done.map((e) => ({ id: e.id, type: String(e.type) })),
			missing,
			conflicts: {
				elements: conflicts,
				authors: Object.fromEntries(
					conflicts.filter((e) => authors[e.id]).map((e) => [e.id, authors[e.id]])
				),
				fileCount: 0,
			},
		};
	});

	return {
		writeSession,
		readSession: async (): Promise<SketchSessionSnapshot> => ({
			elements,
			authors: { ...authors },
			fileCount: 0,
		}),
		element: (id: string) => elements.find((e) => e.id === id),
		authors,
		chat,
	};
}

/** Agent alpha with a fake window, a spied outbound screen and a fake Mermaid converter. */
async function writer(initial: SketchSessionSnapshot, deps: SketchToolDeps = {}) {
	const win = fakeWindow(initial);
	const outbound = vi.fn(screenOutbound);
	const convertMermaid = vi.fn<SketchMermaidConverter>(async () => [{ type: 'rectangle' }]);
	const harness = await asAlpha(scene([]), {
		readSession: win.readSession,
		writeSession: win.writeSession,
		outbound,
		convertMermaid,
		...deps,
	});
	return { ...harness, win, outbound, convertMermaid };
}

function many<T>(count: number, make: (index: number) => T): T[] {
	return Array.from({ length: count }, (_, index) => make(index));
}

describe('sketch write tools: element cap', () => {
	const over = SKETCH_MAX_ELEMENTS_PER_CALL + 1;

	it('refuses more than 500 skeletons, patches or ids before screening or writing', async () => {
		const { refusal, win, outbound } = await writer(scene([el('box', 'rectangle')]));
		const cases: [string, Record<string, unknown>, string][] = [
			['sketch_add_elements', { elements: many(over, () => ({ type: 'rectangle' })) }, 'elements'],
			[
				'sketch_update_elements',
				{ patches: many(over, (i) => ({ id: `e${i}`, strokeColor: '#f00' })) },
				'patches',
			],
			['sketch_delete_elements', { ids: many(over, (i) => `e${i}`) }, 'ids'],
			['sketch_focus', { elementIds: many(over, (i) => `e${i}`) }, 'elementIds'],
		];
		for (const [tool, params, field] of cases) {
			const error = await refusal(tool, { sketchId: 'sk-alpha', ...params });
			expect(error.message).toBe(
				`Sketch Book: \`${field}\` has ${over} items; at most ${SKETCH_MAX_ELEMENTS_PER_CALL} per call.`
			);
		}
		expect(outbound).not.toHaveBeenCalled();
		expect(win.writeSession).not.toHaveBeenCalled();
	});

	it('accepts exactly 500 skeletons', async () => {
		const { result, win } = await writer(scene([]));
		const added = await result('sketch_add_elements', {
			sketchId: 'sk-alpha',
			elements: many(SKETCH_MAX_ELEMENTS_PER_CALL, () => ({ type: 'rectangle' })),
		});
		expect(added.added).toHaveLength(SKETCH_MAX_ELEMENTS_PER_CALL);
		expect(win.writeSession).toHaveBeenCalledTimes(1);
	});

	it('refuses a Mermaid diagram that converts to more than 500 elements, before screening', async () => {
		const { refusal, win, outbound, convertMermaid } = await writer(scene([]));
		convertMermaid.mockResolvedValueOnce(many(over, () => ({ type: 'rectangle' })));
		const error = await refusal('sketch_from_mermaid', {
			sketchId: 'sk-alpha',
			mermaid: 'flowchart LR\n  A --> B',
		});
		expect(error.message).toMatch(`the diagram makes ${over} elements; at most 500 per call`);
		expect(outbound).not.toHaveBeenCalled();
		expect(win.writeSession).not.toHaveBeenCalled();
	});

	it('refuses a chat post over the byte cap and an empty one', async () => {
		const { refusal, win } = await writer(scene([]));
		const long = await refusal('sketch_chat_post', {
			sketchId: 'sk-alpha',
			text: 'x'.repeat(SKETCH_MAX_CHAT_POST_BYTES + 1),
		});
		expect(long.message).toMatch(`at most ${SKETCH_MAX_CHAT_POST_BYTES} bytes`);
		const empty = await refusal('sketch_chat_post', { sketchId: 'sk-alpha', text: '  ' });
		expect(empty.message).toMatch('`text` must be a non-empty string');
		expect(win.writeSession).not.toHaveBeenCalled();
	});

	it('refuses writes past the per-sketch rate limit', async () => {
		const { result, refusal } = await writer(scene([]), {
			writeGuard: createSlidingWindowGuard(() => 0),
		});
		for (let i = 0; i < SKETCH_WRITE_LIMITS.maxPerWindow; i += 1) {
			await result('sketch_chat_post', { sketchId: 'sk-alpha', text: `post ${i}` });
		}
		const error = await refusal('sketch_chat_post', { sketchId: 'sk-alpha', text: 'one more' });
		expect(error.message).toMatch('too many writes to this sketch');
	});
});

describe('sketch_update_elements: baseVersion', () => {
	it('refuses a stale patch and returns the element as it is now', async () => {
		const box = el('box', 'rectangle', { version: 3, strokeColor: '#000' });
		const { result, win } = await writer(scene([box]));
		const updated = await result('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [{ id: 'box', baseVersion: 2, strokeColor: '#f00' }],
		});
		expect(updated.updated).toEqual([]);
		expect(updated.conflicts).toEqual([
			{
				...box,
				author: { id: 'conductor', kind: 'conductor', name: 'Pedram' },
			},
		]);
		expect(win.element('box')).toMatchObject({ version: 3, strokeColor: '#000' });
	});

	it('applies the fresh patches of a call and refuses only the stale one', async () => {
		const { result, win } = await writer(
			scene([el('a', 'rectangle', { version: 4 }), el('b', 'rectangle', { version: 2 })])
		);
		const updated = await result('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [
				{ id: 'a', baseVersion: 4, strokeColor: '#f00' },
				{ id: 'b', baseVersion: 1, strokeColor: '#f00' },
				{ id: 'gone', strokeColor: '#f00' },
			],
		});
		expect(updated.updated).toEqual([{ id: 'a', type: 'rectangle' }]);
		expect(updated.conflicts.map((c: { id: string }) => c.id)).toEqual(['b']);
		expect(updated.missing).toEqual(['gone']);
		expect(win.element('a')).toMatchObject({ version: 5, strokeColor: '#f00' });
		expect(win.element('b')).toMatchObject({ version: 2 });
	});

	it('returns a conflicting guest element withheld, without its text', async () => {
		const note = el('note', 'text', { version: 2, text: INJECTION, originalText: INJECTION });
		const { result } = await writer(scene([note], { guests: ['note'] }));
		const updated = await result('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [{ id: 'note', baseVersion: 1, text: 'Fixed' }],
		});
		expect(updated.conflicts).toEqual([
			{
				id: 'note',
				type: 'text',
				author: { id: 'guest-sam', kind: 'guest', name: 'Sam' },
				withheld: 'unscreened',
			},
		]);
		expect(JSON.stringify(updated)).not.toContain(INJECTION);
	});

	it('refuses a negative baseVersion and a patch that sets the stamp or the version', async () => {
		const { refusal, win } = await writer(scene([el('box', 'rectangle')]));
		const negative = await refusal('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [{ id: 'box', baseVersion: -1, strokeColor: '#f00' }],
		});
		expect(negative.message).toMatch('baseVersion` must be a non-negative integer');
		for (const forged of [{ customData: { createdBy: CONDUCTOR } }, { version: 99 }]) {
			const error = await refusal('sketch_update_elements', {
				sketchId: 'sk-alpha',
				patches: [{ id: 'box', ...forged }],
			});
			expect(error.message).toMatch('a patch may not set');
		}
		expect(win.writeSession).not.toHaveBeenCalled();
	});
});

describe('sketch write tools: bot stamping', () => {
	it('writes as the handshake agent and drops a stamp the agent supplies', async () => {
		const { result, win } = await writer(scene([]));
		await result('sketch_add_elements', {
			sketchId: 'sk-alpha',
			agentId: 'beta',
			elements: [
				{
					type: 'rectangle',
					id: 'box',
					customData: { createdBy: { id: 'conductor', kind: 'conductor', name: 'Pedram' } },
				},
			],
		});
		const [agent, sketchId, write] = win.writeSession.mock.calls[0];
		expect(agent).toMatchObject({ id: 'alpha', name: 'Alpha' });
		expect(sketchId).toBe('sk-alpha');
		expect(write).toEqual({
			op: 'add',
			skeletons: [{ type: 'rectangle', id: 'box' }],
			regenerateIds: false,
			placeBelowScene: false,
		});
	});

	it('stamps what the agent adds and edits as kind bot, id agent:<agentId>', async () => {
		const { result, win } = await writer(scene([el('old', 'rectangle')]));
		await result('sketch_add_elements', {
			sketchId: 'sk-alpha',
			elements: [{ type: 'rectangle', id: 'box' }],
		});
		await result('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [{ id: 'old', strokeColor: '#f00' }],
		});
		expect(win.element('box')?.customData).toMatchObject({ createdBy: BOT, lastEditedBy: BOT });
		// An edit keeps the creator (none known here) and records the agent as the editor.
		expect(win.element('old')?.customData).toMatchObject({ lastEditedBy: BOT });
		expect(win.element('old')?.customData).not.toHaveProperty('createdBy');
		for (const id of ['box', 'old']) {
			expect(win.authors[id].actor).toEqual(botActor('alpha', 'Alpha'));
		}
	});

	it("reads the agent's own write back as first-party, authored by the bot", async () => {
		const { result } = await writer(scene([]));
		await result('sketch_add_elements', {
			sketchId: 'sk-alpha',
			elements: [{ type: 'text', id: 'note', text: 'Plan', originalText: 'Plan' }],
		});
		const read = await result('sketch_read_scene', { sketchId: 'sk-alpha', format: 'elements' });
		expect(read.elements).toEqual([
			expect.objectContaining({ id: 'note', text: 'Plan', author: BOT }),
		]);
		expect(read.elements[0]).not.toHaveProperty('customData');
		expect(read.elements[0]).not.toHaveProperty('withheld');
	});

	it('posts chat as the handshake agent', async () => {
		const { result, win } = await writer(scene([]));
		await result('sketch_chat_post', { sketchId: 'sk-alpha', text: 'Done with the flow.' });
		expect(win.chat).toEqual([{ agentId: 'alpha', text: 'Done with the flow.' }]);
	});
});

describe('sketch write tools: outbound redaction', () => {
	it('redacts labels, text and links before the window sees them', async () => {
		const { result, win, outbound } = await writer(scene([]));
		const added = await result('sketch_add_elements', {
			sketchId: 'sk-alpha',
			elements: [
				{ type: 'rectangle', id: 'box', label: { text: `token ${SECRET}` } },
				{ type: 'text', id: 'note', text: `use ${SECRET}`, link: `https://x.test/?k=${SECRET}` },
				{ type: 'ellipse', id: 'plain', label: { text: 'Login' } },
			],
		});
		expect(added.redactedCount).toBe(3);
		expect(outbound).toHaveBeenCalledTimes(1);
		expect(outbound.mock.calls[0][0]).toMatchObject({
			sketchId: 'sk-alpha',
			agentId: 'alpha',
			purpose: 'element',
		});
		const sent = JSON.stringify(win.writeSession.mock.calls[0][2]);
		expect(sent).not.toContain(SECRET);
		expect(sent).toContain(`token ${REDACTED}`);
		expect(win.element('box')).toMatchObject({ label: { text: `token ${REDACTED}` } });
		expect(win.element('plain')).toMatchObject({ label: { text: 'Login' } });
	});

	it('redacts patched text', async () => {
		const { result, win } = await writer(
			scene([el('note', 'text', { text: 'old', originalText: 'old' })])
		);
		const updated = await result('sketch_update_elements', {
			sketchId: 'sk-alpha',
			patches: [{ id: 'note', text: `key ${SECRET}`, originalText: `key ${SECRET}` }],
		});
		expect(updated.redactedCount).toBe(2);
		expect(win.element('note')).toMatchObject({
			text: `key ${REDACTED}`,
			originalText: `key ${REDACTED}`,
		});
	});

	it('redacts the labels of a converted Mermaid diagram', async () => {
		const { result, win, convertMermaid } = await writer(scene([]));
		convertMermaid.mockResolvedValueOnce([
			{ type: 'rectangle', id: 'm1', label: { text: `A ${SECRET}` } },
		] as SketchElementSkeleton[]);
		const added = await result('sketch_from_mermaid', {
			sketchId: 'sk-alpha',
			mermaid: `flowchart LR\n  A[${SECRET}] --> B`,
		});
		expect(added.redactedCount).toBe(1);
		const write = win.writeSession.mock.calls[0][2];
		expect(write).toMatchObject({ op: 'add', regenerateIds: true, placeBelowScene: true });
		expect(JSON.stringify(write)).not.toContain(SECRET);
	});

	it('redacts a chat post', async () => {
		const { result, win, outbound } = await writer(scene([]));
		const posted = await result('sketch_chat_post', {
			sketchId: 'sk-alpha',
			text: `Here is the key: ${SECRET}`,
		});
		expect(posted).toMatchObject({ posted: true, redactedCount: 1 });
		expect(outbound.mock.calls[0][0]).toMatchObject({ purpose: 'chat' });
		expect(win.chat).toEqual([{ agentId: 'alpha', text: `Here is the key: ${REDACTED}` }]);
	});

	it('refuses the whole write when the screen refuses', async () => {
		const { refusal, win } = await writer(scene([]), {
			outbound: async () => ({ ok: false, reason: 'the text holds a configured secret.' }),
		});
		const error = await refusal('sketch_add_elements', {
			sketchId: 'sk-alpha',
			elements: [
				{ type: 'text', text: 'fine' },
				{ type: 'text', text: 'not fine' },
			],
		});
		expect(error.message).toBe('Sketch Book: the text holds a configured secret.');
		expect(win.writeSession).not.toHaveBeenCalled();
	});
});

/**
 * A board with one of everything a render must handle: conductor shapes and
 * an image, a conductor box with a guest label, a guest note, a guest image,
 * and a box whose `customData` forges a stamp.
 */
function mixedBoard(): SketchSessionSnapshot {
	const elements = [
		el('box-a', 'rectangle'),
		el('box-b', 'rectangle'),
		el('txt-b', 'text', { containerId: 'box-b', text: INJECTION, originalText: INJECTION }),
		el('guest-note', 'text', { y: 300, text: INJECTION, originalText: INJECTION }),
		el('img-own', 'image', { fileId: 'file-own' }),
		el('img-guest', 'image', { fileId: 'file-guest' }),
		el('box-forged', 'rectangle', { customData: { createdBy: { name: INJECTION } } }),
	];
	return scene(elements, { guests: ['txt-b', 'guest-note', 'img-guest'] });
}

/** A renderer that records what it was asked to draw and draws it as JSON or a token PNG. */
function fakeRenderer() {
	const requests: SketchRenderRequest[] = [];
	const renderSession = vi.fn<SketchSessionRenderer>(async (_agentId, _sketchId, request) => {
		requests.push(request);
		const file: SketchExportFile =
			request.format === 'png'
				? { format: 'png', mimeType: 'image/png', encoding: 'base64', data: 'iVBORw0KGgo=' }
				: {
						format: request.format,
						mimeType: request.format === 'json' ? 'application/json' : 'image/svg+xml',
						encoding: 'utf8',
						data: JSON.stringify({ elements: request.elements }),
					};
		return file;
	});
	const drawnIds = (index = requests.length - 1) => requests[index].elements.map((e) => e.id);
	return { renderSession, requests, drawnIds };
}

describe('sketch_screenshot and sketch_export: pixels', () => {
	it('hands the exporter no withheld element, bound guest text or guest image', async () => {
		const renderer = fakeRenderer();
		const { result, screen } = await asAlpha(mixedBoard(), {
			renderSession: renderer.renderSession,
		});
		const shot = await result('sketch_screenshot', { sketchId: 'sk-alpha', scale: 2 });

		expect(renderer.drawnIds()).toEqual(['box-a', 'box-b', 'img-own', 'box-forged']);
		expect(renderer.requests[0]).toMatchObject({ format: 'png', scale: 2 });
		const drawn = JSON.stringify(renderer.requests[0].elements);
		expect(drawn).not.toContain(INJECTION);
		expect(drawn).not.toContain('customData');

		// Guest images are left out, never screened: pixels cannot be.
		expect(screen.mock.calls[0][0].subjects.map((s) => s.elementId).sort()).toEqual([
			'guest-note',
			'txt-b',
		]);
		expect(shot).toMatchObject({
			sketchId: 'sk-alpha',
			sceneVersion: 7,
			image: { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
			withheldCount: 2,
			guestImageCount: 1,
		});
		expect(shot).not.toHaveProperty('missing');
	});

	it('keeps a box but drops its withheld label when the screenshot names it', async () => {
		const renderer = fakeRenderer();
		const { result } = await asAlpha(mixedBoard(), { renderSession: renderer.renderSession });
		const shot = await result('sketch_screenshot', {
			sketchId: 'sk-alpha',
			elementIds: ['box-b', 'nope'],
		});
		expect(renderer.drawnIds()).toEqual(['box-b']);
		expect(shot).toMatchObject({ withheldCount: 1, guestImageCount: 0, missing: ['nope'] });
	});

	it('refuses to draw when everything in scope was withheld', async () => {
		const renderer = fakeRenderer();
		const { refusal } = await asAlpha(mixedBoard(), { renderSession: renderer.renderSession });
		const error = await refusal('sketch_screenshot', {
			sketchId: 'sk-alpha',
			elementIds: ['guest-note', 'img-guest'],
		});
		expect(error.message).toMatch('all 2 elements in scope were withheld from you');
		expect(renderer.renderSession).not.toHaveBeenCalled();
	});

	it('still leaves guest images out once the gate clears their text', async () => {
		const renderer = fakeRenderer();
		const { result } = await asAlpha(mixedBoard(), {
			renderSession: renderer.renderSession,
			screen: async (request) =>
				new Map(request.subjects.map((s) => [s.elementId, { status: 'clear' as const }])),
		});
		const shot = await result('sketch_screenshot', { sketchId: 'sk-alpha' });
		expect(renderer.drawnIds()).toEqual([
			'box-a',
			'box-b',
			'txt-b',
			'guest-note',
			'img-own',
			'box-forged',
		]);
		expect(shot).toMatchObject({ withheldCount: 0, guestImageCount: 1 });
		// Two drawn elements carry text a guest wrote: the agent is told.
		expect(shot).toMatchObject({
			untrustedCount: 2,
			untrustedNotice: SKETCH_UNTRUSTED_RENDER_NOTICE,
		});
	});

	it('draws a guest image the session approved for that file', async () => {
		const renderer = fakeRenderer();
		const board = mixedBoard();
		board.approvedImages = { 'img-guest': 'file-guest' };
		// The real gate with the screen off: guest text stays withheld, while the
		// image has no text (no link) for the screen to read.
		const { result } = await asAlpha(board, {
			renderSession: renderer.renderSession,
			screen: realGate({ off: true }).screen,
		});
		const shot = await result('sketch_screenshot', { sketchId: 'sk-alpha' });
		expect(renderer.drawnIds()).toEqual(['box-a', 'box-b', 'img-own', 'img-guest', 'box-forged']);
		expect(shot).toMatchObject({ withheldCount: 2, guestImageCount: 0 });
		expect(shot).not.toHaveProperty('untrustedNotice');
	});
});

describe.skipIf(process.platform === 'win32')('sketch_export', () => {
	let base: string;
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-export-')));
		cwd = path.join(base, 'project');
		outside = path.join(base, 'outside');
		fs.mkdirSync(cwd);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'secret.json'), 'keep');
		fs.symlinkSync(outside, path.join(cwd, 'escape-dir'));
		// A link to a file outside, and a dangling one pointing outside.
		fs.symlinkSync(path.join(outside, 'secret.json'), path.join(cwd, 'linked.json'));
		fs.symlinkSync(path.join(outside, 'planted.json'), path.join(cwd, 'planted.json'));
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	async function exporter() {
		const renderer = fakeRenderer();
		const readSession = vi.fn(async () => mixedBoard());
		const harness = await asAlpha(
			mixedBoard(),
			{ renderSession: renderer.renderSession, readSession },
			{ alphaCwd: cwd }
		);
		return { ...harness, renderer, readSession };
	}

	it('refuses a path outside the working directory before reading or drawing', async () => {
		const { refusal, renderer, readSession } = await exporter();
		const cases: [string, RegExp][] = [
			['../outside/board.json', /is outside your working directory/],
			[path.join(outside, 'board.json'), /is outside your working directory/],
			['escape-dir/board.json', /resolves outside your working directory .* through a symlink/],
			['linked.json', /resolves outside your working directory .* through a symlink/],
			['.', /names your working directory/],
			['', /`path` must be a non-empty string/],
		];
		for (const [requested, message] of cases) {
			const error = await refusal('sketch_export', {
				sketchId: 'sk-alpha',
				format: 'json',
				path: requested,
			});
			expect(error.message).toMatch(message);
		}
		expect(readSession).not.toHaveBeenCalled();
		expect(renderer.renderSession).not.toHaveBeenCalled();
		expect(fs.readdirSync(outside)).toEqual(['secret.json']);
		expect(fs.readFileSync(path.join(outside, 'secret.json'), 'utf8')).toBe('keep');
	});

	it('replaces a dangling link at the target instead of writing through it', async () => {
		const { result } = await exporter();
		await result('sketch_export', { sketchId: 'sk-alpha', format: 'json', path: 'planted.json' });
		const target = path.join(cwd, 'planted.json');
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(target, 'utf8')).not.toContain(INJECTION);
		expect(fs.readdirSync(outside)).toEqual(['secret.json']);
	});

	it('writes inside the working directory, without withheld elements', async () => {
		const { result, renderer } = await exporter();
		const exported = await result('sketch_export', {
			sketchId: 'sk-alpha',
			format: 'json',
			path: 'out/board.json',
		});
		const target = path.join(cwd, 'out', 'board.json');
		expect(exported).toMatchObject({
			sketchId: 'sk-alpha',
			format: 'json',
			path: target,
			withheldCount: 2,
			guestImageCount: 1,
		});
		expect(renderer.drawnIds()).toEqual(['box-a', 'box-b', 'img-own', 'box-forged']);
		const written = fs.readFileSync(target, 'utf8');
		expect(exported.bytes).toBe(Buffer.byteLength(written));
		expect(written).not.toContain(INJECTION);
		expect(JSON.parse(written).elements.map((e: { id: string }) => e.id)).toEqual(
			renderer.drawnIds()
		);
	});

	it('writes PNG bytes for an absolute path inside the working directory', async () => {
		const { result } = await exporter();
		const target = path.join(cwd, 'board.png');
		await result('sketch_export', { sketchId: 'sk-alpha', format: 'png', path: target });
		expect(fs.readFileSync(target)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));
	});
});
