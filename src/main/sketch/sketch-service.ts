/**
 * The Sketch Book service: the one implementation behind every surface that
 * reads or edits a sketch. The `sketch:*` IPC handlers call it, and the CLI's
 * WS verbs call the same methods (CLAUDE.md, "If the User Can Do It,
 * `maestro-cli` Can Do It"), so the UI and the CLI cannot drift.
 *
 * It owns what the store does not: the Encore gate, and who may own a sketch.
 *
 * - Gate (spec section 3): while the `sketchBook` Encore Feature is off, every
 *   method throws `encoreDisabledMessage('sketchBook')` before touching the
 *   store, so nothing is read or written and the CLI prints the same text.
 * - Owner (Q12): a new sketch belongs to a live LOCAL agent. An agent that runs
 *   over SSH cannot own one, because the MCP bridge is a local socket.
 *   Listing by owner does not check the agent: a sketch outlives the agent that
 *   made it (spec section 3), so its records stay readable.
 *
 * Arguments arrive from IPC and the WS bridge, so each one is checked here by
 * type before the store sees it. The secrets (room key, owner token) are not
 * part of this surface: they never leave the main process.
 *
 * The CLI verbs (`maestro-cli sketch new|open|read|export`) also land here.
 * Opening a tab and drawing PNG or SVG need a window, so those go through the
 * renderer bridge (`sketch-renderer-bridge.ts`) to the window that owns the
 * agent; the window opens the tab with the same `openSketchTab()` the UI uses.
 * `read` and `export` read the SAVED scene, which the tab autosaves within a
 * second of an edit.
 *
 * Sharing (spec section 6) lives here too, so the Collaborate panel and
 * `maestro-cli sketch share|unshare|revoke-link|rotate` run the same code:
 *
 * - `share`: on the first share, create the room, generate the AES key on this
 *   desktop, upload the live scene as the first encrypted snapshot (images
 *   first, each its own blob), then mint the link. The link is the last step,
 *   so no link ever opens an empty room; a failure before it archives the new
 *   room again. Later shares mint another link only. The window that owns the
 *   agent then joins the room (`syncRoom`).
 * - `unshare` archives the room, `revoke-link` revokes one link, `rotate`
 *   resets all access: every link revoked, a new key, and a new snapshot.
 * - `uploadSnapshot` is the room client's periodic snapshot (every ~200 ops,
 *   or after 60 s idle): the window sends the live scene, main seals it.
 *
 * Every sharing verb takes `requestedBy` when an agent asked through the CLI
 * (A1): the conductor answers a desktop confirmation first, and nothing runs
 * on Deny.
 *
 * The `@bot` decisions (`maestro-cli sketch requests|approve|deny|escalate|
 * publish|discard`, spec sections 5 and 9) live here too. The bot relay's
 * requests are held in the window that owns each sketch, so `listBotRequests`
 * asks each owner's window, and `decideBotRequest` finds the request, raises
 * the A1 confirmation for an agent's approve, escalate or publish, then asks
 * that window to press the same button the Sketch tab shows. The owner token and the room key stay in main, except for the
 * connection handed to the room client in the owning window.
 */

