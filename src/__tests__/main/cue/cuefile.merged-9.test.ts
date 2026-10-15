// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-file-watcher.test.ts
//   - src/__tests__/main/cue/cue-process-lifecycle.test.ts
//   - src/__tests__/main/cue/cue-notify-bridge.test.ts
//   - src/__tests__/main/cue/cue-template-variables.test.ts
//   - src/__tests__/main/cue/cue-active-state.test.ts

import {
	isCueActive,
	resetCueActiveForTests,
	setCueActive,
} from '../../../main/cue/cue-active-state';
import { createCueFileWatcher } from '../../../main/cue/cue-file-watcher';
import { emitCueNotifyToast } from '../../../main/cue/cue-notify-bridge';
import {
	getActiveProcessMap,
	getProcessList,
	runProcess,
	stopAllProcesses,
	stopProcess,
	trackCueProcess,
} from '../../../main/cue/cue-process-lifecycle';
import type { SpawnSpec } from '../../../main/cue/cue-spawn-builder';
import type { CueEvent } from '../../../main/cue/cue-types';
import { substituteTemplateVariables } from '../../../shared/templateVariables';
import type { TemplateContext } from '../../../shared/templateVariables';
import type { ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'test-uuid-1234'),
}));
vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: mockOn,
		close: mockClose,
	})),
}));
vi.mock('../../../main/parsers', () => ({
	getOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
const { mockIsWindows, mockExecFile, mockExecFileSync } = vi.hoisted(() => ({
	mockIsWindows: vi.fn(() => false),
	mockExecFile: vi.fn((_cmd: unknown, _args: unknown, cb?: unknown) => {
		if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
	}),
	mockExecFileSync: vi.fn(),
}));
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return {
		...actual,
		isWindows: () => mockIsWindows(),
	};
});
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		execFile: (...args: unknown[]) => mockExecFile(...(args as [unknown, unknown, unknown?])),
		execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
			execFile: (...args: unknown[]) => mockExecFile(...(args as [unknown, unknown, unknown?])),
			execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
		},
	};
});
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: (...args: unknown[]) => broadcastBridgeEventMock(...args),
}));

// ===== from src/__tests__/main/cue/cue-file-watcher.test.ts =====

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();

const mockClose = vi.fn();

