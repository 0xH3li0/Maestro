/**
 * Chain of thought export: the turn assembler.
 *
 * It turns the life of one agent process into one turn of the log. Three
 * things happen to a process, and each is one call here:
 *
 *   it starts   -> `handleSpawn`        writes `turn-start`
 *   it prints   -> `handleParsedEvent`  writes what the line adds
 *   it ends     -> `handleExit`         writes `turn-end`
 *
 * One process is one turn: every message to an agent starts a process of its
 * own, and the process ends when the turn does.
 *
 * WHAT IS DECIDED WHEN THE PROCESS STARTS
 * Whether the turn is recorded, and into which folder, is decided once, in
 * `handleSpawn`, before the function returns. Nothing later changes it. Turning
 * export on does not pick up a turn that is already running, turning it off
 * does not cut one short, and a new folder applies from the next turn. A turn
 * that is not recorded costs one lookup when it starts and nothing after.
 *
 * WHY EVENTS CAN WAIT
 * Which agent a process belongs to is known at once for most processes, and
 * after one file read for a group chat participant. Until it is known for
 * certain the turn is `pending`: `turn-start` is not written yet, and the
 * events of the process are held, in order, and written the moment the answer
 * arrives. If the answer is "not an agent turn" they are dropped.
 *
 * A TURN THAT NEVER REPORTS ITS END
 * Two things leave a turn open with no exit to close it:
 * - The process could not be started. `handleSpawn` is told so by
 *   `isProcessRunning`, and closes the turn at once with no exit code.
 * - A process was stopped and a new one took its id before the old one was
 *   reported gone. The new `handleSpawn` closes the old turn, with no exit
 *   code, before it opens its own.
 * Either way every `turn-start` gets its `turn-end`, which the writer relies
 * on to let go of the file.
 *
 * WHAT A TURN FILE CANNOT HOLD
 * - The prompt of a turn on an SSH remote. That prompt travels inside the SSH
 *   command, not in the field this module reads, so `turn-start.prompt` is
 *   empty and a `capture-gap` right after it says why.
 * - Text that was still being joined when the app stopped. Pieces of one
 *   block are held until the block ends or 8 KB is reached (see
 *   `COALESCE_FLUSH_BYTES`), and what is held is in memory only.
 * - Anything the process printed while Maestro was not running. A process
 *   that was already going when Maestro started has no turn here, and its
 *   events are ignored.
 *
 * This module never throws into its caller. A failure goes to `onError`.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import { randomUUID } from 'crypto';
import { getAgentCapabilities } from '../agents/capabilities';
import {
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
	hasEmbeddedSystemPrompt,
	stripEmbeddedSystemPrompt,
} from '../../shared/embeddedSystemPrompt';
import type { ToolType } from '../../shared/types';
import type {
	CotRecordPayload,
	CotTextPayload,
	CotThinkingPayload,
	CotTurnOrigin,
	CotTurnStartPayload,
} from '../../shared/cotExport/types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import type { ProcessConfig } from '../process-manager/types';
import { sha256Hex } from './hash-chain';
import { turnFilePath } from './layout';
import { createTurnNormalizeState, normalizeParsedEvent } from './normalize';
import type { CotBlock, TurnNormalizeState } from './normalize';
import type { CotTarget } from './resolve-agent';
import type { CotWriter } from './writer';

// ============================================================================
// Contract
// ============================================================================

/**
 * What the assembler reads of a spawn. It is a slice of the config the process
 * was started with, and it is only read: nothing here is passed on to the
 * process or changed.
 */
export type CotSpawnConfig = Pick<
	ProcessConfig,
	| 'sessionId'
	| 'toolType'
	| 'cwd'
	| 'prompt'
	| 'images'
	| 'querySource'
	| 'projectPath'
	| 'sshRemoteId'
	| 'sshStdinScript'
	| 'sshRemoteCommand'
	| 'agentSessionId'
>;

