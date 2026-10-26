/**
 * Tests for the `sketch_command` wire module: the action and format guards,
 * the renderer reply normalizer main trusts, and `summarizeSketchScene()`, the
 * `maestro-cli sketch read` summary (bound text folded into its shape, arrows
 * as `from -> to`, deleted elements counted but not listed), and the
 * `.excalidraw` file both JSON exports write.
 */

import { describe, it, expect } from 'vitest';
import {
	isSketchCommandAction,
	isSketchExportFormat,
	isSketchReadFormat,
	normalizeSketchRendererResult,
	sketchSceneJsonFile,
	summarizeSketchScene,
} from '../../../shared/sketch/commands';
import type { SketchScene } from '../../../shared/sketch/types';

function scene(
	elements: SketchScene['elements'],
	files: Record<string, unknown> = {}
): SketchScene {
	return { type: 'excalidraw', version: 2, elements, appState: {}, files };
}

describe('guards', () => {
	it('accepts exactly the five room-free actions', () => {
		for (const action of ['new', 'list', 'open', 'read', 'export']) {
			expect(isSketchCommandAction(action), action).toBe(true);
		}
		for (const action of ['share', 'NEW', '', undefined, 1]) {
			expect(isSketchCommandAction(action), String(action)).toBe(false);
		}
	});

	it('accepts the read and export formats only', () => {
		expect(isSketchReadFormat('summary')).toBe(true);
		expect(isSketchReadFormat('elements')).toBe(true);
		expect(isSketchReadFormat('json')).toBe(false);
		expect(isSketchExportFormat('png')).toBe(true);
		expect(isSketchExportFormat('svg')).toBe(true);
		expect(isSketchExportFormat('json')).toBe(true);
		expect(isSketchExportFormat('gif')).toBe(false);
	});
});

describe('normalizeSketchRendererResult', () => {
	it('keeps a tab id and a well-formed file', () => {
		const file = { format: 'png', mimeType: 'image/png', encoding: 'base64', data: 'iVBO' };
		expect(normalizeSketchRendererResult({ success: true, tabId: 'tab-1', file })).toEqual({
			success: true,
			tabId: 'tab-1',
			file,
		});
	});

	it('drops a malformed file and a non-string tab id', () => {
		expect(
			normalizeSketchRendererResult({
				success: true,
				tabId: 7,
				file: { format: 'gif', mimeType: 'x', encoding: 'utf8', data: '' },
			})
		).toEqual({ success: true });
		expect(
			normalizeSketchRendererResult({
				success: true,
				file: { format: 'svg', mimeType: 'image/svg+xml', encoding: 'hex', data: '' },
			})
		).toEqual({ success: true });
	});

	it('keeps a session snapshot and drops author entries that do not parse', () => {
		const actor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' };
		const good = { version: 2, actor, textHash: 'abc', guestTouched: true };
		expect(
			normalizeSketchRendererResult({
				success: true,
				session: {
					elements: [{ id: 'a', version: 2, type: 'text' }],
					authors: { a: good, b: { version: 1, actor: { ...actor, kind: 'host' } } },
					fileCount: 3,
				},
			})
		).toEqual({
			success: true,
			session: {
				elements: [{ id: 'a', version: 2, type: 'text' }],
				authors: { a: good },
				fileCount: 3,
			},
		});
	});

	it('keeps a null session and drops a malformed one', () => {
		expect(normalizeSketchRendererResult({ success: true, session: null })).toEqual({
			success: true,
			session: null,
		});
		expect(
			normalizeSketchRendererResult({
				success: true,
				session: { elements: [{ id: 'a' }], authors: {} },
			})
		).toEqual({ success: true });
	});

	it('keeps a well-formed write report and drops a malformed one', () => {
		const write = {
			sceneVersion: 7,
			elements: [{ id: 'r1', type: 'rectangle', extra: 'dropped' }],
			missing: ['gone'],
			conflicts: { elements: [{ id: 'r2', version: 4 }], authors: {}, fileCount: 0 },
		};
		expect(normalizeSketchRendererResult({ success: true, write })).toEqual({
			success: true,
			write: {
				sceneVersion: 7,
				elements: [{ id: 'r1', type: 'rectangle' }],
				missing: ['gone'],
				conflicts: { elements: [{ id: 'r2', version: 4 }], authors: {}, fileCount: 0 },
			},
		});
		expect(
			normalizeSketchRendererResult({ success: true, write: { ...write, sceneVersion: 'x' } })
		).toEqual({ success: true });
		expect(
			normalizeSketchRendererResult({ success: true, write: { ...write, conflicts: null } })
		).toEqual({ success: true });
	});

	it('keeps Mermaid skeletons only when every one is an object', () => {
		expect(
			normalizeSketchRendererResult({ success: true, skeletons: [{ type: 'rectangle' }] })
		).toEqual({ success: true, skeletons: [{ type: 'rectangle' }] });
		expect(
			normalizeSketchRendererResult({ success: true, skeletons: [{ type: 'rectangle' }, 'x'] })
		).toEqual({ success: true });
	});

	it('turns anything else into a failure with a readable error', () => {
		expect(normalizeSketchRendererResult(null)).toEqual({
			success: false,
			error: 'The Maestro window sent no answer.',
		});
		expect(normalizeSketchRendererResult({ success: false, error: 'Agent gone.' })).toEqual({
			success: false,
			error: 'Agent gone.',
		});
		expect(normalizeSketchRendererResult({ success: 'true' })).toEqual({
			success: false,
			error: 'The Maestro window could not do that.',
		});
	});
});

