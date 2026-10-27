/**
 * Sketch Book Collaborate panel (spec sections 6, 8.8 and 9, hosted spec §8): what
 * the conductor sees of a shared sketch's room and does to it.
 *
 * One implementation for the Collaborate panel in the Sketch tab and
 * `maestro-cli sketch stats|kick|unlock|unsuspend|audit`:
 *
 * - `stats` reads the room's newest `room.stats` from the window that runs
 *   the room client (`roomAdmin` hop), which asks the server first.
 * - `act` sends Kick, Unlock or Unsuspend through that room client. From an
 *   agent caller, Unlock and Unsuspend wait on the desktop confirmation (A1);
 *   Kick runs.
 * - `audit` reads the sketch's audit log (spec section 8.8) from disk: every
 *   gate decision (never the text) and the elements whose newest decision is
 *   `flagged`, which the panel offers to delete.
 *
 * Revoke link and Reset all access are the Collaborate panel's own verbs
 * (`SketchService.revokeSketchLink` / `rotateSketch`); the Collaborate panel calls
 * those, so a link is revoked by one code path wherever it is clicked.
 */

import * as fs from 'fs/promises';
import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import {
	describeRoomStatsActor,
	flaggedSketchElements,
	isSketchRoomActionOp,
	parseSketchAuditLog,
	sketchKickMinutesProblem,
	sketchRoomAdminNeedsConfirmation,
	SKETCH_KICK_DEFAULT_MINUTES,
	type SketchRoomAction,
	type SketchRoomActionOp,
	type SketchRoomAudit,
	type SketchRoomStatsReading,
} from '../../shared/sketch/room-admin';
import type { SketchRecord } from '../../shared/sketch/types';
import { getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import {
	confirmSketchActionOnDesktop,
	type SketchDesktopConfirmPrompt,
} from './sketch-desktop-confirm';
import { sketchAuditPath } from './sketch-guardrail';
import { requestSketchRenderer, type SketchRendererBridge } from './sketch-renderer-bridge';
import { findSketchOwnerAgent, type SketchCaller, type SketchOwnerAgent } from './sketch-service';
import { getSketchStore, type SketchStore } from './sketch-store';

const LOG_CONTEXT = '[SketchBook][Room]';

export interface SketchRoomAdminDeps {
	store?: () => SketchStore;
	isEnabled?: () => boolean;
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	renderer?: SketchRendererBridge;
	/** The A1 desktop confirmation. Resolves true only on Allow. */
	confirm?: (prompt: SketchDesktopConfirmPrompt) => Promise<boolean>;
	/** Where a sketch's audit log lives, or null. */
	auditPath?: (sketchId: string) => Promise<string | null>;
	/** The audit file's text, or null when there is none yet. */
	readAudit?: (filePath: string) => Promise<string | null>;
}

/** One Collaborate panel action as IPC and the WS bridge hand it over. */
export interface SketchRoomActionInput {
	actorId?: unknown;
	capId?: unknown;
	minutes?: unknown;
}

export interface SketchRoomAdminService {
	/** The room's newest `room.stats`, asked of the server first. */
	stats(sketchId: string): Promise<SketchRoomStatsReading>;
	/**
	 * Kick, Unlock or Unsuspend. An agent caller's Unlock and Unsuspend wait on
	 * the conductor (A1). Resolves with the room as it stands after.
	 */
	act(
		sketchId: string,
		op: SketchRoomActionOp,
		input: SketchRoomActionInput,
		caller?: SketchCaller
	): Promise<SketchRoomStatsReading>;
	/** The sketch's audit log: every decision, and the elements whose newest one is `flagged`. */
	audit(sketchId: string): Promise<SketchRoomAudit>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`Sketch Book: ${field} must be a non-empty string.`);
	}
	return value;
}

async function readAuditFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		// No decision was made yet, so the gate never wrote the file.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/** The action an op and its input name. Throws on a missing id or a bad kick length. */
function actionOf(op: SketchRoomActionOp, input: SketchRoomActionInput): SketchRoomAction {
	if (op === 'unsuspend') return { op, capId: requireString(input.capId, 'capId') };
	const actorId = requireString(input.actorId, 'actorId');
	if (op === 'unlock') return { op, actorId };
	const problem = sketchKickMinutesProblem(input.minutes);
	if (problem) throw new Error(`Sketch Book: ${problem}`);
	return input.minutes === undefined
		? { op, actorId }
		: { op, actorId, minutes: input.minutes as number };
}

