/**
 * The renderer half of `maestro-cli sketch` (spec section 9).
 *
 * Main answers every verb through its SketchService, and sends this window
 * only the two jobs a window must do (`SketchRendererRequest`):
 *
 * - `open`: show a sketch in a tab on its agent, through the same
 *   `openSketchInSession()` the four UI ways in use. `background` leaves the
 *   active agent and tab alone.
 * - `export`: draw a saved scene as SVG or PNG with Excalidraw's own exporters,
 *   which need a DOM to measure text. Excalidraw loads lazily, the same way the
 *   tab loads it, with the bundled fonts.
 *
 * Every path answers, a thrown one included, so main never waits out its
 * timeout. Registered by `useRemoteIntegration`.
 */

import {
	SKETCH_EXPORT_MIME_TYPES,
	type SketchExportFile,
	type SketchImageFormat,
	type SketchRendererRequest,
	type SketchRendererResult,
} from '../../shared/sketch/commands';
import type { SketchScene } from '../../shared/sketch/types';
import { readBlobAsDataUrl } from '../utils/imageData';
import { openSketchInSession } from './sketchTabs';

/** Space around the drawing in an export, in scene pixels. */
const EXPORT_PADDING = 16;

type ExportOptions = Parameters<(typeof import('@excalidraw/excalidraw'))['exportToSvg']>[0];

/**
 * Draw a saved scene as SVG (text) or PNG (base64). Deleted elements are left
 * out; the board's background color is kept.
 */
export async function exportSketchImage(
	scene: SketchScene,
	format: SketchImageFormat
): Promise<SketchExportFile> {
	// Imported here so the asset module stays its own lazy chunk (excalidrawAssets.ts).
	const { loadExcalidraw } = await import('../components/SketchBook/excalidrawAssets');
	const { exportToBlob, exportToSvg } = await loadExcalidraw();
	const elements = scene.elements.filter(
		(element) => element.isDeleted !== true
	) as unknown as ExportOptions['elements'];
	const appState = { ...scene.appState, exportBackground: true } as ExportOptions['appState'];
	const files = scene.files as unknown as ExportOptions['files'];
	const mimeType = SKETCH_EXPORT_MIME_TYPES[format];

	if (format === 'svg') {
		const svg = await exportToSvg({ elements, appState, files, exportPadding: EXPORT_PADDING });
		return { format, mimeType, encoding: 'utf8', data: svg.outerHTML };
	}
	const blob = await exportToBlob({
		elements,
		appState,
		files,
		mimeType,
		exportPadding: EXPORT_PADDING,
	});
	const dataUrl = await readBlobAsDataUrl(blob);
	return { format, mimeType, encoding: 'base64', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

/** Run one request from main and resolve with the reply it waits for. */
export async function runRemoteSketchCommand(
	request: SketchRendererRequest
): Promise<SketchRendererResult> {
	try {
		if (request.action === 'open') {
			const tabId = openSketchInSession(
				request.sessionId,
				{ sketchId: request.sketchId, name: request.name },
				{ background: request.background }
			);
			return tabId
				? { success: true, tabId }
				: { success: false, error: 'The agent that owns this sketch is not in this window.' };
		}
		if (request.action === 'export') {
			return { success: true, file: await exportSketchImage(request.scene, request.format) };
		}
		return { success: false, error: 'Unknown Sketch Book request.' };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