/** Everything the assembler needs from outside. It reads no store and no clock itself. */
export interface CotTurnAssemblerDeps {
	/**
	 * The agent a process would be recorded under, from memory alone, or null
	 * when the process is not an agent turn (`peekCotAgentId`). It is asked
	 * while the process starts, so it must not wait on anything.
	 */
	peekAgentId: (processSessionId: string) => string | null;
	/** The full answer, which may need a read (`resolveCotTarget`). */
	resolveTarget: (processSessionId: string) => Promise<CotTarget | null>;
	/** Whether the agent's turns are recorded right now. */
	isEnabled: (agentId: string) => boolean;
	/** The folder the agent's log goes to, or null when none is chosen. */
	getFolder: (agentId: string) => string | null;
	/**
	 * Whether a process with this id is running, asked right after it was
	 * started. A start that failed leaves none, and no exit will ever be
	 * reported for it.
	 */
	isProcessRunning: (processSessionId: string) => boolean;
	writer: Pick<CotWriter, 'append'>;
	/**
	 * A turn could not be recorded, in whole or in part. `agentId` is null when
	 * the failure came before the agent was known.
	 */
	onError: (agentId: string | null, error: Error) => void;
	/**
	 * Called with true when the first turn starts being followed and with false
	 * when the last one ends. The listener uses it to hear parsed events only
	 * while there is a turn to write them to.
	 */
	onFollowingChange?: (following: boolean) => void;
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	now?: () => number;
	/** A new turn id. Defaults to a random UUID. */
	newTurnId?: () => string;
}

export interface CotTurnAssembler {
	/** A process was started. Decides, now, whether its turn is recorded. */
	handleSpawn(config: CotSpawnConfig): void;
	/** A process printed one parsed line. Ignored for a process with no turn. */
	handleParsedEvent(processSessionId: string, event: ParsedEvent): void;
	/**
	 * A process ended. `outcome` is how Maestro judged the end, when it did.
	 * Ignored for a process with no turn.
	 */
	handleExit(processSessionId: string, exitCode: number | null, outcome?: string): void;
	/**
	 * Resolves when everything handed over so far is on disk or reported lost.
	 * For a caller that reads the files back: a test, or a check of the chain.
	 */
	whenIdle(): Promise<void>;
}

// ============================================================================
// One turn
// ============================================================================

/**
 * How much joined text is held before it is written. Providers that stream
 * send a block a few words at a time, and one record for each piece would
 * make a log nobody can read. Past this size the held text is written and the
 * block goes on as a further piece.
 */
const COALESCE_FLUSH_BYTES = 8 * 1024;

/** Reason of the gap written when the prompt never reached this module. */
const PROMPT_NOT_CAPTURED_REASON = 'prompt-not-captured';

type ProseBlock = CotThinkingPayload | CotTextPayload;

function isProse(block: CotBlock): block is ProseBlock {
	return block.kind === 'thinking' || block.kind === 'text';
}

/**
 * True when `next` is a further piece of the block `held` belongs to: the same
 * kind, message, place in the message, and subagent. A block with no place
 * cannot be told from the block before it, so it is never joined.
 */
function isSameBlock(held: ProseBlock, next: ProseBlock): boolean {
	return (
		held.blockIndex !== undefined &&
		held.kind === next.kind &&
		held.blockIndex === next.blockIndex &&
		held.providerMessageId === next.providerMessageId &&
		held.parentToolCallId === next.parentToolCallId
	);
}

/** Pieces of one block that are being joined, and when the first one came. */
interface HeldProse {
	block: ProseBlock;
	pieces: string[];
	bytes: number;
	ts: string;
}

/** A turn whose `turn-start` is written. */
interface TurnRecorder {
	/** Writes what one parsed event adds to the turn. `at` is when it arrived. */
	add(event: ParsedEvent, at: number): void;
	/** Writes what is still held, then `turn-end`. Call it once. `at` is when the turn ended. */
	end(exitCode: number | null, outcome: string | undefined, at: number): void;
}

interface TurnInput {
	agentId: string;
	/** The provider that runs the turn. It picks the normalizer's rules. */
	toolType: string;
	filePath: string;
	turnId: string;
	startedAt: number;
	start: CotTurnStartPayload;
	/** Reasons `start` is known to be incomplete. One `capture-gap` each. */
	startGaps: string[];
}