export function createSketchRoomAdminService(
	deps: SketchRoomAdminDeps = {}
): SketchRoomAdminService {
	const store = deps.store ?? getSketchStore;
	const isEnabled =
		deps.isEnabled ?? (() => isEncoreFeatureEnabled(getSettingsStore(), 'sketchBook'));
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const renderer = deps.renderer ?? requestSketchRenderer;
	const confirm = deps.confirm ?? confirmSketchActionOnDesktop;
	const auditPath = deps.auditPath ?? sketchAuditPath;
	const readAudit = deps.readAudit ?? readAuditFile;

	function open(): SketchStore {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
		return store();
	}

	async function requireSketch(sketchId: unknown): Promise<SketchRecord> {
		const id = requireString(sketchId, 'sketchId');
		const record = await open().getSketch(id);
		if (!record) throw new Error(`Sketch Book: no sketch has the id "${id}".`);
		return record;
	}

	/** A shared sketch's owner, while it is a live local agent: the window that runs the room. */
	function requireRoomOwner(record: SketchRecord): SketchOwnerAgent {
		if (!record.share) throw new Error(`Sketch Book: "${record.name}" is not shared.`);
		const agent = findAgent(record.ownerAgentId);
		if (!agent) throw new Error(`Sketch Book: the agent that owns "${record.name}" is gone.`);
		if (agent.sshRemote) {
			throw new Error(`Sketch Book runs on local agents only. "${agent.name}" runs over SSH.`);
		}
		return agent;
	}

	async function hop(
		record: SketchRecord,
		request: { op: 'stats' } | SketchRoomAction
	): Promise<SketchRoomStatsReading> {
		const agent = requireRoomOwner(record);
		const result = await renderer(agent.id, {
			action: 'roomAdmin',
			sketchId: record.sketchId,
			...request,
		});
		if (!result.success) throw new Error(result.error);
		if (!result.roomStats) throw new Error('Sketch Book: the window did not report the room.');
		return result.roomStats;
	}

	/** The A1 prompt for an agent's Unlock or Unsuspend, naming who or which link it frees. */
	function confirmPrompt(
		action: SketchRoomAction,
		record: SketchRecord,
		before: SketchRoomStatsReading
	): Omit<SketchDesktopConfirmPrompt, 'requestedBy'> {
		const sketch = JSON.stringify(record.name);
		if (action.op === 'unsuspend') {
			const cap = before.stats?.caps.find((candidate) => candidate.capId === action.capId);
			const link = cap?.label ? `the link ${JSON.stringify(cap.label)}` : `link ${action.capId}`;
			return {
				title: 'Unsuspend a sketch link?',
				message: `Let guests on ${link} ask the agent on ${sketch} again?`,
				detail:
					'The server suspended @bot for this link after the screen rejected its requests 5 times. Guests on it can send the agent requests again; each still waits for your approval.',
			};
		}
		const actor = before.stats?.actors.find((candidate) => candidate.actorId === action.actorId);
		const who = actor ? describeRoomStatsActor(actor) : `guest ${action.actorId}`;
		return {
			title: 'Unlock a guest?',
			message: `Let ${who} ask the agent on ${sketch} again?`,
			detail:
				'The server locked this guest out after 3 rejected requests in a row. Unlocking clears that streak; each new request still waits for your approval.',
		};
	}

	return {
		async stats(sketchId) {
			return hop(await requireSketch(sketchId), { op: 'stats' });
		},

		async act(sketchId, op, input, caller) {
			if (!isSketchRoomActionOp(op)) {
				throw new Error('Sketch Book: op must be kick, unlock or unsuspend.');
			}
			const record = await requireSketch(sketchId);
			const action = actionOf(op, input ?? {});
			const requestedBy =
				typeof caller?.requestedBy === 'string' && caller.requestedBy
					? caller.requestedBy
					: undefined;
			if (requestedBy && sketchRoomAdminNeedsConfirmation(op)) {
				const before = await hop(record, { op: 'stats' });
				const allowed = await confirm({ ...confirmPrompt(action, record, before), requestedBy });
				if (!allowed) {
					throw new Error('Sketch Book: the conductor chose Deny, so nothing was changed.');
				}
			}
			const after = await hop(record, action);
			logger.info('Sketch Book room action', LOG_CONTEXT, {
				sketchId: record.sketchId,
				op,
				...(action.op === 'kick' ? { minutes: action.minutes ?? SKETCH_KICK_DEFAULT_MINUTES } : {}),
				byAgent: Boolean(requestedBy),
			});
			return after;
		},

		async audit(sketchId) {
			const record = await requireSketch(sketchId);
			const filePath = await auditPath(record.sketchId);
			const text = filePath ? await readAudit(filePath) : null;
			const entries = text ? parseSketchAuditLog(text) : [];
			return { sketchId: record.sketchId, entries, flagged: flaggedSketchElements(entries) };
		},
	};
}

let defaultService: SketchRoomAdminService | null = null;

/** The app's Collaborate panel service. */
export function getSketchRoomAdmin(): SketchRoomAdminService {
	defaultService ??= createSketchRoomAdminService();
	return defaultService;
}
