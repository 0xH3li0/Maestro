/**
 * @file sketch.test.ts
 * @description Tests for `maestro-cli sketch` (spec section 9): each verb sends the
 * `sketch_command` action the SketchService method behind it expects, `new` is
 * background by default and `open` focuses by default, `read` prints a summary or
 * the elements, `export` writes the returned bytes to the resolved `--output` path,
 * and bad arguments and app refusals exit with the documented codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	resolveAgentId: vi.fn((agent: string) => `resolved-${agent}`),
	readLiveSessions: vi.fn(() => [{ id: 'resolved-planner', name: 'Planner' }]),
}));

import {
	exportFileBytes,
	formatSketchSummary,
	sketchExport,
	sketchList,
	sketchNew,
	sketchOpen,
	sketchRead,
} from '../../../cli/commands/sketch';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { encoreDisabledMessage } from '../../../shared/encoreFeatureDefaults';
import { summarizeSketchScene } from '../../../shared/sketch/commands';
import type { SketchRecord } from '../../../shared/sketch/types';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';

const record: SketchRecord = {
	sketchId: SKETCH_ID,
	ownerAgentId: 'resolved-planner',
	name: 'Architecture',
	filePath: path.join('/data', 'sketches', 'resolved-planner', `${SKETCH_ID}.excalidraw`),
	createdAt: Date.now() - 60_000,
	share: null,
	guestEdited: false,
};

function mockReply(reply: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					sent.push({ ...payload, responseType: rt, timeout });
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return sent;
}

const respond = (response: unknown) =>
	mockReply({ type: 'sketch_result', success: true, response });

describe('sketch command', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const errors = () => errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('new', () => {
		it('creates the sketch for the resolved agent in a background tab by default', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', name: '  Architecture  ' });

			expect(sent[0]).toMatchObject({
				type: 'sketch_command',
				action: 'new',
				agentId: 'resolved-planner',
				name: 'Architecture',
				background: true,
				responseType: 'sketch_result',
			});
			expect(logged()).toContain('Created sketch "Architecture" on Planner (background tab)');
			expect(logged()).toContain(`Sketch: ${SKETCH_ID}`);
			expect(logged()).toContain('Tab: tab-1');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('shows the sketch with --focus', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', focus: true });

			expect(sent[0]).toMatchObject({ background: false, name: undefined });
			expect(logged()).not.toContain('background tab');
		});

		it('prints the record, tab and placement under --json', async () => {
			respond({ record, tabId: 'tab-1' });
			await sketchNew({ agent: 'planner', json: true });

			expect(json()).toEqual({ success: true, record, tabId: 'tab-1', background: true });
		});

		it('exits with the app refusal, an SSH agent for one', async () => {
			mockReply({
				type: 'sketch_result',
				success: false,
				error: 'Sketch Book runs on local agents only.',
			});
			await expect(sketchNew({ agent: 'planner' })).rejects.toThrow('__exit__');

			expect(errors()).toContain('Sketch Book runs on local agents only.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('gives the app refusal for a turned-off feature the gate code under --json', async () => {
			const message = encoreDisabledMessage('sketchBook');
			mockReply({ type: 'sketch_result', success: false, error: message });
			await expect(sketchNew({ agent: 'planner', json: true })).rejects.toThrow('__exit__');

			expect(json()).toEqual({ success: false, error: message, code: 'SKETCH_BOOK_DISABLED' });
		});
	});

	describe('list', () => {
		it('lists every sketch with its agent name', async () => {
			const sent = respond([record]);
			await sketchList({});

			expect(sent[0]).toMatchObject({ action: 'list', agentId: undefined });
			const out = logged();
			expect(out).toContain('ID');
			expect(out).toContain(SKETCH_ID);
			expect(out).toContain('Architecture');
			expect(out).toContain('Planner');
			expect(out).toContain('local');
		});

		it('filters by the resolved agent and says when it owns nothing', async () => {
			const sent = respond([]);
			await sketchList({ agent: 'planner' });

			expect(sent[0]).toMatchObject({ action: 'list', agentId: 'resolved-planner' });
			expect(logged()).toBe('Planner owns no sketches.');
		});

		it('names a removed owner instead of hiding the sketch', async () => {
			respond([{ ...record, ownerAgentId: 'gone' }]);
			await sketchList({});

			expect(logged()).toContain('(agent removed)');
		});

		it('prints the records under --json', async () => {
			respond([record]);
			await sketchList({ json: true });

			expect(json()).toEqual({ success: true, sketches: [record] });
		});
	});

	describe('open', () => {
		it('focuses the tab by default', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchOpen(` ${SKETCH_ID} `, {});

			expect(sent[0]).toMatchObject({ action: 'open', sketchId: SKETCH_ID, background: false });
			expect(logged()).toContain('Opened sketch "Architecture"');
			expect(logged()).not.toContain('background tab');
		});

		it('adds the tab without moving the view with --background', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await sketchOpen(SKETCH_ID, { background: true });

			expect(sent[0]).toMatchObject({ background: true });
			expect(logged()).toContain('(background tab)');
		});

		it('refuses an empty id as a usage error before the bridge', async () => {
			const sent = respond({ record, tabId: 'tab-1' });
			await expect(sketchOpen('   ', {})).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('read', () => {
		const scene = {
			type: 'excalidraw' as const,
			version: 2,
			elements: [
				{ id: 'box-a', version: 1, type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
				{ id: 'label-a', version: 1, type: 'text', text: 'API', containerId: 'box-a' },
				{ id: 'box-b', version: 1, type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
				{
					id: 'arrow-1',
					version: 1,
					type: 'arrow',
					x: 100,
					y: 25,
					width: 100,
					height: 0,
					startBinding: { elementId: 'box-a' },
					endBinding: { elementId: 'box-b' },
				},
			],
			appState: {},
			files: {},
		};
		const summary = summarizeSketchScene(scene);

		it('asks for the summary by default and prints shapes and connections', async () => {
			const sent = respond({ record, format: 'summary', summary });
			await sketchRead(SKETCH_ID, {});

			expect(sent[0]).toMatchObject({ action: 'read', sketchId: SKETCH_ID, format: 'summary' });
			const out = logged();
			expect(out).toContain(`Architecture (${SKETCH_ID})`);
			expect(out).toContain('rectangle box-a  "API"');
			expect(out).toContain('API -> ellipse#box-b');
		});

		it('prints the elements as JSON', async () => {
			const elements = scene.elements;
			respond({ record, format: 'elements', elements });
			await sketchRead(SKETCH_ID, { format: 'elements' });

			expect(JSON.parse(logged())).toEqual(elements);
		});

		it('refuses an unknown format as a usage error', async () => {
			const sent = respond({});
			await expect(sketchRead(SKETCH_ID, { format: 'xml' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('--format expects summary or elements');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('formats an empty board without a bounds line', () => {
			const text = formatSketchSummary(record, summarizeSketchScene({ ...scene, elements: [] }));
			expect(text).toContain('0 elements');
			expect(text).not.toContain('Bounds');
		});
	});

	describe('export', () => {
		let dir: string;

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sketch-export-'));
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('writes a base64 PNG to the resolved output path', async () => {
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const output = path.join(dir, 'board.png');
			const sent = respond({
				record,
				file: {
					format: 'png',
					mimeType: 'image/png',
					encoding: 'base64',
					data: png.toString('base64'),
				},
			});
			await sketchExport(SKETCH_ID, { format: 'png', output });

			expect(sent[0]).toMatchObject({ action: 'export', sketchId: SKETCH_ID, format: 'png' });
			expect(sent[0].timeout).toBeGreaterThan(10_000);
			expect(fs.readFileSync(output)).toEqual(png);
			expect(logged()).toContain(`Exported "Architecture" as PNG to ${output}`);
		});

		it('writes UTF-8 text and reports the path and size under --json', async () => {
			const output = path.join(dir, 'board.svg');
			respond({
				record,
				file: { format: 'svg', mimeType: 'image/svg+xml', encoding: 'utf8', data: '<svg>é</svg>' },
			});
			await sketchExport(SKETCH_ID, { format: 'svg', output, json: true });

			expect(fs.readFileSync(output, 'utf8')).toBe('<svg>é</svg>');
			expect(json()).toEqual({
				success: true,
				sketchId: SKETCH_ID,
				format: 'svg',
				mimeType: 'image/svg+xml',
				path: output,
				bytes: Buffer.byteLength('<svg>é</svg>'),
			});
		});

		it('requires a known format and an output path', async () => {
			const sent = respond({});
			await expect(sketchExport(SKETCH_ID, { format: 'gif', output: 'x.gif' })).rejects.toThrow(
				'__exit__'
			);
			await expect(sketchExport(SKETCH_ID, { format: 'png' })).rejects.toThrow('__exit__');

			expect(sent).toHaveLength(0);
			expect(errors()).toContain('--format expects png, svg or json');
			expect(errors()).toContain('--output <path> is required.');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('reports a write failure', async () => {
			respond({
				record,
				file: { format: 'json', mimeType: 'application/json', encoding: 'utf8', data: '{}' },
			});
			const output = path.join(dir, 'missing-folder', 'board.json');
			await expect(sketchExport(SKETCH_ID, { format: 'json', output })).rejects.toThrow('__exit__');

			expect(errors()).toContain(`Could not write ${output}`);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('decodes the file encoding it was given', () => {
			expect(
				exportFileBytes({ format: 'json', mimeType: '', encoding: 'utf8', data: 'ab' })
			).toEqual(Buffer.from('ab'));
			expect(
				exportFileBytes({ format: 'png', mimeType: '', encoding: 'base64', data: 'YWI=' })
			).toEqual(Buffer.from('ab'));
		});
	});
});
