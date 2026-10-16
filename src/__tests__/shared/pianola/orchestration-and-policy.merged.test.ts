// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/shared/pianola/pianola-orchestrator.test.ts
//   - src/__tests__/shared/pianola/pianola-orchestrator-reactive.test.ts
//   - src/__tests__/shared/pianola/pianola-policy.test.ts
//   - src/__tests__/shared/pianola/pianola-synthesis.test.ts
//   - src/__tests__/shared/pianola/supervisor-storage.test.ts
//   - src/__tests__/shared/pianola/decision-log.test.ts

import { appendDecisionLine, compactDecisionLog } from '../../../shared/pianola/decision-log';
import type { AgentRunState } from '../../../shared/pianola/pianola-completion-detector';
import {
	initialOrchestratorState,
	runOrchestratorIteration,
} from '../../../shared/pianola/pianola-orchestrator';
import type {
	OrchestratorDeps,
	OrchestratorState,
	PianolaTaskLedger,
} from '../../../shared/pianola/pianola-orchestrator';
import {
	decide,
	hasNarrowingPredicate,
	matchHasNarrowingPredicate,
	ruleAppliesToScope,
	ruleMatchesClassification,
	selectRule,
} from '../../../shared/pianola/pianola-policy';
import {
	SUGGESTION_MIN_SAMPLES,
	synthesizeSuggestions,
} from '../../../shared/pianola/pianola-synthesis';
import type { PianolaPlan, PianolaTask } from '../../../shared/pianola/pianola-tasks';
import {
	PIANOLA_DECISION_RECORD_MAX_BYTES,
	validatePianolaRule,
	validatePianolaSupervisedTarget,
	validatePianolaSupervisorFile,
} from '../../../shared/pianola/storage';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { DecisionPair, ReplyPolarity } from '../../../shared/pianola/transcript-mining';
import type {
	PianolaClassification,
	PianolaMessage,
	PianolaRisk,
	PianolaRule,
	PianolaSignalKind,
} from '../../../shared/pianola/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ===== from src/__tests__/shared/pianola/pianola-orchestrator.test.ts =====

function task(overrides: Partial<PianolaTask> = {}): PianolaTask {
	return {
		id: 't1',
		title: 'Task 1',
		prompt: 'Do the thing.',
		dependsOn: [],
		status: 'pending',
		...overrides,
	};
}

function plan(tasks: PianolaTask[], overrides: Partial<PianolaPlan> = {}): PianolaPlan {
	return {
		id: 'plan-1',
		title: 'Plan 1',
		createdAt: 1000,
		tasks,
		...overrides,
	};
}

let seq = 0;

function msg(role: PianolaMessage['role'], content: string): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	};
}

/**
 * Build orchestrator deps wired to simple in-memory fakes. `runStates` maps a task
 * id to the run state getRunState should return for it; `messages` maps a task id
 * to its recent transcript tail. Both default to a working ('busy') agent with no
 * output, so an unconfigured running task stays running.
 */
function makeDeps(
	config: {
		runStates?: Record<string, AgentRunState>;
		messages?: Record<string, readonly PianolaMessage[]>;
		ensureAgent?: OrchestratorDeps['ensureAgent'];
		dispatch?: OrchestratorDeps['dispatch'];
		notify?: OrchestratorDeps['notify'];
	} = {}
): OrchestratorDeps {
	const runStates = config.runStates ?? {};
	const messages = config.messages ?? {};
	return {
		getRunState: vi.fn(async (t: PianolaTask) => runStates[t.id] ?? 'busy'),
		getRecentMessages: vi.fn(async (t: PianolaTask) => messages[t.id] ?? []),
		ensureAgent:
			config.ensureAgent ??
			vi.fn(async (t: PianolaTask) => ({
				agentId: t.agentId ?? `agent-${t.id}`,
				agentType: t.agentType ?? 'claude-code',
			})),
		dispatch: config.dispatch ?? vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
		persist: vi.fn(),
		log: vi.fn(),
		notify: config.notify,
	};
}

function statusOf(state: OrchestratorState, id: string): string | undefined {
	return state.plan.tasks.find((t) => t.id === id)?.status;
}

