/**
 * The `sketch_command` WS message (`maestro-cli sketch`, spec section 9) and
 * the renderer hop behind it.
 *
 * The CLI sends one message with an `action`; main answers it through the
 * SketchService, the same service the `sketch:*` IPC handlers call. Two
 * actions need a window: opening a sketch tab (the tab lives in the renderer's
 * agent model) and rendering PNG or SVG (Excalidraw measures text in a DOM).
 * For those, main sends a `SketchRendererRequest` to the window that owns the
 * agent and waits for a `SketchRendererResult`. The agent read tools (T1, T3,
 * T4) use the same hop to read the live `SketchSession` (`readSession`): the
 * scene with unsaved edits and the author map, which only the window holds.
 *
 * Also here: `summarizeSketchScene()`, the `read --format summary` view of a
 * saved scene. Bundled into the renderer and the CLI, so it imports nothing
 * from Electron or Node.
 */

import type { ElementAuthorship } from './attribution';
import type { SketchWireElement } from './payloads';
import { SKETCH_ACTOR_KINDS, SKETCH_ROLES, type SketchRecord, type SketchScene } from './types';

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
	| { action: 'export'; format: SketchImageFormat; scene: SketchScene }
	| {
			action: 'readSession';
			sketchId: string;
			/**
			 * Read the scene into a session when none is open yet. False answers
			 * `session: null` instead, so a listing never loads every board.
			 */
			open: boolean;
	  };

/**
 * A live `SketchSession` as the agent read tools see it: the elements (deleted
 * ones included, for `sketch_changes`) and the author map (spec section 7).
 * Binary files stay in the window; only their count crosses.
 */
export interface SketchSessionSnapshot {
	elements: SketchWireElement[];
	authors: Record<string, ElementAuthorship>;
	fileCount: number;
}

export type SketchRendererResult =
	| {
			success: true;
			tabId?: string;
			file?: SketchExportFile;
			/** `readSession`: null when no session is open and `open` was false. */
			session?: SketchSessionSnapshot | null;
	  }
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorship(value: unknown): value is ElementAuthorship {
	if (!isObjectRecord(value) || !isObjectRecord(value.actor)) return false;
	const actor = value.actor;
	return (
		typeof value.version === 'number' &&
		typeof value.textHash === 'string' &&
		typeof value.guestTouched === 'boolean' &&
		typeof actor.id === 'string' &&
		typeof actor.name === 'string' &&
		(SKETCH_ACTOR_KINDS as readonly unknown[]).includes(actor.kind) &&
		(SKETCH_ROLES as readonly unknown[]).includes(actor.role)
	);
}

/**
 * A session snapshot as main may trust it, or undefined when it is malformed.
 * An author map entry that does not parse is dropped, so its element reads as
 * unknown-author, which the gate treats as third-party (fail closed).
 */
function normalizeSessionSnapshot(value: unknown): SketchSessionSnapshot | undefined {
	if (!isObjectRecord(value) || !Array.isArray(value.elements)) return undefined;
	const elements = value.elements.filter(
		(element): element is SketchWireElement =>
			isObjectRecord(element) &&
			typeof element.id === 'string' &&
			typeof element.version === 'number'
	);
	if (elements.length !== value.elements.length) return undefined;
	const authors: Record<string, ElementAuthorship> = {};
	if (isObjectRecord(value.authors)) {
		for (const [id, entry] of Object.entries(value.authors)) {
			if (isAuthorship(entry)) authors[id] = entry;
		}
	}
	const fileCount =
		typeof value.fileCount === 'number' && Number.isFinite(value.fileCount) ? value.fileCount : 0;
	return { elements, authors, fileCount };
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
	const session = reply.session === null ? null : normalizeSessionSnapshot(reply.session);
	return {
		success: true,
		...(typeof reply.tabId === 'string' ? { tabId: reply.tabId } : {}),
		...(isExportFile(reply.file) ? { file: reply.file } : {}),
		...(session !== undefined ? { session } : {}),
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

/** The element types drawn as connectors (`from -> to`). */
export const SKETCH_CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line']);

/** A string field, trimmed; undefined when missing or blank. */
export function sketchStringField(element: SketchWireElement, field: string): string | undefined {
	const value = element[field];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A finite number field, or 0. */
export function sketchNumberField(element: SketchWireElement, field: string): number {
	const value = element[field];
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The element id an arrow end (`startBinding` / `endBinding`) is bound to, or null. */
export function sketchBoundElementId(element: SketchWireElement, field: string): string | null {
	const binding = element[field];
	if (!binding || typeof binding !== 'object') return null;
	const id = (binding as Record<string, unknown>).elementId;
	return typeof id === 'string' ? id : null;
}

/** The short name of an element nobody labeled: `rectangle#1a2b3c4d`. */
export function sketchAnonymousName(element: SketchWireElement): string {
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
		const containerId = sketchStringField(element, 'containerId');
		const text = sketchStringField(element, 'text');
		if (element.type === 'text' && containerId && text && byId.has(containerId)) {
			boundText.set(containerId, text);
		}
	}
	const labelOf = (element: SketchWireElement): string | undefined =>
		boundText.get(element.id) ??
		(element.type === 'text' ? sketchStringField(element, 'text') : undefined);
	const endName = (id: string | null): string | null => {
		if (!id) return null;
		const end = byId.get(id);
		return end ? (labelOf(end) ?? sketchAnonymousName(end)) : null;
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

		const x = sketchNumberField(element, 'x');
		const y = sketchNumberField(element, 'y');
		const width = sketchNumberField(element, 'width');
		const height = sketchNumberField(element, 'height');
		minX = Math.min(minX, x, x + width);
		minY = Math.min(minY, y, y + height);
		maxX = Math.max(maxX, x, x + width);
		maxY = Math.max(maxY, y, y + height);

		const label = labelOf(element);
		if (SKETCH_CONNECTOR_TYPES.has(type)) {
			connections.push({
				id: element.id,
				type,
				from: endName(sketchBoundElementId(element, 'startBinding')),
				to: endName(sketchBoundElementId(element, 'endBinding')),
				...(label ? { label } : {}),
			});
			continue;
		}
		// Bound text is already the label of its container.
		const containerId = sketchStringField(element, 'containerId');
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
