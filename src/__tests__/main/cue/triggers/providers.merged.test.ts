// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/cue/triggers/cue-file-watcher-trigger-source.test.ts
//   - src/__tests__/main/cue/triggers/cue-github-poller-trigger-source.test.ts
//   - src/__tests__/main/cue/triggers/cue-task-scanner-trigger-source.test.ts
//   - src/__tests__/main/cue/triggers/cue-webhook-trigger-source.test.ts

import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEvent, CueEventType, CueSubscription } from '../../../../main/cue/cue-types';
import {
	handleCueWebhookRequest,
	resetCueWebhookServerForTests,
} from '../../../../main/cue/cue-webhook-server';
import { createCueFileWatcherTriggerSource } from '../../../../main/cue/triggers/cue-file-watcher-trigger-source';
import { createCueGitHubPollerTriggerSource } from '../../../../main/cue/triggers/cue-github-poller-trigger-source';
import { createCueTaskScannerTriggerSource } from '../../../../main/cue/triggers/cue-task-scanner-trigger-source';
import { createCueWebhookTriggerSource } from '../../../../main/cue/triggers/cue-webhook-trigger-source';
import type { SessionInfo } from '../../../../shared/types';
import { EventEmitter } from 'events';
import type * as http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) =>
		mockCreateCueFileWatcher(...(args as Parameters<typeof mockCreateCueFileWatcher>)),
}));
vi.mock('../../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) =>
		mockCreateCueGitHubPoller(...(args as Parameters<typeof mockCreateCueGitHubPoller>)),
}));
vi.mock('../../../../main/cue/cue-susfactor', () => ({
	guardGitHubEvent: vi.fn(async () => susFactorAllows),
}));
vi.mock('../../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) =>
		mockCreateCueTaskScanner(...(args as Parameters<typeof mockCreateCueTaskScanner>)),
}));

// ===== from src/__tests__/main/cue/triggers/cue-file-watcher-trigger-source.test.ts =====

const mockCleanup = vi.fn();

const mockCreateCueFileWatcher = vi.fn(() => mockCleanup);

function makeSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'watch-tasks',
		event: 'file.changed',
		enabled: true,
		prompt: 'do work',
		watch: '**/*.md',
		...overrides,
	};
}

function makeEvent(): CueEvent {
	return {
		id: 'evt-1',
		type: 'file.changed',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'watch-tasks',
		payload: { path: '/p/notes.md', filename: 'notes.md' },
	};
}

