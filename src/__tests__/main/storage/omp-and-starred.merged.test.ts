// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/storage/omp-session-storage.test.ts
//   - src/__tests__/main/storage/starred-transcript-mirror.test.ts

import { OmpSessionStorage } from '../../../main/storage/omp-session-storage';
import {
	flushTranscriptMirrorsSync,
	listMirroredStarredSessions,
	releaseSnoozedTranscriptMirror,
	releaseTranscriptMirror,
	restoreStarredTranscript,
	setMirrorRootForTest,
	snapshotStarredTranscript,
} from '../../../main/storage/starred-transcript-mirror';
import {
	selectOlderEntries,
	transcriptMessagesToLogEntries,
} from '../../../renderer/utils/transcriptMessages';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import type { SshRemoteConfig } from '../../../shared/types';
import * as realFs from 'fs';
import { promises as fs } from 'fs';
import * as fsp from 'fs/promises';
import os from 'os';
import * as os_1 from 'os';
import path from 'path';
import * as path_1 from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('electron', () => ({
	app: { getPath: vi.fn().mockReturnValue('/should-be-overridden') },
}));

vi.mock('../../../main/agents/session-storage', () => ({
	getSessionStorage: vi.fn(() => ({
		agentId: 'claude-code',
		getSessionPath: getSessionPathMock,
	})),
}));

// ===== from src/__tests__/main/storage/omp-session-storage.test.ts =====

/**
 * These tests exercise OmpSessionStorage against REAL temp transcript files
 * (os.homedir spied to a temp root) so they are deterministic and never touch a
 * developer's `~/.omp`. The on-disk shape mirrors omp's actual JSONL layout:
 * `~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<id>.jsonl`.
 */
