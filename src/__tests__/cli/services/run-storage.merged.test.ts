// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/cli/services/agent-run-lock.test.ts
//   - src/__tests__/cli/services/agent-run-store-concurrency.test.ts
//   - src/__tests__/cli/services/mcp-bridge.test.ts
//   - src/__tests__/cli/services/pianola-store.test.ts

import { withStoreLock } from '../../../cli/services/agent-run-lock';
import {
	appendAgentRunEvent,
	readAgentRunEvents,
	readAgentRuns,
	readCampaigns,
	upsertAgentRun,
	writeAgentRuns,
	writeCampaigns,
} from '../../../cli/services/agent-run-store';
import type { AgentRun, AgentRunEvent, Campaign } from '../../../cli/services/agent-run-store';
import { MCP_CALL_TIMEOUT_MS, createMcpBridge } from '../../../cli/services/mcp-bridge';
import {
	appendPianolaDecision,
	readPianolaDecisions,
	readPianolaRules,
} from '../../../cli/services/pianola-store';
import {
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_RULES_FILENAME,
} from '../../../shared/pianola/storage';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ===== from src/__tests__/cli/services/agent-run-lock.test.ts =====

const LOCK_DIR_NAME = 'maestro-agent-store.lock';

const STALE_LOCK_MS = 30_000;

let tmpDir: string;

let lockDir: string;

let holderPath: string;

let prevEnv: string | undefined;