describe('cue-file-watcher-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null when watch is missing', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ watch: undefined }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueFileWatcher).not.toHaveBeenCalled();
	});

	it('start() wires up the underlying file watcher with the right config', () => {
		const onLog = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ watch: '**/*.ts' }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueFileWatcher).toHaveBeenCalledOnce();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			watchGlob: string;
			projectRoot: string;
			triggerName: string;
		};
		expect(config.watchGlob).toBe('**/*.ts');
		expect(config.projectRoot).toBe('/p');
		expect(config.triggerName).toBe('watch-tasks');

		source.stop();
	});

	it('emit fires when the underlying watcher reports an event and filter passes', () => {
		const emit = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();

		// Pull the onEvent callback that the wrapper passed to the provider and
		// invoke it directly - simulates a file change.
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('does not emit when enabled() returns false', () => {
		const emit = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => false,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('does not emit when the subscription filter rejects the event', () => {
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ filter: { filename: 'other.md' } }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('stop() releases the underlying watcher cleanup', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		source.stop();

		expect(mockCleanup).toHaveBeenCalledOnce();
	});

	it('nextTriggerAt() always returns null (file watchers fire on demand)', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		expect(source.nextTriggerAt()).toBeNull();
		source.stop();
	});
});

// ===== from src/__tests__/main/cue/triggers/cue-github-poller-trigger-source.test.ts =====

const mockCleanup_1 = vi.fn();

const mockCreateCueGitHubPoller = vi.fn((_config: unknown) => mockCleanup_1);

// The SusFactor guard is exercised in cue-susfactor.test.ts; here we only care
// that the trigger source honours its verdict, so it is stubbed to a value the
// test controls. Without this the guard would read ODIN_API_TOKEN from the
// developer's environment and could make a real network call.
let susFactorAllows = true;

function makeSession_1(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub_1(event: CueEventType, overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'gh-poll',
		event,
		enabled: true,
		prompt: 'do work',
		repo: 'foo/bar',
		...overrides,
	};
}

function makeEvent_1(type: CueEventType): CueEvent {
	return {
		id: 'evt-1',
		type,
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'gh-poll',
		payload: { number: 42, title: 'Test PR', state: 'open' },
	};
}

describe('cue-github-poller-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null for non-GitHub event types', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('time.heartbeat', { interval_minutes: 5 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueGitHubPoller).not.toHaveBeenCalled();
	});

	it('start() wires up the GitHub poller for github.pull_request', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request', {
				poll_minutes: 10,
				gh_state: 'merged',
			}),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueGitHubPoller).toHaveBeenCalledOnce();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			eventType: CueEventType;
			repo?: string;
			pollMinutes: number;
			projectRoot: string;
			triggerName: string;
			subscriptionId: string;
			ghState?: string;
		};
		expect(config.eventType).toBe('github.pull_request');
		expect(config.repo).toBe('foo/bar');
		expect(config.pollMinutes).toBe(10);
		expect(config.ghState).toBe('merged');
		expect(config.subscriptionId).toBe('session-1:gh-poll');

		source.stop();
	});

	it('start() wires up the GitHub poller for github.issue', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.issue'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as { eventType: CueEventType };
		expect(config.eventType).toBe('github.issue');

		source.stop();
	});

	it('start() wires up the GitHub poller for github.label with its label narrowing', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.label', {
				gh_label_target: 'pr',
				gh_labels: ['ready-to-merge', 'needs-rebase'],
			}),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			eventType: CueEventType;
			labelTarget?: string;
			watchLabels?: string[];
		};
		expect(config.eventType).toBe('github.label');
		expect(config.labelTarget).toBe('pr');
		expect(config.watchLabels).toEqual(['ready-to-merge', 'needs-rebase']);

		source.stop();
	});

	it('defaults pollMinutes to 5 when not specified', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as { pollMinutes: number };
		expect(config.pollMinutes).toBe(5);
		source.stop();
	});

	it('emit fires when the underlying poller reports an event', async () => {
		susFactorAllows = true;
		const emit = vi.fn();
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent_1('github.pull_request'));

		// The emit is deferred behind the async SusFactor gate, so it lands on a
		// later microtask rather than synchronously inside onEvent.
		await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

		source.stop();
	});

	it('does not emit when SusFactor blocks the item', async () => {
		susFactorAllows = false;
		const emit = vi.fn();
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent_1('github.pull_request'));

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(emit).not.toHaveBeenCalled();

		susFactorAllows = true;
		source.stop();
	});

	it('honours the subscription filter', () => {
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request', { filter: { number: 99 } }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent_1('github.pull_request')); // payload has number: 42, not 99

		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('stop() releases the underlying poller cleanup', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		source.stop();

		expect(mockCleanup_1).toHaveBeenCalledOnce();
	});

	it('nextTriggerAt() always returns null', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		expect(source.nextTriggerAt()).toBeNull();
		source.start();
		expect(source.nextTriggerAt()).toBeNull();
		source.stop();
	});

	it('pollNow() invokes the handle the underlying poller registers via onReady', () => {
		const innerPollNow = vi.fn();
		mockCreateCueGitHubPoller.mockImplementationOnce((config: unknown) => {
			(config as { onReady?: (h: { pollNow: () => void }) => void }).onReady?.({
				pollNow: innerPollNow,
			});
			return mockCleanup_1;
		});

		const source = createCueGitHubPollerTriggerSource({
			session: makeSession_1(),
			subscription: makeSub_1('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		// Before start(): pollNow is a no-op (no underlying poller yet).
		source.pollNow?.();
		expect(innerPollNow).not.toHaveBeenCalled();

		source.start();
		source.pollNow?.();
		expect(innerPollNow).toHaveBeenCalledOnce();

		source.stop();
		// After stop(), pollNow is dropped - calling it does not reach the inner.
		source.pollNow?.();
		expect(innerPollNow).toHaveBeenCalledOnce();
	});
});

// ===== from src/__tests__/main/cue/triggers/cue-task-scanner-trigger-source.test.ts =====

const mockCleanup_2 = vi.fn();

const mockCreateCueTaskScanner = vi.fn(() => mockCleanup_2);

function makeSession_2(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub_2(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'tasks',
		event: 'task.pending',
		enabled: true,
		prompt: 'do work',
		watch: '**/TODO.md',
		...overrides,
	};
}

function makeEvent_2(): CueEvent {
	return {
		id: 'evt-1',
		type: 'task.pending',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'tasks',
		payload: { taskCount: 3, filename: 'TODO.md' },
	};
}

describe('cue-task-scanner-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null when watch is missing', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2({ watch: undefined }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueTaskScanner).not.toHaveBeenCalled();
	});

	it('start() wires up the task scanner with the subscription poll_minutes', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2({ poll_minutes: 5 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueTaskScanner).toHaveBeenCalledOnce();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			watchGlob: string;
			pollMinutes: number;
			projectRoot: string;
			triggerName: string;
		};
		expect(config.watchGlob).toBe('**/TODO.md');
		expect(config.pollMinutes).toBe(5);
		expect(config.projectRoot).toBe('/p');
		expect(config.triggerName).toBe('tasks');

		source.stop();
	});

	it('start() does NOT pass an isActive visibility gate (task.pending must scan while hidden)', () => {
		// Regression guard for #1164: task.pending is the unattended-automation
		// case, so it must keep scanning while the window is hidden. Unlike the
		// file.changed / github.* sources, it must not forward isCueActive.
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueTaskScanner).toHaveBeenCalledOnce();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as { isActive?: () => boolean };
		expect(config.isActive).toBeUndefined();

		source.stop();
	});

	it('start() defaults pollMinutes to 1 when subscription does not specify', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as { pollMinutes: number };
		expect(config.pollMinutes).toBe(1);

		source.stop();
	});

	it('emit fires when the underlying scanner reports an event', () => {
		const emit = vi.fn();
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent_2());

		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('does not emit when enabled() returns false', () => {
		const emit = vi.fn();
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => false,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent_2());

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('stop() releases the underlying scanner cleanup', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		source.stop();

		expect(mockCleanup_2).toHaveBeenCalledOnce();
	});

	it('nextTriggerAt() always returns null', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession_2(),
			subscription: makeSub_2(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		expect(source.nextTriggerAt()).toBeNull();
		source.start();
		expect(source.nextTriggerAt()).toBeNull();
		source.stop();
	});
});