describe('OmpSessionStorage', () => {
	let tmpHome: string;
	let projectPath: string;
	let storage: OmpSessionStorage;

	const sshConfig: SshRemoteConfig = {
		enabled: true,
		remoteId: 'remote-1',
	} as SshRemoteConfig;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-store-'));
		vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
		projectPath = path.join(tmpHome, 'code', 'proj'); // slug -> "-code-proj"
		storage = new OmpSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	async function writeTranscript(
		slug: string,
		filename: string,
		events: Record<string, unknown>[]
	): Promise<void> {
		const dir = path.join(tmpHome, '.omp', 'agent', 'sessions', slug);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, filename),
			events.map((e) => JSON.stringify(e)).join('\n') + '\n'
		);
	}

	function fullTranscript(cwd: string, sessionId: string): Record<string, unknown>[] {
		return [
			{ type: 'title', title: 'Fix the parser bug' },
			{ type: 'session', id: sessionId, cwd, timestamp: '2026-07-14T06:38:15.818Z' },
			{ type: 'model_change', model: 'anthropic/claude-opus-4-8' },
			{
				type: 'message',
				id: 'm0',
				timestamp: '2026-07-14T06:38:16.000Z',
				message: {
					role: 'user',
					content: [{ type: 'text', text: '# Maestro System Context\n\nYou are ...' }],
				},
			},
			{
				type: 'message',
				id: 'm1',
				timestamp: '2026-07-14T06:39:00.000Z',
				message: { role: 'user', content: [{ type: 'text', text: 'Please fix the parser' }] },
			},
			{
				type: 'message',
				id: 'm2',
				timestamp: '2026-07-14T06:40:00.000Z',
				message: {
					role: 'assistant',
					model: 'anthropic/claude-opus-4-8',
					content: [
						{ type: 'thinking', thinking: 'internal reasoning' },
						{ type: 'text', text: 'Done, fixed it.' },
					],
					usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02 },
				},
			},
			{ type: 'message', id: 'm3', message: { role: 'toolResult', content: 'tool output' } },
		];
	}

	it('lists a session for the matching project with metadata, usage, and title', async () => {
		await writeTranscript(
			'-code-proj',
			'2026-07-14T06-38-15_sess-1.jsonl',
			fullTranscript(projectPath, 'sess-1')
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		const s = sessions[0];
		expect(s.sessionId).toBe('sess-1');
		expect(s.sessionName).toBe('Fix the parser bug');
		// System-context turn is skipped for the preview; real request wins.
		expect(s.firstMessage).toBe('Please fix the parser');
		// user (system) + user + assistant = 3; toolResult excluded.
		expect(s.messageCount).toBe(3);
		expect(s.inputTokens).toBe(100);
		expect(s.outputTokens).toBe(50);
		expect(s.cacheReadTokens).toBe(10);
		expect(s.cacheCreationTokens).toBe(5);
		expect(s.costUsd).toBeCloseTo(0.02);
		expect(s.byModel && s.byModel.length).toBeGreaterThan(0);
	});

	it('excludes sessions whose transcript cwd does not match the project', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));
		await writeTranscript(
			'-code-proj',
			'b_sess-2.jsonl',
			fullTranscript('/somewhere/else', 'sess-2')
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((s) => s.sessionId)).toEqual(['sess-1']);
	});

	it('finds the matching session even when another dir holds unrelated transcripts', async () => {
		// A non-matching transcript sits in the dir that a slug guess would target;
		// the real match lives elsewhere. Always-scan + authoritative cwd filter
		// must still surface it (no fast-path short-circuit hides sessions).
		await writeTranscript(
			'-code-proj',
			'stale_sess-0.jsonl',
			fullTranscript('/other/project', 'sess-0')
		);
		await writeTranscript('legacy-slug', 'x_sess-9.jsonl', fullTranscript(projectPath, 'sess-9'));

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((s) => s.sessionId)).toEqual(['sess-9']);
	});

	it('reads user + assistant messages, extracts text, and skips thinking/toolResult', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));

		const result = await storage.readSessionMessages(projectPath, 'sess-1');

		expect(result.total).toBe(3);
		const roles = result.messages.map((m) => m.role);
		expect(roles).toEqual(['user', 'user', 'assistant']);
		const assistant = result.messages.find((m) => m.role === 'assistant');
		expect(assistant?.content).toBe('Done, fixed it.'); // thinking block excluded
	});

	it('matches prompt-file history to a live turn instead of prepending its greeting again', async () => {
		const prompt = embedSystemPromptInPrompt('# Maestro System Context', 'Hello!');
		const wrapped =
			'<file name="C:/Temp/maestro-prompt-193d3119-8a93-4b08-8d1f-d59d57cff686.txt">\n' +
			prompt +
			'\n</file>\n';
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', [
			{ type: 'session', id: 'sess-1', cwd: projectPath },
			{
				type: 'message',
				id: 'disk-user',
				timestamp: '2026-10-05T20:13:39.141Z',
				message: { role: 'user', content: [{ type: 'text', text: wrapped }] },
			},
			{
				type: 'message',
				id: 'disk-answer',
				timestamp: '2026-10-05T20:13:41.302Z',
				message: { role: 'assistant', content: 'Hello! What would you like to work on?' },
			},
		]);
		const history = await storage.readSessionMessages(projectPath, 'sess-1');
		const loaded = transcriptMessagesToLogEntries(history.messages);
		const visible = [
			{
				id: 'live-user',
				source: 'user' as const,
				text: 'Hello!',
				timestamp: Date.parse('2026-10-05T20:13:55.870Z'),
			},
			{
				id: 'live-answer',
				source: 'stdout' as const,
				text: 'Hello! What would you like to work on?',
				timestamp: Date.parse('2026-10-05T20:13:44.653Z'),
			},
		];
		expect(selectOlderEntries(loaded, visible)).toEqual([]);
		expect(loaded[0].text).toBe('Hello!');
	});

	it.each([
		[
			'Windows resume wrapper',
			'user',
			'<file name="C:\\Temp\\maestro-prompt-193d3119-8a93-4b08-8d1f-d59d57cff686.txt">\r\ncontinue\r\n</file>\r\n',
			'continue',
		],
		[
			'nested user markup',
			'user',
			'<file name="/tmp/maestro-prompt-193d3119-8a93-4b08-8d1f-d59d57cff686.txt">\nKeep <file>example</file>\n</file>\n',
			'Keep <file>example</file>',
		],
		[
			'ordinary attachment',
			'user',
			'<file name="/tmp/example.txt">\nHello!\n</file>\n',
			'<file name="/tmp/example.txt">\nHello!\n</file>\n',
		],
		[
			'assistant quotation',
			'assistant',
			'<file name="/tmp/maestro-prompt-193d3119-8a93-4b08-8d1f-d59d57cff686.txt">\nHello!\n</file>\n',
			'<file name="/tmp/maestro-prompt-193d3119-8a93-4b08-8d1f-d59d57cff686.txt">\nHello!\n</file>\n',
		],
		['literal closing tag', 'user', 'Keep this\n</file>\n', 'Keep this\n</file>\n'],
	])('preserves user content when reading %s', async (_label, role, content, expected) => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', [
			{ type: 'session', id: 'sess-1', cwd: projectPath },
			{ type: 'message', id: 'message', message: { role, content } },
		]);
		const result = await storage.readSessionMessages(projectPath, 'sess-1');
		expect(result.messages.map((message) => message.content)).toEqual([expected]);
	});

	it('deletes a user message and its following assistant turn, stopping at the next user', async () => {
		const events: Record<string, unknown>[] = [
			{ type: 'session', id: 'sess-1', cwd: projectPath, timestamp: '2026-07-14T06:38:15.818Z' },
			{
				type: 'message',
				id: 'u1',
				message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
			},
			{
				type: 'message',
				id: 'a1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
			},
			{ type: 'message', id: 'tr', message: { role: 'toolResult', content: 'tool' } },
			{
				type: 'message',
				id: 'u2',
				message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
			},
			{
				type: 'message',
				id: 'a2',
				message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
			},
		];
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', events);

		const del = await storage.deleteMessagePair(projectPath, 'sess-1', 'u1');
		expect(del.success).toBe(true);
		expect(del.linesRemoved).toBe(3); // u1 + a1 + toolResult, stop at u2

		const result = await storage.readSessionMessages(projectPath, 'sess-1');
		expect(result.messages.map((m) => m.uuid)).toEqual(['u2', 'a2']);
	});

	it('degrades to empty for SSH-remote sessions (local-only v1)', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions).toEqual([]);

		const messages = await storage.readSessionMessages(projectPath, 'sess-1', undefined, sshConfig);
		expect(messages.messages).toEqual([]);

		const del = await storage.deleteMessagePair(projectPath, 'sess-1', 'm1', undefined, sshConfig);
		expect(del.success).toBe(false);
	});

	it('does not read or delete a same-id transcript that belongs to another project', async () => {
		// A transcript whose cwd is a DIFFERENT project. read/delete scoped to
		// projectPath must not resolve it - project-boundary isolation (Greptile P1).
		await writeTranscript('other', 'x_sess-b.jsonl', fullTranscript('/other/project', 'sess-b'));

		const read = await storage.readSessionMessages(projectPath, 'sess-b');
		expect(read.messages).toEqual([]);
		expect(read.total).toBe(0);

		const del = await storage.deleteMessagePair(projectPath, 'sess-b', 'm1');
		expect(del.success).toBe(false);
	});

	it('matches a cwd differing only in casing on case-insensitive platforms', async () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		try {
			// Transcript cwd differs from the requested project only in casing; on a
			// case-insensitive platform (darwin) it must still be listed.
			const casedCwd = path.join(tmpHome, 'code', 'PROJ');
			await writeTranscript('-code-PROJ', 'a_sess-c.jsonl', fullTranscript(casedCwd, 'sess-c'));

			const sessions = await storage.listSessions(projectPath); // projectPath ends in .../code/proj
			expect(sessions.map((s) => s.sessionId)).toEqual(['sess-c']);
		} finally {
			if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
		}
	});
});

