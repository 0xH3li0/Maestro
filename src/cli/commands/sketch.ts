// Sketch Book commands - `maestro-cli sketch ...` (spec section 9).
//
// The CLI half of the verbs that need no room: create, list, open, read and
// export a sketch. Each rides the `sketch_command` WS message to the SAME
// SketchService the `sketch:*` IPC handlers call, so the app must be running
// and the result is the one the Sketch tab works from.
//
// - `new --agent <id>` creates a sketch owned by a local agent and opens it in
//   a BACKGROUND tab there (spec Q5); `--focus` shows it instead. It never
//   shares: sharing is always a human action.
// - `list [--agent]` lists every sketch, or the ones one agent owns.
// - `open <sketchId>` shows the sketch in a tab on its agent; `--background`
//   adds the tab without moving the view.
// - `read <sketchId>` prints a summary of the saved board, or with
//   `--format elements` its live Excalidraw elements as JSON.
// - `export <sketchId> --format png|svg|json --output <path>` writes the saved
//   board to a file. PNG and SVG are drawn by the desktop window, JSON is the
//   `.excalidraw` file itself.
//
// `read` and `export` work from the SAVED scene, which the tab autosaves within
// a second of an edit.
//
// Encore-gated: `src/cli/index.ts` registers the command with
// `encoreCommand()`, so it is hidden and refused while `sketchBook` is off. The
// app's service refuses too, with the same text and the same `--json` code.

import { promises as fs } from 'fs';
import { ExitCode } from '../exit-codes';
import { failCommand, resolveAgentOrFail, sendBridgeCommand } from '../services/session-command';
import { readLiveSessions } from '../services/storage';
import { formatTextTable } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import { encoreRefusalFields } from '../utils/encore-gate';
import { formatRelativeTime, formatSize } from '../../shared/formatters';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import {
	isSketchExportFormat,
	isSketchReadFormat,
	type ExportedSketch,
	type OpenedSketch,
	type SketchCommandAction,
	type SketchExportFile,
	type SketchExportFormat,
	type SketchReading,
	type SketchSceneSummary,
} from '../../shared/sketch/commands';
import type { SketchRecord } from '../../shared/sketch/types';

/** Opening a tab waits on the window that owns the agent. */
const OPEN_TIMEOUT_MS = 20_000;
/** The first PNG or SVG loads Excalidraw and its fonts in the window. */
const EXPORT_TIMEOUT_MS = 60_000;

