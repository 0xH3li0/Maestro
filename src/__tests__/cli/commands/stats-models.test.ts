/**
 * @file stats-models.test.ts
 * @description Tests for `maestro-cli stats models`: the request crosses the WS
 * bridge in the shape the desktop handler expects, the record is printed as a
 * person reads it (and whole as JSON), a range that is not one of the six is
 * refused before anything is sent, and a failure the app reports is not a
 * success.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { statsModels } from '../../../cli/commands/stats';
import { CommandTimeoutError, withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { ModelUsage } from '../../../shared/local-models/model-usage';
import { emptyPercentiles, type DurationPercentiles } from '../../../shared/percentiles';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

function latency(p50: number, p95: number, count = 10): DurationPercentiles {
	return { count, min: p50, p50, p75: p50, p90: p95, p95, p99: p95, max: p95 };
}

const NO_OUTCOMES = {
	ok: 0,
	'failed-open': 0,
	'failed-closed': 0,
	unavailable: 0,
	cancelled: 0,
};

const EMPTY: ModelUsage = {
	range: 'week',
	since: 0,
	totals: {
		requests: 0,
		otherModelRequests: 0,
		onDeviceRequests: 0,
		errors: 0,
		tokensIn: 0,
		tokensOut: 0,
		onDeviceTokens: 0,
	},
	sources: [],
	byTask: [],
	byAgent: [],
	systemOne: {
		decisions: 0,
		cached: 0,
		outcomes: NO_OUTCOMES,
		timeouts: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
		byTask: [],
		byEngine: [],
		routedTiers: { low: 0, medium: 0, high: 0 },
		retentionDays: 30,
		coversRange: true,
	},
	proxy: {
		totals: {
			requests: 0,
			compressRequests: 0,
			originalTokens: 0,
			sentTokens: 0,
			tokensSaved: 0,
			avgAddedLatencyMs: 0,
		},
		routedRequests: 0,
		byAgent: [],
	},
};

const BUSY: ModelUsage = {
	range: 'quarter',
	since: 1_700_000_000_000,
	totals: {
		requests: 164,
		otherModelRequests: 124,
		onDeviceRequests: 41,
		errors: 3,
		tokensIn: 1_250_000,
		tokensOut: 80_100,
		onDeviceTokens: 52_000,
	},
	sources: [
		{
			key: 'server',
			kind: 'server',
			id: null,
			label: 'Maestro model server',
			onDevice: true,
			endpointKind: null,
			requests: 41,
			runs: 36,
			turns: 4,
			routed: 1,
			errors: 1,
			cancelled: 0,
			tokensIn: 45_000,
			tokensOut: 3200,
			cachedTokensIn: 0,
			latency: latency(240, 1200),
			turnDuration: latency(60_000, 240_000, 4),
			models: [
				{ model: 'qwen3-coder', requests: 30 },
				{ model: 'qwen3.5-4b', requests: 11 },
			],
		},
		{
			key: 'provider:claude-code',
			kind: 'provider',
			id: 'claude-code',
			label: 'Claude Code',
			onDevice: false,
			endpointKind: null,
			requests: 40,
			runs: 0,
			turns: 40,
			routed: 0,
			errors: 0,
			cancelled: 0,
			tokensIn: 1_200_000,
			tokensOut: 76_000,
			cachedTokensIn: 9_000_000,
			latency: emptyPercentiles(),
			turnDuration: latency(90_000, 600_000, 40),
			models: [],
		},
		{
			key: 'system-one:jev-cloud',
			kind: 'system-one',
			id: 'jev-cloud',
			label: 'Jev (TypeSafe cloud)',
			onDevice: false,
			endpointKind: null,
			requests: 83,
			runs: 83,
			turns: 0,
			routed: 0,
			errors: 2,
			cancelled: 0,
			tokensIn: 5000,
			tokensOut: 900,
			cachedTokensIn: 0,
			latency: latency(123, 410, 81),
			turnDuration: emptyPercentiles(),
			models: [{ model: 'jev-1.13.0', requests: 81 }],
		},
	],
	byTask: [
		{
			taskId: 'cue-gate',
			label: 'Cue gate',
			runs: 83,
			errors: 2,
			cancelled: 0,
			tokensIn: 5000,
			tokensOut: 900,
			latency: latency(123, 410, 81),
			sources: [{ key: 'system-one:jev-cloud', label: 'Jev (TypeSafe cloud)', runs: 83 }],
		},
		{
			taskId: 'tab-naming',
			label: 'Tab naming',
			runs: 36,
			errors: 1,
			cancelled: 0,
			tokensIn: 9000,
			tokensOut: 400,
			latency: latency(240, 1200, 35),
			sources: [{ key: 'server', label: 'Maestro model server', runs: 36 }],
		},
	],
	byAgent: [
		{
			agentId: 'agent-alpha-0001',
			name: 'Alpha',
			agentType: 'claude-code',
			turns: 4,
			runs: 12,
			tokensIn: 36_000,
			tokensOut: 2800,
			turnDuration: latency(60_000, 240_000, 4),
			targets: [
				{
					sourceKey: 'server',
					sourceLabel: 'Maestro model server',
					model: 'qwen3-coder',
					turns: 4,
				},
			],
		},
		{
			// Runs were filed for it, and it launched nothing on another model.
			agentId: 'agent-beta-0002',
			name: 'Beta',
			agentType: null,
			turns: 0,
			runs: 71,
			tokensIn: 0,
			tokensOut: 0,
			turnDuration: emptyPercentiles(),
			targets: [],
		},
	],
	systemOne: {
		decisions: 90,
		cached: 7,
		outcomes: { ...NO_OUTCOMES, ok: 86, 'failed-open': 3, 'failed-closed': 1 },
		timeouts: 2,
		tokensIn: 5000,
		tokensOut: 900,
		costUsd: 0.0019,
		byTask: [
			{
				taskId: 'cue-gate',
				label: 'Cue gate',
				decisions: 90,
				cached: 7,
				outcomes: { ...NO_OUTCOMES, ok: 86, 'failed-open': 3, 'failed-closed': 1 },
				timeouts: 2,
				latency: latency(123, 410, 79),
			},
		],
		byEngine: [{ engine: 'jev-cloud', label: 'Jev (TypeSafe cloud)', decisions: 90, answered: 86 }],
		routedTiers: { low: 10, medium: 5, high: 2 },
		retentionDays: 30,
		coversRange: false,
	},
	proxy: {
		totals: {
			requests: 12,
			compressRequests: 5,
			originalTokens: 40_000,
			sentTokens: 30_000,
			tokensSaved: 10_000,
			avgAddedLatencyMs: 14,
		},
		routedRequests: 1,
		byAgent: [
			{
				agentId: 'agent-alpha-0001',
				name: 'Alpha',
				requests: 9,
				compressRequests: 5,
				originalTokens: 40_000,
				sentTokens: 30_000,
				tokensSaved: 10_000,
				avgAddedLatencyMs: 14,
			},
			{
				agentId: null,
				name: null,
				requests: 3,
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				tokensSaved: 0,
				avgAddedLatencyMs: 0,
			},
		],
	},
};

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

describe('stats models command', () => {
	it('asks the app for the range and prints every block of the record', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter' });

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'quarter' });
		expect(captured.responseType).toBe('model_usage');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*quarter/);
		expect(output).toContain(
			'164 requests, 1.3M tokens in, 80.1K out, 25% on this machine, 3 errors'
		);

		// Sources: the split says which unit each count is in.
		expect(output).toMatch(
			/Maestro model server\s+.*Model server.*41 requests .*\(36 runs, 4 turns, 1 routed\).*45\.0K in, 3\.2K out.*1 error.*p50 240ms {2}p95 1\.2s/
		);
		expect(output).toContain('qwen3-coder, qwen3.5-4b');
		// A provider has no single-request latency: its turns are what was timed.
		expect(output).toMatch(
			/Claude Code\s+.*Provider cloud.*40 requests .*\(40 turns\).*p50 1\.5m {2}p95 10\.0m/
		);
		expect(output).toContain('p50 and p95 are whole turns, not single requests');
		expect(output).toMatch(
			/Jev \(TypeSafe cloud\)\s+.*System One.*83 requests .*2 errors.*p50 123ms {2}p95 410ms/
		);

		// Tasks, with where each ran.
		expect(output).toMatch(/Cue gate\s+83 runs\s+.*2 errors.*p50 123ms.*Jev \(TypeSafe cloud\) 83/);
		expect(output).toMatch(/Tab naming\s+36 runs\s+.*1 error\b.*Maestro model server 36/);

		// Only an agent that launched turns on another model is listed.
		expect(output).toMatch(
			/Alpha\s+4 turns\s+36\.0K in, 2\.8K out\s+.*qwen3-coder on Maestro model server 4/
		);
		expect(output).not.toMatch(/Beta/);

		// System One: the ledger's retention is said when the range outruns it.
		expect(output).toMatch(/System One\s+.*decisions are kept 30 days/);
		expect(output).toContain(
			'90 decisions (7 from the cache): 86 answered, 3 failed open, 1 failed closed, 2 timed out, $0.001900'
		);
		expect(output).toMatch(/Auto routing\s+17 turns: low 10, medium 5, high 2/);

		// The proxy's saving is an estimate, and the report says so.
		expect(output).toMatch(/All agents\s+12 requests, 10000 tokens saved \(25%\), 14 ms average/);
		expect(output).toMatch(/Alpha\s+9 requests/);
		expect(output).toMatch(/No agent\s+3 requests, -/);
		expect(output).toContain('1 background request sent to a Local Models target');
		expect(output).toContain('Token counts are estimates at 4 characters per token.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('reads the week when no range is named', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'week' });
	});

	it('says nothing ran, and where to look, for an empty range, and exits 0', async () => {
		mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*week/);
		expect(output).toContain('Nothing ran in this range.');
		expect(output).toContain('maestro-cli models status');
		expect(output).not.toMatch(/Sources|Tasks|System One|Token proxy/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the providers alone when no other model did anything', async () => {
		const provider = BUSY.sources[1];
		mockSend({
			type: 'model_usage',
			success: true,
			data: {
				...EMPTY,
				totals: { ...EMPTY.totals, requests: 40, tokensIn: 1_200_000, tokensOut: 76_000 },
				sources: [provider],
			},
		});

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toContain(
			'40 requests, 1.2M tokens in, 76.0K out, 0% on this machine, 0 errors'
		);
		expect(output).toMatch(/Claude Code\s+.*40 requests/);
		expect(output).not.toMatch(/Tasks|Agents|System One|Token proxy/);
	});

	it('prints the whole record as JSON with --json', async () => {
		mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter', json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(BUSY);
	});

	it('refuses a range that is not one of the six before anything is sent', async () => {
		await expect(statsModels({ range: 'fortnight' })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls[0][0]).toContain(
			'Invalid range "fortnight". Must be one of: day, week, month, quarter, year, all'
		);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});

	it('reports a failure the app answered with, as JSON when asked', async () => {
		mockSend({ type: 'model_usage', success: false, error: 'Stats database is not ready' });

		await expect(statsModels({ json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toEqual({
			error: 'Stats database is not ready',
		});
		expect(logSpy).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('exits with the bridge code when the app does not answer in time', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new CommandTimeoutError('model_usage'));

		await expect(statsModels({})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.Timeout);
	});
});