// ===== from src/__tests__/main/storage/starred-transcript-mirror.test.ts =====

// Fake storage: one transcript file per (projectPath, sessionId) under providerRoot.
let providerRoot = '';

const getSessionPathMock = vi.fn((projectPath: string, sessionId: string): string | null => {
	const safeProject = projectPath.replace(/[^a-zA-Z0-9]/g, '_');
	return path_1.join(providerRoot, safeProject, `${sessionId}.jsonl`);
});

const AGENT = 'claude-code';

const PROJECT = '/Users/me/proj';

const SESSION = 'abc-123';

let mirrorRoot = '';

async function writeProviderFile(sessionId: string, content: string): Promise<string> {
	const p = getSessionPathMock(PROJECT, sessionId)!;
	await fsp.mkdir(path_1.dirname(p), { recursive: true });
	await fsp.writeFile(p, content, 'utf-8');
	return p;
}

async function readMaybe(p: string): Promise<string | null> {
	try {
		return await fsp.readFile(p, 'utf-8');
	} catch {
		return null;
	}
}

/** Raw index entry for a session, so tests can assert on retention reasons. */
async function readIndexEntry(
	sessionId: string
): Promise<{ retain?: string[]; sessionName?: string } | undefined> {
	const raw = await readMaybe(path_1.join(mirrorRoot, 'index.json'));
	if (!raw) return undefined;
	return JSON.parse(raw)[`${AGENT}::${sessionId}`];
}

