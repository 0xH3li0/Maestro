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
 * what prompt, when, and how it ended. This module reads that ledger and
 * writes one turn for each such run, with `origin: 'cli'`:
 *
 *   turn-start    the prompt, the agent's directory, the provider
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
 * - not recorded before. The store keeps a mark per agent (`CotLedgerCursor`):
 *   when the newest recorded run ended, and which runs ended at that moment.
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

import { isTerminalAgentRunStatus } from '../../shared/agent-run';
import type { AgentRun } from '../../shared/agent-run';
import type { CotLedgerCursor } from './config-store';
import { recordCompletedRun } from './turn-assembler';
import type { CotCueRecorderDeps } from './turn-assembler';

/** How the command line names itself in a run's `source`. */
const CLI_SOURCE_PREFIX = 'cli:';

/** The end of a `source` that names a synopsis turn: Maestro's own prompt. */
const SYNOPSIS_SOURCE_SUFFIX = '-synopsis';

/** Everything the recorder needs from outside. It reads no store and no file itself. */
export interface CotLedgerRecorderDeps extends Pick<
	CotCueRecorderDeps,
	'writer' | 'onError' | 'newTurnId'
> {
	/** The agents whose turns are recorded right now. */
	listEnabledAgents: () => string[];
	/** The folder the agent's log goes to, or null when none is chosen. */
	getFolder: (agentId: string) => string | null;
	/** The provider the agent runs, or null for an agent Maestro no longer has. */
	getToolType: (agentId: string) => string | null;
	/** How far the log has followed the agent's runs, or null when it never began. */
	getCursor: (agentId: string) => CotLedgerCursor | null;
	setCursor: (agentId: string, cursor: Pick<CotLedgerCursor, 'at' | 'ids'>) => void;
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

/**
 * When the run ended. Counted from its start, not read from `updatedAt`: a
 * later write to the ledger can move `updatedAt`, and the mark must not move
 * with it, or the run would be taken twice.
 */
function endedAt(run: AgentRun): number {
	return run.createdAt + durationOf(run);
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

/** Whether the mark says this run was not recorded yet. */
function isPastCursor(run: AgentRun, cursor: Pick<CotLedgerCursor, 'at' | 'ids'>): boolean {
	const end = endedAt(run);
	return end > cursor.at || (end === cursor.at && !cursor.ids.includes(run.id));
}

export function createCotLedgerRecorder(deps: CotLedgerRecorderDeps): CotLedgerRecorder {
	function report(agentId: string | null, error: unknown): void {
		try {
			deps.onError(agentId, error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Nowhere left to send it.
		}
	}

	async function recordFor(agentId: string, runs: AgentRun[]): Promise<void> {
		const cursor = deps.getCursor(agentId);
		const folder = deps.getFolder(agentId);
		const toolType = deps.getToolType(agentId);
		if (!cursor || !folder || !toolType) return;

		const due = runs
			.filter(
				(run) =>
					run.agentId === agentId &&
					isCliTurn(run) &&
					isTerminalAgentRunStatus(run.status) &&
					run.createdAt >= cursor.since &&
					isPastCursor(run, cursor)
			)
			.sort((a, b) => endedAt(a) - endedAt(b) || a.id.localeCompare(b.id));

		let mark: Pick<CotLedgerCursor, 'at' | 'ids'> = { at: cursor.at, ids: cursor.ids };
		for (const run of due) {
			await recordCompletedRun(
				{ agentId, folder },
				{
					origin: 'cli',
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
			// The mark moves whether or not every record landed: a record that was
			// lost is counted by the writer and shows as a gap. Taking the run
			// again at the next change of the ledger would write it twice.
			const end = endedAt(run);
			mark = end === mark.at ? { at: end, ids: [...mark.ids, run.id] } : { at: end, ids: [run.id] };
			deps.setCursor(agentId, mark);
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