export interface SketchNewOptions {
	agent: string;
	name?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

export interface SketchListOptions {
	agent?: string;
	json?: boolean;
}

export interface SketchOpenOptions {
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

export interface SketchReadOptions {
	format?: string;
	json?: boolean;
}

export interface SketchExportOptions {
	format?: string;
	output?: string;
	json?: boolean;
}

interface SketchReply<T> {
	type: string;
	success: boolean;
	error?: string;
	response?: T;
}

/** One `sketch_command` round trip. Exits on any failure; returns the response. */
async function request<T>(
	action: SketchCommandAction,
	fields: Record<string, unknown>,
	json: boolean | undefined,
	timeoutMs?: number
): Promise<T> {
	const reply = await sendBridgeCommand<SketchReply<T>>(
		{ type: 'sketch_command', action, ...fields },
		'sketch_result',
		json,
		timeoutMs,
		encoreRefusalFields('sketchBook')
	);
	return reply.response as T;
}

function requireSketchId(sketchId: string, json?: boolean): string {
	const id = sketchId.trim();
	if (!id) failCommand('A sketch id is required.', json, ExitCode.InvalidUsage);
	return id;
}

function agentName(agentId: string): string {
	try {
		return readLiveSessions().find((s) => s.id === agentId)?.name ?? '(agent removed)';
	} catch {
		return agentId.slice(0, 8);
	}
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

export async function sketchNew(options: SketchNewOptions): Promise<void> {
	const agentId = resolveAgentOrFail(options.agent, options.json);
	const background = resolveBackgroundFlag(options, 'sketch-new');
	const name = options.name?.trim() || undefined;
	const opened = await request<OpenedSketch>(
		'new',
		{ agentId, name, background },
		options.json,
		OPEN_TIMEOUT_MS
	);
	if (options.json) {
		printJson({ success: true, ...opened, background });
		return;
	}
	console.log(
		`Created sketch "${opened.record.name}" on ${agentName(agentId)}${background ? ' (background tab)' : ''}`
	);
	console.log(`  Sketch: ${opened.record.sketchId}`);
	if (opened.tabId) console.log(`  Tab: ${opened.tabId}`);
}

export async function sketchList(options: SketchListOptions): Promise<void> {
	const agentId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	const records = await request<SketchRecord[]>('list', { agentId }, options.json);
	if (options.json) {
		printJson({ success: true, sketches: records });
		return;
	}
	if (records.length === 0) {
		console.log(agentId ? `${agentName(agentId)} owns no sketches.` : 'No sketches yet.');
		return;
	}
	const names = new Map<string, string>();
	const rows = records.map((record) => {
		if (!names.has(record.ownerAgentId)) {
			names.set(record.ownerAgentId, agentName(record.ownerAgentId));
		}
		return [
			record.sketchId,
			record.name,
			names.get(record.ownerAgentId) ?? '',
			formatRelativeTime(record.createdAt),
			record.share ? 'shared' : 'local',
		];
	});
	console.log(formatTextTable(['ID', 'NAME', 'AGENT', 'CREATED', 'STATE'], rows));
}

export async function sketchOpen(sketchId: string, options: SketchOpenOptions): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const background = resolveBackgroundFlag(options, 'sketch-open');
	const opened = await request<OpenedSketch>(
		'open',
		{ sketchId: id, background },
		options.json,
		OPEN_TIMEOUT_MS
	);
	if (options.json) {
		printJson({ success: true, ...opened, background });
		return;
	}
	console.log(`Opened sketch "${opened.record.name}"${background ? ' (background tab)' : ''}`);
	if (opened.tabId) console.log(`  Tab: ${opened.tabId}`);
}

/** The human reading of a summary: counts, then shapes, then connections. */
export function formatSketchSummary(record: SketchRecord, summary: SketchSceneSummary): string {
	const lines = [`${record.name} (${record.sketchId})`];
	const types = Object.entries(summary.byType)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([type, count]) => `${count} ${type}`);
	lines.push(
		`  ${summary.elementCount} element${summary.elementCount === 1 ? '' : 's'}${types.length ? `: ${types.join(', ')}` : ''}`
	);
	if (summary.fileCount > 0) lines.push(`  ${summary.fileCount} embedded image(s)`);
	if (summary.bounds) {
		const { minX, minY, maxX, maxY } = summary.bounds;
		lines.push(`  Bounds: ${Math.round(maxX - minX)} x ${Math.round(maxY - minY)}`);
	}
	if (summary.shapes.length > 0) {
		lines.push('', 'Shapes:');
		for (const shape of summary.shapes) {
			lines.push(`  ${shape.type} ${shape.id}${shape.label ? `  "${shape.label}"` : ''}`);
		}
	}
	if (summary.connections.length > 0) {
		lines.push('', 'Connections:');
		for (const link of summary.connections) {
			const label = link.label ? `  "${link.label}"` : '';
			lines.push(`  ${link.from ?? '(loose)'} -> ${link.to ?? '(loose)'}${label}  [${link.id}]`);
		}
	}
	return lines.join('\n');
}

export async function sketchRead(sketchId: string, options: SketchReadOptions): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const format = options.format ?? 'summary';
	if (!isSketchReadFormat(format)) {
		failCommand(
			`--format expects summary or elements, got "${format}"`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const reading = await request<SketchReading>('read', { sketchId: id, format }, options.json);
	if (options.json) {
		printJson({ success: true, ...reading });
		return;
	}
	if (reading.format === 'elements') {
		// Elements are data, not prose: print them as JSON either way.
		printJson(reading.elements);
		return;
	}
	console.log(formatSketchSummary(reading.record, reading.summary));
}

/** The bytes an exported file holds. */
export function exportFileBytes(file: SketchExportFile): Buffer {
	return Buffer.from(file.data, file.encoding === 'base64' ? 'base64' : 'utf8');
}

export async function sketchExport(sketchId: string, options: SketchExportOptions): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const format = options.format;
	if (!isSketchExportFormat(format)) {
		failCommand(
			`--format expects png, svg or json, got "${format ?? ''}"`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	if (!options.output?.trim()) {
		failCommand('--output <path> is required.', options.json, ExitCode.InvalidUsage);
	}
	const outputPath = resolveCliPath(options.output);
	const exported = await request<ExportedSketch>(
		'export',
		{ sketchId: id, format: format as SketchExportFormat },
		options.json,
		EXPORT_TIMEOUT_MS
	);
	const bytes = exportFileBytes(exported.file);
	try {
		await fs.writeFile(outputPath, bytes);
	} catch (error) {
		failCommand(
			`Could not write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
			options.json
		);
	}
	if (options.json) {
		printJson({
			success: true,
			sketchId: exported.record.sketchId,
			format: exported.file.format,
			mimeType: exported.file.mimeType,
			path: outputPath,
			bytes: bytes.length,
		});
		return;
	}
	console.log(
		`Exported "${exported.record.name}" as ${exported.file.format.toUpperCase()} to ${outputPath} (${formatSize(bytes.length)})`
	);
}
