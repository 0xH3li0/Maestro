/**
 * The renderer half of `maestro-cli sketch` (spec section 9).
 *
 * Main answers every verb through its SketchService, and sends this window
 * only the jobs a window must do (`SketchRendererRequest`):
 *
 * - `open`: show a sketch in a tab on its agent, through the same
 *   `openSketchInSession()` the four UI ways in use. `background` leaves the
 *   active agent and tab alone.
 * - `export`: draw a saved scene as SVG or PNG with Excalidraw's own exporters,
 *   which need a DOM to measure text. Excalidraw loads lazily, the same way the
 *   tab loads it, with the bundled fonts.
 * - `readSession`: hand the agent read tools (T1, T3, T4) the live session:
 *   the scene with unsaved edits and the author map, which only this window
 *   holds. `open` reads the scene into a session first when none is open.
 * - `agentWrite` and `convertMermaid`: the agent write tools (T5-T8, T11,
 *   T12), in `sketchAgentWrites.ts`.
 * - `renderForAgent`: `sketch_screenshot` and `sketch_export` (T9, T10). Main
 *   picks the elements (the gate has removed what the agent may not see);
 *   this window adds the session's background and the image files those
 *   elements name, and nothing else.
 *
 * Every path answers, a thrown one included, so main never waits out its
 * timeout. Registered by `useRemoteIntegration`.
 */

import {
	SKETCH_EXPORT_MIME_TYPES,
	sketchSceneJsonFile,
	type SketchExportFile,
	type SketchImageFormat,
	type SketchRendererRequest,
	type SketchRendererResult,
	type SketchSessionSnapshot,
} from '../../shared/sketch/commands';
import type { SketchScene } from '../../shared/sketch/types';
import { openReadySketchSession, useSketchSessionStore } from '../stores/sketchSessionStore';
import { readBlobAsDataUrl } from '../utils/imageData';
import { applySketchAgentWrite, convertMermaidToSkeletons } from './sketchAgentWrites';
import { openSketchInSession } from './sketchTabs';

/** Space around the drawing in an export, in scene pixels. */
const EXPORT_PADDING = 16;

type ExportOptions = Parameters<(typeof import('@excalidraw/excalidraw'))['exportToSvg']>[0];

/**
 * Draw a saved scene as SVG (text) or PNG (base64). Deleted elements are left
 * out; the board's background color is kept. `scale` (PNG only) is pixels per
 * scene pixel.
 */
export async function exportSketchImage(
	scene: SketchScene,
	format: SketchImageFormat,
	options: { scale?: number } = {}
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
	const scale = options.scale ?? 1;
	const blob = await exportToBlob({
		elements,
		appState,
		files,
		mimeType,
		exportPadding: EXPORT_PADDING,
		...(scale !== 1
			? {
					getDimensions: (width: number, height: number) => ({
						width: width * scale,
						height: height * scale,
						scale,
					}),
				}
			: {}),
	});
	const dataUrl = await readBlobAsDataUrl(blob);
	return { format, mimeType, encoding: 'base64', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

/**
 * The live session of a sketch, for the agent read tools. With `open`, a
 * sketch no view has opened is read into a session first (and stays, so the
 * author map it gathers from here on is kept); without it, such a sketch
 * answers null. A session that failed to load throws its error.
 */
export async function readSketchSessionSnapshot(
	sketchId: string,
	open: boolean
): Promise<SketchSessionSnapshot | null> {
	if (!useSketchSessionStore.getState().sessions[sketchId] && !open) return null;
	const session = await openReadySketchSession(sketchId);
	return {
		elements: session.scene.elements,
		authors: session.authors,
		fileCount: Object.keys(session.scene.files).length,
	};
}

/**
 * Draw the elements main picked from a live session, for an agent (T9, T10).
 * The scene is rebuilt from those elements alone: the session adds its
 * background color and the image files the elements name, so nothing main
 * left out (a withheld element, a guest image's file) can reach the output.
 */
export async function renderSketchForAgent(
	request: Extract<SketchRendererRequest, { action: 'renderForAgent' }>
): Promise<SketchExportFile> {
	const session = await openReadySketchSession(request.sketchId);
	const files: Record<string, unknown> = {};
	for (const element of request.elements) {
		const fileId = element.type === 'image' ? element.fileId : undefined;
		if (typeof fileId === 'string' && session.scene.files[fileId] !== undefined) {
			files[fileId] = session.scene.files[fileId];
		}
	}
	const { viewBackgroundColor, gridSize } = session.scene.appState;
	const scene: SketchScene = {
		type: 'excalidraw',
		version: session.scene.version,
		source: session.scene.source,
		elements: request.elements,
		appState: { viewBackgroundColor: viewBackgroundColor ?? '#ffffff', gridSize: gridSize ?? null },
		files,
	};
	if (request.format === 'json') return sketchSceneJsonFile(scene);
	return exportSketchImage(scene, request.format, { scale: request.scale });
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
		if (request.action === 'agentWrite') {
			return {
				success: true,
				write: await applySketchAgentWrite(request.sketchId, request.agent, request.write),
			};
		}
		if (request.action === 'convertMermaid') {
			return { success: true, skeletons: await convertMermaidToSkeletons(request.mermaid) };
		}
		if (request.action === 'renderForAgent') {
			return { success: true, file: await renderSketchForAgent(request) };
		}
		if (request.action === 'readSession') {
			return {
				success: true,
				session: await readSketchSessionSnapshot(request.sketchId, request.open),
			};
		}
		return { success: false, error: 'Unknown Sketch Book request.' };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