/** Rewrite the index without `retain`, simulating a pre-retention-reasons entry. */
async function stripRetainFromIndex(): Promise<void> {
	const indexPath = path_1.join(mirrorRoot, 'index.json');
	const index = JSON.parse((await readMaybe(indexPath))!);
	for (const entry of Object.values(index) as Array<Record<string, unknown>>) {
		delete entry.retain;
	}
	await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

describe('snapshotStarredTranscript', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('copies the provider transcript into the mirror and records the index', async () => {
		await writeProviderFile(SESSION, 'line1\nline2\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			sessionName: 'My Session',
		});

		const entries = await listMirroredStarredSessions();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			sessionName: 'My Session',
		});
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('line1\nline2\n');
	});

	it('is a no-op when the provider mtime is unchanged (mtime gate)', async () => {
		await writeProviderFile(SESSION, 'original\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		// Drop a sentinel into the mirror. If snapshot #2 respects the mtime gate
		// (provider file untouched), it won't re-copy and the sentinel survives.
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		await fsp.writeFile(mirrorFile, 'SENTINEL\n', 'utf-8');

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		expect(await readMaybe(mirrorFile)).toBe('SENTINEL\n');
	});

	it('re-copies when the provider mtime advances', async () => {
		const providerPath = await writeProviderFile(SESSION, 'v1\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		await fsp.writeFile(providerPath, 'v1\nv2\n', 'utf-8');
		const future = new Date(Date.now() + 10_000);
		await fsp.utimes(providerPath, future, future);

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('v1\nv2\n');
	});

	it('does not clobber an existing mirror when the provider file is gone', async () => {
		await writeProviderFile(SESSION, 'kept\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await fsp.rm(getSessionPathMock(PROJECT, SESSION)!);

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('kept\n');
	});
});

describe('restoreStarredTranscript', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('rehydrates the provider file from the mirror when it has aged out', async () => {
		const providerPath = await writeProviderFile(SESSION, 'restore-me\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await fsp.rm(providerPath);

		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});
		expect(restored).toBe(true);
		expect(await readMaybe(providerPath)).toBe('restore-me\n');
	});

	it('is a no-op when the provider file still exists', async () => {
		await writeProviderFile(SESSION, 'present\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});
		expect(restored).toBe(false);
	});

	it('returns false when there is no mirror to restore from', async () => {
		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: 'never-mirrored',
		});
		expect(restored).toBe(false);
	});
});

describe('releaseTranscriptMirror', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('removes the mirror file and its index entry on unstar', async () => {
		await writeProviderFile(SESSION, 'bye\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(1);

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(0);
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBeNull();
	});
});

describe('flushTranscriptMirrorsSync', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('mirrors only starred open tabs with a provider session id', async () => {
		await writeProviderFile('s-starred', 'starred-content\n');
		await writeProviderFile('s-unstarred', 'unstarred-content\n');

		const sessions = [
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [
					{ agentSessionId: 's-starred', starred: true, name: 'Keep me' },
					{ agentSessionId: 's-unstarred', starred: false, name: 'Skip me' },
					{ starred: true, name: 'No session id' },
				],
			},
		];

		flushTranscriptMirrorsSync(sessions);

		const entries = await listMirroredStarredSessions();
		expect(entries.map((e) => e.sessionId)).toEqual(['s-starred']);
		const mirrorFile = path_1.join(mirrorRoot, AGENT, 's-starred.jsonl');
		expect(realFs.readFileSync(mirrorFile, 'utf-8')).toBe('starred-content\n');
	});

	it('mirrors snoozed tabs, which are not in aiTabs and outlive provider retention', async () => {
		await writeProviderFile('s-snoozed', 'snoozed-content\n');

		flushTranscriptMirrorsSync([
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [],
				snoozedTabs: [
					{
						id: 'snooze-1',
						wakeAt: Date.now() + 86_400_000,
						tab: { agentSessionId: 's-snoozed', starred: false, name: 'Back tomorrow' },
					},
				],
			},
		]);

		const mirrorFile = path_1.join(mirrorRoot, AGENT, 's-snoozed.jsonl');
		expect(realFs.readFileSync(mirrorFile, 'utf-8')).toBe('snoozed-content\n');

		// Retained for snooze only, so it must NOT surface as a starred session.
		expect(await listMirroredStarredSessions()).toHaveLength(0);
		expect(await readIndexEntry('s-snoozed')).toMatchObject({ retain: ['snoozed'] });
	});

	it('records both reasons for a tab that is snoozed and starred', async () => {
		await writeProviderFile('s-both', 'both\n');

		flushTranscriptMirrorsSync([
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [],
				snoozedTabs: [{ id: 'x', tab: { agentSessionId: 's-both', starred: true, name: 'Both' } }],
			},
		]);

		const entry = await readIndexEntry('s-both');
		expect(entry?.retain?.slice().sort()).toEqual(['snoozed', 'starred']);
		// Starred, so it still belongs in the aged-out starred listing.
		expect((await listMirroredStarredSessions()).map((e) => e.sessionId)).toEqual(['s-both']);
	});
});