/**
 * Opens a turn: writes `turn-start` and returns what the rest of the turn is
 * written through. `write` hands one record to the writer and must not throw.
 */
function openTurn(
	turn: TurnInput,
	write: (payload: CotRecordPayload, ts: string) => void
): TurnRecorder {
	const normalize: TurnNormalizeState = createTurnNormalizeState();
	// What `turn-end.recordCount` reports: every record of the turn but a
	// `capture-gap`, which is Maestro's note about the log and not part of it.
	let recordCount = 0;
	let held: HeldProse | null = null;

	const record = (payload: CotRecordPayload, ts: string): void => {
		if (payload.kind !== 'capture-gap') recordCount += 1;
		write(payload, ts);
	};

	const flush = (): void => {
		if (!held) return;
		const { block, pieces, ts } = held;
		held = null;
		record({ ...block, text: pieces.join('') }, ts);
	};

	const addBlock = (block: CotBlock, ts: string): void => {
		if (!isProse(block)) {
			flush();
			record(block, ts);
			return;
		}
		if (held && isSameBlock(held.block, block)) {
			held.pieces.push(block.text);
			held.bytes += Buffer.byteLength(block.text, 'utf8');
		} else {
			flush();
			// The record keeps the time its first piece arrived, so the times in
			// a file never run backwards.
			held = {
				block,
				pieces: [block.text],
				bytes: Buffer.byteLength(block.text, 'utf8'),
				ts,
			};
		}
		if (held.bytes >= COALESCE_FLUSH_BYTES) flush();
	};

	const startTs = new Date(turn.startedAt).toISOString();
	record(turn.start, startTs);
	for (const reason of turn.startGaps) record({ kind: 'capture-gap', reason }, startTs);

	return {
		add(event, at) {
			const blocks = normalizeParsedEvent(turn.toolType, event, normalize);
			if (blocks.length === 0) return;
			const ts = new Date(at).toISOString();
			for (const block of blocks) addBlock(block, ts);
		},
		end(exitCode, outcome, at) {
			flush();
			record(
				{
					kind: 'turn-end',
					exitCode,
					durationMs: Math.max(0, at - turn.startedAt),
					// Counts this record too.
					recordCount: recordCount + 1,
					...(outcome ? { outcome } : {}),
				},
				new Date(at).toISOString()
			);
		},
	};
}

// ============================================================================
// The start of a turn
// ============================================================================

/**
 * The prompt as the person or Maestro wrote it, with the system prompt a
 * provider had to be given inside the first message taken out and hashed.
 *
 * The system prompt is looked for only where the spawn path puts one: a
 * provider with no flag for it, on the turn that opens a provider
 * conversation. Everywhere else the marker can only be the writer's own text,
 * and cutting there would remove part of the prompt from the record.
 */
function splitSystemPrompt(config: CotSpawnConfig): {
	prompt: string;
	systemPromptSha256?: string;
} {
	const prompt = config.prompt ?? '';
	const mayCarrySystemPrompt =
		!config.agentSessionId && !getAgentCapabilities(config.toolType).supportsAppendSystemPrompt;
	if (!mayCarrySystemPrompt || !hasEmbeddedSystemPrompt(prompt)) return { prompt };

	const ownPrompt = stripEmbeddedSystemPrompt(prompt);
	const systemPrompt = prompt.slice(
		0,
		prompt.length - ownPrompt.length - EMBEDDED_SYSTEM_PROMPT_SEPARATOR.length
	);
	return { prompt: ownPrompt, systemPromptSha256: sha256Hex(systemPrompt) };
}

/** True when the config shows the turn runs on another machine over SSH. */
function runsOverSsh(config: CotSpawnConfig): boolean {
	return Boolean(config.sshRemoteId || config.sshStdinScript || config.sshRemoteCommand);
}

/**
 * `turn-start` for a process, and the reasons it is known to be incomplete.
 *
 * The working directory of an SSH turn is the path on the remote host. The
 * local process of such a turn is the SSH client, started in the home folder,
 * and the spawn site keeps the agent's own directory in `projectPath`.
 */