describe('runOrchestratorIteration - linear A->B->C', () => {
	it('runs to completion across iterations, respecting dependency order', async () => {
		const p = plan([
			task({ id: 'A', dependsOn: [] }),
			task({ id: 'B', dependsOn: ['A'] }),
			task({ id: 'C', dependsOn: ['B'] }),
		]);
		let state = initialOrchestratorState(p);

		// Iteration 1: only A is ready, so only A is dispatched.
		let deps = makeDeps();
		let r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.dispatchedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(statusOf(r.state, 'B')).toBe('pending');
		expect(statusOf(r.state, 'C')).toBe('pending');
		expect(r.done).toBe(false);
		state = r.state;

		// Iteration 2: A completes (busy -> idle); B becomes ready and dispatches.
		deps = makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'A done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['A']);
		expect(r.dispatchedTaskIds).toEqual(['B']);
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(statusOf(r.state, 'B')).toBe('running');
		expect(statusOf(r.state, 'C')).toBe('pending');
		state = r.state;

		// Iteration 3: B completes; C dispatches.
		deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'B done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['B']);
		expect(r.dispatchedTaskIds).toEqual(['C']);
		expect(statusOf(r.state, 'C')).toBe('running');
		expect(r.done).toBe(false);
		state = r.state;

		// Iteration 4: C completes; plan is done.
		deps = makeDeps({ runStates: { C: 'idle' }, messages: { C: [msg('assistant', 'C done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['C']);
		expect(statusOf(r.state, 'C')).toBe('done');
		expect(r.done).toBe(true);
		expect(r.progress.complete).toBe(true);
		expect(r.progress.done).toBe(3);
	});

	it('does not dispatch B before A is done', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const state = initialOrchestratorState(p);
		// A is still busy after iteration 1.
		const r1 = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		// A still busy: it stays running, B stays pending.
		const r2 = await runOrchestratorIteration(r1.state, makeDeps(), { concurrencyLimit: 5 });
		expect(statusOf(r2.state, 'A')).toBe('running');
		expect(statusOf(r2.state, 'B')).toBe('pending');
		expect(r2.dispatchedTaskIds).toEqual([]);
	});
});

describe('runOrchestratorIteration - concurrency', () => {
	it('caps simultaneous running tasks at concurrencyLimit', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
		const state = initialOrchestratorState(p);
		const deps = makeDeps();
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
		expect(r.dispatchedTaskIds).toHaveLength(2);
		expect(r.progress.running).toBe(2);
		expect(r.progress.pending).toBe(1);
		// dispatch was called exactly twice, never for the third task this tick.
		expect(deps.dispatch).toHaveBeenCalledTimes(2);
	});

	it('fills a freed slot on the next iteration as running tasks complete', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: A and B run, C waits.
		let r = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 2 });
		expect(r.dispatchedTaskIds).toHaveLength(2);
		state = r.state;

		// Iteration 2: A completes, freeing a slot; C dispatches; B keeps running.
		const deps = makeDeps({
			runStates: { A: 'idle', B: 'busy' },
			messages: { A: [msg('assistant', 'A done.')] },
		});
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
		expect(r.completedTaskIds).toEqual(['A']);
		expect(r.dispatchedTaskIds).toEqual(['C']);
		expect(r.progress.running).toBe(2);
	});
});

describe('runOrchestratorIteration - failure and blocking', () => {
	it('marks a task failed, fires notify, and blocks its dependents', async () => {
		const p = plan([
			task({ id: 'A', status: 'running', agentId: 'agent-A' }),
			task({ id: 'B', dependsOn: ['A'] }),
			task({ id: 'C', dependsOn: ['B'] }),
		]);
		const state = initialOrchestratorState(p);
		const notify = vi.fn(async () => {});
		// A enters error state -> failed.
		const deps = makeDeps({ runStates: { A: 'error' }, notify });
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });

		expect(r.failedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('failed');
		// Dependents cascade to blocked.
		expect(statusOf(r.state, 'B')).toBe('blocked');
		expect(statusOf(r.state, 'C')).toBe('blocked');
		// Notify fired once with the failed task.
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith({
			kind: 'task_failed',
			task: expect.objectContaining({ id: 'A', status: 'failed' }),
		});
		// Plan is complete: nothing left that can run.
		expect(r.done).toBe(true);
		expect(r.progress.failed).toBe(1);
		expect(r.progress.blocked).toBe(2);
	});

	it('captures the failure reason as the task error', async () => {
		const p = plan([task({ id: 'A', status: 'running', agentId: 'agent-A' })]);
		const state = initialOrchestratorState(p);
		const deps = makeDeps({
			runStates: { A: 'idle' },
			messages: { A: [msg('error', 'fatal error: build broke')] },
		});
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('failed');
		const failed = r.state.plan.tasks.find((t) => t.id === 'A');
		expect(failed?.error).toBeTruthy();
	});

	it('does not throw when notify rejects', async () => {
		const p = plan([task({ id: 'A', status: 'running', agentId: 'agent-A' })]);
		const state = initialOrchestratorState(p);
		const notify = vi.fn(async () => {
			throw new Error('toast backend down');
		});
		const deps = makeDeps({ runStates: { A: 'error' }, notify });
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('failed');
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

describe('runOrchestratorIteration - agent and dispatch failures', () => {
	it('leaves a task pending when ensureAgent errors, then dispatches once it succeeds', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: ensureAgent fails -> A stays pending, dispatch never called.
		const failingEnsure = vi.fn(async () => ({ error: 'no capacity' }));
		const dispatch1 = vi.fn(async () => ({ success: true, tabId: 'tab-1' }));
		let r = await runOrchestratorIteration(
			state,
			makeDeps({ ensureAgent: failingEnsure, dispatch: dispatch1 }),
			{ concurrencyLimit: 5 }
		);
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(r.dispatchedTaskIds).toEqual([]);
		expect(dispatch1).not.toHaveBeenCalled();
		state = r.state;

		// Iteration 2: ensureAgent succeeds -> A dispatches.
		r = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(r.dispatchedTaskIds).toEqual(['A']);
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentType).toBe('claude-code');
	});

	it('leaves a task pending when dispatch fails without permanently consuming a slot', async () => {
		// A's dispatch fails; B should still take the slot in the same iteration.
		const p = plan([task({ id: 'A' }), task({ id: 'B' })]);
		const state = initialOrchestratorState(p);
		const dispatch = vi.fn(async (t: PianolaTask) =>
			t.id === 'A' ? { success: false, error: 'agent busy' } : { success: true, tabId: 'tab-B' }
		);
		const r = await runOrchestratorIteration(state, makeDeps({ dispatch }), {
			concurrencyLimit: 1,
		});
		// A failed to dispatch (stays pending), B consumed the single slot.
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(statusOf(r.state, 'B')).toBe('running');
		expect(r.dispatchedTaskIds).toEqual(['B']);
		expect(r.progress.running).toBe(1);
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentType).toBe('claude-code');
	});

	it('retries a dispatch failure on the next iteration', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);
		let attempt = 0;
		const dispatch = vi.fn(async () => {
			attempt += 1;
			return attempt === 1
				? { success: false, error: 'transient' }
				: { success: true, tabId: 'tab-1' };
		});
		// First tick: dispatch fails, A stays pending.
		let r = await runOrchestratorIteration(state, makeDeps({ dispatch }), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('pending');
		state = r.state;
		// Second tick: same dispatch fake now succeeds.
		r = await runOrchestratorIteration(state, makeDeps({ dispatch }), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('running');
	});
});