describe('cue-file-watcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates a chokidar watcher with correct options', () => {
		createCueFileWatcher({
			watchGlob: 'src/**/*.ts',
			projectRoot: '/projects/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test-trigger',
		});

		expect(chokidar.watch).toHaveBeenCalledWith('src/**/*.ts', {
			cwd: '/projects/test',
			ignoreInitial: true,
			persistent: true,
		});
	});

	it('registers change, add, and unlink handlers', () => {
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test',
		});

		const registeredEvents = mockOn.mock.calls.map((call) => call[0]);
		expect(registeredEvents).toContain('change');
		expect(registeredEvents).toContain('add');
		expect(registeredEvents).toContain('unlink');
		expect(registeredEvents).toContain('error');
	});

	it('debounces events per file', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		expect(changeHandler).toBeDefined();

		// Rapid changes to the same file
		changeHandler('src/index.ts');
		changeHandler('src/index.ts');
		changeHandler('src/index.ts');

		vi.advanceTimersByTime(5000);
		expect(onEvent).toHaveBeenCalledTimes(1);
	});

	it('does not coalesce events from different files', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];

		changeHandler('src/a.ts');
		changeHandler('src/b.ts');

		vi.advanceTimersByTime(5000);
		expect(onEvent).toHaveBeenCalledTimes(2);
	});

	it('constructs a CueEvent with correct payload for change events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'my-trigger',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		changeHandler('src/index.ts');
		vi.advanceTimersByTime(100);

		expect(onEvent).toHaveBeenCalledTimes(1);
		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.id).toBe('test-uuid-1234');
		expect(event.type).toBe('file.changed');
		expect(event.triggerName).toBe('my-trigger');
		expect(event.payload.filename).toBe('index.ts');
		expect(event.payload.extension).toBe('.ts');
		expect(event.payload.changeType).toBe('change');
	});

	it('reports correct changeType for add events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'test',
		});

		const addHandler = mockOn.mock.calls.find((call) => call[0] === 'add')?.[1];
		addHandler('src/new.ts');
		vi.advanceTimersByTime(100);

		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.payload.changeType).toBe('add');
	});

	it('reports correct changeType for unlink events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'test',
		});

		const unlinkHandler = mockOn.mock.calls.find((call) => call[0] === 'unlink')?.[1];
		unlinkHandler('src/deleted.ts');
		vi.advanceTimersByTime(100);

		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.payload.changeType).toBe('unlink');
	});

	it('cleanup function clears timers and closes watcher', () => {
		const onEvent = vi.fn();
		const cleanup = createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		// Trigger a change to create a pending timer
		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		changeHandler('src/index.ts');

		cleanup();

		// Advance past debounce - event should NOT fire since cleanup was called
		vi.advanceTimersByTime(5000);
		expect(onEvent).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
	});

	it('handles watcher errors gracefully with console.error fallback', () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test',
		});

		const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
		expect(errorHandler).toBeDefined();

		// Should not throw
		errorHandler(new Error('Watch error'));
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('routes errors through onLog when provided', () => {
		const onLog = vi.fn();
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'my-watcher',
			onLog,
		});

		const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
		expect(errorHandler).toBeDefined();

		errorHandler(new Error('Watch error'));

		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('my-watcher'));
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('Watch error'));
		expect(consoleSpy).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	// PR-B 1.4: visibility-aware pause
	describe('isActive gate', () => {
		it('drops the debounced event when isActive returns false', () => {
			const onEvent = vi.fn();
			const active = false;

			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
				isActive: () => active,
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/index.ts');
			vi.advanceTimersByTime(5000);

			expect(onEvent).not.toHaveBeenCalled();
		});

		it('dispatches the next event after isActive flips to true', () => {
			const onEvent = vi.fn();
			let active = false;

			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
				isActive: () => active,
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/inactive.ts');
			vi.advanceTimersByTime(5000);
			expect(onEvent).not.toHaveBeenCalled();

			active = true;
			changeHandler('src/active.ts');
			vi.advanceTimersByTime(5000);
			expect(onEvent).toHaveBeenCalledTimes(1);
		});

		it('still subscribes to chokidar even when isActive is false (no setup teardown)', () => {
			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent: vi.fn(),
				triggerName: 'test',
				isActive: () => false,
			});

			const registeredEvents = mockOn.mock.calls.map((call) => call[0]);
			expect(registeredEvents).toContain('change');
			expect(registeredEvents).toContain('add');
			expect(registeredEvents).toContain('unlink');
		});

		it('defaults to always-active when isActive is omitted', () => {
			const onEvent = vi.fn();
			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/index.ts');
			vi.advanceTimersByTime(5000);

			expect(onEvent).toHaveBeenCalledTimes(1);
		});
	});
});

// ===== from src/__tests__/main/cue/cue-process-lifecycle.test.ts =====

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock parsers - default returns null (no parser)
const mockGetOutputParser = vi.fn(() => null as any);