import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import {
	isSketchExportFormat,
	isSketchReadFormat,
	sketchSceneJsonFile,
	summarizeSketchScene,
	type ExportedSketch,
	type OpenedSketch,
	type SketchExportFormat,
	type SketchReadFormat,
	type SketchReading,
} from '../../shared/sketch/commands';
import {
	encryptPayloadBlob,
	generateRoomKey,
	importRoomKey,
	type SketchRoomKey,
} from '../../shared/sketch/crypto';
import { sceneSnapshotPayloads } from '../../shared/sketch/payloads';
import { describeSketchActor } from '../../shared/sketch/attribution';
import {
	describeSketchVerdict,
	isSketchBotDecisionOp,
	sketchBotOpNeedsConfirmation,
	type SketchBotDecisionOp,
	type SketchBotRequestInfo,
} from '../../shared/sketch/bot-requests';
import { truncateAtWordBoundary } from '../../shared/formatters';
import { FILE_MAX_BYTES, isSketchFileId } from '../../shared/sketch/protocol';
import {
	DEFAULT_LINK_EXPIRY_DAYS,
	LINK_LABEL_MAX_CHARS,
	sketchShareLinkUrl,
	type SketchOwnerStatus,
} from '../../shared/sketch/server';
import {
	SKETCH_LINK_ROLES,
	SKETCH_ROLES,
	type SketchBotScreenRequest,
	type SketchLink,
	type SketchLinkRole,
	type SketchRecord,
	type SketchScene,
	type SketchScreenVerdict,
	type SketchShare,
} from '../../shared/sketch/types';
import type {
	SketchElementVersion,
	SketchRoomJoin,
	SketchSceneForSnapshot,
	SketchShareOptions,
	SketchShareResult,
} from '../../shared/sketch/commands';
import { getLiveSessions, getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import {
	confirmSketchActionOnDesktop,
	type SketchDesktopConfirmPrompt,
} from './sketch-desktop-confirm';
import { screenText, type SketchScreenTextRequest } from './sketch-guardrail';
import {
	configuredSketchServerUrl,
	getSketchOwnerAuth,
	type SketchOwnerAuth,
	type SketchOwnerRegistration,
} from './sketch-owner-auth';
import { requestSketchRenderer, type SketchRendererBridge } from './sketch-renderer-bridge';
import { createSketchRoomApi, type SketchRoomApi, type SketchRoomAuth } from './sketch-room-api';
import {
	assertSketchScene,
	getSketchStore,
	type SaveToProjectOptions,
	type SketchStore,
} from './sketch-store';

const LOG_CONTEXT = '[SketchBook][Share]';

/** The longest link expiry a request may name; the server caps it lower by plan. */
const MAX_LINK_EXPIRY_DAYS = 3650;

/** Who asked, when an agent asked through the CLI (A1). */
export interface SketchCaller {
	/** The asking agent's name, shown in the desktop confirmation. */
	requestedBy?: string;
}

/** The live agent a sketch may belong to, as the service sees it. */
export interface SketchOwnerAgent {
	id: string;
	name: string;
	/** True when the agent runs over SSH, which Sketch Book does not support (Q12). */
	sshRemote: boolean;
	/** The agent's working directory: the only place `sketch_export` may write (T10). */
	cwd: string;
}

export interface SketchServiceDeps {
	store?: () => SketchStore;
	isEnabled?: () => boolean;
	/** The live agent with this id, or `null`. */
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	/** Reaches the window that owns an agent (open a tab, draw an image). */
	renderer?: SketchRendererBridge;
	/** This device's owner sign-in (spec section 6, M1). */
	ownerAuth?: () => SketchOwnerAuth;
	/** The server configured now (`sketchBook.serverUrl`, else the hosted one). */
	serverUrl?: () => string;
	roomApi?: SketchRoomApi;
	/** The A1 desktop confirmation. Resolves true only on Allow. */
	confirm?: (prompt: SketchDesktopConfirmPrompt) => Promise<boolean>;
	newRoomKey?: () => string;
	now?: () => number;
	/** The guardrail gate (spec section 8). Default the app's `screenText()`. */
	screen?: (request: SketchScreenTextRequest) => Promise<SketchScreenVerdict>;
}

export interface SketchService {
	createSketch(input: { ownerAgentId: string; name?: string }): Promise<SketchRecord>;
	listSketches(filter?: { ownerAgentId?: string }): Promise<SketchRecord[]>;
	getSketch(sketchId: string): Promise<SketchRecord | null>;
	readScene(sketchId: string): Promise<SketchScene>;
	writeScene(sketchId: string, scene: SketchScene): Promise<void>;
	renameSketch(sketchId: string, name: string): Promise<SketchRecord>;
	deleteSketch(sketchId: string): Promise<void>;
	saveSketchToProject(
		sketchId: string,
		destDir: string,
		options?: SaveToProjectOptions
	): Promise<string>;
	/** Create a sketch and open it in a tab on its agent (`maestro-cli sketch new`). */
	newSketch(input: {
		ownerAgentId: string;
		name?: string;
		background?: boolean;
	}): Promise<OpenedSketch>;
	/** Open a sketch in a tab on the agent that owns it (`maestro-cli sketch open`). */
	openSketch(sketchId: string, options?: { background?: boolean }): Promise<OpenedSketch>;
	/** The saved scene as a summary or as its live elements (`maestro-cli sketch read`). */
	readSketch(sketchId: string, format?: SketchReadFormat): Promise<SketchReading>;
	/** The saved scene as PNG, SVG or Excalidraw JSON (`maestro-cli sketch export`). */
	exportSketch(sketchId: string, format: SketchExportFormat): Promise<ExportedSketch>;

	/** This device's owner sign-in. Never carries a token. */
	ownerStatus(): Promise<SketchOwnerStatus>;
	/** Ask for the confirmation email (`maestro-cli sketch owner register`). */
	registerOwner(email: string): Promise<SketchOwnerRegistration>;
	/** Wait for the email to be confirmed, at most `timeoutMs` (default 15 minutes). */
	waitForOwner(options?: { timeoutMs?: number }): Promise<SketchOwnerStatus>;
	signOutOwner(): Promise<SketchOwnerStatus>;

	/** Share a sketch: the room on the first share, then a new link (`sketch share`). */
	shareSketch(
		sketchId: string,
		options?: SketchShareOptions,
		caller?: SketchCaller
	): Promise<SketchShareResult>;
	/** Archive the room; the sketch stays on this desktop (`sketch unshare`). */
	unshareSketch(sketchId: string, caller?: SketchCaller): Promise<SketchRecord>;
	/** Revoke one link (`sketch revoke-link`). */
	revokeSketchLink(sketchId: string, capId: string, caller?: SketchCaller): Promise<SketchRecord>;
	/** Reset all access: links revoked, a new key, a new snapshot (`sketch rotate`). */
	rotateSketch(sketchId: string, caller?: SketchCaller): Promise<SketchRecord>;
	/** The room client's periodic snapshot of the live scene. */
	uploadSnapshot(sketchId: string, input: SketchSceneForSnapshot): Promise<{ bytes: number }>;
	/** What the room client needs to join, or null when the sketch is not shared or no one is signed in. */
	roomConnection(sketchId: string): Promise<SketchRoomJoin | null>;
	/**
	 * Screen a guest's `@bot` chat (spec section 8.2, I1) for the bot relay,
	 * on behalf of the sketch's owning agent. Only guest requests: anything
	 * else is refused, so no caller can skip the gate by naming another actor.
	 */
	screenBotRequest(sketchId: string, request: SketchBotScreenRequest): Promise<SketchScreenVerdict>;
	/** Every open `@bot` request, from the windows that own the sketches (`sketch requests`). */
	listBotRequests(): Promise<SketchBotRequestInfo[]>;
	/**
	 * Approve, deny, escalate, publish or discard one request (`sketch approve`
	 * and siblings). An agent caller's approve, escalate and publish wait on
	 * the desktop confirmation (A1). Resolves with the request as it stands after.
	 */
	decideBotRequest(
		op: SketchBotDecisionOp,
		replyTo: string,
		caller?: SketchCaller
	): Promise<SketchBotRequestInfo>;
}

/** Longest stretch of a request quoted in the A1 confirmation. */
const CONFIRM_REQUEST_MAX_CHARS = 400;

/** The A1 confirmation for an agent's `@bot` decision. */
function botDecisionPrompt(
	op: SketchBotDecisionOp,
	request: SketchBotRequestInfo,
	sketchName: string
): Omit<SketchDesktopConfirmPrompt, 'requestedBy'> {
	const quoted = JSON.stringify(
		truncateAtWordBoundary(request.text, CONFIRM_REQUEST_MAX_CHARS, '…')
	);
	const sketch = JSON.stringify(sketchName);
	switch (op) {
		case 'escalate':
			return {
				title: 'Run with full access?',
				message: `Run your message on ${sketch} again with the agent's full access?`,
				detail: `A guest has edited this board, so the message ran restricted. With full access the agent can run commands and change files while it reads what guests put on the board. The message: ${quoted}`,
			};
		case 'publish':
			return {
				title: 'Publish a held reply?',
				message: `Post the held bot reply on ${sketch} to the room?`,
				detail: `The outbound screen held this reply because it may hold a secret. Everyone in the room reads it once it is posted. It answers ${describeSketchActor(request.actor)}.`,
			};
		default:
			return {
				title: 'Run a guest request?',
				message: `Run the request from ${describeSketchActor(request.actor)} on ${sketch}?`,
				detail: `The agent runs it restricted: read-only, plus the sketch tools. ${describeSketchVerdict(request.verdict)}. The request: ${quoted}`,
			};
	}
}

/** The live agent with this id, as Sketch Book sees it, or `null`. */
export function findSketchOwnerAgent(agentId: string): SketchOwnerAgent | null {
	const session = getLiveSessions().find((candidate) => candidate.id === agentId);
	if (!session) return null;
	return {
		id: session.id,
		name: session.name,
		sshRemote: session.sessionSshRemoteConfig?.enabled === true,
		cwd: session.cwd,
	};
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`Sketch Book: ${field} must be a non-empty string.`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error(`Sketch Book: ${field} must be a string.`);
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSketchService(deps: SketchServiceDeps = {}): SketchService {
	const store = deps.store ?? getSketchStore;
	const isEnabled =
		deps.isEnabled ?? (() => isEncoreFeatureEnabled(getSettingsStore(), 'sketchBook'));
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const renderer = deps.renderer ?? requestSketchRenderer;
	const ownerAuth = deps.ownerAuth ?? getSketchOwnerAuth;
	const serverUrl = deps.serverUrl ?? configuredSketchServerUrl;
	const roomApi = deps.roomApi ?? createSketchRoomApi();
	const confirm = deps.confirm ?? confirmSketchActionOnDesktop;
	const newRoomKey = deps.newRoomKey ?? generateRoomKey;
	const now = deps.now ?? Date.now;
	const screen = deps.screen ?? screenText;
	/** The file ids each room holds under each key epoch, so a snapshot uploads only new images. */
	const uploadedFiles = new Map<string, Set<string>>();

	/** The store, once the gate has passed. */
	function open(): SketchStore {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
		return store();
	}

	async function requireSketch(sketches: SketchStore, sketchId: unknown): Promise<SketchRecord> {
		const id = requireString(sketchId, 'sketchId');
		const record = await sketches.getSketch(id);
		if (!record) throw new Error(`Sketch Book: no sketch has the id "${id}".`);
		return record;
	}

	/** Open a record's tab on its owner, which must still be a live local agent. */
	async function openRecord(record: SketchRecord, background: boolean): Promise<OpenedSketch> {
		const agent = findAgent(record.ownerAgentId);
		if (!agent) {
			throw new Error(
				`Sketch Book: the agent that owns "${record.name}" is gone, so it has no tab to open in.`
			);
		}
		if (agent.sshRemote) {
			throw new Error(
				`Sketch Book runs on local agents only. "${agent.name}" runs over SSH, so it cannot show a sketch.`
			);
		}
		const result = await renderer(agent.id, {
			action: 'open',
			sessionId: agent.id,
			sketchId: record.sketchId,
			name: record.name,
			background,
		});
		if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
		return { record, tabId: result.tabId ?? null };
	}

	/** The gate alone, for the verbs that need no store (owner sign-in). */
	function requireEnabled(): void {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
	}

	function requireShare(record: SketchRecord): SketchShare {
		if (!record.share) throw new Error(`Sketch Book: "${record.name}" is not shared.`);
		return record.share;
	}

	/**
	 * The owner's credentials for a room on `roomServer` (the configured server
	 * for a new room). A token is only ever sent to the server it came from.
	 */
	async function requireAuth(roomServer?: string): Promise<SketchRoomAuth> {
		const configured = serverUrl();
		if (roomServer && roomServer !== configured) {
			throw new Error(
				`Sketch Book: this sketch is shared on ${roomServer}, but Sketch Book now points at ${configured}. Set sketchBook.serverUrl back to reach its room.`
			);
		}
		const token = await ownerAuth().ownerToken();
		if (!token) {
			throw new Error(
				`Sketch Book: sign in to ${configured} first (the Collaborate panel, or maestro-cli sketch owner register --email <address>).`
			);
		}
		return { serverUrl: configured, ownerToken: token };
	}

	/** A1: an agent's request waits on the conductor. Throws on Deny. */
	async function confirmForAgent(
		caller: SketchCaller | undefined,
		prompt: Omit<SketchDesktopConfirmPrompt, 'requestedBy'>
	): Promise<void> {
		const requestedBy = isObject(caller)
			? optionalString(caller.requestedBy, 'requestedBy')
			: undefined;
		if (!requestedBy) return;
		if (!(await confirm({ ...prompt, requestedBy }))) {
			throw new Error('Sketch Book: the conductor chose Deny, so nothing was changed.');
		}
	}

	function normalizeShareOptions(raw: unknown): {
		role: SketchLinkRole;
		expiresInDays: number;
		label: string;
	} {
		const options: Record<string, unknown> = isObject(raw) ? raw : {};
		const role = options.role ?? 'rw';
		if (!(SKETCH_LINK_ROLES as readonly unknown[]).includes(role)) {
			throw new Error('Sketch Book: role must be "rw" or "ro".');
		}
		const linkRole = role as SketchLinkRole;
		const days = options.expiresInDays ?? DEFAULT_LINK_EXPIRY_DAYS[linkRole];
		if (
			!Number.isSafeInteger(days) ||
			(days as number) < 1 ||
			(days as number) > MAX_LINK_EXPIRY_DAYS
		) {
			throw new Error(
				`Sketch Book: the link expiry must be a whole number of days from 1 to ${MAX_LINK_EXPIRY_DAYS}.`
			);
		}
		const label = (optionalString(options.label, 'label') ?? '')
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
			.trim();
		if (Array.from(label).length > LINK_LABEL_MAX_CHARS) {
			throw new Error(`Sketch Book: a link label is at most ${LINK_LABEL_MAX_CHARS} characters.`);
		}
		return { role: linkRole, expiresInDays: days as number, label };
	}

	/** The room key of a shared sketch. */
	async function requireRoomKey(sketches: SketchStore, record: SketchRecord): Promise<string> {
		const { roomKey } = await sketches.readSketchSecrets(record.sketchId);
		if (!roomKey) {
			throw new Error(
				`Sketch Book: the room key of "${record.name}" is missing on this desktop. Stop sharing and share it again.`
			);
		}
		return roomKey;
	}

	/**
	 * The live scene (unsaved edits included) from the window that owns the
	 * agent, or the saved scene when no window answers.
	 */
	async function liveScene(
		sketches: SketchStore,
		record: SketchRecord
	): Promise<SketchSceneForSnapshot> {
		const agent = findAgent(record.ownerAgentId);
		if (agent && !agent.sshRemote) {
			const result = await renderer(agent.id, {
				action: 'snapshotScene',
				sketchId: record.sketchId,
			});
			if (result.success && result.snapshot) return result.snapshot;
			logger.warn('No window gave the live scene; the saved scene is uploaded', LOG_CONTEXT, {
				sketchId: record.sketchId,
				error: result.success ? 'no snapshot' : result.error,
			});
		}
		return { scene: await sketches.readScene(record.sketchId), baseSeq: 0 };
	}

	/**
	 * Seal and upload a scene: each image the room does not hold yet as its own
	 * `file` blob, then the `snapshot` naming them (Y2). Resolves with the
	 * snapshot body size. An image the server cannot take is left out of the
	 * snapshot, with a warning, rather than failing the whole upload.
	 */
	async function uploadScene(
		auth: SketchRoomAuth,
		share: SketchShare,
		key: SketchRoomKey,
		source: SketchSceneForSnapshot
	): Promise<number> {
		const { roomId, keyEpoch } = share;
		const { snapshot, files } = sceneSnapshotPayloads(source.scene);
		const uploadKey = `${roomId}:${keyEpoch}`;
		const held = uploadedFiles.get(uploadKey) ?? new Set<string>();
		uploadedFiles.set(uploadKey, held);
		const skipped = new Set<string>();
		for (const file of files) {
			if (held.has(file.id)) continue;
			if (!isSketchFileId(file.id)) {
				skipped.add(file.id);
				continue;
			}
			const body = await encryptPayloadBlob(key, 'file', roomId, keyEpoch, file);
			if (body.length > FILE_MAX_BYTES) {
				skipped.add(file.id);
				continue;
			}
			const stored = await roomApi.putFile(auth, roomId, file.id, body);
			if (stored === 'exists' && keyEpoch > 0) {
				// The hosted rotate keeps files from the old key; guests cannot open those.
				logger.warn(
					'The room kept an image from before a reset; guests may not see it',
					LOG_CONTEXT,
					{
						roomId,
						keyEpoch,
					}
				);
			}
			held.add(file.id);
		}
		if (skipped.size > 0) {
			logger.warn('Images the room cannot hold were left out of the snapshot', LOG_CONTEXT, {
				roomId,
				count: skipped.size,
			});
			snapshot.files = snapshot.files.filter((id) => !skipped.has(id));
		}
		const body = await encryptPayloadBlob(key, 'snapshot', roomId, keyEpoch, snapshot);
		await roomApi.putSnapshot(auth, roomId, source.baseSeq, body);
		return body.length;
	}

	/** What the room holds after `source` was uploaded. */
	function baselineOf(source: SketchSceneForSnapshot): SketchElementVersion[] {
		return source.scene.elements.map((element) => ({ id: element.id, version: element.version }));
	}

	/**
	 * Tell the window that owns the agent to join the room (or leave it, for
	 * `null`). A window that is not there joins when the sketch opens, so a
	 * failure here is logged, never thrown.
	 */
	async function syncRoom(
		record: SketchRecord,
		connection: SketchRoomJoin | null,
		baseline?: SketchElementVersion[]
	): Promise<void> {
		const agent = findAgent(record.ownerAgentId);
		if (!agent || agent.sshRemote) return;
		const result = await renderer(agent.id, {
			action: 'syncRoom',
			sketchId: record.sketchId,
			connection,
			...(baseline ? { baseline } : {}),
		});
		if (!result.success) {
			logger.warn('The window did not update the sketch room connection', LOG_CONTEXT, {
				sketchId: record.sketchId,
				join: connection !== null,
				error: result.error,
			});
		}
	}

	/** The agent a room's bot speaks for: the owner, while it is a live local agent. */
	function botFor(record: SketchRecord): SketchRoomJoin['bot'] {
		const agent = findAgent(record.ownerAgentId);
		return agent && !agent.sshRemote ? { agentId: agent.id, name: agent.name } : null;
	}

	function connectionFor(
		record: SketchRecord,
		share: SketchShare,
		auth: SketchRoomAuth,
		roomKey: string
	): SketchRoomJoin {
		return {
			sketchId: record.sketchId,
			roomId: share.roomId,
			roomKey,
			ownerToken: auth.ownerToken,
			serverUrl: auth.serverUrl,
			// The bot relay answers for the owner (spec section 5), so the room
			// client announces it; with the owner gone the bot stays offline.
			bot: botFor(record),
		};
	}

	/** Archive a room this call created and forget it locally. Best effort. */
	async function rollbackRoom(
		sketches: SketchStore,
		record: SketchRecord,
		auth: SketchRoomAuth,
		roomId: string
	): Promise<void> {
		try {
			await roomApi.deleteRoom(auth, roomId);
		} catch (error) {
			logger.warn('Could not archive a room whose share failed', LOG_CONTEXT, {
				roomId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await sketches.updateSketchShare(record.sketchId, () => null);
		await sketches.setSketchSecrets(record.sketchId, { roomKey: null });
	}

	/** First share: a room, a key, and the live scene as the first snapshot. */
	async function createRoom(
		sketches: SketchStore,
		record: SketchRecord,
		auth: SketchRoomAuth
	): Promise<{ record: SketchRecord; roomKey: string; baseline: SketchElementVersion[] }> {
		const { roomId } = await roomApi.createRoom(auth);
		try {
			const roomKey = newRoomKey();
			const key = await importRoomKey(roomKey);
			await sketches.setSketchSecrets(record.sketchId, { roomKey });
			const updated = await sketches.updateSketchShare(record.sketchId, () => ({
				roomId,
				keyEpoch: 0,
				links: [],
				botPolicy: 'conductor',
				serverUrl: auth.serverUrl,
			}));
			const source = await liveScene(sketches, updated);
			await uploadScene(auth, requireShare(updated), key, source);
			return { record: updated, roomKey, baseline: baselineOf(source) };
		} catch (error) {
			await rollbackRoom(sketches, record, auth, roomId);
			throw error;
		}
	}

	const service: SketchService = {
		async createSketch(input) {
			const sketches = open();
			const request: Record<string, unknown> = isObject(input) ? input : {};
			const ownerAgentId = requireString(request.ownerAgentId, 'ownerAgentId');
			const name = optionalString(request.name, 'name');
			const agent = findAgent(ownerAgentId);
			if (!agent) throw new Error(`Sketch Book: no agent has the id "${ownerAgentId}".`);
			if (agent.sshRemote) {
				throw new Error(
					`Sketch Book runs on local agents only. "${agent.name}" runs over SSH, so it cannot own a sketch.`
				);
			}
			return sketches.createSketch({ ownerAgentId, name });
		},

		async listSketches(filter) {
			const sketches = open();
			const ownerAgentId = optionalString(
				isObject(filter) ? filter.ownerAgentId : undefined,
				'ownerAgentId'
			);
			return sketches.listSketches(ownerAgentId ? { ownerAgentId } : undefined);
		},

		async getSketch(sketchId) {
			return open().getSketch(requireString(sketchId, 'sketchId'));
		},

		async readScene(sketchId) {
			return open().readScene(requireString(sketchId, 'sketchId'));
		},

		async writeScene(sketchId, scene) {
			// The store checks the scene's shape before anything is written.
			return open().writeScene(requireString(sketchId, 'sketchId'), scene);
		},

		async renameSketch(sketchId, name) {
			const sketches = open();
			if (typeof name !== 'string') throw new Error('Sketch Book: name must be a string.');
			return sketches.renameSketch(requireString(sketchId, 'sketchId'), name);
		},

		async deleteSketch(sketchId) {
			return open().deleteSketch(requireString(sketchId, 'sketchId'));
		},

		async saveSketchToProject(sketchId, destDir, options) {
			const sketches = open();
			const raw: Record<string, unknown> = isObject(options) ? options : {};
			const fileName = optionalString(raw.fileName, 'fileName');
			return sketches.saveSketchToProject(
				requireString(sketchId, 'sketchId'),
				requireString(destDir, 'destDir'),
				{
					...(fileName !== undefined ? { fileName } : {}),
					overwrite: raw.overwrite === true,
				}
			);
		},

		async newSketch(input) {
			const request: Record<string, unknown> = isObject(input) ? input : {};
			const record = await service.createSketch({
				ownerAgentId: request.ownerAgentId as string,
				name: request.name as string | undefined,
			});
			try {
				return await openRecord(record, request.background === true);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Sketch "${record.name}" (${record.sketchId}) was created, but its tab did not open. ${reason}`
				);
			}
		},

		async openSketch(sketchId, options) {
			const record = await requireSketch(open(), sketchId);
			return openRecord(record, isObject(options) && options.background === true);
		},

		async readSketch(sketchId, format = 'summary') {
			const sketches = open();
			if (!isSketchReadFormat(format)) {
				throw new Error('Sketch Book: format must be "summary" or "elements".');
			}
			const record = await requireSketch(sketches, sketchId);
			const scene = await sketches.readScene(record.sketchId);
			if (format === 'elements') {
				return {
					record,
					format,
					elements: scene.elements.filter((element) => element.isDeleted !== true),
				};
			}
			return { record, format, summary: summarizeSketchScene(scene) };
		},

		async exportSketch(sketchId, format) {
			const sketches = open();
			if (!isSketchExportFormat(format)) {
				throw new Error('Sketch Book: format must be "png", "svg" or "json".');
			}
			const record = await requireSketch(sketches, sketchId);
			const scene = await sketches.readScene(record.sketchId);
			if (format === 'json') {
				// The `.excalidraw` file as saved.
				return { record, file: sketchSceneJsonFile(scene) };
			}
			// Any window can draw it; prefer the one that owns the agent.
			const owner = findAgent(record.ownerAgentId);
			const result = await renderer(owner?.id ?? null, { action: 'export', format, scene });
			if (!result.success) throw new Error(`Sketch Book: ${result.error}`);
			if (!result.file || result.file.format !== format) {
				throw new Error(`Sketch Book: the Maestro window did not return a ${format} file.`);
			}
			return { record, file: result.file };
		},

		async ownerStatus() {
			requireEnabled();
			return ownerAuth().status();
		},

		async registerOwner(email) {
			requireEnabled();
			return ownerAuth().register(requireString(email, 'email'));
		},

		async waitForOwner(options) {
			requireEnabled();
			const timeoutMs = isObject(options) ? options.timeoutMs : undefined;
			if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !(timeoutMs > 0))) {
				throw new Error('Sketch Book: timeoutMs must be a positive number.');
			}
			return ownerAuth().pollStatus(timeoutMs !== undefined ? { timeoutMs } : {});
		},

		async signOutOwner() {
			requireEnabled();
			await ownerAuth().signOut();
			return ownerAuth().status();
		},

		async shareSketch(sketchId, options, caller) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const link = normalizeShareOptions(options);
			await confirmForAgent(caller, {
				title: 'Share a sketch?',
				message: `Share "${record.name}" on RunMaestro.ai?`,
				detail: `This mints a link that lets anyone who has it ${link.role === 'rw' ? 'view and edit' : 'view'} the sketch for ${link.expiresInDays} day${link.expiresInDays === 1 ? '' : 's'}. ${record.share ? 'The sketch is already shared; this adds one more link.' : 'The sketch is uploaded, end-to-end encrypted, to a new room.'} The agent receives the link.`,
			});
			const auth = await requireAuth(record.share?.serverUrl);

			let current = record;
			let roomKey: string;
			let baseline: SketchElementVersion[] | undefined;
			const createdRoom = record.share === null;
			if (createdRoom) {
				({ record: current, roomKey, baseline } = await createRoom(sketches, record, auth));
			} else {
				roomKey = await requireRoomKey(sketches, record);
			}
			const share = requireShare(current);

			let minted;
			try {
				minted = await roomApi.createLink(auth, share.roomId, {
					role: link.role,
					expiresInDays: link.expiresInDays,
					...(link.label ? { label: link.label } : {}),
				});
			} catch (error) {
				if (createdRoom) await rollbackRoom(sketches, current, auth, share.roomId);
				throw error;
			}
			const stored: SketchLink = {
				capId: minted.capId,
				role: link.role,
				label: link.label,
				createdAt: now(),
				expiresAt: minted.expiresAt,
				revoked: false,
			};
			current = await sketches.updateSketchShare(record.sketchId, (prev) =>
				prev ? { ...prev, links: [...prev.links, stored] } : prev
			);
			if (createdRoom) {
				await syncRoom(current, connectionFor(current, share, auth, roomKey), baseline);
			}
			logger.info('Sketch shared', LOG_CONTEXT, {
				sketchId: record.sketchId,
				roomId: share.roomId,
				createdRoom,
				role: link.role,
				byAgent: Boolean(caller?.requestedBy),
			});
			return {
				record: current,
				createdRoom,
				link: {
					capId: minted.capId,
					role: link.role,
					label: link.label,
					expiresAt: minted.expiresAt,
					url: sketchShareLinkUrl(auth.serverUrl, share.roomId, roomKey, minted.cap),
				},
			};
		},

		async unshareSketch(sketchId, caller) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const share = requireShare(record);
			await confirmForAgent(caller, {
				title: 'Stop sharing a sketch?',
				message: `Stop sharing "${record.name}"?`,
				detail:
					'The room is deleted on RunMaestro.ai: every guest is disconnected, every link stops working, and the room chat is gone. The sketch stays on this computer.',
			});
			const auth = await requireAuth(share.serverUrl);
			await syncRoom(record, null);
			await roomApi.deleteRoom(auth, share.roomId);
			const updated = await sketches.updateSketchShare(record.sketchId, () => null);
			await sketches.setSketchSecrets(record.sketchId, { roomKey: null });
			for (const key of [...uploadedFiles.keys()]) {
				if (key.startsWith(`${share.roomId}:`)) uploadedFiles.delete(key);
			}
			logger.info('Sketch unshared', LOG_CONTEXT, {
				sketchId: record.sketchId,
				roomId: share.roomId,
			});
			return updated;
		},

		async revokeSketchLink(sketchId, capId, caller) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const share = requireShare(record);
			const id = requireString(capId, 'capId');
			const link = share.links.find((candidate) => candidate.capId === id);
			if (!link) throw new Error(`Sketch Book: "${record.name}" has no link "${id}".`);
			await confirmForAgent(caller, {
				title: 'Revoke a sketch link?',
				message: `Revoke the ${link.role === 'rw' ? 'edit' : 'view'} link${link.label ? ` "${link.label}"` : ''} to "${record.name}"?`,
				detail:
					'Guests on this link are disconnected and the link stops working. Other links keep working.',
			});
			const auth = await requireAuth(share.serverUrl);
			await roomApi.revokeLink(auth, share.roomId, id);
			return sketches.updateSketchShare(record.sketchId, (prev) =>
				prev
					? {
							...prev,
							links: prev.links.map((candidate) =>
								candidate.capId === id ? { ...candidate, revoked: true } : candidate
							),
						}
					: prev
			);
		},

		async rotateSketch(sketchId, caller) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const share = requireShare(record);
			await confirmForAgent(caller, {
				title: 'Reset all access to a sketch?',
				message: `Reset all access to "${record.name}"?`,
				detail:
					'Every link stops working and every guest is disconnected. The room history and chat are cleared, and the sketch is uploaded again under a new key. Share again to invite anyone back.',
			});
			const auth = await requireAuth(share.serverUrl);
			// Leave first: nothing may go out under the old key once the server rotates.
			await syncRoom(record, null);
			const { keyEpoch } = await roomApi.rotate(auth, share.roomId);
			const roomKey = newRoomKey();
			const key = await importRoomKey(roomKey);
			await sketches.setSketchSecrets(record.sketchId, { roomKey });
			const updated = await sketches.updateSketchShare(record.sketchId, (prev) =>
				prev
					? {
							...prev,
							keyEpoch,
							links: prev.links.map((candidate) => ({ ...candidate, revoked: true })),
						}
					: prev
			);
			const rotated = requireShare(updated);
			let uploadError: unknown = null;
			let baseline: SketchElementVersion[] | undefined;
			try {
				const source = await liveScene(sketches, updated);
				await uploadScene(auth, rotated, key, source);
				baseline = baselineOf(source);
			} catch (error) {
				uploadError = error;
			}
			await syncRoom(updated, connectionFor(updated, rotated, auth, roomKey), baseline);
			logger.info('Sketch access reset', LOG_CONTEXT, {
				sketchId: record.sketchId,
				roomId: share.roomId,
				keyEpoch,
				snapshot: uploadError === null,
			});
			if (uploadError !== null) {
				const reason = uploadError instanceof Error ? uploadError.message : String(uploadError);
				throw new Error(
					`Sketch Book: access was reset, but the new snapshot did not upload (${reason}). It uploads again after the next edits.`
				);
			}
			return updated;
		},

		async uploadSnapshot(sketchId, input) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const share = requireShare(record);
			const raw: Record<string, unknown> = isObject(input) ? input : {};
			const { baseSeq, scene } = raw;
			if (!Number.isSafeInteger(baseSeq) || (baseSeq as number) < 0) {
				throw new Error('Sketch Book: baseSeq must be a whole number of at least 0.');
			}
			assertSketchScene(scene);
			const auth = await requireAuth(share.serverUrl);
			const key = await importRoomKey(await requireRoomKey(sketches, record));
			const bytes = await uploadScene(auth, share, key, {
				scene: scene as SketchScene,
				baseSeq: baseSeq as number,
			});
			return { bytes };
		},

		async roomConnection(sketchId) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const share = record.share;
			if (!share) return null;
			const token = await ownerAuth().ownerToken();
			if (!token || (share.serverUrl && share.serverUrl !== serverUrl())) return null;
			const roomKey = await requireRoomKey(sketches, record);
			return connectionFor(record, share, { serverUrl: serverUrl(), ownerToken: token }, roomKey);
		},

		async screenBotRequest(sketchId, request) {
			const sketches = open();
			const record = await requireSketch(sketches, sketchId);
			const raw: Record<string, unknown> = isObject(request) ? request : {};
			const replyTo = requireString(raw.replyTo, 'replyTo');
			if (!Number.isSafeInteger(raw.ts) || (raw.ts as number) < 0) {
				throw new Error('Sketch Book: ts must be a whole number of at least 0.');
			}
			if (typeof raw.text !== 'string') throw new Error('Sketch Book: text must be a string.');
			const actor: Record<string, unknown> = isObject(raw.actor) ? raw.actor : {};
			if (actor.kind !== 'guest') {
				throw new Error('Sketch Book: only a guest request goes through the bot screen.');
			}
			if (!(SKETCH_ROLES as readonly unknown[]).includes(actor.role)) {
				throw new Error('Sketch Book: actor.role is not a room role.');
			}
			return screen({
				sketchId: record.sketchId,
				agentId: record.ownerAgentId,
				subject: { kind: 'chat', replyTo, ts: raw.ts as number },
				actor: {
					id: requireString(actor.id, 'actor.id'),
					kind: 'guest',
					name: optionalString(actor.name, 'actor.name') ?? '',
					role: actor.role as SketchBotScreenRequest['actor']['role'],
					...(typeof actor.capId === 'string' ? { capId: actor.capId } : {}),
					...(typeof actor.capLabel === 'string' ? { capLabel: actor.capLabel } : {}),
				},
				text: raw.text,
			});
		},

		async listBotRequests() {
			const sketches = open();
			const records = await sketches.listSketches();
			const byOwner = new Map<string, string[]>();
			for (const record of records) {
				const agent = findAgent(record.ownerAgentId);
				if (!agent || agent.sshRemote) continue;
				byOwner.set(agent.id, [...(byOwner.get(agent.id) ?? []), record.sketchId]);
			}
			const requests: SketchBotRequestInfo[] = [];
			for (const [agentId, sketchIds] of byOwner) {
				const result = await renderer(agentId, { action: 'botRequest', op: 'list', sketchIds });
				if (!result.success) {
					// A window that is closed holds no requests: they went with its room client.
					logger.warn('A window did not list its Sketch Book requests', LOG_CONTEXT, {
						agentId,
						error: result.error,
					});
					continue;
				}
				requests.push(...(result.botRequests ?? []));
			}
			return requests.sort((a, b) => a.ts - b.ts);
		},

		async decideBotRequest(op, replyTo, caller) {
			if (!isSketchBotDecisionOp(op)) {
				throw new Error('Sketch Book: op must be approve, deny, escalate, publish or discard.');
			}
			const id = requireString(replyTo, 'replyTo');
			const sketches = open();
			const request = (await service.listBotRequests()).find(
				(candidate) => candidate.replyTo === id
			);
			if (!request) {
				throw new Error(
					`Sketch Book: no open @bot request has the id "${id}". List them with maestro-cli sketch requests.`
				);
			}
			const record = await requireSketch(sketches, request.sketchId);
			if (sketchBotOpNeedsConfirmation(op)) {
				await confirmForAgent(caller, botDecisionPrompt(op, request, record.name));
			}
			const result = await renderer(record.ownerAgentId, {
				action: 'botRequest',
				op,
				sketchId: record.sketchId,
				replyTo: id,
			});
			if (!result.success) throw new Error(result.error);
			const after = result.botRequests?.[0];
			if (!after) throw new Error('Sketch Book: the window did not report the request.');
			logger.info('Sketch Book @bot decision', LOG_CONTEXT, {
				sketchId: record.sketchId,
				op,
				byAgent: Boolean(caller?.requestedBy),
			});
			return after;
		},
	};
	return service;
}

let defaultService: SketchService | null = null;

/** The app's service, over the app's store and settings. */
export function getSketchService(): SketchService {
	defaultService ??= createSketchService();
	return defaultService;
}
