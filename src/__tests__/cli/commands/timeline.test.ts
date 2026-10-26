/**
 * @file timeline.test.ts
 * @description Tests for `maestro-cli timeline`: sources, filters, the text and
 * `--json` output, and the Computer History gate. History and journey files are
 * real JSONL in a temp data directory, so the shared readers run for real; the
 * agent list and the Encore gate are mocked, and no agent is a git repository
 * (its cwd does not exist), so git contributes nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../../shared/types';
import type { TimelineEvent } from '../../../shared/timeline';

const mockReadLiveSessions = vi.fn<() => SessionInfo[]>();
const encore = { computerHistory: false };

vi.mock('../../../cli/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../cli/services/storage')>();
	return { ...actual, readLiveSessions: () => mockReadLiveSessions() };
});

vi.mock('../../../cli/utils/encore-gate', () => ({
	isEncoreEnabled: vi.fn((flag: 'computerHistory') => encore[flag]),
	requireEncore: vi.fn((flag: 'computerHistory') => {
		if (!encore[flag]) throw new Error('ENCORE_OFF');
	}),
}));

import { timeline } from '../../../cli/commands/timeline';
import { requireEncore } from '../../../cli/utils/encore-gate';

const NOW = Date.now();
const MIN = 60 * 1000;

const alpha = { id: 'agent-alpha', name: 'Alpha', cwd: '/nonexistent/alpha' } as SessionInfo;
const beta = { id: 'agent-beta', name: 'Beta', cwd: '/nonexistent/beta' } as SessionInfo;

let dataDir: string;
let priorDataDir: string | undefined;
let log: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

function writeJsonl(file: string, rows: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

function output(): string {
	return log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function jsonOutput(): {
	success: boolean;
	events?: (TimelineEvent & { time: string; agentName?: string })[];
	notes?: string[];
	error?: string;
} {
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-cli-'));
	priorDataDir = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
	encore.computerHistory = false;
	mockReadLiveSessions.mockReturnValue([alpha, beta]);
	writeJsonl(path.join(dataDir, 'history', `${alpha.id}.jsonl`), [
		{
			id: 'h-old',
			type: 'USER',
			timestamp: NOW - 3 * 24 * 60 * MIN,
			summary: 'ancient',
			projectPath: alpha.cwd,
		},
		{
			id: 'h-alpha',
			type: 'USER',
			timestamp: NOW - 30 * MIN,
			summary: 'fixed auth',
			projectPath: alpha.cwd,
		},
	]);
	writeJsonl(path.join(dataDir, 'history', `${beta.id}.jsonl`), [
		{
			id: 'h-beta',
			type: 'AUTO',
			timestamp: NOW - 20 * MIN,
			summary: 'ran docs',
			projectPath: beta.cwd,
		},
	]);
	writeJsonl(path.join(dataDir, 'journey', `${alpha.id}.jsonl`), [
		{ ts: NOW - 10 * MIN, agentId: alpha.id, kind: 'file.save', target: `${alpha.cwd}/src/a.ts` },
	]);
	log = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	mockReadLiveSessions.mockReset();
	if (priorDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = priorDataDir;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('timeline --json', () => {
	it('merges every agent oldest first inside the default day, with names and ISO times', async () => {
		await timeline({ json: true });
		const result = jsonOutput();
		expect(result.success).toBe(true);
		expect(result.events?.map((e) => [e.source, e.agentName, e.text])).toEqual([
			['history', 'Alpha', 'USER: fixed auth'],
			['history', 'Beta', 'AUTO: ran docs'],
			['journey', 'Alpha', 'user saved src/a.ts'],
		]);
		expect(result.events?.[0]).toMatchObject({
			ref: 'h-alpha',
			time: new Date(NOW - 30 * MIN).toISOString(),
		});
		expect(result.notes).toEqual([]);
	});
});

describe('timeline filters', () => {
	it('--agent narrows to one agent by name', async () => {
		await timeline({ agent: 'Beta', json: true });
		expect(jsonOutput().events?.map((e) => e.ref)).toEqual(['h-beta']);
	});

	it('--since takes a duration and widens the window', async () => {
		await timeline({ agent: alpha.id, since: '15m', json: true });
		expect(jsonOutput().events?.map((e) => e.source)).toEqual(['journey']);

		log.mockClear();
		await timeline({ agent: alpha.id, since: '1w', json: true });
		expect(jsonOutput().events?.map((e) => e.ref)).toEqual(['h-old', 'h-alpha', undefined]);
	});

	it('--until, --sources, --grep, and --tail narrow the list', async () => {
		await timeline({ until: '25m', json: true });
		expect(jsonOutput().events?.map((e) => e.ref)).toEqual(['h-alpha']);

		log.mockClear();
		await timeline({ sources: 'journey', json: true });
		expect(jsonOutput().events?.map((e) => e.source)).toEqual(['journey']);

		log.mockClear();
		await timeline({ grep: 'AUTH', json: true });
		expect(jsonOutput().events?.map((e) => e.ref)).toEqual(['h-alpha']);

		log.mockClear();
		await timeline({ tail: '1', json: true });
		expect(jsonOutput().events?.map((e) => e.source)).toEqual(['journey']);
	});

	it('rejects an unknown source, naming only the sources this machine has', async () => {
		await timeline({ sources: 'history,transcripts', json: true });
		const result = jsonOutput();
		expect(result.success).toBe(false);
		expect(result.error).toContain('transcripts');
		expect(result.error).toContain('history, journey, git');
		expect(result.error).not.toContain('computer');
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('rejects a malformed --since or --tail', async () => {
		await timeline({ since: 'yesterday-ish', json: true });
		expect(jsonOutput().error).toContain('Invalid --since');

		log.mockClear();
		await timeline({ tail: '5abc' });
		expect(String(errorLog.mock.calls[0]?.[0])).toContain('Invalid --tail');
		expect(exit).toHaveBeenCalledTimes(2);
	});
});

describe('timeline Computer History', () => {
	it('refuses the computer source while the feature is off', async () => {
		await timeline({ sources: 'computer', json: true });
		expect(requireEncore).toHaveBeenCalledWith('computerHistory', true);
		expect(jsonOutput().success).toBe(false);
	});

	it('reads the computer source while the feature is on (an empty store reads as nothing)', async () => {
		encore.computerHistory = true;
		await timeline({ sources: 'computer,history', agent: alpha.id, json: true });
		const result = jsonOutput();
		expect(result.success).toBe(true);
		expect(result.events?.map((e) => e.source)).toEqual(['history']);
	});
});

describe('timeline text output', () => {
	it('prints one line per event with handles, and no agent names for one agent', async () => {
		await timeline({ agent: alpha.id });
		const text = output();
		expect(text).toMatch(/history USER: fixed auth \[entry h-alpha\]$/m);
		expect(text).toMatch(/journey user saved src\/a\.ts$/m);
		expect(text).not.toContain('Alpha:');
	});

	it('names the agent on each line when the timeline spans agents', async () => {
		await timeline({});
		expect(output()).toMatch(/history Beta: AUTO: ran docs/);
	});

	it('notes that git was skipped for an SSH agent', async () => {
		mockReadLiveSessions.mockReturnValue([
			{ ...alpha, sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } } as SessionInfo,
		]);
		await timeline({ agent: alpha.id, json: true });
		expect(jsonOutput().notes).toEqual(['git: skipped, the agent works on an SSH remote']);
	});

	it('says so when nothing matches', async () => {
		await timeline({ grep: 'no-such-thing' });
		expect(output()).toBe('No timeline events.');
	});
});