describe('runOrchestratorIteration - persistence and progress', () => {
	it('calls persist once per iteration with the updated plan', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const deps = makeDeps();
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(deps.persist).toHaveBeenCalledTimes(1);
		// persist receives the final plan for this iteration (A now running).
		expect(deps.persist).toHaveBeenCalledWith(r.state.plan);
		expect(statusOf(r.state, 'A')).toBe('running');
	});

	it('flips done true only when all tasks are terminal or blocked', async () => {
		const p = plan([task({ id: 'A', status: 'done' }), task({ id: 'B', status: 'running' })]);
		const state = initialOrchestratorState(p);
		// B still busy: not done.
		const r1 = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(r1.done).toBe(false);
		// B completes: now done.
		const deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'ok')] } });
		const r2 = await runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
		expect(r2.done).toBe(true);
	});

	it('does not mutate the input state or plan', async () => {
		const p = plan([task({ id: 'A' })]);
		const state = initialOrchestratorState(p);
		const snapshot = JSON.parse(JSON.stringify(state));
		await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(state).toEqual(snapshot);
	});
});

describe('runOrchestratorIteration - prevStates carry-across', () => {
	it('detects a busy->idle transition using prevStates from the prior iteration', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: A dispatched. It is seeded 'connecting' (its just-spun-up
		// state) so the next poll has a working state to compare against.
		let r = await runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
			concurrencyLimit: 5,
		});
		expect(r.state.prevStates.A).toBe('connecting');
		expect(statusOf(r.state, 'A')).toBe('running');
		state = r.state;

		// Iteration 2: A now idle. The carried prev state ('connecting') makes this a
		// working->idle transition, so the task is detected done.
		r = await runOrchestratorIteration(
			state,
			makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'finished')] } }),
			{ concurrencyLimit: 5 }
		);
		expect(r.completedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('done');
	});

	it('only carries forward run states observed this iteration', async () => {
		const p = plan([task({ id: 'A', status: 'running' }), task({ id: 'B', status: 'done' })]);
		const state: OrchestratorState = {
			plan: p,
			prevStates: { A: 'busy', B: 'idle' },
		};
		const r = await runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
			concurrencyLimit: 5,
		});
		// Only A is polled (running), so prevStates holds A only; B's stale entry drops.
		expect(r.state.prevStates).toEqual({ A: 'busy' });
	});
});

describe('runOrchestratorIteration - dispatch failure does not leak agents', () => {
	it('persists the bound agent on a failed dispatch so the retry reuses it', async () => {
		const p = plan([task({ id: 'A' })]);
		let created = 0;
		const ensureAgent: OrchestratorDeps['ensureAgent'] = vi.fn(async (t: PianolaTask) => {
			if (t.agentId) return { agentId: t.agentId };
			created += 1;
			return { agentId: `created-${created}` };
		});
		let failNext = true;
		const dispatch: OrchestratorDeps['dispatch'] = vi.fn(async () => {
			if (failNext) {
				failNext = false;
				return { success: false, error: 'transient' };
			}
			return { success: true, tabId: 'tab-1' };
		});

		let state = initialOrchestratorState(p);
		let r = await runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
			concurrencyLimit: 1,
		});
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentId).toBe('created-1');
		state = r.state;

		r = await runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
			concurrencyLimit: 1,
		});
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(created).toBe(1);
	});
});

// ===== from src/__tests__/shared/pianola/pianola-orchestrator-reactive.test.ts =====

function task_1(overrides: Partial<PianolaTask> = {}): PianolaTask {
	return {
		id: 't1',
		title: 'Task 1',
		prompt: 'Do the thing.',
		dependsOn: [],
		status: 'pending',
		...overrides,
	};
}

function plan_1(tasks: PianolaTask[], overrides: Partial<PianolaPlan> = {}): PianolaPlan {
	return {
		id: 'plan-1',
		title: 'Plan 1',
		createdAt: 1000,
		tasks,
		...overrides,
	};
}

interface ReactiveConfig {
	runStates?: Record<string, AgentRunState>;
	messages?: Record<string, readonly PianolaMessage[]>;
	reactiveEnabled?: OrchestratorDeps['reactiveEnabled'];
	getRunLedger?: OrchestratorDeps['getRunLedger'];
	dispatchFix?: OrchestratorDeps['dispatchFix'];
	requestMerge?: OrchestratorDeps['requestMerge'];
	notify?: OrchestratorDeps['notify'];
}