// Mock Sentry
const mockCaptureException = vi.fn();

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
	pid = 12345;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(_signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;

const mockSpawn = vi.fn(() => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createSpec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
	return {
		command: 'claude',
		args: ['--print', '--', 'test prompt'],
		cwd: '/projects/test',
		env: { PATH: '/usr/bin' },
		...overrides,
	};
}

function createOptions(overrides = {}) {
	return {
		toolType: 'claude-code',
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-process-lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default to the POSIX branch; Windows tests opt in via mockReturnValue(true).
		mockIsWindows.mockReturnValue(false);
		vi.useFakeTimers();
		getActiveProcessMap().clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Cue spawns agents directly rather than through the ProcessManager, so the
	// desktop's WakaTime listener never sees these runs. `onActivity` is the
	// hook that lets a run beat for its whole duration instead of going
	// unrecorded - a long Cue run would otherwise blow past WakaTime's idle
	// timeout with nothing reported.
	describe('onActivity (WakaTime heartbeat hook)', () => {
		it('fires on each stdout chunk so long runs keep beating', async () => {
			const onActivity = vi.fn();
			const resultPromise = runProcess('run-1', createSpec(), createOptions({ onActivity }));
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'chunk one');
			mockChild.stdout.emit('data', 'chunk two');

			expect(onActivity).toHaveBeenCalledTimes(2);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('fires on stderr too - a run streaming only stderr is still working', async () => {
			const onActivity = vi.fn();
			const resultPromise = runProcess('run-1', createSpec(), createOptions({ onActivity }));
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stderr.emit('data', 'progress on stderr');

			expect(onActivity).toHaveBeenCalledTimes(1);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('is optional - runs still complete and capture output without it', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'hello');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stdout).toContain('hello');
			expect(result.status).toBe('completed');
		});
	});

	describe('runProcess', () => {
		it('spawns process with correct command, args, and cwd', async () => {
			const spec = createSpec();
			const resultPromise = runProcess('run-1', spec, createOptions());
			await vi.advanceTimersByTimeAsync(0);

			// Local mode: stdin is `'ignore'` so agents like Codex don't print
			// "Reading additional input from stdin..." into the run output.
			expect(mockSpawn).toHaveBeenCalledWith(
				'claude',
				['--print', '--', 'test prompt'],
				expect.objectContaining({
					cwd: '/projects/test',
					stdio: ['ignore', 'pipe', 'pipe'],
				})
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('captures stdout and returns it in result', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'Hello ');
			mockChild.stdout.emit('data', 'world');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stdout).toBe('Hello world');
		});

		it('captures stderr and returns it in result', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stderr.emit('data', 'Warning: something');
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.stderr).toBe('Warning: something');
		});

		it('returns completed status on exit code 0', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
		});

		it('returns failed status on non-zero exit code', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 1);
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(1);
		});

		it('handles spawn errors gracefully', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('error', new Error('spawn ENOENT'));
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Spawn error: spawn ENOENT');
			expect(result.exitCode).toBeNull();
		});

		it('tracks the process in activeProcesses while running', async () => {
			const resultPromise = runProcess('tracked-run', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(getActiveProcessMap().has('tracked-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			expect(getActiveProcessMap().has('tracked-run')).toBe(false);
		});

		it('closes stdin for local execution', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(mockChild.stdin.end).toHaveBeenCalled();

			mockChild.emit('close', 0);
			await resultPromise;
		});

		describe('stdin modes', () => {
			it('writes sshStdinScript to stdin for SSH stdin-script mode', async () => {
				const spec = createSpec({ sshStdinScript: '#!/bin/bash\nclaude "prompt"' });
				const resultPromise = runProcess(
					'run-1',
					spec,
					createOptions({
						sshRemoteEnabled: true,
						sshStdinScript: '#!/bin/bash\nclaude "prompt"',
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockChild.stdin.write).toHaveBeenCalledWith('#!/bin/bash\nclaude "prompt"');
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('writes stdinPrompt to stdin for SSH prompt mode', async () => {
				const spec = createSpec({ stdinPrompt: 'large prompt' });
				const resultPromise = runProcess(
					'run-1',
					spec,
					createOptions({
						sshRemoteEnabled: true,
						stdinPrompt: 'large prompt',
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockChild.stdin.write).toHaveBeenCalledWith('large prompt');
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		describe('timeout enforcement', () => {
			it('sends SIGTERM when timeout expires', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 5000 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				mockChild.emit('close', null);
				const result = await resultPromise;
				expect(result.status).toBe('timeout');
			});

			it('escalates to SIGKILL after SIGTERM + delay', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 5000 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				mockChild.killed = false;
				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGKILL');

				mockChild.emit('close', null);
				await resultPromise;
			});

			it('does not timeout when timeoutMs is 0', async () => {
				const resultPromise = runProcess('run-1', createSpec(), createOptions({ timeoutMs: 0 }));
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				await vi.advanceTimersByTimeAsync(60000);
				expect(childKill).not.toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('logs timeout messages', async () => {
				const onLog = vi.fn();
				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({
						timeoutMs: 5000,
						onLog,
					})
				);
				await vi.advanceTimersByTimeAsync(0);

				await vi.advanceTimersByTimeAsync(5000);

				expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('timed out'));

				mockChild.emit('close', null);
				await resultPromise;
			});
		});

		describe('output parsing', () => {
			it('returns raw stdout when no parser is registered', async () => {
				mockGetOutputParser.mockReturnValue(null);

				const resultPromise = runProcess('run-1', createSpec(), createOptions());
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', 'plain text output\n');
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('plain text output\n');
			});

			it('extracts result-event text when parser is available', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'text') {
								return { type: 'result', text: msg.part?.text || '' };
							}
							return { type: 'system', raw: msg };
						} catch {
							return { type: 'text', text: line };
						}
					},
				} as any);

				const ndjson = JSON.stringify({ type: 'text', part: { text: 'Parsed output' } });

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'opencode' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', ndjson);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('Parsed output');
			});

			it('falls back to assistant text when result text is empty', async () => {
				mockGetOutputParser.mockReturnValue({
					parseJsonLine: (line: string) => {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'result') {
								return { type: 'result', text: msg.result || '' };
							}
							if (msg.type === 'assistant') {
								return { type: 'text', text: msg.text, isPartial: true };
							}
							return { type: 'system', raw: msg };
						} catch {
							return { type: 'text', text: line };
						}
					},
				} as any);

				const lines = [
					JSON.stringify({ type: 'assistant', text: 'Hello from the agent' }),
					JSON.stringify({ type: 'result', result: '' }),
				].join('\n');

				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stdout.emit('data', lines);
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(result.stdout).toBe('Hello from the agent');
			});
		});

		describe('stderr cleaning (benign noise filter)', () => {
			it('strips "Reading additional input from stdin..." from Codex stderr', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Codex emits this diagnostic on stderr on every run - it's
				// informational, not an error, and should never surface in the
				// activity log's "Errors" panel.
				mockChild.stderr.emit('data', 'Reading additional input from stdin...\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('preserves real Codex errors while dropping benign noise', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				mockChild.stderr.emit(
					'data',
					'Reading additional input from stdin...\nError: model rate limited\n'
				);
				mockChild.emit('close', 1);

				const result = await resultPromise;
				expect(result.stderr).toContain('Error: model rate limited');
				expect(result.stderr).not.toContain('Reading additional input from stdin');
			});

			it('strips Codex noise with ANSI dim codes', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Simulate a Codex build that wraps the diagnostic in ANSI dimming.
				mockChild.stderr.emit('data', '\u001b[2mReading additional input from stdin...\u001b[0m\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('strips Codex noise regardless of trailing text on the same prefix line', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec({ command: 'codex' }),
					createOptions({ toolType: 'codex' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// A prefix match catches variants with or without trailing dots,
				// extra whitespace, or future additions to the diagnostic line.
				mockChild.stderr.emit('data', 'Reading additional input from stdin\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toBe('');
			});

			it('does not filter stderr for agents without a noise filter', async () => {
				const resultPromise = runProcess(
					'run-1',
					createSpec(),
					createOptions({ toolType: 'claude-code' })
				);
				await vi.advanceTimersByTimeAsync(0);

				// Even a message that happens to look like Codex noise stays put
				// for non-Codex agents - filtering is opt-in per agent.
				mockChild.stderr.emit('data', 'Reading additional input from stdin...\n');
				mockChild.emit('close', 0);

				const result = await resultPromise;
				expect(result.stderr).toContain('Reading additional input from stdin');
			});
		});
	});

	describe('stopProcess', () => {
		it('returns false for unknown runId', () => {
			expect(stopProcess('nonexistent')).toBe(false);
		});

		it('sends SIGTERM to a running process', async () => {
			const resultPromise = runProcess('stop-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			const stopped = stopProcess('stop-test');
			expect(stopped).toBe(true);
			expect(childKill).toHaveBeenCalledWith('SIGTERM');

			mockChild.emit('close', null);
			await resultPromise;
		});

		it('escalates to SIGKILL after delay if process survives SIGTERM', async () => {
			const resultPromise = runProcess('stop-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			stopProcess('stop-test');
			expect(childKill).toHaveBeenCalledWith('SIGTERM');

			// Process hasn't exited - SIGKILL should fire after delay
			await vi.advanceTimersByTimeAsync(5000);
			expect(childKill).toHaveBeenCalledWith('SIGKILL');

			mockChild.emit('close', null);
			await resultPromise;
		});
	});

	describe('Windows process-tree kill (taskkill)', () => {
		it('kills via taskkill /pid <pid> /t /f instead of POSIX signals', async () => {
			mockIsWindows.mockReturnValue(true);

			const resultPromise = runProcess('win-stop', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			const stopped = stopProcess('win-stop');
			expect(stopped).toBe(true);
			expect(mockExecFile).toHaveBeenCalledWith(
				'taskkill',
				['/pid', String(mockChild.pid), '/t', '/f'],
				expect.any(Function)
			);
			// POSIX signals must not be used on Windows (no-op for shell-spawned trees).
			expect(childKill).not.toHaveBeenCalled();

			mockChild.emit('close', null);
			await resultPromise;
		});

		it('tolerates taskkill failing because the process is already dead', async () => {
			mockIsWindows.mockReturnValue(true);
			mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, cb?: unknown) => {
				if (typeof cb === 'function') {
					(cb as (e: Error | null) => void)(new Error('ERROR: The process "12345" not found.'));
				}
			});

			const resultPromise = runProcess('win-dead', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			// The child exited before taskkill ran. The exit code, not the
			// (localized) error text, is what marks the failure as benign.
			mockChild.exitCode = 1;
			stopProcess('win-dead');
			// Already-dead is expected on Windows and must not be reported to Sentry.
			expect(mockCaptureException).not.toHaveBeenCalled();

			mockChild.emit('close', null);
			await resultPromise;
		});
	});

	describe('trackCueProcess', () => {
		function trackedEntry(child: MockChildProcess) {
			return {
				child: child as unknown as ChildProcess,
				command: 'sh',
				args: ['-c', 'true'],
				cwd: '/projects/test',
				toolType: 'terminal',
				startTime: Date.now(),
				getStdout: () => '',
				getStderr: () => '',
			};
		}

		it('a stale unregister does not drop a newer run under the same id', () => {
			const untrackOld = trackCueProcess('same-id', trackedEntry(new MockChildProcess()));
			const newer = trackedEntry(new MockChildProcess());
			trackCueProcess('same-id', newer);

			untrackOld();
			expect(getActiveProcessMap().get('same-id')).toBe(newer);
		});

		it('stopAllProcesses escalates to SIGKILL at once (shutdown cannot wait on a timer)', () => {
			const child = new MockChildProcess();
			const childKill = vi.spyOn(child, 'kill');
			trackCueProcess('shutdown-run', trackedEntry(child));

			stopAllProcesses();
			expect(childKill).toHaveBeenCalledWith('SIGTERM');
			expect(childKill).toHaveBeenCalledWith('SIGKILL');
			expect(getActiveProcessMap().size).toBe(0);
		});
	});

	describe('getProcessList', () => {
		it('returns empty array when no active processes', () => {
			expect(getProcessList()).toEqual([]);
		});

		it('returns process info during active run', async () => {
			const resultPromise = runProcess('list-test', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const list = getProcessList();
			expect(list).toHaveLength(1);
			expect(list[0].runId).toBe('list-test');
			expect(list[0].pid).toBe(12345);
			expect(list[0].toolType).toBe('claude-code');
			expect(list[0].cwd).toBe('/projects/test');
			expect(list[0].command).toBe('claude');
			expect(Array.isArray(list[0].args)).toBe(true);
			expect(typeof list[0].startTime).toBe('number');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('excludes completed processes', async () => {
			const resultPromise = runProcess('completed-run', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			expect(getProcessList().some((p) => p.runId === 'completed-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			expect(getProcessList().some((p) => p.runId === 'completed-run')).toBe(false);
		});
	});

	describe('Sentry error reporting', () => {
		it('reports synchronous spawn failure to Sentry', async () => {
			mockSpawn.mockImplementationOnce(() => {
				throw new Error('spawn EPERM');
			});

			const result = await runProcess('run-1', createSpec(), createOptions());

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Spawn error: spawn EPERM');
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'spawn EPERM' }),
				expect.objectContaining({ operation: 'cue:spawn', runId: 'run-1' })
			);
		});

		it('reports async child process error to Sentry', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			const spawnError = new Error('spawn ENOENT');
			mockChild.emit('error', spawnError);
			await resultPromise;

			expect(mockCaptureException).toHaveBeenCalledWith(
				spawnError,
				expect.objectContaining({ operation: 'cue:childProcess:error', runId: 'run-1' })
			);
		});
	});

	describe('settled guard', () => {
		it('ignores duplicate close events', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			mockChild.emit('close', 1); // duplicate - should be ignored
			const result = await resultPromise;

			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
		});

		it('ignores error after close', async () => {
			const resultPromise = runProcess('run-1', createSpec(), createOptions());
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			mockChild.emit('error', new Error('late error')); // should be ignored
			const result = await resultPromise;

			expect(result.status).toBe('completed');
		});
	});
});

// ===== from src/__tests__/main/cue/cue-notify-bridge.test.ts =====

// Mock the bridge fan-out leaf so we can assert web-desktop clients receive the
// toast. The bridge always fires regardless of desktop-window liveness, which is
// exactly the parity guarantee this migration adds.
const broadcastBridgeEventMock = vi.fn();

/** A live window: not destroyed, webContents present and not destroyed. */
function aliveWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
	const send = vi.fn();
	const win = {
		isDestroyed: () => false,
		webContents: { isDestroyed: () => false, send },
	} as unknown as BrowserWindow;
	return { win, send };
}

/** A destroyed window: still an object, but no longer sendable. */
function destroyedWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
	const send = vi.fn();
	const win = {
		isDestroyed: () => true,
		webContents: { isDestroyed: () => false, send },
	} as unknown as BrowserWindow;
	return { win, send };
}

const EXPECTED_PAYLOAD = {
	title: 'My Agent',
	message: 'standup time',
	color: 'theme',
	dismissible: false,
	sessionId: 'agent-1',
	clickAction: { kind: 'jump-session', sessionId: 'agent-1' },
};

describe('emitCueNotifyToast', () => {
	beforeEach(() => {
		broadcastBridgeEventMock.mockReset();
	});

	it('fans out to web-desktop bridge clients even when mainWindow is null', () => {
		const result = emitCueNotifyToast(null, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		// No desktop renderer to reach, but the bridge still delivers.
		expect(result).toBe(false);
		expect(broadcastBridgeEventMock).toHaveBeenCalledTimes(1);
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
	});

	it('fans out to the bridge even when the desktop window is destroyed', () => {
		const { win, send } = destroyedWindow();
		const result = emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		expect(result).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
	});

	it('sends to both the desktop renderer and the bridge when the window is alive', () => {
		const { win, send } = aliveWindow();
		const result = emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		expect(result).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith('remote:notifyToast', EXPECTED_PAYLOAD);
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
	});

	it('marks the toast sticky when sticky: true', () => {
		const { win, send } = aliveWindow();
		emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'Critical',
			message: 'attention required',
			sticky: true,
		});
		const payload = send.mock.calls[0][1] as { dismissible: boolean };
		expect(payload.dismissible).toBe(true);
	});

	it('passes through a caller-provided clickAction', () => {
		const { win, send } = aliveWindow();
		emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'check PR',
			clickAction: { kind: 'open-url', url: 'https://example.com/pr/1' },
		});
		const payload = send.mock.calls[0][1] as { clickAction: unknown };
		expect(payload.clickAction).toEqual({ kind: 'open-url', url: 'https://example.com/pr/1' });
	});
});