function buildTurnStart(
	config: CotSpawnConfig,
	target: CotTarget
): { start: CotTurnStartPayload; startGaps: string[] } {
	const ssh = runsOverSsh(config);
	const { prompt, systemPromptSha256 } = splitSystemPrompt(config);
	const origin: CotTurnOrigin = target.origin;
	const start: CotTurnStartPayload = {
		kind: 'turn-start',
		// The id resolved to an agent Maestro has, so this is a provider it knows.
		toolType: config.toolType as ToolType,
		origin,
		...(target.tabId ? { tabId: target.tabId } : {}),
		...(config.agentSessionId ? { providerSessionId: config.agentSessionId } : {}),
		cwd: ssh && config.projectPath ? config.projectPath : config.cwd,
		...(config.sshRemoteId ? { sshRemoteId: config.sshRemoteId } : {}),
		...(config.querySource ? { querySource: config.querySource } : {}),
		prompt,
		...(systemPromptSha256 ? { systemPromptSha256 } : {}),
		imageCount: config.images?.length ?? 0,
	};
	const startGaps =
		typeof config.prompt === 'string'
			? []
			: [ssh ? `${PROMPT_NOT_CAPTURED_REASON}:ssh-remote` : PROMPT_NOT_CAPTURED_REASON];
	return { start, startGaps };
}

// ============================================================================
// Assembler
// ============================================================================

/** What is waiting for a pending turn, in the order it arrived. */
type HeldStep = (recorder: TurnRecorder) => void;

/** One process the assembler follows. */
interface ProcessSlot {
	agentId: string;
	/** Set once `turn-start` is written. Until then the turn is pending. */
	recorder: TurnRecorder | null;
	/** Events and the exit that arrived while the turn was pending. */
	heldSteps: HeldStep[];
	/** The turn's end was handled, or was put in line behind a pending start. */
	ended: boolean;
}

