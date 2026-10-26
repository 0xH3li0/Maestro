/**
 * The desktop's timeline reader: the shared `readTimeline()` over the app's
 * data directory, with git run through `execGitReadOnly()` on local agents only.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => userData) },
}));

const execGitReadOnly = vi.fn();
vi.mock('../../main/utils/remote-git', () => ({
	execGitReadOnly: (...args: unknown[]) => execGitReadOnly(...args),
}));

import { readAgentTimeline, timelineAgentFor } from '../../main/agent-timeline';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60_000;

describe('timelineAgentFor', () => {
	it('reads git only in a local repository', () => {
		expect(timelineAgentFor({ id: 'a', cwd: '/p', isGitRepo: true, isSsh: false })).toEqual({
			id: 'a',
			cwd: '/p',
			gitCwd: '/p',
		});
		expect(timelineAgentFor({ id: 'a', cwd: '/p', isGitRepo: true, isSsh: true }).gitCwd).toBe(
			undefined
		);
		expect(timelineAgentFor({ id: 'a', cwd: '/p', isGitRepo: false, isSsh: false }).gitCwd).toBe(
			undefined
		);
	});
});

describe('readAgentTimeline', () => {
	beforeEach(() => {
		userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-timeline-'));
		fs.mkdirSync(path.join(userData, 'history'));
		fs.writeFileSync(
			path.join(userData, 'history', 'agent-1.jsonl'),
			`${JSON.stringify({ id: 'h-1', type: 'USER', timestamp: NOW - 10 * MIN, summary: 'did it', projectPath: '/p' })}\n`
		);
		execGitReadOnly.mockResolvedValue({
			exitCode: 0,
			stdout: `abc1234\x1f${Math.floor((NOW - 5 * MIN) / 1000)}\x1fAda\x1fship\n`,
			stderr: '',
		});
	});

	afterEach(() => {
		fs.rmSync(userData, { recursive: true, force: true });
	});

	it('reads history from the data directory and commits through execGitReadOnly', async () => {
		const events = await readAgentTimeline(
			{ id: 'agent-1', cwd: '/p', gitCwd: '/p' },
			{ sinceMs: NOW - 60 * MIN, sources: ['history', 'git'], now: NOW }
		);
		expect(events.map((e) => [e.source, e.text])).toEqual([
			['history', 'USER: did it'],
			['git', 'commit by Ada: ship'],
		]);
		expect(execGitReadOnly).toHaveBeenCalledWith(
			expect.arrayContaining(['log']),
			'/p',
			null,
			undefined,
			expect.any(Number)
		);
	});

	it('reads a failed git as no commits', async () => {
		execGitReadOnly.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a repo' });
		const events = await readAgentTimeline(
			{ id: 'agent-1', cwd: '/p', gitCwd: '/p' },
			{ sinceMs: NOW - 60 * MIN, sources: ['git'], now: NOW }
		);
		expect(events).toEqual([]);
	});
});