// ===== from src/__tests__/main/cue/cue-template-variables.test.ts =====

function makeContext(cue: TemplateContext['cue'] = {}): TemplateContext {
	return {
		session: {
			id: 'session-1',
			name: 'Test Agent',
			toolType: 'claude-code',
			cwd: '/projects/test',
		},
		cue,
	};
}

describe('Cue template variable substitution', () => {
	it('substitutes all file.changed variables', () => {
		const ctx = makeContext({
			filePath: '/projects/test/src/app.ts',
			fileName: 'app.ts',
			fileDir: '/projects/test/src',
			fileExt: '.ts',
			fileChangeType: 'change',
		});
		const template =
			'File {{CUE_FILE_PATH}} name={{CUE_FILE_NAME}} dir={{CUE_FILE_DIR}} ext={{CUE_FILE_EXT}} change={{CUE_FILE_CHANGE_TYPE}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'File /projects/test/src/app.ts name=app.ts dir=/projects/test/src ext=.ts change=change'
		);
	});

	it('substitutes all agent.completed variables', () => {
		const ctx = makeContext({
			sourceSession: 'worker-1',
			sourceOutput: 'Build succeeded',
			sourceStatus: 'completed',
			sourceExitCode: '0',
			sourceDuration: '12345',
			sourceTriggeredBy: 'file-watcher-sub',
		});
		const template = [
			'session={{CUE_SOURCE_SESSION}}',
			'output={{CUE_SOURCE_OUTPUT}}',
			'status={{CUE_SOURCE_STATUS}}',
			'exit={{CUE_SOURCE_EXIT_CODE}}',
			'duration={{CUE_SOURCE_DURATION}}',
			'trigger={{CUE_SOURCE_TRIGGERED_BY}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'session=worker-1 output=Build succeeded status=completed exit=0 duration=12345 trigger=file-watcher-sub'
		);
	});

	it('substitutes all task.pending variables', () => {
		const ctx = makeContext({
			taskFile: '/projects/test/tasks/todo.md',
			taskFileName: 'todo.md',
			taskFileDir: '/projects/test/tasks',
			taskCount: '3',
			taskList: '- [ ] task one\n- [ ] task two\n- [ ] task three',
			taskContent: '# TODO\n- [ ] task one\n- [ ] task two\n- [ ] task three',
		});
		const template = [
			'file={{CUE_TASK_FILE}}',
			'name={{CUE_TASK_FILE_NAME}}',
			'dir={{CUE_TASK_FILE_DIR}}',
			'count={{CUE_TASK_COUNT}}',
			'list={{CUE_TASK_LIST}}',
			'content={{CUE_TASK_CONTENT}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'file=/projects/test/tasks/todo.md name=todo.md dir=/projects/test/tasks count=3 list=- [ ] task one\n- [ ] task two\n- [ ] task three content=# TODO\n- [ ] task one\n- [ ] task two\n- [ ] task three'
		);
	});

	it('substitutes all github variables', () => {
		const ctx = makeContext({
			ghType: 'pull_request',
			ghNumber: '42',
			ghTitle: 'Add feature X',
			ghAuthor: 'alice',
			ghUrl: 'https://github.com/owner/repo/pull/42',
			ghBody: 'This PR adds feature X',
			ghLabels: 'enhancement,priority',
			ghState: 'open',
			ghRepo: 'owner/repo',
			ghBranch: 'feature-x',
			ghBaseBranch: 'main',
			ghAssignees: 'bob,charlie',
			ghMergedAt: '2026-03-15T12:00:00Z',
		});
		const template = [
			'type={{CUE_GH_TYPE}}',
			'num={{CUE_GH_NUMBER}}',
			'title={{CUE_GH_TITLE}}',
			'author={{CUE_GH_AUTHOR}}',
			'url={{CUE_GH_URL}}',
			'body={{CUE_GH_BODY}}',
			'labels={{CUE_GH_LABELS}}',
			'state={{CUE_GH_STATE}}',
			'repo={{CUE_GH_REPO}}',
			'branch={{CUE_GH_BRANCH}}',
			'base={{CUE_GH_BASE_BRANCH}}',
			'assignees={{CUE_GH_ASSIGNEES}}',
			'merged={{CUE_GH_MERGED_AT}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'type=pull_request num=42 title=Add feature X author=alice url=https://github.com/owner/repo/pull/42 body=This PR adds feature X labels=enhancement,priority state=open repo=owner/repo branch=feature-x base=main assignees=bob,charlie merged=2026-03-15T12:00:00Z'
		);
	});

	it('substitutes base event variables', () => {
		const ctx = makeContext({
			eventType: 'file.changed',
			eventTimestamp: '2026-03-15T10:30:00Z',
			triggerName: 'watch-src',
			runId: 'abc-123-def',
		});
		const template =
			'event={{CUE_EVENT_TYPE}} ts={{CUE_EVENT_TIMESTAMP}} trigger={{CUE_TRIGGER_NAME}} run={{CUE_RUN_ID}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'event=file.changed ts=2026-03-15T10:30:00Z trigger=watch-src run=abc-123-def'
		);
	});

	it('produces empty string for missing cue context fields', () => {
		const ctx = makeContext({});
		const template =
			'event={{CUE_EVENT_TYPE}} file={{CUE_FILE_PATH}} session={{CUE_SOURCE_SESSION}} task={{CUE_TASK_FILE}} gh={{CUE_GH_TYPE}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe('event= file= session= task= gh=');
	});

	it('handles special characters in variable values', () => {
		const ctx = makeContext({
			sourceOutput: 'Line 1\nLine "2"\nCurly {braces} and {{double}}',
		});
		const template = 'output={{CUE_SOURCE_OUTPUT}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe('output=Line 1\nLine "2"\nCurly {braces} and {{double}}');
	});

	it('preserves 5000-char sourceOutput without truncation', () => {
		const longOutput = 'x'.repeat(5000);
		const ctx = makeContext({ sourceOutput: longOutput });
		const template = '{{CUE_SOURCE_OUTPUT}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toHaveLength(5000);
		expect(result).toBe(longOutput);
	});
});

// ===== from src/__tests__/main/cue/cue-active-state.test.ts =====

describe('cue-active-state', () => {
	beforeEach(() => {
		resetCueActiveForTests();
	});

	it('defaults to active', () => {
		expect(isCueActive()).toBe(true);
	});

	it('flips to inactive when setCueActive(false) is called', () => {
		setCueActive(false);
		expect(isCueActive()).toBe(false);
	});

	it('flips back to active when setCueActive(true) is called', () => {
		setCueActive(false);
		setCueActive(true);
		expect(isCueActive()).toBe(true);
	});

	it('is idempotent - repeated calls preserve the same state', () => {
		setCueActive(false);
		setCueActive(false);
		expect(isCueActive()).toBe(false);
		setCueActive(true);
		setCueActive(true);
		expect(isCueActive()).toBe(true);
	});

	it('resetCueActiveForTests restores the default', () => {
		setCueActive(false);
		resetCueActiveForTests();
		expect(isCueActive()).toBe(true);
	});
});