/**
 * Deps with the reactive-loop side effects injectable. Defaults: a running task
 * is observed idle (so a working->idle transition settles it), no transcript
 * (no failure marker), and NO reactive gate wired unless the test wires one.
 */
function makeReactiveDeps(config: ReactiveConfig = {}): OrchestratorDeps {
	const runStates = config.runStates ?? {};
	const messages = config.messages ?? {};
	return {
		getRunState: vi.fn(async (t: PianolaTask) => runStates[t.id] ?? 'idle'),
		getRecentMessages: vi.fn(async (t: PianolaTask) => messages[t.id] ?? []),
		ensureAgent: vi.fn(async (t: PianolaTask) => ({
			agentId: t.agentId ?? `agent-${t.id}`,
			agentType: 'claude-code',
		})),
		dispatch: vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
		persist: vi.fn(),
		log: vi.fn(),
		notify: config.notify,
		reactiveEnabled: config.reactiveEnabled,
		getRunLedger: config.getRunLedger,
		dispatchFix: config.dispatchFix,
		requestMerge: config.requestMerge,
	};
}

function statusOf_1(state: OrchestratorState, id: string): string | undefined {
	return state.plan.tasks.find((t) => t.id === id)?.status;
}

function taskOf(state: OrchestratorState, id: string): PianolaTask | undefined {
	return state.plan.tasks.find((t) => t.id === id);
}

/** A running task observed working last tick, so getRunState 'idle' this tick settles it. */
function runningState(t: PianolaTask): OrchestratorState {
	return { plan: plan_1([t]), prevStates: { [t.id]: 'busy' } };
}

// ---------------------------------------------------------------------------
// ISC-8.13 - reactiveEnabled master gate: supervisor parity when off/absent
// ---------------------------------------------------------------------------

describe('reactiveEnabled gate (ISC-8.13)', () => {
	it('leaves a needs_review task untouched when reactiveEnabled returns false', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review' })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => false,
			// A fully-green ledger AND open-finding ledger would BOTH trigger action
			// if the gate were open; with it closed, neither dep may fire.
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			dispatchFix,
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf_1(r.state, 'A')).toBe('needs_review');
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(requestMerge).not.toHaveBeenCalled();
		expect(r.completedTaskIds).toEqual([]);
	});

	it('leaves a needs_review task untouched when reactiveEnabled is absent', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review' })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const deps = makeReactiveDeps({
			// reactiveEnabled omitted entirely.
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			dispatchFix,
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf_1(r.state, 'A')).toBe('needs_review');
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(requestMerge).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// ISC-8.14 - green task merges once then settles done; never re-merges
// ---------------------------------------------------------------------------

describe('green task merge + settle (ISC-8.14)', () => {
	it('requests a merge once, settles to done, and does not re-merge next iteration', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const ledger: PianolaTaskLedger = { openFindings: 0, checksPassed: true, runId: 'r-A' };
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			requestMerge,
		});

		// Iteration 1: green -> merge requested once, task settles to done.
		const r1 = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(requestMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), ledger);
		expect(statusOf_1(r1.state, 'A')).toBe('done');
		expect(r1.completedTaskIds).toEqual(['A']);

		// Iteration 2: the task is now terminal (done); the needs_review filter
		// skips it, so NO second merge is requested - proves the no-repeat-merge fix.
		const r2 = await runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(statusOf_1(r2.state, 'A')).toBe('done');
		expect(r2.completedTaskIds).toEqual([]);
	});

	it('settles to done even when the merge is not performed (recorded, never re-attempted)', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: false, error: 'not mergeable' }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(statusOf_1(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
	});

	it('does not treat a task with open findings as green (no merge)', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			// checks pass but a finding is still open -> NOT fully green.
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: true, runId: 'r-A' })),
			requestMerge,
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).not.toHaveBeenCalled();
		// Falls through to the fix cycle instead.
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf_1(r.state, 'A')).toBe('fixing');
	});
});

// ---------------------------------------------------------------------------
// ISC-8.8 - bounded auto-fix: dispatch, increment, escalate at the cap
// ---------------------------------------------------------------------------

