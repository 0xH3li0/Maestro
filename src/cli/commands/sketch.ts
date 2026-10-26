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
// - `screening-consent grant|revoke|status --engine jev|openjev` stores or
//   revokes the conductor's consent to screen guest text on a cloud System One
//   engine (spec section 8.10). A person at the terminal reads the disclosure
//   and answers it (or passes `--yes`); an agent caller gets the desktop
//   confirmation instead (A1), and nothing is stored unless the conductor
//   allows it. `revoke` and `status` run.
//
// - `share <sketchId> [--role rw|ro] [--expires-days n] [--label]` shares the
//   sketch on RunMaestro.ai (the room on the first share) and prints the new
//   link, which holds the room key: it is shown once and kept nowhere.
//   `unshare` archives the room, `revoke-link <sketchId> <capId>` revokes one
//   link, `rotate` resets all access. From an agent caller each raises the
//   desktop confirmation and runs only on Allow (A1); a person runs them.
// - `owner status|register|sign-out` is this device's RunMaestro.ai sign-in,
//   which sharing needs. `register --email <address> [--wait]` sends the
//   confirmation email and, with `--wait`, waits for the click.
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
import { canPrompt, confirmOnTerminal } from '../utils/confirm';
import { callerMessageFields, readCallerIdentity } from '../../shared/agentDelegation';
import {
	isSketchCloudEngine,
	sketchCloudEngineLabel,
	sketchCloudScreeningDisclosure,
	type SketchCloudEngine,
	type SketchScreeningConsentStatus,
} from '../../shared/sketch/cloud-consent';
import { formatRelativeTime, formatSize } from '../../shared/formatters';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import {
	isSketchExportFormat,
	isSketchOwnerOp,
	isSketchReadFormat,
	isSketchScreeningConsentOp,
	type ExportedSketch,
	type OpenedSketch,
	type SketchCommandAction,
	type SketchExportFile,
	type SketchExportFormat,
	type SketchReading,
	type SketchOwnerCommandResult,
	type SketchSceneSummary,
	type SketchShareResult,
} from '../../shared/sketch/commands';
import type { SketchOwnerStatus } from '../../shared/sketch/server';
import type { SketchLinkRole, SketchRecord } from '../../shared/sketch/types';

/** Opening a tab waits on the window that owns the agent. */
const OPEN_TIMEOUT_MS = 20_000;
/** The first PNG or SVG loads Excalidraw and its fonts in the window. */
const EXPORT_TIMEOUT_MS = 60_000;
/** An agent's grant waits on the conductor answering the desktop confirmation. */
const CONSENT_CONFIRM_TIMEOUT_MS = 5 * 60_000;
/** A share uploads the whole board (and its images) before the link exists. */
const SHARE_TIMEOUT_MS = 4 * 60_000;
/** An agent's share waits on the conductor first (A1), then uploads. */
const AGENT_SHARE_TIMEOUT_MS = CONSENT_CONFIRM_TIMEOUT_MS + SHARE_TIMEOUT_MS;
/** `owner register --wait`: the app polls for up to 15 minutes. */
const OWNER_WAIT_TIMEOUT_MS = 16 * 60_000;

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

export interface SketchScreeningConsentOptions {
	engine?: string;
	yes?: boolean;
	json?: boolean;
}

export interface SketchShareCliOptions {
	role?: string;
	expiresDays?: string;
	label?: string;
	json?: boolean;
}

export interface SketchSharingCliOptions {
	json?: boolean;
}