// ===== from src/__tests__/main/cue/triggers/cue-webhook-trigger-source.test.ts =====

function makeSession_3(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub_3(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'PR Review',
		event: 'webhook.received',
		enabled: true,
		prompt: 'review it',
		webhook: { secret: 's3cret' },
		...overrides,
	};
}

function makeCtx(sub: CueSubscription, enabled = true) {
	const emit = vi.fn();
	const onLog = vi.fn();
	return {
		emit,
		onLog,
		ctx: {
			session: makeSession_3(),
			subscription: sub,
			registry: createCueSessionRegistry(),
			enabled: () => enabled,
			onLog,
			emit,
		},
	};
}

/** POST a body to the shared listener and resolve once it has responded. */
async function deliver(
	path: string,
	body: string,
	headers: Record<string, string> = { 'x-maestro-cue-secret': 's3cret' }
): Promise<number> {
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = 'POST';
	req.url = `/cue/${path}`;
	req.headers = headers;
	req.destroy = () => {};
	queueMicrotask(() => {
		req.emit('data', Buffer.from(body, 'utf8'));
		req.emit('end');
	});

	let status = 0;
	const res = {
		writeHead: (code: number) => {
			status = code;
		},
		end: () => {},
	};
	await handleCueWebhookRequest(req, res as unknown as http.ServerResponse);
	return status;
}

