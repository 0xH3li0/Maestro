// @vitest-environment node
/** Real YAML loading and timer sources; native notifications are deliberately lost. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'chokidar';
import { createMockSession } from './cue-test-helpers';

vi.mock('chokidar', () => ({
	watch: vi.fn(() => Object.assign(new EventEmitter(), { close: vi.fn() })),
}));
vi.mock('../../../main/cue/cue-db', () => ({ clearGitHubSeenForSubscription: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	createCueSessionRuntimeService,
	type CueSessionRuntimeServiceDeps,
} from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { writeCueYamlAtomicSync } from '../../../main/cue/cue-yaml-write';

describe('shared cwd Cue health', () => {
	let root: string;
	let configPath: string;
	let runtime: ReturnType<typeof createCueSessionRuntimeService>;
	let registry: ReturnType<typeof createCueSessionRegistry>;
	let intervals: ReturnType<typeof vi.spyOn<typeof globalThis, 'setInterval'>>;
	const onLog = vi.fn();
	const dispatch = vi.fn<CueSessionRuntimeServiceDeps['dispatchSubscription']>(() => 1);
	const sessions = ['Mira', 'Claude', 'OpenCode', 'Copilot'].map((name) =>
		createMockSession({ id: name.toLowerCase(), name })
	);
	const refresh = vi.fn((id: string, cwd: string) => runtime.refreshSession(id, cwd));

	beforeEach(() => {
		vi.useFakeTimers();
		intervals = vi.spyOn(globalThis, 'setInterval');
		fs.mkdirSync('.build', { recursive: true });
		root = fs.mkdtempSync(path.resolve('.build/cue-shared-health-'));
		fs.mkdirSync(path.join(root, '.maestro'));
		configPath = path.join(root, '.maestro/cue.yaml');
		fs.writeFileSync(configPath, 'subscriptions: []\n');
		for (const session of sessions) session.projectRoot = root;
		registry = createCueSessionRegistry();
		runtime = createCueSessionRuntimeService({
			enabled: () => true,
			getSessions: () => sessions,
			registry,
			onRefreshRequested: refresh,
			onLog,
			dispatchSubscription: dispatch,
			clearQueue: vi.fn(),
			clearFanInState: vi.fn(),
		});
	});

	afterEach(() => {
		runtime.clearAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each([2, 4])(
		'heals repeated missed edits for %i agents without health notifications',
		(agentCount) => {
			for (const session of sessions.slice(0, agentCount)) {
				runtime.initSession(session, { reason: 'discovery' });
			}
			for (let edit = 0; edit < 2; edit++) {
				// Cross the sticky-toast bridge's five-minute coalescing window.
				vi.advanceTimersByTime(12 * 30_000);
				expect(refresh).toHaveBeenCalledTimes(edit * agentCount);
				writeCueYamlAtomicSync(configPath, `subscriptions: []\n# edit ${edit}\n`);
				vi.advanceTimersByTime(31_000);
				expect(refresh).toHaveBeenCalledTimes((edit + 1) * agentCount);
			}
			vi.advanceTimersByTime(12 * 30_000);
			expect(refresh).toHaveBeenCalledTimes(2 * agentCount);
			expect(
				onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')
			).toEqual([]);
		}
	);

	it('replaces real interval timers for every target and ignores late native events', () => {
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		for (const minutes of [15, 20, 25]) {
			writeCueYamlAtomicSync(
				configPath,
				`subscriptions:\n${sessions
					.map(
						(session) =>
							`  - name: ${session.id}-timer\n    agent_id: ${session.id}\n    event: time.heartbeat\n    interval_minutes: ${minutes}\n    prompt: inert test\n`
					)
					.join('')}`
			);
			if (minutes === 15) {
				for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
			} else {
				vi.advanceTimersByTime(31_000);
			}
			expect(dispatch).toHaveBeenCalledTimes(((minutes - 15) / 5 + 1) * 4);
			const currentTimers = intervals.mock.calls.flatMap(([callback, delay], index) =>
				delay === minutes * 60_000 ? [{ callback, timer: intervals.mock.results[index].value }] : []
			);
			expect(currentTimers).toHaveLength(4);
			for (const session of sessions) {
				expect(registry.get(session.id)?.triggerSources).toHaveLength(1);
				const nextFire = registry.get(session.id)!.triggerSources[0].nextTriggerAt();
				expect(nextFire).toBeGreaterThan(Date.now() + (minutes - 1) * 60_000);
				expect(nextFire).toBeLessThanOrEqual(Date.now() + minutes * 60_000);
			}
			const refreshCount = refresh.mock.calls.length;
			for (const result of vi.mocked(watch).mock.results) result.value.emit('change', configPath);
			vi.advanceTimersByTime(1000 + 12 * 30_000);
			expect(refresh).toHaveBeenCalledTimes(refreshCount);
			for (const { timer } of currentTimers)
				expect(clearIntervalSpy).not.toHaveBeenCalledWith(timer);
		}
		const oldTimers = intervals.mock.calls.flatMap(([, delay], index) =>
			delay === 15 * 60_000 || delay === 20 * 60_000 ? [intervals.mock.results[index].value] : []
		);
		for (const timer of oldTimers) expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
		expect(vi.getTimerCount()).toBe(8); // Four health polls and four current intervals.
		dispatch.mockClear();
		for (const [callback, delay] of intervals.mock.calls) {
			if (delay === 25 * 60_000) (callback as () => void)();
		}
		expect(dispatch.mock.calls.map(([id]) => id)).toEqual(sessions.map((session) => session.id));
		expect(onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')).toEqual(
			[]
		);
	});

	it.each([
		'  - name: invalid\n    event: nonexistent.event\n    prompt: inert test\n',
		'  - name: missing-prompt\n    event: agent.completed\n    prompt_file: .maestro/prompts/missing.md\n',
	])('alarms on failed subscriptions in an otherwise loadable config: %s', (subscription) => {
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		writeCueYamlAtomicSync(configPath, `subscriptions:\n${subscription}`);
		vi.advanceTimersByTime(31_000);
		expect(registry.size()).toBe(4);
		expect(
			onLog.mock.calls.filter(
				([level, , data]) => level === 'warn' && data?.type === 'triggerHealthWarning'
			)
		).toHaveLength(4);
	});

	it.each(['subscriptions: [', 'subscriptions: false\n'])(
		'alarms on genuine YAML errors and recovers after correction: %s',
		(invalidYaml) => {
			for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
			writeCueYamlAtomicSync(configPath, invalidYaml);
			vi.advanceTimersByTime(31_000);
			expect(registry.size()).toBe(0);
			expect(
				onLog.mock.calls.filter(
					([level, , data]) => level === 'error' && data?.type === 'triggerHealthWarning'
				)
			).toHaveLength(4);
			onLog.mockClear();
			vi.advanceTimersByTime(12 * 30_000);
			expect(onLog).not.toHaveBeenCalled();
			writeCueYamlAtomicSync(configPath, 'subscriptions: []\n');
			vi.advanceTimersByTime(31_000);
			expect(registry.size()).toBe(4);
			expect(
				onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')
			).toEqual([]);
		}
	);
});
