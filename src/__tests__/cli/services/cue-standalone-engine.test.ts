/**
 * Standalone Cue engine wiring (`src/cli/services/cue-standalone-engine.ts`).
 *
 * The desktop registers every provider's output parser at boot; the standalone
 * runner has to do it itself, or every prompt run is recorded as raw
 * stream-json with no provider session id and no usage. The same goes for the
 * stores an agent's Run on target is looked up in: unwired, a run of such an
 * agent throws rather than run on its provider's model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CueEvent, CueRunResult } from '../../../shared/cue/contracts';

const initializeOutputParsers = vi.fn();
const executeCuePrompt = vi.fn();

vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers }));
vi.mock('../../../main/cue/cue-executor', () => ({ executeCuePrompt, stopCueRun: vi.fn() }));
vi.mock('../../../main/cue/cue-shell-executor', () => ({
	executeCueShell: vi.fn(),
	stopCueShellRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	executeCueCli: vi.fn(),
	stopCueCliRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure: vi.fn(() => null) }));
const RUN_ON = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };
// The model router is the desktop app's. A test never reaches it: what a
// routed run resolves to is what this stand-in answers.
const resolveCliAutoTurn = vi.hoisted(() => vi.fn());
vi.mock('../../../cli/services/auto-turn', () => ({ resolveCliAutoTurn }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' },
		{
			id: 'agent-2',
			name: 'beta',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			runOn: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' },
		},
		{
			// Sends `low` to a local model and leaves `high` to the harness default.
			id: 'agent-3',
			name: 'gamma',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			customModel: 'sonnet',
			tierTargets: {
				low: { type: 'source', endpointId: 'maestro-server', model: 'qwen3.5-4b' },
				medium: { type: 'source' },
			},
		},
		{
			// Set to the Auto model. Its Cue runs route only when a subscription opts in.
			id: 'agent-4',
			name: 'delta',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			customModel: 'auto',
			customEffort: 'low',
		},
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readHarnessTierDefaults: () => ({
		'claude-code': { high: { type: 'provider-model', model: 'opus[1m]' } },
	}),
}));

import { buildStandaloneCueEngineDeps } from '../../../cli/services/cue-standalone-engine';
import { isAgentRunOnConfigured } from '../../../main/local-models/run-on';

const event: CueEvent = {
	id: 'evt-1',
	type: 'webhook.received',
	timestamp: new Date().toISOString(),
	triggerName: 'ask',
	payload: {},
};

describe('buildStandaloneCueEngineDeps', () => {
	beforeEach(() => {
		executeCuePrompt.mockResolvedValue({ status: 'completed' } as CueRunResult);
	});

	it('registers the output parsers before the first prompt run executes', async () => {
		executeCuePrompt.mockImplementation(async () => {
			expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
			return { status: 'completed' } as CueRunResult;
		});
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-1',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(initializeOutputParsers).toHaveBeenCalledTimes(1);
	});

	// The desktop host resolves a subscription's tier / model / effort in
	// src/main/index.ts. This runner has its own onCueRun, so without the same
	// step a headless run silently used the agent's default model.
	it("spawns the prompt run on the subscription's model choice", async () => {
		executeCuePrompt.mockClear();
		const onLog = vi.fn();
		const deps = buildStandaloneCueEngineDeps({ onLog });

		await deps.onCueRun({
			runId: 'run-2',
			sessionId: 'agent-1',
			prompt: 'Review it',
			subscriptionName: 'deep-review',
			event,
			timeoutMs: 1000,
			turnSettings: { model: 'claude-pinned-model', effort: 'low' },
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(executeCuePrompt.mock.calls[0][0]).toMatchObject({ customModel: 'claude-pinned-model' });
		expect(executeCuePrompt.mock.calls[0][0].customEffort).toBeTruthy();
	});

	it("keeps the agent's own model when the subscription sets none", async () => {
		executeCuePrompt.mockClear();
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-3',
			sessionId: 'agent-1',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt.mock.calls[0][0].customModel).toBeUndefined();
		expect(executeCuePrompt.mock.calls[0][0].customEffort).toBeUndefined();
	});

	it("hands the run the agent's Run on target, with its lookup wired first", async () => {
		executeCuePrompt.mockClear();
		executeCuePrompt.mockImplementation(async () => {
			// The spawn builder looks the target's source up through these stores.
			expect(isAgentRunOnConfigured()).toBe(true);
			return { status: 'completed' } as CueRunResult;
		});
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });

		await deps.onCueRun({
			runId: 'run-4',
			sessionId: 'agent-2',
			prompt: 'Say pong',
			subscriptionName: 'ask',
			event,
			timeoutMs: 1000,
		} as Parameters<typeof deps.onCueRun>[0]);

		expect(executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(executeCuePrompt.mock.calls[0][0]).toMatchObject({ runOn: RUN_ON });
	});

	describe('a subscription tier', () => {
		const runTier = async (sessionId: string, tier: string) => {
			executeCuePrompt.mockReset();
			executeCuePrompt.mockResolvedValue({ status: 'completed' } as CueRunResult);
			const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });
			await deps.onCueRun({
				runId: `run-${tier}`,
				sessionId,
				prompt: 'Say pong',
				subscriptionName: 'ask',
				event,
				timeoutMs: 1000,
				turnSettings: { tier },
			} as Parameters<typeof deps.onCueRun>[0]);
			return executeCuePrompt.mock.calls[0][0];
		};

		it("launches on the agent's own tier target", async () => {
			const config = await runTier('agent-3', 'low');
			expect(config).toMatchObject({
				customModel: 'qwen3.5-4b',
				runOn: { type: 'source', endpointId: 'maestro-server', model: 'qwen3.5-4b' },
			});
			expect(config.launchRefusal).toBeUndefined();
		});

		it('launches on the harness default when the agent sets no target for the tier', async () => {
			expect(await runTier('agent-3', 'high')).toMatchObject({
				customModel: 'opus[1m]',
				runOn: { type: 'provider' },
			});
		});

		it("sends a source agent's tier to the provider when a layer the user wrote says so", async () => {
			// agent-2 runs on Ollama; the harness default names the provider for `high`.
			expect(await runTier('agent-2', 'high')).toMatchObject({
				customModel: 'opus[1m]',
				runOn: { type: 'provider' },
			});
		});

		it('keeps a source agent on its own target for a tier only the built-in table maps', async () => {
			expect(await runTier('agent-2', 'low')).toMatchObject({ runOn: RUN_ON });
		});

		it('hands the run a refusal for a tier target that cannot be used', async () => {
			const config = await runTier('agent-3', 'medium');
			expect(config.launchRefusal).toContain('"medium" tier target cannot be used');
		});
	});

	// `model: auto` on a subscription opts its runs into model routing. The
	// prompt only exists once the executor has substituted its variables, so the
	// run is handed a hook that decides its settings then.
	describe('a subscription on the Auto model', () => {
		const runWith = async (sessionId: string, turnSettings: unknown, onLog = vi.fn()) => {
			executeCuePrompt.mockReset();
			executeCuePrompt.mockResolvedValue({ status: 'completed' } as CueRunResult);
			const deps = buildStandaloneCueEngineDeps({ onLog });
			await deps.onCueRun({
				runId: 'run-auto',
				sessionId,
				prompt: 'Review {{CUE_FILE_PATH}}',
				subscriptionName: 'review',
				event,
				timeoutMs: 1000,
				turnSettings,
			} as Parameters<typeof deps.onCueRun>[0]);
			return executeCuePrompt.mock.calls[0][0];
		};

		beforeEach(() => {
			resolveCliAutoTurn.mockReset();
			resolveCliAutoTurn.mockResolvedValue({
				model: 'haiku',
				effort: 'low',
				notes: ['Auto: Embedding router chose tier low, effort low.'],
				warnings: [],
				stamp: { status: 'routed' },
			});
		});

		it('hands the run its fallback settings and a hook that routes the substituted prompt', async () => {
			const onLog = vi.fn();
			const config = await runWith('agent-3', { model: 'auto', effort: 'high' }, onLog);

			// What the run launches with if the router gives no decision: the
			// agent's own model, and the subscription's effort. Never the word.
			expect(config).toMatchObject({ customModel: 'sonnet', customEffort: 'max' });
			expect(resolveCliAutoTurn).not.toHaveBeenCalled();

			const launch = await config.resolveLateTurn('Review src/app.ts');

			expect(resolveCliAutoTurn).toHaveBeenCalledWith({
				agent: expect.objectContaining({ id: 'agent-3' }),
				prompt: 'Review src/app.ts',
				agentEffort: undefined,
				marker: { line: 0, effort: 'high', scopes: { effort: 'subscription' } },
			});
			expect(launch).toEqual({ customModel: 'haiku', customEffort: 'low', runOn: undefined });
			expect(onLog).toHaveBeenCalledWith(
				'cue',
				'[CUE] "review" model: Auto: Embedding router chose tier low, effort low.'
			);
		});

		it("carries the routed tier's place, and a refusal as the message the run fails with", async () => {
			const local = { type: 'source', endpointId: 'maestro-server', model: 'qwen3.5-4b' };
			const config = await runWith('agent-2', { model: 'auto' });

			resolveCliAutoTurn.mockResolvedValueOnce({
				model: 'qwen3.5-4b',
				runOn: local,
				notes: [],
				warnings: [],
			});
			expect(await config.resolveLateTurn('p')).toMatchObject({ runOn: local });

			// With no place of its own the turn stays on the agent's Run on target.
			resolveCliAutoTurn.mockResolvedValueOnce({ model: 'haiku', notes: [], warnings: [] });
			expect(await config.resolveLateTurn('p')).toMatchObject({ runOn: RUN_ON });

			resolveCliAutoTurn.mockResolvedValueOnce({
				notes: [],
				warnings: ['The "low" tier target cannot run.'],
				refusal: { code: 'tier-invalid-target', message: 'The "low" tier target cannot run.' },
			});
			expect((await config.resolveLateTurn('p')).launchRefusal).toBe(
				'The "low" tier target cannot run.'
			);
		});

		it('does not route a run whose subscription did not opt in, even for an agent set to Auto', async () => {
			const config = await runWith('agent-4', undefined);

			expect(config.resolveLateTurn).toBeUndefined();
			expect(config.customModel).toBeUndefined();
			expect(config.customEffort).toBe('low');
			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
		});

		it('does not route a subscription that pins a model or a tier', async () => {
			expect((await runWith('agent-4', { model: 'opus' })).resolveLateTurn).toBeUndefined();
			expect((await runWith('agent-4', { tier: 'high' })).resolveLateTurn).toBeUndefined();
		});
	});
});