describe('withStoreLock', () => {
	beforeEach(() => {
		prevEnv = process.env.MAESTRO_USER_DATA;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-lock-'));
		process.env.MAESTRO_USER_DATA = tmpDir;
		lockDir = path.join(tmpDir, LOCK_DIR_NAME);
		holderPath = path.join(lockDir, 'holder');
	});
	afterEach(() => {
		if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('runs fn, returns its value, and releases the lock dir', () => {
		expect(fs.existsSync(lockDir)).toBe(false);

		let sawLockHeld = false;
		const result = withStoreLock(() => {
			// The lock dir must exist while fn runs.
			sawLockHeld = fs.existsSync(lockDir);
			return 42;
		});

		expect(result).toBe(42);
		expect(sawLockHeld).toBe(true);
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('releases the lock dir even when fn throws, and propagates the throw', () => {
		expect(() =>
			withStoreLock(() => {
				throw new Error('boom from inside fn');
			})
		).toThrow('boom from inside fn');

		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('times out and throws when a fresh lock dir is already held, without running fn', () => {
		// A just-created (fresh) lock dir: not stale, so it cannot be stolen.
		fs.mkdirSync(lockDir);

		let fnRan = false;
		const start = Date.now();
		expect(() =>
			withStoreLock(
				() => {
					fnRan = true;
				},
				{ timeoutMs: 50 }
			)
		).toThrow(/agent-run store lock timeout after 50ms/);
		const elapsed = Date.now() - start;

		expect(fnRan).toBe(false);
		// It actually waited for (roughly) the timeout rather than failing instantly.
		expect(elapsed).toBeGreaterThanOrEqual(40);
		// The contended lock belongs to the (simulated) other holder: not deleted.
		expect(fs.existsSync(lockDir)).toBe(true);
	});

	it('steals a stale lock dir and runs fn to completion', () => {
		// A lock left behind by a crashed holder: dir present, mtime far in the past.
		fs.mkdirSync(lockDir);
		fs.writeFileSync(holderPath, JSON.stringify({ token: 'dead-holder', pid: 999 }), 'utf-8');
		const past = new Date(Date.now() - (STALE_LOCK_MS + 60_000));
		fs.utimesSync(lockDir, past, past);

		let fnRan = false;
		const result = withStoreLock(
			() => {
				fnRan = true;
				return 'stolen-and-ran';
			},
			{ timeoutMs: 200 }
		);

		expect(fnRan).toBe(true);
		expect(result).toBe('stolen-and-ran');
		// Our acquisition owned the fresh lock and released it in finally.
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('does not delete the lock dir in finally once ownership has changed hands', () => {
		// Simulate our lock being declared stale and stolen mid-run: the holder token
		// no longer matches ours, so finally must NOT destroy the new owner's lock.
		withStoreLock(() => {
			fs.writeFileSync(
				holderPath,
				JSON.stringify({ token: 'a-different-owner', pid: 12345 }),
				'utf-8'
			);
		});

		expect(fs.existsSync(lockDir)).toBe(true);
		const holder = JSON.parse(fs.readFileSync(holderPath, 'utf-8')) as { token?: string };
		expect(holder.token).toBe('a-different-owner');
	});
});

// ===== from src/__tests__/cli/services/agent-run-store-concurrency.test.ts =====

const AGENT_RUN_EVENTS_FILE = 'maestro-agent-run-events.jsonl';

let tmpDir_1: string;

let prevEnv_1: string | undefined;

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-1',
	createdAt: 100,
	updatedAt: 100,
	provider: 'claude-code',
	status: 'queued',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

const event = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
	id: 'event-1',
	runId: 'run-1',
	timestamp: 200,
	type: 'status',
	...overrides,
});

const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
	id: 'campaign-1',
	title: 'Campaign One',
	createdAt: 100,
	updatedAt: 100,
	status: 'queued',
	runIds: [],
	tasks: [],
	...overrides,
});

describe('agent-run store write-safety', () => {
	beforeEach(() => {
		prevEnv_1 = process.env.MAESTRO_USER_DATA;
		tmpDir_1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-store-conc-'));
		process.env.MAESTRO_USER_DATA = tmpDir_1;
	});
	afterEach(() => {
		if (prevEnv_1 === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv_1;
		fs.rmSync(tmpDir_1, { recursive: true, force: true });
	});

	it('persists two sequential upserts of different run ids without dropping either', () => {
		// The classic lost-update shape: the second upsert must re-read the snapshot
		// the first one committed, not an empty in-memory baseline.
		upsertAgentRun(run({ id: 'run-a' }));
		upsertAgentRun(run({ id: 'run-b' }));

		const ids = readAgentRuns()
			.map((entry) => entry.id)
			.sort();
		expect(ids).toEqual(['run-a', 'run-b']);
	});

	it('appends events for two different runs: both JSONL lines land and each snapshot updates', () => {
		writeAgentRuns([
			run({ id: 'run-a', status: 'running', updatedAt: 100 }),
			run({ id: 'run-b', status: 'running', updatedAt: 100 }),
		]);

		appendAgentRunEvent(
			event({ id: 'ev-a', runId: 'run-a', type: 'status', status: 'completed', timestamp: 500 })
		);
		appendAgentRunEvent(
			event({ id: 'ev-b', runId: 'run-b', type: 'status', status: 'failed', timestamp: 600 })
		);

		// The JSONL append is additive: both lines survive on disk in order.
		const rawLines = fs
			.readFileSync(path.join(tmpDir_1, AGENT_RUN_EVENTS_FILE), 'utf-8')
			.trim()
			.split('\n');
		expect(rawLines.map((line) => (JSON.parse(line) as AgentRunEvent).id)).toEqual([
			'ev-a',
			'ev-b',
		]);

		// Each run's events are retrievable independently through the public reader.
		expect(readAgentRunEvents('run-a').map((e) => e.id)).toEqual(['ev-a']);
		expect(readAgentRunEvents('run-b').map((e) => e.id)).toEqual(['ev-b']);

		// Each run snapshot picked up its own event's status + timestamp, no cross-talk.
		const runs = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
		expect(runs.get('run-a')).toMatchObject({ status: 'completed', updatedAt: 500 });
		expect(runs.get('run-b')).toMatchObject({ status: 'failed', updatedAt: 600 });
	});

	it('round-trips writeAgentRuns full-snapshot writes through readAgentRuns', () => {
		writeAgentRuns([
			run({ id: 'run-a', status: 'running', updatedAt: 10 }),
			run({ id: 'run-b', status: 'completed', updatedAt: 20 }),
		]);

		const persisted = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
		expect([...persisted.keys()].sort()).toEqual(['run-a', 'run-b']);
		expect(persisted.get('run-a')).toMatchObject({ status: 'running', updatedAt: 10 });
		expect(persisted.get('run-b')).toMatchObject({ status: 'completed', updatedAt: 20 });
	});

	it('round-trips writeCampaigns full-snapshot writes through readCampaigns', () => {
		writeCampaigns([
			campaign({ id: 'campaign-a', title: 'Alpha', status: 'running', updatedAt: 10 }),
			campaign({ id: 'campaign-b', title: 'Beta', status: 'complete', updatedAt: 20 }),
		]);

		const persisted = new Map(readCampaigns().map((entry) => [entry.id, entry]));
		expect([...persisted.keys()].sort()).toEqual(['campaign-a', 'campaign-b']);
		expect(persisted.get('campaign-a')).toMatchObject({ title: 'Alpha', status: 'running' });
		expect(persisted.get('campaign-b')).toMatchObject({ title: 'Beta', status: 'complete' });
	});
});

// ===== from src/__tests__/cli/services/mcp-bridge.test.ts =====

const serverInfo = { name: 'maestro-plugins', version: '1.0.0' };

const log = (): void => {};

describe('createMcpBridge - listTools', () => {
	it('maps app tool entries to MCP defs with a default inputSchema', async () => {
		const request = vi.fn(async () => ({
			tools: [{ name: 'p__a', toolId: 'p/a', description: 'd' }],
		}));
		const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
		expect(tools).toEqual([{ name: 'p__a', description: 'd', inputSchema: { type: 'object' } }]);
	});

	it('de-collides duplicate sanitized names and routes the call to the right toolId', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({
			tools: [
				{ name: 'p__a', toolId: 'p/a' },
				{ name: 'p__a', toolId: 'p/a2' },
			],
		});
		const bridge = createMcpBridge({ serverInfo, request, log });
		const tools = await bridge.listTools();
		expect(tools.map((t) => t.name)).toEqual(['p__a', 'p__a__2']);

		request.mockResolvedValueOnce({ ok: true, result: 'R' });
		await bridge.callTool('p__a__2', {});
		expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
			type: 'plugins_call_tool',
			toolId: 'p/a2',
		});
	});

	it('advertises zero tools when the app is unreachable', async () => {
		const request = vi.fn(async () => {
			throw new Error('Not connected to Maestro');
		});
		const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
		expect(tools).toEqual([]);
	});
});

describe('createMcpBridge - callTool', () => {
	it('maps a risk-gate block to an isError result', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();
		request.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'high-risk prompt' });
		const r = await bridge.callTool('p__a', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('risk gate');
	});

	it('maps a tool failure to an isError result', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();
		request.mockResolvedValueOnce({ ok: false, error: 'boom' });
		const r = await bridge.callTool('p__a', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('boom');
	});

	it('rejects an unmapped tool name without calling the app', async () => {
		const request = vi.fn();
		const r = await createMcpBridge({ serverInfo, request, log }).callTool('never-listed', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('Unknown tool');
		expect(request).not.toHaveBeenCalled();
	});

	it('maps a success to text content, with mapped toolId and the long call timeout', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();

		request.mockResolvedValueOnce({ ok: true, result: { v: 1 } });
		const r = await bridge.callTool('p__a', { q: 2 });
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text).toBe(JSON.stringify({ v: 1 }));

		const lastCall = request.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			type: 'plugins_call_tool',
			toolId: 'p/a',
			args: { q: 2 },
		});
		expect(lastCall?.[2]).toBe(MCP_CALL_TIMEOUT_MS);
	});
});

