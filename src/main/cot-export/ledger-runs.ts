/**
 * Chain of thought export: turns the command line ran outside the app.
 *
 * `maestro-cli send`, a playbook run from the command line, and a goal run all
 * start the agent inside the command line's own process. Nothing of such a
 * turn passes through the app, so the process listener never sees it, and
 * without this module the log would simply not mention it.
 *
 * The command line does leave one trace of its own accord, for every person
 * and whether or not anything is recorded: a line in the run ledger
 * (`src/cli/services/agent-run-capture.ts`), which says which agent ran, with
 * what prompt, when, and how it ended. This module is handed that ledger and
 * writes one turn for each such run, with `origin: 'cli'`:
 *
 *   turn-start    the prompt, the agent's directory, the provider, the run's id
 *   capture-gap   `output-not-captured:outside-app`
 *   turn-end      the exit code, how long it ran, how it ended
 *
 * The command line is not changed to make this work, and is told nothing. It
 * holds no word of this feature, so a run of it gives an agent no sign. This
 * module does not read the ledger itself either: whoever watches the ledger
 * hands it over (`recordPending`), so nothing here reaches into the command
 * line's code.
 *
 * WHAT SUCH A TURN IS WORTH
 * It is a report, not an observation. The ledger is a file the command line
 * wrote, and the command line can be run by the agent itself. A turn of this
 * origin shows that the ledger says a run took place. It does not prove what
 * the run did, and a run that never reached the ledger is not here at all.
 * The output is never in it: the gap says so on every such turn, so that an
 * empty turn is not read as an agent that said nothing.
 *
 * WHICH RUNS
 * - reported by the command line (`source` starts with `cli:`), and not a
 *   synopsis, which is Maestro's own prompt and is left out everywhere
 * - finished, for an agent that is recorded now and that Maestro still has
 * - started after export was last turned on for that agent, so that turning
 *   it on never picks up a run that was already going
 * - not recorded before
 *
 * ONE RUN, ONE FILE
 * "Recorded before" is answered by the run's own id, never by a time. The
 * turn id of a run is derived from its id in the ledger, so a run always maps
 * to the same turn file, and a run whose file is already there (in the
 * agent's current folder, or in one it used before) is not written again.
 * That holds through a crash right after the write and through a restart,
 * with nothing to save in between. A mark kept by time would lose a run: two
 * runs of the command line can reach the ledger in the other order than they
 * ended in, and the one that ended first would then lie behind the mark.
 *
 * A file that is there is taken as the whole turn. If the app stopped while
 * the turn was being written, the file stays as it is: a turn with no
 * `turn-end`, which is what the format says a turn cut short looks like.
 *
 * A run that finished while the app was closed is recorded at the next start,
 * as long as the ledger still holds it. The ledger keeps a bounded number of
 * finished runs, so a very long absence can lose some.
 *
 * Nothing here throws into its caller. A failure goes to `onError`.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import { isTerminalAgentRunStatus } from '../../shared/agent-run';
import type { AgentRun } from '../../shared/agent-run';
import { sha256Hex } from './hash-chain';
import { turnFilePath } from './layout';
import { recordCompletedRun } from './turn-assembler';
import type { CotCueRecorderDeps } from './turn-assembler';

/** How the command line names itself in a run's `source`. */
const CLI_SOURCE_PREFIX = 'cli:';

/** The end of a `source` that names a synopsis turn: Maestro's own prompt. */
const SYNOPSIS_SOURCE_SUFFIX = '-synopsis';

/** Everything the recorder needs from outside. It reads no store itself. */
export interface CotLedgerRecorderDeps extends Pick<CotCueRecorderDeps, 'writer' | 'onError'> {
	/** The agents whose turns are recorded right now. */
	listEnabledAgents: () => string[];
	/**
	 * The folders that hold the agent's log: the one it writes to now first,
	 * then the ones it used before. Empty when no folder is chosen.
	 */
	getFolders: (agentId: string) => string[];
	/** The provider the agent runs, or null for an agent Maestro no longer has. */
	getToolType: (agentId: string) => string | null;
	/** When export was last turned on for the agent, or null when it never was. */
	getSince: (agentId: string) => number | null;
}

export interface CotLedgerRecorder {
	/**
	 * Writes a turn for every run that is due. `readRuns` gives the ledger. It
	 * is called only when some agent is recorded, so with export off for
	 * everyone the ledger is not even read. One call runs at a time, and a
	 * call made meanwhile waits its turn. It never rejects.
	 */
	recordPending(readRuns: () => AgentRun[]): Promise<void>;
}