describe('summarizeSketchScene', () => {
	it('summarizes an empty board', () => {
		expect(summarizeSketchScene(scene([]))).toEqual({
			elementCount: 0,
			deletedCount: 0,
			byType: {},
			shapes: [],
			connections: [],
			bounds: null,
			fileCount: 0,
		});
	});

	it('folds bound text into its shape and names arrows by their ends', () => {
		const summary = summarizeSketchScene(
			scene(
				[
					{ id: 'box-a', version: 1, type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
					{ id: 'text-a', version: 1, type: 'text', text: ' API ', containerId: 'box-a' },
					{
						id: 'box-b-long-id',
						version: 1,
						type: 'diamond',
						x: 300,
						y: -20,
						width: 60,
						height: 60,
					},
					{
						id: 'arrow-1',
						version: 1,
						type: 'arrow',
						x: 100,
						y: 25,
						width: 200,
						height: 0,
						startBinding: { elementId: 'box-a' },
						endBinding: { elementId: 'box-b-long-id' },
					},
					{ id: 'arrow-label', version: 1, type: 'text', text: 'calls', containerId: 'arrow-1' },
					{
						id: 'note',
						version: 1,
						type: 'text',
						text: 'Free note',
						x: 0,
						y: 100,
						width: 40,
						height: 20,
					},
					{ id: 'loose', version: 1, type: 'line', x: 0, y: 200, width: 10, height: 10 },
				],
				{ 'file-1': {} }
			)
		);

		expect(summary.elementCount).toBe(7);
		expect(summary.byType).toEqual({ rectangle: 1, text: 3, diamond: 1, arrow: 1, line: 1 });
		expect(summary.shapes).toEqual([
			{ id: 'box-a', type: 'rectangle', label: 'API' },
			{ id: 'box-b-long-id', type: 'diamond' },
			{ id: 'note', type: 'text', label: 'Free note' },
		]);
		expect(summary.connections).toEqual([
			{ id: 'arrow-1', type: 'arrow', from: 'API', to: 'diamond#box-b-lo', label: 'calls' },
			{ id: 'loose', type: 'line', from: null, to: null },
		]);
		expect(summary.bounds).toEqual({ minX: 0, minY: -20, maxX: 360, maxY: 210 });
		expect(summary.fileCount).toBe(1);
	});

	it('counts deleted elements without listing them, and frees text whose container is gone', () => {
		const summary = summarizeSketchScene(
			scene([
				{ id: 'box', version: 3, type: 'rectangle', isDeleted: true },
				{ id: 'orphan', version: 1, type: 'text', text: 'left behind', containerId: 'box' },
				{
					id: 'arrow',
					version: 1,
					type: 'arrow',
					startBinding: { elementId: 'box' },
					endBinding: null,
				},
			])
		);

		expect(summary.deletedCount).toBe(1);
		expect(summary.elementCount).toBe(2);
		expect(summary.shapes).toEqual([{ id: 'orphan', type: 'text', label: 'left behind' }]);
		expect(summary.connections).toEqual([{ id: 'arrow', type: 'arrow', from: null, to: null }]);
	});
});

describe('sketchSceneJsonFile', () => {
	it('writes the scene as tab-indented JSON that parses back unchanged', () => {
		const board = scene([{ id: 'a', version: 1, type: 'rectangle' }]);
		const file = sketchSceneJsonFile(board);
		expect(file).toMatchObject({ format: 'json', mimeType: 'application/json', encoding: 'utf8' });
		expect(file.data).toBe(JSON.stringify(board, null, '\t'));
		expect(JSON.parse(file.data)).toEqual(board);
	});
});