// ===== from src/__tests__/cli/services/pianola-store.test.ts =====

let tmpDir_2: string;

let prevEnv_2: string | undefined;

function writeRulesFile(content: string): void {
	fs.writeFileSync(path.join(tmpDir_2, PIANOLA_RULES_FILENAME), content, 'utf-8');
}

function decisionRecord(id: string): PianolaDecisionRecord {
	return {
		id,
		timestamp: '2026-01-01T00:00:00.000Z',
		tabId: 'tab-1',
		agentId: 'agent-1',
		classification: {
			kind: 'question',
			risk: 'low',
			topic: 'tabs',
			confidence: 'medium',
			evidence: { messageId: 'm1', reason: 'test', structured: false },
		},
		decision: { action: 'escalate', matchedRuleId: null, reason: 'default' },
		dispatched: false,
		dryRun: true,
	};
}

describe('readPianolaRules', () => {
	beforeEach(() => {
		prevEnv_2 = process.env.MAESTRO_USER_DATA;
		tmpDir_2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-store-'));
		process.env.MAESTRO_USER_DATA = tmpDir_2;
	});
	afterEach(() => {
		if (prevEnv_2 === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv_2;
		fs.rmSync(tmpDir_2, { recursive: true, force: true });
	});

	it('returns [] when the rules file is missing', () => {
		expect(readPianolaRules()).toEqual([]);
	});

	it('reads a bare array of rules', () => {
		writeRulesFile(
			JSON.stringify([
				{
					id: 'r1',
					enabled: true,
					scope: 'global',
					match: { maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'ok',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
			])
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['r1']);
	});

	it('reads an electron-store style { rules: [...] } object', () => {
		writeRulesFile(
			JSON.stringify({
				rules: [
					{
						id: 'r2',
						enabled: true,
						scope: 'global',
						match: {},
						action: 'escalate',
						priority: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			})
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['r2']);
	});

	it('returns [] for malformed JSON', () => {
		writeRulesFile('{ not json');
		expect(readPianolaRules()).toEqual([]);
	});

	it('drops individual invalid rules', () => {
		writeRulesFile(
			JSON.stringify([
				{
					id: 'good',
					enabled: true,
					scope: 'global',
					action: 'escalate',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
				{ id: 'bad', scope: 'planet' },
			])
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['good']);
	});
});

describe('decision audit log', () => {
	beforeEach(() => {
		prevEnv_2 = process.env.MAESTRO_USER_DATA;
		tmpDir_2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-store-'));
		process.env.MAESTRO_USER_DATA = tmpDir_2;
	});
	afterEach(() => {
		if (prevEnv_2 === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv_2;
		fs.rmSync(tmpDir_2, { recursive: true, force: true });
	});

	it('returns [] when the log is missing', () => {
		expect(readPianolaDecisions()).toEqual([]);
	});

	it('appends and reads back records in order', () => {
		appendPianolaDecision(decisionRecord('d1'));
		appendPianolaDecision(decisionRecord('d2'));
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('honors a tail limit', () => {
		appendPianolaDecision(decisionRecord('d1'));
		appendPianolaDecision(decisionRecord('d2'));
		appendPianolaDecision(decisionRecord('d3'));
		expect(readPianolaDecisions(2).map((r) => r.id)).toEqual(['d2', 'd3']);
	});

	it('skips a corrupt line without failing the read', () => {
		appendPianolaDecision(decisionRecord('d1'));
		fs.appendFileSync(path.join(tmpDir_2, PIANOLA_DECISIONS_FILENAME), 'not json\n', 'utf-8');
		appendPianolaDecision(decisionRecord('d2'));
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('skips a schema-invalid JSON line', () => {
		appendPianolaDecision(decisionRecord('d1'));
		fs.appendFileSync(path.join(tmpDir_2, PIANOLA_DECISIONS_FILENAME), '{"foo":1}\n', 'utf-8');
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1']);
	});

	it('folds an intent and outcome record sharing an id (last wins, position kept)', () => {
		const intent = { ...decisionRecord('same'), dispatched: false };
		const outcome = { ...decisionRecord('same'), dispatched: true };
		appendPianolaDecision(decisionRecord('first'));
		appendPianolaDecision(intent);
		appendPianolaDecision(outcome);
		const records = readPianolaDecisions();
		expect(records.map((r) => r.id)).toEqual(['first', 'same']);
		expect(records[1].dispatched).toBe(true);
	});
});