/** Whether the command line reported the run, as a turn someone asked for. */
function isCliTurn(run: AgentRun): boolean {
	const source = run.source ?? '';
	return source.startsWith(CLI_SOURCE_PREFIX) && !source.endsWith(SYNOPSIS_SOURCE_SUFFIX);
}

/** A number the ledger holds under `key`, or undefined. The ledger is a file anyone can write. */
function metadataNumber(run: AgentRun, key: string): number | undefined {
	const value = run.metadata?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** How long the run took, as the command line measured it. */
function durationOf(run: AgentRun): number {
	const measured = metadataNumber(run, 'durationMs');
	return measured !== undefined && measured >= 0
		? measured
		: Math.max(0, run.updatedAt - run.createdAt);
}

/** The outcome string of a turn for the status a run ended with. */
function outcomeOf(run: AgentRun): string | undefined {
	switch (run.status) {
		case 'completed':
			return 'completed';
		case 'cancelled':
			return 'interrupted';
		case 'failed':
			return 'crashed';
		default:
			return undefined;
	}
}

/**
 * The turn id of a run: the same for the same run, every time. It is what
 * makes a run land in one file and no other.
 */
export function cliTurnId(runId: string): string {
	return sha256Hex(`cli-run\n${runId}`).slice(0, 32);
}

/** Whether a file is there. A file that cannot be reached is taken as not there. */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function createCotLedgerRecorder(deps: CotLedgerRecorderDeps): CotLedgerRecorder {
	/**
	 * The runs known to be in the log, by agent, so that a run costs one look
	 * at the disk and not one at every change of the ledger. It is only a
	 * memory of what the disk says, and it is rebuilt from the disk after a
	 * restart.
	 */
	const recorded = new Map<string, Set<string>>();

	function report(agentId: string | null, error: unknown): void {
		try {
			deps.onError(agentId, error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Nowhere left to send it.
		}
	}

	async function recordFor(agentId: string, runs: AgentRun[]): Promise<void> {
		const since = deps.getSince(agentId);
		const folders = deps.getFolders(agentId);
		const toolType = deps.getToolType(agentId);
		if (since === null || folders.length === 0 || !toolType) return;
		const [folder] = folders;

		const candidates = runs.filter(
			(run) =>
				run.agentId === agentId &&
				isCliTurn(run) &&
				isTerminalAgentRunStatus(run.status) &&
				run.createdAt >= since
		);
		// A run the ledger no longer holds can never come up again, so it need
		// not be remembered. This keeps the memory as small as the ledger.
		const known = new Set(
			[...(recorded.get(agentId) ?? [])].filter((id) => candidates.some((run) => run.id === id))
		);
		recorded.set(agentId, known);

		const due = candidates
			.filter((run) => !known.has(run.id))
			// By when they started, so that the files and the chain read in order.
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

		for (const run of due) {
			const turnId = cliTurnId(run.id);
			const startedAt = new Date(run.createdAt);
			let onDisk = false;
			for (const candidate of folders) {
				if (await fileExists(turnFilePath(candidate, startedAt, undefined, turnId))) {
					onDisk = true;
					break;
				}
			}
			if (!onDisk) {
				await recordCompletedRun(
					{ agentId, folder },
					{
						origin: 'cli',
						cliRunId: run.id,
						turnId,
						toolType,
						cwd: run.cwd ?? '',
						prompt: run.prompt,
						rawStdout: null,
						startTime: run.createdAt,
						durationMs: durationOf(run),
						exitCode: metadataNumber(run, 'exitCode') ?? null,
						outcome: outcomeOf(run),
					},
					deps
				);
			}
			// Remembered whether or not every record landed: a record that was lost
			// is counted by the writer and shows as a gap. Taking the run again at
			// the next change of the ledger would write it twice.
			known.add(run.id);
		}
	}

	async function recordNow(readRuns: () => AgentRun[]): Promise<void> {
		try {
			const enabled = deps.listEnabledAgents();
			// Nobody is recorded: the ledger is not even read.
			if (enabled.length === 0) return;
			const runs = readRuns();
			for (const agentId of enabled) {
				try {
					await recordFor(agentId, runs);
				} catch (error) {
					report(agentId, error);
				}
			}
		} catch (error) {
			report(null, error);
		}
	}

	let tail: Promise<void> = Promise.resolve();

	return {
		recordPending(readRuns) {
			tail = tail.then(() => recordNow(readRuns));
			return tail;
		},
	};
}