describe('bounded auto-fix cycle (ISC-8.8)', () => {
	it('dispatches a fix for an open-findings task, moving it to fixing and incrementing fixAttempts', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const ledger: PianolaTaskLedger = { openFindings: 2, checksPassed: false, runId: 'r-A' };
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(dispatchFix).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), ledger);
		expect(statusOf_1(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(1);
	});

	it('leaves the task in needs_review (no increment) when the fix dispatch fails', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 1 })]);
		const dispatchFix = vi.fn(async () => ({ success: false, error: 'agent busy' }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf_1(r.state, 'A')).toBe('needs_review');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(1);
	});

	it('still dispatches a fix at fixAttempts 2 (just under the cap)', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 2 })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf_1(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);
	});

	it('escalates a still-needs_review task to failed at the cap, dispatching no further fix', async () => {
		const p = plan_1([task_1({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 3 })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const notify = vi.fn(async () => {});
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
			notify,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf_1(r.state, 'A')).toBe('failed');
		expect(r.failedTaskIds).toEqual(['A']);
		expect(taskOf(r.state, 'A')?.error).toMatch(/fix loop exhausted/i);
		// The cap is a hard stop: no fix is dispatched for a task at the limit.
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('accumulates fixAttempts across iterations and escalates on the fourth review', async () => {
		// Drive the real fixing<->needs_review cycle: each tick the fix agent is
		// seen going working->idle (prevStates seeded 'busy'), the ledger still has
		// open findings, so the task re-enters needs_review and the counter climbs.
		const ledger: PianolaTaskLedger = {
			openCriticalOrHighFindings: 1,
			openFindings: 1,
			checksPassed: false,
			runId: 'r-A',
		};
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			dispatchFix,
		});

		// Start already fixing (attempt 1 in flight), observed busy last tick.
		let state: OrchestratorState = {
			plan: plan_1([task_1({ id: 'A', status: 'fixing', runId: 'r-A', fixAttempts: 1 })]),
			prevStates: { A: 'busy' },
		};

		// Tick 1: fix finishes -> ledger not green -> needs_review -> dispatch fix (attempt 2).
		let r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(2);

		// Tick 2: same cycle -> attempt 3. Re-seed 'busy' (fix agent ran again).
		state = { plan: r.state.plan, prevStates: { A: 'busy' } };
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);

		// Tick 3: fix finishes, task re-enters needs_review at attempts 3 -> escalate.
		state = { plan: r.state.plan, prevStates: { A: 'busy' } };
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('failed');
		expect(r.failedTaskIds).toEqual(['A']);

		// Exactly two more fix dispatches happened (attempts 2 and 3); the fourth
		// review escalated instead of dispatching a fifth.
		expect(dispatchFix).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// ISC-8.4 - a running task settles on its ledger, not busy->idle alone
// ---------------------------------------------------------------------------

describe('ledger-driven settle of a running task (ISC-8.4)', () => {
	it('routes a completed run with open critical/high findings to needs_review, not done', async () => {
		const t = task_1({ id: 'A', status: 'running', runId: 'r-A' });
		// reactiveEnabled OFF so the settled needs_review is not swept into the fix
		// cycle in the same tick - isolates the poll-time ledger gate.
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({ openCriticalOrHighFindings: 2, runId: 'r-A' })),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('needs_review');
		expect(r.completedTaskIds).toEqual([]);
		expect(taskOf(r.state, 'A')?.runId).toBe('r-A');
	});

	it('routes a completed run with failing checks to needs_review, not done', async () => {
		const t = task_1({ id: 'A', status: 'running', runId: 'r-A' });
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({
				openCriticalOrHighFindings: 0,
				checksPassed: false,
				runId: 'r-A',
			})),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('needs_review');
		expect(r.completedTaskIds).toEqual([]);
	});

	it('settles a completed run with a clean ledger to done', async () => {
		const t = task_1({ id: 'A', status: 'running', runId: 'r-A' });
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({
				openCriticalOrHighFindings: 0,
				checksPassed: true,
				runId: 'r-A',
			})),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
		expect(taskOf(r.state, 'A')?.runId).toBe('r-A');
	});

	it('settles to done when no ledger reader is wired (falls back to busy->idle)', async () => {
		const t = task_1({ id: 'A', status: 'running' });
		const deps = makeReactiveDeps({ runStates: { A: 'idle' } }); // no getRunLedger
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf_1(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
	});
});

// ===== from src/__tests__/shared/pianola/pianola-policy.test.ts =====

function classification(
	overrides: Partial<PianolaClassification> & { kind: PianolaSignalKind; risk: PianolaRisk }
): PianolaClassification {
	return {
		topic: 'should i use tabs',
		confidence: 'medium',
		evidence: { messageId: 'm1', reason: 'test', structured: false },
		...overrides,
	};
}

let ruleSeq = 0;

function rule(overrides: Partial<PianolaRule>): PianolaRule {
	ruleSeq += 1;
	return {
		id: `r${ruleSeq}`,
		enabled: true,
		scope: 'global',
		match: {},
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 100,
		createdAt: ruleSeq,
		updatedAt: ruleSeq,
		...overrides,
	};
}

