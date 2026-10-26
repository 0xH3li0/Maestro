/**
 * The desktop's reader of an agent's timeline (`src/shared/timeline.ts`): the
 * shared `readTimeline()` over this app's data directory, with git run through
 * `execGitReadOnly()` (timeout, no optional locks) on local agents only.
 *
 * Feeds `{{RECENT_TIMELINE}}` in `buildMaestroSystemPromptForSession()` and
 * the `timeline:read` IPC the renderer's prompt builders call, so every spawn
 * path reads the same snapshot `maestro-cli timeline` prints.
 */

import * as path from 'path';
import { app } from 'electron';
import {
	readTimeline,
	type TimelineAgent,
	type TimelineGitRunner,
} from '../shared/maestro-lib/store/read-timeline';
import type { SelectTimelineOptions, TimelineEvent, TimelineSource } from '../shared/timeline';
import { execGitReadOnly } from './utils/remote-git';

/** Git gets this long before the commits are left out of the timeline. */
const GIT_TIMEOUT_MS = 5_000;

const runGit: TimelineGitRunner = async (cwd, args) => {
	const result = await execGitReadOnly(args, cwd, null, undefined, GIT_TIMEOUT_MS);
	return result.exitCode === 0 ? result.stdout : null;
};

export interface AgentTimelineOptions extends SelectTimelineOptions {
	sinceMs: number;
	sources: readonly TimelineSource[];
	/** Read Computer History (the caller checked the Encore Feature). */
	computerHistory?: boolean;
	now?: number;
}

/**
 * The timeline input for a stored agent: git only for a local repository, since
 * an SSH agent's working directory is on the remote.
 */
export function timelineAgentFor(agent: {
	id: string;
	cwd: string;
	isGitRepo?: boolean;
	isSsh: boolean;
}): TimelineAgent {
	return {
		id: agent.id,
		cwd: agent.cwd,
		gitCwd: !agent.isSsh && agent.isGitRepo && agent.cwd ? agent.cwd : undefined,
	};
}

/** One agent's timeline, oldest first. Never throws; an unreadable source reads as no events. */
export async function readAgentTimeline(
	agent: TimelineAgent,
	options: AgentTimelineOptions
): Promise<TimelineEvent[]> {
	try {
		const userDataDir = app.getPath('userData');
		const { events } = await readTimeline({
			...options,
			paths: { userDataDir, historyDir: path.join(userDataDir, 'history') },
			agents: [agent],
			runGit,
		});
		return events;
	} catch {
		return [];
	}
}