describe('retention reasons', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('keeps the mirror when unstarring a session that is still snoozed', async () => {
		// The whole point: a months-long snooze must not be collected by an unstar.
		await writeProviderFile(SESSION, 'precious\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'starred',
		});
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'starred' });

		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('precious\n');
		expect(await readIndexEntry(SESSION)).toMatchObject({ retain: ['snoozed'] });
		// No longer starred, so it drops out of the starred listing.
		expect(await listMirroredStarredSessions()).toHaveLength(0);
	});

	it('deletes the mirror once the last reason is released', async () => {
		await writeProviderFile(SESSION, 'temp\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'snoozed' });

		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBeNull();
		expect(await readIndexEntry(SESSION)).toBeUndefined();
	});

	it('treats a legacy entry with no retain field as starred', async () => {
		// Entries written before retention reasons existed were all stars.
		await writeProviderFile(SESSION, 'legacy\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await stripRetainFromIndex();

		expect((await listMirroredStarredSessions()).map((e) => e.sessionId)).toEqual([SESSION]);

		// Releasing a snooze it never had must not delete it.
		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'snoozed' });
		expect(await readMaybe(path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBe('legacy\n');

		// Unstarring it does.
		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'starred' });
		expect(await readMaybe(path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBeNull();
	});

	it('widens retention on an unchanged transcript without re-copying', async () => {
		await writeProviderFile(SESSION, 'v1\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		// Sentinel proves the mtime gate still suppresses the copy while the new
		// reason is recorded.
		const mirrorFile = path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		await fsp.writeFile(mirrorFile, 'SENTINEL\n', 'utf-8');

		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		expect(await readMaybe(mirrorFile)).toBe('SENTINEL\n');
		expect((await readIndexEntry(SESSION))?.retain?.slice().sort()).toEqual(['snoozed', 'starred']);
	});
});

describe('releaseSnoozedTranscriptMirror', () => {
	beforeEach(async () => {
		const base = await fsp.mkdtemp(path_1.join(os_1.tmpdir(), 'stm-test-'));
		providerRoot = path_1.join(base, 'provider');
		mirrorRoot = path_1.join(base, 'mirror');
		setMirrorRootForTest(mirrorRoot);
		getSessionPathMock.mockClear();
	});
	afterEach(() => {
		setMirrorRootForTest(null);
	});

	it('rehydrates an aged-out transcript before letting the mirror go', async () => {
		// A wake must never be the thing that loses the conversation.
		const providerPath = await writeProviderFile(SESSION, 'survived\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});
		await fsp.rm(providerPath); // provider ages it out during the snooze

		await releaseSnoozedTranscriptMirror({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});

		// Conversation is back where the provider expects it...
		expect(await readMaybe(providerPath)).toBe('survived\n');
		// ...and the now-unneeded mirror is gone.
		expect(await readMaybe(path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBeNull();
	});

	it('leaves the mirror in place when the session is also starred', async () => {
		await writeProviderFile(SESSION, 'still-starred\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseSnoozedTranscriptMirror({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});

		expect(await readMaybe(path_1.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBe(
			'still-starred\n'
		);
		expect(await readIndexEntry(SESSION)).toMatchObject({ retain: ['starred'] });
	});
});