describe('decide - safety defaults', () => {
	it('ignores a none classification', () => {
		const d = decide(classification({ kind: 'none', risk: 'low' }), [rule({})]);
		expect(d.action).toBe('ignore');
		expect(d.matchedRuleId).toBeNull();
	});

	it('escalates when no rule matches', () => {
		const d = decide(classification({ kind: 'question', risk: 'low' }), []);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBeNull();
	});

	it('never auto-answers a high-risk prompt even if a rule says to', () => {
		const r = rule({ match: { maxRisk: 'high' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'high' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBe(r.id);
		expect(d.reason).toContain('high-risk');
	});

	it('never lets an ignore rule suppress a high-risk prompt', () => {
		// Regression: high-risk override must run before rule actions, so a broad
		// ignore rule cannot silence the most important alerts.
		const r = rule({ action: 'ignore', match: {} });
		const d = decide(classification({ kind: 'blocked', risk: 'high' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('high-risk');
	});
});

describe('decide - rule actions', () => {
	it('auto-answers a low-risk prompt matched by a rule', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'Use tabs.' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d).toMatchObject({ action: 'auto_answer', answer: 'Use tabs.', matchedRuleId: r.id });
	});

	it('escalates an auto-answer rule that has no narrowing predicate (too broad)', () => {
		const r = rule({ match: {}, action: 'auto_answer', answer: 'sure' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('narrowing predicate');
	});

	it('escalates when matched auto-answer rule has no answer text', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: '   ' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('no answer');
	});

	it('honors an explicit escalate rule', () => {
		const r = rule({ action: 'escalate' });
		const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.matchedRuleId).toBe(r.id);
	});

	it('honors an explicit ignore rule for a non-high-risk prompt', () => {
		const r = rule({ action: 'ignore', match: { maxRisk: 'low' } });
		const d = decide(classification({ kind: 'blocked', risk: 'low' }), [r]);
		expect(d.action).toBe('ignore');
		expect(d.matchedRuleId).toBe(r.id);
	});
});

describe('matchHasNarrowingPredicate', () => {
	it('treats maxRisk, kinds, or topicIncludes as narrowing', () => {
		expect(matchHasNarrowingPredicate({ maxRisk: 'low' })).toBe(true);
		expect(matchHasNarrowingPredicate({ kinds: ['question'] })).toBe(true);
		expect(matchHasNarrowingPredicate({ topicIncludes: ['naming'] })).toBe(true);
	});

	it('treats an empty match as not narrowing', () => {
		expect(matchHasNarrowingPredicate({})).toBe(false);
		expect(matchHasNarrowingPredicate({ kinds: [], topicIncludes: [] })).toBe(false);
	});

	it('hasNarrowingPredicate delegates to the match check', () => {
		expect(hasNarrowingPredicate(rule({ match: { maxRisk: 'low' } }))).toBe(true);
		expect(hasNarrowingPredicate(rule({ match: {} }))).toBe(false);
	});
});

describe('rule matching', () => {
	it('respects maxRisk', () => {
		const r = rule({ match: { maxRisk: 'low' } });
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
			true
		);
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'medium' }))).toBe(
			false
		);
	});

	it('respects kinds filter', () => {
		const r = rule({ match: { kinds: ['blocked'] } });
		expect(ruleMatchesClassification(r, classification({ kind: 'blocked', risk: 'low' }))).toBe(
			true
		);
		expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
			false
		);
	});

	it('respects topicIncludes (case-insensitive)', () => {
		const r = rule({ match: { topicIncludes: ['TABS'] } });
		expect(
			ruleMatchesClassification(
				r,
				classification({ kind: 'question', risk: 'low', topic: 'should i use tabs' })
			)
		).toBe(true);
		expect(
			ruleMatchesClassification(
				r,
				classification({ kind: 'question', risk: 'low', topic: 'rename the module' })
			)
		).toBe(false);
	});
});

describe('scope filtering', () => {
	it('global rules always apply', () => {
		expect(ruleAppliesToScope(rule({ scope: 'global' }), {})).toBe(true);
	});

	it('project rules apply only for the matching project path', () => {
		const r = rule({ scope: 'project', scopeId: '/repo/a' });
		expect(ruleAppliesToScope(r, { projectPath: '/repo/a' })).toBe(true);
		expect(ruleAppliesToScope(r, { projectPath: '/repo/b' })).toBe(false);
		expect(ruleAppliesToScope(r, {})).toBe(false);
	});

	it('tab rules apply only for the matching tab id', () => {
		const r = rule({ scope: 'tab', scopeId: 'tab-1' });
		expect(ruleAppliesToScope(r, { tabId: 'tab-1' })).toBe(true);
		expect(ruleAppliesToScope(r, { tabId: 'tab-2' })).toBe(false);
	});
});

describe('selectRule precedence', () => {
	it('picks the lowest priority number among matches', () => {
		const low = rule({ priority: 10, answer: 'low-pri-wins' });
		const high = rule({ priority: 50, answer: 'high-pri' });
		const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [high, low], {});
		expect(picked?.id).toBe(low.id);
	});

	it('skips disabled and out-of-scope rules', () => {
		const disabled = rule({ priority: 1, enabled: false });
		const wrongScope = rule({ priority: 2, scope: 'project', scopeId: '/other' });
		const ok = rule({ priority: 3 });
		const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [
			disabled,
			wrongScope,
			ok,
		]);
		expect(picked?.id).toBe(ok.id);
	});
});

describe('decide - confidence gating', () => {
	it('escalates instead of auto-answering a low-confidence classification', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'low' }), [r]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('low-confidence');
	});

	it('still auto-answers a medium-confidence classification matched by a rule', () => {
		const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
		const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'medium' }), [r]);
		expect(d.action).toBe('auto_answer');
	});
});

describe('scope normalization case-sensitivity', () => {
	const originalPlatform = process.platform;
	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
	});

	it('folds case on Windows (case-insensitive filesystem)', () => {
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		const r = rule({ scope: 'project', scopeId: 'C:/Repo/App' });
		expect(ruleAppliesToScope(r, { projectPath: 'c:/repo/app' })).toBe(true);
	});

	it('does NOT fold case off Windows (case-sensitive filesystem)', () => {
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		const r = rule({ scope: 'project', scopeId: '/repo/App' });
		expect(ruleAppliesToScope(r, { projectPath: '/repo/app' })).toBe(false);
		expect(ruleAppliesToScope(r, { projectPath: '/repo/App' })).toBe(true);
	});
});

// ===== from src/__tests__/shared/pianola/pianola-synthesis.test.ts =====