export function createCotTurnAssembler(deps: CotTurnAssemblerDeps): CotTurnAssembler {
	const now = deps.now ?? Date.now;
	const newTurnId = deps.newTurnId ?? randomUUID;

	/** The turn each process id is writing to. A process with no turn is absent. */
	const slots = new Map<string, ProcessSlot>();
	/** Slots that are not finished, counting a pending one a new process replaced. */
	let following = 0;
	/** Work that has not settled yet, for `whenIdle`. */
	const inFlight = new Set<Promise<unknown>>();

	function report(agentId: string | null, error: unknown): void {
		try {
			deps.onError(agentId, error instanceof Error ? error : new Error(String(error)));
		} catch {
			// `onError` is the last place a failure can go, and nothing here may
			// throw into the process events that drive this module.
		}
	}

	/**
	 * Remembers `work` until it settles. Nothing handed in here is meant to
	 * reject, and one that does is let go the same way, so that it cannot
	 * become an unhandled rejection.
	 */
	function track(work: Promise<unknown>): void {
		inFlight.add(work);
		const done = (): void => {
			inFlight.delete(work);
		};
		void work.then(done, done);
	}

	function setFollowing(delta: 1 | -1): void {
		const was = following > 0;
		following += delta;
		const is = following > 0;
		if (was === is) return;
		try {
			deps.onFollowingChange?.(is);
		} catch (error) {
			report(null, error);
		}
	}

	/** The slot is done: nothing more will be written through it. */
	function release(processSessionId: string, slot: ProcessSlot): void {
		// A newer process may hold the id by now. Only this slot's entry goes.
		if (slots.get(processSessionId) === slot) slots.delete(processSessionId);
		setFollowing(-1);
	}

	/** Runs `step` on the slot's turn now, or holds it until the turn is open. */
	function run(slot: ProcessSlot, step: HeldStep): void {
		if (!slot.recorder) {
			slot.heldSteps.push(step);
			return;
		}
		try {
			step(slot.recorder);
		} catch (error) {
			report(slot.agentId, error);
		}
	}

	/** Puts the end of the slot's turn in line, once. `at` is when the turn ended. */
	function end(
		processSessionId: string,
		slot: ProcessSlot,
		exitCode: number | null,
		outcome: string | undefined,
		at: number
	): void {
		if (slot.ended) return;
		slot.ended = true;
		run(slot, (recorder) => {
			try {
				recorder.end(exitCode, outcome, at);
			} finally {
				release(processSessionId, slot);
			}
		});
	}

	/**
	 * Lets go of a turn that was never opened, with everything held for it. The
	 * end that may be among the held steps is what would have released the
	 * slot, so the release happens here in its place.
	 */
	function drop(processSessionId: string, slot: ProcessSlot): void {
		slot.heldSteps = [];
		slot.ended = true;
		release(processSessionId, slot);
	}

	/**
	 * The second half of a start: confirms the agent, writes `turn-start`, and
	 * then everything that arrived in the meantime.
	 */
	async function open(
		config: CotSpawnConfig,
		slot: ProcessSlot,
		folder: string,
		startedAt: number
	): Promise<void> {
		const { agentId } = slot;
		try {
			const target = await deps.resolveTarget(config.sessionId);
			// The answer given while the process started was a candidate. If the
			// full answer is another agent, or none, the turn belongs to no chain
			// this module may write to.
			if (!target || target.agentId !== agentId) {
				drop(config.sessionId, slot);
				return;
			}

			const turnId = newTurnId();
			const filePath = turnFilePath(folder, new Date(startedAt), target.tabId, turnId);
			const { start, startGaps } = buildTurnStart(config, target);
			// `append` never rejects and reports its own failures. The guard is for
			// a throw before the writer takes the record, so that one bad record
			// cannot leave a `turn-start` without its `turn-end`.
			const write = (payload: CotRecordPayload, ts: string): void => {
				try {
					track(deps.writer.append(agentId, filePath, { turnId, ts, ...payload }));
				} catch (error) {
					report(agentId, error);
				}
			};
			slot.recorder = openTurn(
				{ agentId, toolType: config.toolType, filePath, turnId, startedAt, start, startGaps },
				write
			);

			// Nothing can be added to the held steps from here on: with a recorder
			// set, `run` calls a step at once.
			const steps = slot.heldSteps;
			slot.heldSteps = [];
			for (const step of steps) run(slot, step);
		} catch (error) {
			report(agentId, error);
			// Only a turn that never opened can end up here: once the recorder is
			// set, every step is guarded where it runs.
			if (!slot.recorder) drop(config.sessionId, slot);
		}
	}

	return {
		handleSpawn(config) {
			const processSessionId = config.sessionId;
			const startedAt = now();

			// A turn is still open under this id: its process was replaced before
			// it was reported gone, so no exit will come for it. Close it first.
			const previous = slots.get(processSessionId);
			if (previous) {
				slots.delete(processSessionId);
				end(processSessionId, previous, null, undefined, startedAt);
			}

			let agentId: string | null = null;
			let folder: string | null;
			try {
				agentId = deps.peekAgentId(processSessionId);
				if (agentId === null || !deps.isEnabled(agentId)) return;
				folder = deps.getFolder(agentId);
			} catch (error) {
				report(agentId, error);
				return;
			}
			if (!folder) return;

			const slot: ProcessSlot = { agentId, recorder: null, heldSteps: [], ended: false };
			slots.set(processSessionId, slot);
			setFollowing(1);

			// A start that failed leaves no process, and so no exit. The turn is
			// still recorded: it was asked for, and it ran nothing.
			let running = true;
			try {
				running = deps.isProcessRunning(processSessionId);
			} catch (error) {
				report(agentId, error);
			}
			if (!running) {
				slots.delete(processSessionId);
				end(processSessionId, slot, null, undefined, startedAt);
			}

			track(open(config, slot, folder, startedAt));
		},

		handleParsedEvent(processSessionId, event) {
			const slot = slots.get(processSessionId);
			if (!slot || slot.ended) return;
			const at = now();
			run(slot, (recorder) => recorder.add(event, at));
		},

		handleExit(processSessionId, exitCode, outcome) {
			const slot = slots.get(processSessionId);
			if (!slot) return;
			end(processSessionId, slot, exitCode, outcome, now());
		},

		async whenIdle() {
			while (inFlight.size > 0) {
				await Promise.allSettled([...inFlight]);
			}
		},
	};
}