describe('cue-webhook-trigger-source', () => {
	const originalPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;

	beforeEach(() => {
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		resetCueWebhookServerForTests();
	});

	afterEach(() => {
		resetCueWebhookServerForTests();
		delete process.env.WEBHOOK_TEST_SECRET;
		if (originalPort === undefined) {
			delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
		} else {
			process.env.MAESTRO_CUE_WEBHOOK_PORT = originalPort;
		}
	});

	it('returns null when the subscription has no webhook block', () => {
		const { ctx } = makeCtx(makeSub_3({ webhook: undefined }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
	});

	it('returns null and logs when no secret can be resolved', () => {
		const { ctx, onLog } = makeCtx(makeSub_3({ webhook: {} }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('no secret resolved'));
	});

	it('returns null when secret_env points at an unset variable', () => {
		const { ctx, onLog } = makeCtx(makeSub_3({ webhook: { secret_env: 'WEBHOOK_TEST_SECRET' } }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('WEBHOOK_TEST_SECRET'));
	});

	it('resolves the secret from secret_env', async () => {
		process.env.WEBHOOK_TEST_SECRET = 'from-env';
		const { ctx, emit } = makeCtx(
			makeSub_3({ webhook: { path: 'hook', secret_env: 'WEBHOOK_TEST_SECRET' } })
		);
		const source = createCueWebhookTriggerSource(ctx);
		source?.start();

		expect(await deliver('hook', '{}', { 'x-maestro-cue-secret': 'from-env' })).toBe(202);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('defaults the path to a slug of the subscription name', async () => {
		const { ctx, emit } = makeCtx(makeSub_3());
		const source = createCueWebhookTriggerSource(ctx);
		source?.start();

		// "PR Review" → "pr-review"
		expect(await deliver('pr-review', '{}')).toBe(202);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('returns null when the name and path both slug to nothing', () => {
		const { ctx } = makeCtx(makeSub_3({ name: '!!!', webhook: { secret: 's3cret' } }));
		expect(createCueWebhookTriggerSource(ctx)).toBeNull();
	});

	it('emits an event carrying the parsed body and vendor metadata', async () => {
		const { ctx, emit } = makeCtx(makeSub_3({ webhook: { path: 'hook', secret: 's3cret' } }));
		createCueWebhookTriggerSource(ctx)?.start();

		await deliver('hook', JSON.stringify({ action: 'opened', number: 12 }), {
			'x-maestro-cue-secret': 's3cret',
			'x-github-event': 'pull_request',
			'x-github-delivery': 'abc-123',
		});

		const event = emit.mock.calls[0][0] as CueEvent;
		expect(event.type).toBe('webhook.received');
		expect(event.triggerName).toBe('PR Review');
		expect(event.payload.path).toBe('hook');
		expect(event.payload.webhook_event).toBe('pull_request');
		expect(event.payload.delivery_id).toBe('abc-123');
		expect(event.payload.body).toEqual({ action: 'opened', number: 12 });
	});

	it('applies the subscription filter against nested body fields', async () => {
		const { ctx, emit } = makeCtx(
			makeSub_3({
				webhook: { path: 'hook', secret: 's3cret' },
				filter: { 'body.action': 'opened' },
			})
		);
		createCueWebhookTriggerSource(ctx)?.start();

		await deliver('hook', JSON.stringify({ action: 'closed' }));
		expect(emit).not.toHaveBeenCalled();

		await deliver('hook', JSON.stringify({ action: 'opened' }));
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('does not emit while the engine is disabled', async () => {
		const { ctx, emit } = makeCtx(
			makeSub_3({ webhook: { path: 'hook', secret: 's3cret' } }),
			false
		);
		createCueWebhookTriggerSource(ctx)?.start();

		// The listener still accepts the delivery - the gate is on dispatch, so
		// a sender doesn't start seeing errors just because Cue is paused.
		expect(await deliver('hook', '{}')).toBe(202);
		expect(emit).not.toHaveBeenCalled();
	});

	it('has no scheduled next-trigger time', () => {
		const { ctx } = makeCtx(makeSub_3());
		expect(createCueWebhookTriggerSource(ctx)?.nextTriggerAt()).toBeNull();
	});

	it('start and stop are idempotent, and stop deregisters the path', async () => {
		const { ctx, emit } = makeCtx(makeSub_3({ webhook: { path: 'hook', secret: 's3cret' } }));
		const source = createCueWebhookTriggerSource(ctx);

		source?.start();
		source?.start();
		await deliver('hook', '{}');
		// Double-start must not register the path twice, or every delivery
		// would dispatch two runs.
		expect(emit).toHaveBeenCalledTimes(1);

		source?.stop();
		source?.stop();
		expect(await deliver('hook', '{}')).toBe(404);
		expect(emit).toHaveBeenCalledTimes(1);
	});
});