function pair(
	kind: PianolaSignalKind,
	risk: PianolaRisk,
	polarity: ReplyPolarity,
	i = 0
): DecisionPair {
	return {
		agent: 'claude-code',
		sessionId: `s${i}`,
		classification: {
			kind,
			risk,
			topic: 'something',
			confidence: 'medium',
			evidence: { messageId: `m${i}`, reason: 'test', structured: false },
		},
		ask: 'May I proceed?',
		reply: polarity === 'affirmative' ? 'yes' : 'no',
		polarity,
		askedAt: '2026-01-01T00:00:00.000Z',
		repliedAt: '2026-01-01T00:00:01.000Z',
	};
}

function manyPairs(
	kind: PianolaSignalKind,
	risk: PianolaRisk,
	count: number,
	affirmative: number
): DecisionPair[] {
	const out: DecisionPair[] = [];
	for (let i = 0; i < count; i++) {
		out.push(pair(kind, risk, i < affirmative ? 'affirmative' : 'other', i));
	}
	return out;
}

describe('synthesizeSuggestions', () => {
	it('proposes a low-risk auto_answer rule for a consistently-approved kind', () => {
		const pairs = manyPairs('question', 'low', SUGGESTION_MIN_SAMPLES, SUGGESTION_MIN_SAMPLES);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(1);
		expect(proposals[0].action).toBe('auto_answer');
		expect(proposals[0].match.kinds).toEqual(['question']);
		expect(proposals[0].match.maxRisk).toBe('low');
	});

	it('every proposal is valid per validatePianolaRule', () => {
		const pairs = [...manyPairs('question', 'low', 10, 10), ...manyPairs('blocked', 'low', 10, 9)];
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals.length).toBeGreaterThan(0);
		for (const p of proposals) {
			expect(validatePianolaRule(p)).not.toBeNull();
		}
	});

	it('does not propose below the sample threshold', () => {
		const pairs = manyPairs(
			'question',
			'low',
			SUGGESTION_MIN_SAMPLES - 1,
			SUGGESTION_MIN_SAMPLES - 1
		);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('does not propose when approvals are inconsistent', () => {
		// 10 samples, only 5 affirmative (50%) - below the ratio.
		const pairs = manyPairs('question', 'low', 10, 5);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('never proposes an auto_answer for medium or high risk', () => {
		const pairs = [
			...manyPairs('question', 'medium', 20, 20),
			...manyPairs('blocked', 'high', 20, 20),
		];
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('does not duplicate a kind already covered by an existing rule', () => {
		const existing: PianolaRule = {
			id: 'r1',
			enabled: true,
			scope: 'global',
			match: { kinds: ['question'], maxRisk: 'low' },
			action: 'auto_answer',
			answer: 'sure',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const pairs = manyPairs('question', 'low', 10, 10);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('builds a profile diff against the existing profile', () => {
		const pairs = manyPairs('question', 'low', 6, 6);
		const { profileDiff } = synthesizeSuggestions({
			pairs,
			existingRules: [],
			existingProfile: 'old profile',
			now: 1,
		});
		expect(profileDiff.before).toBe('old profile');
		expect(profileDiff.after.length).toBeGreaterThan(0);
		expect(profileDiff.changed).toBe(true);
	});

	it('reports no profile change for an empty corpus', () => {
		const { profileDiff, proposals } = synthesizeSuggestions({
			pairs: [],
			existingRules: [],
			now: 1,
		});
		expect(proposals).toHaveLength(0);
		expect(profileDiff.changed).toBe(false);
	});
});

describe('synthesizeSuggestions - safety scoping', () => {
	it('never proposes for the blocked kind (only question)', () => {
		const pairs = manyPairs('blocked', 'low', 50, 50);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
		expect(proposals).toHaveLength(0);
	});

	it('treats an existing kinds-only rule (no maxRisk) as already covering', () => {
		const existing: PianolaRule = {
			id: 'r-no-maxrisk',
			enabled: true,
			scope: 'global',
			match: { kinds: ['question'] },
			action: 'auto_answer',
			answer: 'sure',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const pairs = manyPairs('question', 'low', 10, 10);
		const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
		expect(proposals).toHaveLength(0);
	});
});

// ===== from src/__tests__/shared/pianola/supervisor-storage.test.ts =====

function validWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'w1',
		kind: 'watch',
		enabled: true,
		createdAt: 1,
		tabId: 'tab-1',
		agentId: 'agent-1',
		...overrides,
	};
}

function validOrchestrate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'o1',
		kind: 'orchestrate',
		enabled: true,
		createdAt: 2,
		planId: 'plan-1',
		...overrides,
	};
}

describe('validatePianolaSupervisorFile', () => {
	it('accepts well-formed watch and orchestrate targets', () => {
		const result = validatePianolaSupervisorFile({
			targets: [validWatch(), validOrchestrate()],
		});
		expect(result.targets).toHaveLength(2);
		const [watch, orchestrate] = result.targets;
		expect(watch).toMatchObject({
			id: 'w1',
			kind: 'watch',
			tabId: 'tab-1',
			agentId: 'agent-1',
		});
		expect(orchestrate).toMatchObject({ id: 'o1', kind: 'orchestrate', planId: 'plan-1' });
	});

	it('keeps optional intervalSeconds and concurrency when present and numeric', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ intervalSeconds: 10 }),
				validOrchestrate({ intervalSeconds: 7, concurrency: 4 }),
			],
		});
		expect(result.targets[0].intervalSeconds).toBe(10);
		expect(result.targets[1].intervalSeconds).toBe(7);
		expect(result.targets[1].concurrency).toBe(4);
	});

	it('drops a watch target missing tabId or agentId', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ tabId: undefined }),
				validWatch({ id: 'w2', agentId: undefined }),
				validWatch({ id: 'w3' }),
			],
		});
		// Only the fully-specified watch survives.
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0].id).toBe('w3');
	});

	it('drops an orchestrate target missing planId', () => {
		const result = validatePianolaSupervisorFile({
			targets: [validOrchestrate({ planId: undefined }), validOrchestrate({ id: 'o2' })],
		});
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0].id).toBe('o2');
	});

	it('drops targets with an invalid kind, enabled, createdAt, or empty id', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ kind: 'nonsense' }),
				validWatch({ id: 'w2', enabled: 'yes' }),
				validWatch({ id: 'w3', createdAt: 'soon' }),
				validWatch({ id: '' }),
			],
		});
		expect(result.targets).toHaveLength(0);
	});

	it('returns a well-formed empty object for junk input', () => {
		expect(validatePianolaSupervisorFile(null)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile(undefined)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile('nope')).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile(42)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile([])).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({})).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({ targets: 'not-an-array' })).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({ targets: [1, 'x', null, {}] })).toEqual({ targets: [] });
	});
});

