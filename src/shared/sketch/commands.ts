/**
 * The `sketch_command` WS message (`maestro-cli sketch`, spec section 9) and
 * the renderer hop behind it.
 *
 * The CLI sends one message with an `action`; main answers it through the
 * SketchService, the same service the `sketch:*` IPC handlers call. Two
 * actions need a window: opening a sketch tab (the tab lives in the renderer's
 * agent model) and rendering PNG or SVG (Excalidraw measures text in a DOM).
 * For those, main sends a `SketchRendererRequest` to the window that owns the
 * agent and waits for a `SketchRendererResult`.
 *
 * Also here: `summarizeSketchScene()`, the `read --format summary` view of a
 * saved scene. Bundled into the renderer and the CLI, so it imports nothing
 * from Electron or Node.
 */

import type { SketchWireElement } from './payloads';
import type { SketchRecord, SketchScene } from './types';

export const SKETCH_COMMAND_ACTIONS = ['new', 'list', 'open', 'read', 'export'] as const;
export type SketchCommandAction = (typeof SKETCH_COMMAND_ACTIONS)[number];

export const SKETCH_READ_FORMATS = ['summary', 'elements'] as const;
export type SketchReadFormat = (typeof SKETCH_READ_FORMATS)[number];

export const SKETCH_EXPORT_FORMATS = ['png', 'svg', 'json'] as const;
export type SketchExportFormat = (typeof SKETCH_EXPORT_FORMATS)[number];

/** The formats only a window can draw. */
export type SketchImageFormat = Exclude<SketchExportFormat, 'json'>;

export const SKETCH_EXPORT_MIME_TYPES: Readonly<Record<SketchExportFormat, string>> = {
	png: 'image/png',
	svg: 'image/svg+xml',
	json: 'application/json',
};

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isSketchCommandAction(value: unknown): value is SketchCommandAction {
	return isOneOf(SKETCH_COMMAND_ACTIONS, value);
}

export function isSketchReadFormat(value: unknown): value is SketchReadFormat {
	return isOneOf(SKETCH_READ_FORMATS, value);
}

export function isSketchExportFormat(value: unknown): value is SketchExportFormat {
	return isOneOf(SKETCH_EXPORT_FORMATS, value);
}

/**
 * An exported file, ready to write. Text formats (SVG, JSON) travel as UTF-8,
 * PNG as base64, so the bytes survive the JSON hops between the window, main
 * and the CLI.
 */
export interface SketchExportFile {
	format: SketchExportFormat;
	mimeType: string;
	encoding: 'utf8' | 'base64';
	data: string;
}

/** `new` and `open`: a sketch and the tab it is shown in. */
export interface OpenedSketch {
	record: SketchRecord;
	tabId: string | null;
}

/** `read`: the saved board as a summary, or its live elements whole. */
export type SketchReading =
	| { record: SketchRecord; format: 'summary'; summary: SketchSceneSummary }
	| { record: SketchRecord; format: 'elements'; elements: SketchWireElement[] };

/** `export`: the file, ready to write, and the sketch it came from. */
export interface ExportedSketch {
	record: SketchRecord;
	file: SketchExportFile;
}

/** Main to the renderer: the work only a window can do. */
export type SketchRendererRequest =
	| {
			action: 'open';
			/** The agent that owns the sketch; the tab opens there. */
			sessionId: string;
			sketchId: string;
			name: string;
			/** Leave the active agent and tab alone (`--background`). */
			background: boolean;
	  }
	| { action: 'export'; format: SketchImageFormat; scene: SketchScene };

export type SketchRendererResult =
	| { success: true; tabId?: string; file?: SketchExportFile }
	| { success: false; error: string };

function isExportFile(value: unknown): value is SketchExportFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as Record<string, unknown>;
	return (
		isSketchExportFormat(file.format) &&
		typeof file.mimeType === 'string' &&
		(file.encoding === 'utf8' || file.encoding === 'base64') &&
		typeof file.data === 'string'
	);
}

/** A renderer reply as main may trust it. Anything malformed is a failure. */
export function normalizeSketchRendererResult(raw: unknown): SketchRendererResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'The Maestro window sent no answer.' };
	}
	const reply = raw as Record<string, unknown>;
	if (reply.success !== true) {
		return {
			success: false,
			error:
				typeof reply.error === 'string' && reply.error
					? reply.error
					: 'The Maestro window could not do that.',
		};
	}
	return {
		success: true,
		...(typeof reply.tabId === 'string' ? { tabId: reply.tabId } : {}),
		...(isExportFile(reply.file) ? { file: reply.file } : {}),
	};
}