export interface SketchOwnerOptions {
	email?: string;
	wait?: boolean;
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

/** The human reading of the consent state. */
export function formatScreeningConsentStatus(status: SketchScreeningConsentStatus): string {
	const lines: string[] = [];
	lines.push(
		status.source
			? `Screen: ${status.source.label} (${status.source.locality}${status.source.host ? `, ${status.source.host}` : ''})`
			: `Screen: none (${status.sourceProblem ?? 'off'})`
	);
	const jev = status.consent.jev;
	const openjev = status.consent.openjev;
	lines.push(
		`Consent: ${sketchCloudEngineLabel('jev')} ${jev ? `granted ${formatRelativeTime(jev.grantedAt)}` : 'not granted'}`
	);
	lines.push(
		`Consent: ${sketchCloudEngineLabel('openjev')} ${openjev ? `granted for ${openjev.host} ${formatRelativeTime(openjev.grantedAt)}` : 'not granted'}`
	);
	if (status.source?.locality === 'cloud') {
		lines.push(
			status.sourceCovered
				? 'The engine in force is covered by your consent.'
				: 'The engine in force is NOT covered: guest text stays withheld from your agent.'
		);
	}
	if (status.rooms.length > 0) {
		lines.push('', 'Live rooms:');
		for (const room of status.rooms) {
			const server = room.serverScreening
				? `server says ${room.serverScreening}`
				: 'no server echo yet';
			lines.push(
				`  ${room.sketchId}  ${room.screening}${room.liveConfirmed ? ', confirmed' : ''}  (${server})`
			);
		}
	}
	return lines.join('\n');
}

export async function sketchScreeningConsent(
	op: string,
	options: SketchScreeningConsentOptions
): Promise<void> {
	if (!isSketchScreeningConsentOp(op)) {
		failCommand(
			`screening-consent expects grant, revoke or status, got "${op}"`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	let engine: SketchCloudEngine | undefined;
	if (op !== 'status') {
		if (!isSketchCloudEngine(options.engine)) {
			failCommand(
				`--engine expects jev or openjev, got "${options.engine ?? ''}"`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
		engine = options.engine as SketchCloudEngine;
	}

	const caller = readCallerIdentity(process.env);
	if (op === 'grant' && engine && !caller && !options.yes) {
		// A person grants at the terminal: show the same disclosure the desktop does.
		if (!canPrompt()) {
			failCommand(
				'Granting cloud screening needs a confirmation. Run it in a terminal, or pass --yes after reading what it sends.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		const disclosure = sketchCloudScreeningDisclosure({ engine, reason: 'grant' });
		console.log(`${disclosure.message}\n\n${disclosure.detail}\n`);
		if (!(await confirmOnTerminal(disclosure.title))) {
			failCommand('Nothing was changed.', options.json);
		}
	}

	const status = await request<SketchScreeningConsentStatus>(
		'screening-consent',
		{ op, ...(engine ? { engine } : {}), ...callerMessageFields(caller) },
		options.json,
		op === 'grant' && caller ? CONSENT_CONFIRM_TIMEOUT_MS : undefined
	);
	if (options.json) {
		printJson({ success: true, op, ...(engine ? { engine } : {}), ...status });
		return;
	}
	if (op === 'grant' && engine) {
		console.log(`Cloud screening allowed on ${sketchCloudEngineLabel(engine)}.`);
	} else if (op === 'revoke' && engine) {
		console.log(`Cloud screening consent revoked for ${sketchCloudEngineLabel(engine)}.`);
	}
	console.log(formatScreeningConsentStatus(status));
}

/** A sharing verb from an agent waits on the desktop confirmation (A1). */
function sharingTimeout(fromAgent: boolean): number {
	return fromAgent ? AGENT_SHARE_TIMEOUT_MS : SHARE_TIMEOUT_MS;
}

export async function sketchShare(sketchId: string, options: SketchShareCliOptions): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const role = options.role ?? 'rw';
	if (role !== 'rw' && role !== 'ro') {
		failCommand(`--role expects rw or ro, got "${role}"`, options.json, ExitCode.InvalidUsage);
	}
	let expiresInDays: number | undefined;
	if (options.expiresDays !== undefined) {
		expiresInDays = Number(options.expiresDays);
		if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1) {
			failCommand(
				`--expires-days expects a whole number of days, got "${options.expiresDays}"`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
	}
	const caller = readCallerIdentity(process.env);
	const result = await request<SketchShareResult>(
		'share',
		{
			sketchId: id,
			role: role as SketchLinkRole,
			...(expiresInDays !== undefined ? { expiresInDays } : {}),
			...(options.label?.trim() ? { label: options.label.trim() } : {}),
			...callerMessageFields(caller),
		},
		options.json,
		sharingTimeout(Boolean(caller))
	);
	if (options.json) {
		printJson({ success: true, ...result });
		return;
	}
	console.log(
		`${result.createdRoom ? 'Shared' : 'New link for'} "${result.record.name}" (${result.link.role === 'rw' ? 'can edit' : 'can view'}, expires ${new Date(result.link.expiresAt).toISOString().slice(0, 10)})`
	);
	console.log(`  Link: ${result.link.url}`);
	console.log(`  Link id: ${result.link.capId}`);
	console.log('  The link holds the room key. It is shown once and kept nowhere.');
}

export async function sketchUnshare(
	sketchId: string,
	options: SketchSharingCliOptions
): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const caller = readCallerIdentity(process.env);
	const record = await request<SketchRecord>(
		'unshare',
		{ sketchId: id, ...callerMessageFields(caller) },
		options.json,
		sharingTimeout(Boolean(caller))
	);
	if (options.json) {
		printJson({ success: true, record });
		return;
	}
	console.log(`Stopped sharing "${record.name}". The room is deleted; the sketch stays here.`);
}

export async function sketchRevokeLink(
	sketchId: string,
	capId: string,
	options: SketchSharingCliOptions
): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const link = capId.trim();
	if (!link) failCommand('A link id is required.', options.json, ExitCode.InvalidUsage);
	const caller = readCallerIdentity(process.env);
	const record = await request<SketchRecord>(
		'revoke-link',
		{ sketchId: id, capId: link, ...callerMessageFields(caller) },
		options.json,
		sharingTimeout(Boolean(caller))
	);
	if (options.json) {
		printJson({ success: true, record });
		return;
	}
	const live = record.share?.links.filter((candidate) => !candidate.revoked).length ?? 0;
	console.log(`Revoked link ${link} on "${record.name}". ${live} link(s) still work.`);
}

export async function sketchRotate(
	sketchId: string,
	options: SketchSharingCliOptions
): Promise<void> {
	const id = requireSketchId(sketchId, options.json);
	const caller = readCallerIdentity(process.env);
	const record = await request<SketchRecord>(
		'rotate',
		{ sketchId: id, ...callerMessageFields(caller) },
		options.json,
		sharingTimeout(Boolean(caller))
	);
	if (options.json) {
		printJson({ success: true, record });
		return;
	}
	console.log(
		`Reset all access to "${record.name}": every link is revoked and the sketch is under a new key (epoch ${record.share?.keyEpoch ?? 0}). Run sketch share to invite anyone back.`
	);
}

/** The human reading of the owner sign-in. */
export function formatOwnerStatus(status: SketchOwnerStatus): string {
	if (status.state === 'signed-out') return 'Not signed in to Sketch Book sharing.';
	const where = status.serverUrl ?? '';
	const other = status.otherServer ? ' (not the server Sketch Book uses now)' : '';
	if (status.state === 'pending') {
		return `Waiting for ${status.email} to confirm the email from ${where}${other}.`;
	}
	return `Signed in as ${status.email} on ${where}${other}.`;
}

export async function sketchOwner(op: string, options: SketchOwnerOptions): Promise<void> {
	if (!isSketchOwnerOp(op)) {
		failCommand(
			`owner expects status, register or sign-out, got "${op}"`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	if (op === 'register' && !options.email?.trim()) {
		failCommand('owner register needs --email <address>.', options.json, ExitCode.InvalidUsage);
	}
	const result = await request<SketchOwnerCommandResult>(
		'owner',
		{
			op,
			...(op === 'register' ? { email: options.email?.trim(), wait: options.wait === true } : {}),
		},
		options.json,
		op === 'register' && options.wait ? OWNER_WAIT_TIMEOUT_MS : undefined
	);
	if (options.json) {
		printJson({ success: true, op, ...result });
		return;
	}
	if (op === 'register' && result.email) {
		console.log(
			result.email === 'already-confirmed'
				? 'That address was confirmed before; a new sign-in link went out.'
				: 'A confirmation email went out. Open the link in it to finish signing in.'
		);
	}
	console.log(formatOwnerStatus(result.status));
}