describe('validatePianolaSupervisedTarget', () => {
	it('returns the typed target for valid input', () => {
		const target = validatePianolaSupervisedTarget(validWatch());
		const expected: PianolaSupervisedTarget = {
			id: 'w1',
			kind: 'watch',
			enabled: true,
			createdAt: 1,
			tabId: 'tab-1',
			agentId: 'agent-1',
		};
		expect(target).toEqual(expected);
	});

	it('returns null for a non-finite numeric field', () => {
		expect(validatePianolaSupervisedTarget(validWatch({ createdAt: Number.NaN }))).toBeNull();
		expect(
			validatePianolaSupervisedTarget(validOrchestrate({ concurrency: Number.POSITIVE_INFINITY }))
		).toBeNull();
	});

	it('returns null when an optional field is present but the wrong type', () => {
		expect(validatePianolaSupervisedTarget(validWatch({ intervalSeconds: '5' }))).toBeNull();
		expect(validatePianolaSupervisedTarget(validOrchestrate({ planId: 123 }))).toBeNull();
	});
});

// ===== from src/__tests__/shared/pianola/decision-log.test.ts =====

let dir: string;

let file: string;

/** A valid JSON-object line, comfortably over the 50-byte record floor. */
function jsonLine(i: number): string {
	return `${JSON.stringify({ id: `rec-${String(i).padStart(5, '0')}`, pad: 'x'.repeat(50) })}\n`;
}

function writeLines(count: number): void {
	for (let i = 0; i < count; i += 1) appendDecisionLine(file, jsonLine(i));
}

function nonEmptyLines(): string[] {
	return fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
}

describe('compactDecisionLog', () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-declog-'));
		file = path.join(dir, 'pianola-decisions.jsonl');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('trims to maxRecords on the record-count trigger (file under the byte cap)', () => {
		writeLines(25);
		expect(fs.statSync(file).size).toBeLessThan(1_000_000);
		compactDecisionLog(file, 10, 1_000_000);
		const lines = nonEmptyLines();
		expect(lines.length).toBe(10);
		// Oldest dropped, newest kept.
		expect(lines.some((l) => l.includes('rec-00024'))).toBe(true);
		expect(lines.some((l) => l.includes('rec-00000'))).toBe(false);
	});

	it('leaves a file already within both caps unchanged', () => {
		writeLines(8);
		const before = fs.readFileSync(file, 'utf-8');
		compactDecisionLog(file, 10, 1_000_000);
		expect(fs.readFileSync(file, 'utf-8')).toBe(before);
	});

	it('does not leave a .lock behind after compaction', () => {
		writeLines(25);
		compactDecisionLog(file, 10, 1_000_000);
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	it('honors BOTH caps under a tiny byte budget', () => {
		writeLines(25);
		const byteCap = 200;
		compactDecisionLog(file, 10, byteCap);
		const lines = nonEmptyLines();
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(fs.statSync(file).size).toBeLessThanOrEqual(byteCap);
	});
});

/** A record line whose serialized byte length exceeds the per-record cap. */
function oversizedLine(): string {
	const answer = 'x'.repeat(PIANOLA_DECISION_RECORD_MAX_BYTES);
	return `${JSON.stringify({ id: 'huge', answer })}\n`;
}

describe('appendDecisionLine - per-record byte cap', () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-declog-'));
		file = path.join(dir, 'pianola-decisions.jsonl');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('appends a normal within-cap record', () => {
		appendDecisionLine(file, jsonLine(0));
		expect(nonEmptyLines().length).toBe(1);
	});

	it('drops a single record over the per-record byte cap (never written)', () => {
		appendDecisionLine(file, oversizedLine());
		expect(fs.existsSync(file)).toBe(false);
	});

	it('keeps small records around a dropped oversized one', () => {
		appendDecisionLine(file, jsonLine(1));
		appendDecisionLine(file, oversizedLine());
		appendDecisionLine(file, jsonLine(2));
		const lines = nonEmptyLines();
		expect(lines.length).toBe(2);
		expect(lines.some((l) => l.includes('huge'))).toBe(false);
		expect(lines.some((l) => l.includes('rec-00001'))).toBe(true);
		expect(lines.some((l) => l.includes('rec-00002'))).toBe(true);
	});
});