/** One shape on the board, named by its own or its bound text. */
export interface SketchSummaryShape {
	id: string;
	type: string;
	label?: string;
}

/** An arrow or line, with the shapes its ends are bound to (`A -> B`). */
export interface SketchSummaryConnection {
	id: string;
	type: string;
	/** The start shape's label, or `type#id-prefix`; null when the end is loose. */
	from: string | null;
	to: string | null;
	label?: string;
}

/** `read --format summary`: what is on a saved board, without its geometry. */
export interface SketchSceneSummary {
	/** Live (not deleted) elements. */
	elementCount: number;
	deletedCount: number;
	/** Live elements by Excalidraw type. */
	byType: Record<string, number>;
	/** Shapes that are neither connectors nor bound text. Text elements count as shapes. */
	shapes: SketchSummaryShape[];
	connections: SketchSummaryConnection[];
	/** The box around every live element, in scene coordinates. */
	bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
	/** Embedded images (Excalidraw binary files). */
	fileCount: number;
}

const CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line']);

function stringField(element: SketchWireElement, field: string): string | undefined {
	const value = element[field];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(element: SketchWireElement, field: string): number {
	const value = element[field];
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function boundElementId(element: SketchWireElement, field: string): string | null {
	const binding = element[field];
	if (!binding || typeof binding !== 'object') return null;
	const id = (binding as Record<string, unknown>).elementId;
	return typeof id === 'string' ? id : null;
}

/** The short name of an element nobody labeled: `rectangle#1a2b3c4d`. */
function anonymousName(element: SketchWireElement): string {
	return `${String(element.type ?? 'element')}#${element.id.slice(0, 8)}`;
}

/**
 * What a saved scene holds, in the words a reader needs: shapes with their
 * labels, connectors as `from -> to`, counts and bounds. Bound text is folded
 * into the shape it labels. Pure, so the CLI, main and tests agree.
 */
export function summarizeSketchScene(scene: SketchScene): SketchSceneSummary {
	const live = scene.elements.filter((element) => element.isDeleted !== true);
	const byId = new Map(live.map((element) => [element.id, element]));

	// A text element with a live container labels that container.
	const boundText = new Map<string, string>();
	for (const element of live) {
		const containerId = stringField(element, 'containerId');
		const text = stringField(element, 'text');
		if (element.type === 'text' && containerId && text && byId.has(containerId)) {
			boundText.set(containerId, text);
		}
	}
	const labelOf = (element: SketchWireElement): string | undefined =>
		boundText.get(element.id) ??
		(element.type === 'text' ? stringField(element, 'text') : undefined);
	const endName = (id: string | null): string | null => {
		if (!id) return null;
		const end = byId.get(id);
		return end ? (labelOf(end) ?? anonymousName(end)) : null;
	};

	const byType: Record<string, number> = {};
	const shapes: SketchSummaryShape[] = [];
	const connections: SketchSummaryConnection[] = [];
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const element of live) {
		const type = String(element.type ?? 'unknown');
		byType[type] = (byType[type] ?? 0) + 1;

		const x = numberField(element, 'x');
		const y = numberField(element, 'y');
		const width = numberField(element, 'width');
		const height = numberField(element, 'height');
		minX = Math.min(minX, x, x + width);
		minY = Math.min(minY, y, y + height);
		maxX = Math.max(maxX, x, x + width);
		maxY = Math.max(maxY, y, y + height);

		const label = labelOf(element);
		if (CONNECTOR_TYPES.has(type)) {
			connections.push({
				id: element.id,
				type,
				from: endName(boundElementId(element, 'startBinding')),
				to: endName(boundElementId(element, 'endBinding')),
				...(label ? { label } : {}),
			});
			continue;
		}
		// Bound text is already the label of its container.
		const containerId = stringField(element, 'containerId');
		if (type === 'text' && containerId && byId.has(containerId)) continue;
		shapes.push({ id: element.id, type, ...(label ? { label } : {}) });
	}

	return {
		elementCount: live.length,
		deletedCount: scene.elements.length - live.length,
		byType,
		shapes,
		connections,
		bounds: live.length > 0 ? { minX, minY, maxX, maxY } : null,
		fileCount: Object.keys(scene.files ?? {}).length,
	};
}
