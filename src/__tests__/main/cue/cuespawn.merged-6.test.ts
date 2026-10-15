// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/main/cue/cue-spawn-builder.test.ts
//   - src/__tests__/main/cue/cue-fan-in-edge-cases.test.ts
//   - src/__tests__/main/cue/cue-query-service.test.ts

import type { CueExecutionConfig } from '../../../main/cue/cue-executor';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import { createCueQueryService } from '../../../main/cue/cue-query-service';
import type { CueQueryServiceDeps } from '../../../main/cue/cue-query-service';
import type { SessionState } from '../../../main/cue/cue-session-state';
import { buildSpawnSpec } from '../../../main/cue/cue-spawn-builder';
import { DEFAULT_CUE_SETTINGS } from '../../../main/cue/cue-types';
import type {
	AgentCompletionData,
	CueConfig,
	CueEvent,
	CueSettings,
	CueSubscription,
} from '../../../main/cue/cue-types';
import type { TemplateContext } from '../../../shared/templateVariables';
import type { SessionInfo } from '../../../shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/agents', () => ({
	getAgentDefinition: (...args: unknown[]) => mockGetAgentDefinition(...args),
	getAgentCapabilities: (...args: unknown[]) => mockGetAgentCapabilities(...args),
}));
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: (...args: unknown[]) => mockBuildAgentArgs(...args),
	applyAgentConfigOverrides: (...args: unknown[]) => mockApplyOverrides(...args),
}));
vi.mock('../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
}));
vi.mock('../../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: () => '/bundled/maestro-p.js',
	isMaestroPBinaryPath: (p: string | null | undefined) => !!p && p.includes('maestro-p'),
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: () => null,
	resolveConfigDirKey: () => 'test-config-key',
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	// Make the resolved maestro-p script read as present; leave every other fs
	// function untouched so the rest of the import graph behaves normally.
	return { ...actual, existsSync: () => true };
});

// ===== from src/__tests__/main/cue/cue-spawn-builder.test.ts =====

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAgentDefinition = vi.fn();

const mockGetAgentCapabilities = vi.fn(() => ({
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: false,
	supportsImageInputOnResume: false,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsContextUsage: true,
	supportsThinking: false,
	supportsStdin: false,
	supportsRawStdin: false,
	supportsModelSelection: false,
	supportsModelDiscovery: false,
	supportsBatchMode: true,
	supportsYoloMode: true,
	supportsExitCodes: true,
	supportsWorkingDir: false,
}));

const mockBuildAgentArgs = vi.fn((_agent: unknown, _opts: unknown) => ['--print', '--verbose']);

const mockApplyOverrides = vi.fn((_agent: unknown, args: string[], _overrides: unknown) => ({
	args,
	effectiveCustomEnvVars: undefined,
	customArgsSource: 'none' as const,
	customEnvSource: 'none' as const,
	modelSource: 'default' as const,
}));

const mockWrapSpawnWithSsh = vi.fn();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultAgentDef = {
	id: 'claude-code',
	name: 'Claude Code',
	binaryName: 'claude',
	command: 'claude',
	args: ['--print', '--verbose'],
};

function createConfig(overrides: Partial<CueExecutionConfig> = {}): CueExecutionConfig {
	return {
		runId: 'run-1',
		session: {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		} as SessionInfo,
		subscription: {
			name: 'test-sub',
			event: 'file.changed',
			enabled: true,
			prompt: 'test',
		} as CueSubscription,
		event: {
			id: 'evt-1',
			type: 'file.changed',
			timestamp: '2026-01-01T00:00:00.000Z',
			triggerName: 'test',
			payload: {},
		} as CueEvent,
		promptPath: 'test prompt',
		toolType: 'claude-code',
		projectRoot: '/projects/test',
		templateContext: {} as TemplateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-spawn-builder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetAgentDefinition.mockReturnValue(defaultAgentDef);
		// The spec env spreads process.env, so an ambient MAESTRO_CLAUDE_BIN
		// (leaked when these tests run inside a maestro/claude agent) would bleed
		// into specs and trip the "maestro-p disabled -> undefined" assertion.
		// Clear it so the suite asserts only what the builder itself injects.
		vi.stubEnv('MAESTRO_CLAUDE_BIN', undefined as unknown as string);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('buildSpawnSpec', () => {
		it('returns error for unknown agent type', async () => {
			mockGetAgentDefinition.mockReturnValue(undefined);

			const result = await buildSpawnSpec(createConfig({ toolType: 'nonexistent' }), 'prompt');

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain('Unknown agent type: nonexistent');
			}
		});

		it('builds spec with correct command and cwd for local execution', async () => {
			const result = await buildSpawnSpec(createConfig(), 'hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('claude');
				expect(result.spec.cwd).toBe('/projects/test');
			}
		});

		it('uses custom path when provided', async () => {
			const result = await buildSpawnSpec(createConfig({ customPath: '/custom/claude' }), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('/custom/claude');
			}
		});

		it('appends -- then prompt for default agents (no promptArgs/noPromptSeparator)', async () => {
			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 2]).toBe('--');
				expect(args[args.length - 1]).toBe('Hello world');
			}
		});

		it('uses promptArgs when agent provides it', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				promptArgs: (p: string) => ['-p', p],
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const pIdx = result.spec.args.indexOf('-p');
				expect(pIdx).toBeGreaterThan(-1);
				expect(result.spec.args[pIdx + 1]).toBe('Hello world');
			}
		});

		it('appends prompt directly when noPromptSeparator is true', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				noPromptSeparator: true,
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 1]).toBe('Hello world');
				expect(args[args.length - 2]).not.toBe('--');
			}
		});

		it('calls buildAgentArgs with yoloMode: true', async () => {
			await buildSpawnSpec(createConfig(), 'prompt');

			expect(mockBuildAgentArgs).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'claude-code' }),
				expect.objectContaining({ yoloMode: true, permissionMode: 'full' })
			);
		});

		it('passes config overrides through applyAgentConfigOverrides', async () => {
			const config = createConfig({
				customModel: 'claude-4-opus',
				customArgs: '--max-tokens 1000',
				customEnvVars: { API_KEY: 'test' },
			});

			await buildSpawnSpec(config, 'prompt');

			expect(mockApplyOverrides).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Array),
				expect.objectContaining({
					sessionCustomModel: 'claude-4-opus',
					sessionCustomArgs: '--max-tokens 1000',
					sessionCustomEnvVars: { API_KEY: 'test' },
				})
			);
		});

		it('includes process.env in the spec env', async () => {
			// Seed a unique env var to avoid platform-fragile assertions (e.g. PATH)
			process.env.__CUE_SPAWN_TEST__ = 'test-value';
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.__CUE_SPAWN_TEST__).toBe('test-value');
				}
			} finally {
				delete process.env.__CUE_SPAWN_TEST__;
			}
		});

		it('expands a launchd PATH instead of inheriting it verbatim (#1573)', async () => {
			const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';
			const originalPath = process.env.PATH;
			process.env.PATH = launchdPath;
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.PATH).not.toBe(launchdPath);
					expect(result.spec.env.PATH).toContain(launchdPath.split(':')[0]);
					if (process.platform !== 'win32') {
						const parts = result.spec.env.PATH.split(':');
						expect(parts).toContain('/opt/homebrew/bin');
						expect(parts).toContain('/usr/local/bin');
					}
				}
			} finally {
				process.env.PATH = originalPath;
			}
		});

		it('marks the spawn as a cue turn', async () => {
			// Nothing else distinguishes a Cue run from a prompt the user typed:
			// same binary, same args, and the prompt text is the user's own words
			// out of cue.yaml. Downstream tooling reads this var instead of guessing.
			const result = await buildSpawnSpec(createConfig(), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		it('keeps the cue marker even when the agent sets its own env vars', async () => {
			const result = await buildSpawnSpec(
				createConfig({ customEnvVars: { MAESTRO_QUERY_SOURCE: 'user' } }),
				'prompt'
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		describe('SSH execution', () => {
			it('calls wrapSpawnWithSsh when SSH is enabled', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--print'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host.example.com' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshStore: mockSshStore,
					}),
					'prompt'
				);

				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						command: 'claude',
						agentBinaryName: 'claude',
					}),
					{ enabled: true, remoteId: 'remote-1' },
					mockSshStore
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.cwd).toBe('/Users/test');
					expect(result.spec.sshRemoteUsed).toEqual({
						id: 'remote-1',
						name: 'Server',
						host: 'host.example.com',
					});
				}
			});

			it('does not append prompt to args for SSH mode (wrapper handles it)', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// Only one occurrence of the prompt (from SSH wrapper)
					const promptOccurrences = result.spec.args.filter((a) =>
						a.includes('Hello world')
					).length;
					expect(promptOccurrences).toBe(1);
				}
			});

			it('passes sshStdinScript through when SSH returns it', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshStdinScript: '#!/bin/bash\nclaude "test prompt"',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'test prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.sshStdinScript).toBe('#!/bin/bash\nclaude "test prompt"');
				}
			});

			it('passes stdinPrompt through when SSH returns prompt for stdin delivery', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: 'large prompt content',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'large prompt content'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.stdinPrompt).toBe('large prompt content');
				}
			});

			it('still appends prompt when SSH is enabled but sshStore is missing', async () => {
				// SSH enabled in config, but no sshStore → SSH wrapping skipped
				// Prompt should still be appended for local fallback
				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						// sshStore deliberately omitted
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					const args = result.spec.args;
					expect(args[args.length - 1]).toBe('Hello world');
					expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
				}
			});
		});

		describe('Claude token-source (maestro-p) rewrite', () => {
			// A claude-code definition carrying the interactive (maestro-p) wiring
			// the resolver requires to treat the spawn as a TUI candidate.
			const claudeInteractiveAgentDef = {
				...defaultAgentDef,
				interactiveCommand: 'maestro-p',
				interactiveModeArgs: ['--dangerously-skip-permissions'],
				defaultEnvVars: {},
			};

			it('rewrites a local spawn to maestro-p for interactive token mode, keeping the prompt last', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: true, maestroPMode: 'interactive' }),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					// maestro-p runs via the Node execPath...
					expect(command).toBe(process.execPath);
					// ...with the maestro-p script first, then --max-wait derived from
					// the run's timeoutMs (30000ms -> 30s), then the interactive flags...
					expect(args[0]).toBe('/bundled/maestro-p.js');
					expect(args[1]).toBe('--max-wait');
					expect(args[2]).toBe('30');
					expect(args[3]).toBe('--dangerously-skip-permissions');
					// ...and the substituted prompt still the trailing positional.
					expect(args[args.length - 1]).toBe('Hello world');
					// maestro-p is told which real claude binary to drive.
					expect(env.MAESTRO_CLAUDE_BIN).toBeTruthy();
				}
			});

			it('leaves a plain claude batch spec unchanged when maestro-p is disabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(createConfig({ enableMaestroP: false }), 'Hello world');

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					expect(command).toBe('claude');
					expect(args[0]).not.toBe('/bundled/maestro-p.js');
					expect(args[args.length - 1]).toBe('Hello world');
					expect(env.MAESTRO_CLAUDE_BIN).toBeUndefined();
				}
			});

			it('routes interactive token mode through maestro-p on the remote when SSH is enabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'maestro-p', '--dangerously-skip-permissions', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						enableMaestroP: true,
						maestroPMode: 'interactive',
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				// The SSH wrapper is handed the REMOTE maestro-p command (not the
				// local execPath rewrite), with --max-wait derived from the run's
				// timeoutMs (30000ms -> 30s) ahead of the interactive flags, then the
				// headless arg list (maestro-p strips those on the remote).
				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						agentBinaryName: 'maestro-p',
						args: expect.arrayContaining(['--max-wait', '30', '--dangerously-skip-permissions']),
					}),
					{ enabled: true, remoteId: 'r1' },
					mockSshStore
				);
				const wrapArgs = mockWrapSpawnWithSsh.mock.calls[0][0].args as string[];
				expect(wrapArgs.slice(0, 3)).toEqual([
					'--max-wait',
					'30',
					'--dangerously-skip-permissions',
				]);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// The local maestro-p execPath rewrite must NOT apply for SSH.
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.command).not.toBe(process.execPath);
				}
			});
		});
	});
});

// ===== from src/__tests__/main/cue/cue-fan-in-edge-cases.test.ts =====

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'fan-in-sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'merge results',
		source_sessions: ['session-a', 'session-b'],
		...overrides,
	};
}

function makeSettings(overrides: Partial<CueSettings> = {}): CueSettings {
	return {
		// Small default so tests can advance a handful of minutes; individual
		// tests override this as needed.
		timeout_minutes: 2,
		timeout_on_fail: 'continue',
		max_concurrent: 1,
		queue_size: 10,
		...overrides,
	};
}

function makeCompletion(overrides: Partial<AgentCompletionData> = {}): AgentCompletionData {
	return {
		sessionName: 'agent-a',
		status: 'completed',
		exitCode: 0,
		durationMs: 1000,
		stdout: 'output from agent',
		triggeredBy: 'fan-in-sub',
		chainDepth: 0,
		...overrides,
	};
}

const SOURCES = ['session-a', 'session-b'];

const OWNER = 'owner-session';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CueFanInTracker - edge cases', () => {
	let dispatch: ReturnType<typeof vi.fn>;
	let onLog: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dispatch = vi.fn();
		onLog = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeTracker() {
		return createCueFanInTracker({
			onLog,
			getSessions: () => [
				{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
				{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
			],
			dispatchSubscription: dispatch,
		});
	}

	// ─── Timeout behavior ──────────────────────────────────────────────────

	describe('source never completes → timeout', () => {
		it('fires with partial data in "continue" mode', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			// Only session-a completes; session-b never does.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ sessionName: 'Agent A', stdout: 'A-OUTPUT' })
			);
			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);

			// Advance just past the 2-minute timeout.
			vi.advanceTimersByTime(2 * 60 * 1000 + 1);

			expect(dispatch).toHaveBeenCalledTimes(1);
			const [ownerArg, subArg, eventArg, sourceNameArg] = dispatch.mock.calls[0];
			expect(ownerArg).toBe(OWNER);
			expect(subArg).toBe(sub);
			// Partial dispatch: only Agent A is in the completedSessions list;
			// Agent B shows up in timedOutSessions.
			expect(eventArg.payload.completedSessions).toEqual(['session-a']);
			expect(eventArg.payload.timedOutSessions).toEqual(['session-b']);
			expect(eventArg.payload.partial).toBe(true);
			expect(eventArg.payload.sourceOutput).toContain('A-OUTPUT');
			expect(sourceNameArg).toBe('Agent A');

			// Tracker state is cleaned up - timeout consumed the entry.
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
		});

		it('logs but does not dispatch in "break" mode', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'break' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			vi.advanceTimersByTime(2 * 60 * 1000 + 1);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			// Break-mode log surface: mentions timeout + waiting list.
			expect(
				onLog.mock.calls.some(
					(call) => typeof call[1] === 'string' && /timed out \(break mode\)/.test(call[1])
				)
			).toBe(true);
		});

		it('honors per-subscription fan_in_timeout_minutes over settings.timeout_minutes', () => {
			const tracker = makeTracker();
			const sub = makeSub({ fan_in_timeout_minutes: 1 });
			const settings = makeSettings({ timeout_minutes: 60, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			// settings.timeout_minutes is 60, but the per-sub override is 1 →
			// timeout fires just after 1 minute, well before 60.
			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).toHaveBeenCalledTimes(1);
		});

		it('honors per-subscription fan_in_timeout_on_fail override', () => {
			const tracker = makeTracker();
			const sub = makeSub({ fan_in_timeout_on_fail: 'break' });
			// Settings says "continue" but the sub pins "break" → must not
			// dispatch on timeout.
			const settings = makeSettings({ timeout_minutes: 1, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	// ─── Mid-wait cleanup ──────────────────────────────────────────────────

	describe('source session removed during fan-in wait', () => {
		it('clearForSession cleans up tracker without firing timeout', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			expect(tracker.getActiveTrackerKeys()).toHaveLength(1);

			// Owner session goes away (user closed the agent); clear its fan-in state.
			tracker.clearForSession(OWNER);

			// Advance past the timeout - must NOT fire because the timer was cleared.
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
		});

		it('clearForSession only clears entries owned by the given session', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				'owner-1',
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			tracker.handleCompletion(
				'owner-2',
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			expect(tracker.getActiveTrackerKeys().sort()).toEqual(
				[`owner-1:${sub.name}`, `owner-2:${sub.name}`].sort()
			);

			tracker.clearForSession('owner-1');

			// owner-2 is still tracked and will time out normally.
			expect(tracker.getActiveTrackerKeys()).toEqual([`owner-2:${sub.name}`]);
		});
	});

	// ─── Idempotency / late-arrivals ───────────────────────────────────────

	describe('duplicate completion from the same source', () => {
		it('treats the second completion as a replacement, not a second vote', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ stdout: 'A-FIRST' })
			);
			// Same session completes a second time - must NOT count as a new vote
			// toward the fan-in, otherwise a 2-source fan-in would fire prematurely
			// after one agent completes twice without the other ever running.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ stdout: 'A-SECOND' })
			);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
		});

		it('second completion does not extend the timeout window', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			// Half the timeout window passes, then a duplicate arrives.
			vi.advanceTimersByTime(60 * 1000);
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			// Remaining 60s + 1ms must trigger the original timeout - the
			// duplicate did NOT reset the timer.
			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).toHaveBeenCalledTimes(1);
		});
	});

	// ─── Late completion after timeout ─────────────────────────────────────

	describe('completion after timeout already fired', () => {
		it('is accepted as a fresh fan-in cycle (starts a new tracker)', () => {
			// This documents the current semantics: once a tracker is cleaned up
			// by a timeout, a late completion from the same source for the same
			// subscription starts a NEW tracker. In-flight coordination logic
			// upstream is responsible for treating post-timeout events as a new
			// cycle or dropping them - the tracker itself is stateless across
			// timeout boundaries.
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			vi.advanceTimersByTime(2 * 60 * 1000 + 1); // timeout fires
			expect(dispatch).toHaveBeenCalledTimes(1);

			// Late completion arrives from session-b - tracker was cleared, so
			// this becomes the first completion of a new cycle.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-b',
				'Agent B',
				makeCompletion()
			);
			// A new timer is ticking; we have NOT re-dispatched yet.
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
		});

		it('expireTracker prevents further completions from that tracker dispatching', () => {
			// expireTracker is the cleanup-service's eviction path. After it runs,
			// subsequent completions for the same key start a fresh tracker
			// cycle, but the tracker we expired must never dispatch.
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			tracker.expireTracker(`${OWNER}:${sub.name}`);

			// Advance past the original timeout - expireTracker should have
			// cleared the timer; no dispatch must occur.
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			expect(dispatch).not.toHaveBeenCalled();
		});
	});
});

// ===== from src/__tests__/main/cue/cue-query-service.test.ts =====

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
	subscriptions: CueSubscription[] = [],
	settingsOverrides: Partial<CueSettings> = {}
): CueConfig {
	return {
		subscriptions,
		settings: { ...DEFAULT_CUE_SETTINGS, ...settingsOverrides },
	};
}

function makeState(config?: CueConfig): SessionState {
	return {
		config: config ?? makeConfig(),
		triggerSources: [],
		yamlWatchers: [],
		sleepPrevented: false,
	};
}

function makeSession(id: string, name = `Session-${id}`, projectRoot = `/proj/${id}`) {
	return { id, name, toolType: 'claude-code', projectRoot };
}

function makeDeps(overrides: Partial<CueQueryServiceDeps> = {}): CueQueryServiceDeps {
	return {
		getAllSessions: vi.fn(() => []),
		getSessionStates: vi.fn(() => new Map()),
		getActiveRunCount: vi.fn(() => 0),
		loadConfigForProjectRoot: vi.fn(() => null),
		...overrides,
	};
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
	it('returns active session with enabled:true when in registry', () => {
		const session = makeSession('s1');
		const state = makeState(
			makeConfig([
				{ name: 'sub1', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 60 },
			])
		);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			getActiveRunCount: () => 2,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].enabled).toBe(true);
		expect(result[0].activeRuns).toBe(2);
		expect(result[0].subscriptionCount).toBe(1);
	});

	it('returns dormant session with enabled:false when engine is running but session not in registry', () => {
		const session = makeSession('s1');
		const config = makeConfig([
			{ name: 'sub1', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 30 },
		]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(), // engine running but s1 not initialized
			loadConfigForProjectRoot: () => config,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].enabled).toBe(false);
		expect(result[0].activeRuns).toBe(0);
		expect(result[0].subscriptionCount).toBe(1);
	});

	it('dormant subscriptionCount excludes disabled subscriptions', () => {
		const session = makeSession('s1');
		const config = makeConfig([
			{
				name: 'active-sub',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 30,
			},
			{
				name: 'disabled-sub',
				event: 'time.heartbeat',
				enabled: false,
				prompt: 'p',
				interval_minutes: 60,
			},
		]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getStatus();

		expect(result[0].subscriptionCount).toBe(1);
	});

	it('does not double-report a session that is both in registry and allSessions', () => {
		const session = makeSession('s1');
		const state = makeState();
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			loadConfigForProjectRoot: () => makeConfig(),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
	});

	it('excludes dormant sessions with no cue config', () => {
		const session = makeSession('s1');
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => null,
		});
		const svc = createCueQueryService(deps);
		expect(svc.getStatus()).toHaveLength(0);
	});

	it('reports both active and dormant sessions simultaneously', () => {
		const active = makeSession('a1');
		const dormant = makeSession('d1');
		const state = makeState();
		const deps = makeDeps({
			getAllSessions: () => [active, dormant],
			getSessionStates: () => new Map([['a1', state]]),
			loadConfigForProjectRoot: (root) => (root === dormant.projectRoot ? makeConfig() : null),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.sessionId === 'a1')?.enabled).toBe(true);
		expect(result.find((r) => r.sessionId === 'd1')?.enabled).toBe(false);
	});
});

// ─── getGraphData ─────────────────────────────────────────────────────────────

describe('getGraphData', () => {
	it('returns dormant session subscriptions when engine is running but session not initialized', () => {
		const session = makeSession('s1', 'Agent1');
		const sub: CueSubscription = {
			name: 'heartbeat',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'go',
			interval_minutes: 60,
		};
		const config = makeConfig([sub]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getGraphData();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].sessionName).toBe('Agent1');
		expect(result[0].subscriptions).toHaveLength(1);
		expect(result[0].subscriptions[0].name).toBe('heartbeat');
	});

	it('does not double-report a session that is both initialized and in allSessions', () => {
		const session = makeSession('s1');
		const sub: CueSubscription = {
			name: 'sub1',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 60,
		};
		const state = makeState(makeConfig([sub]));
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			loadConfigForProjectRoot: () => makeConfig([sub]),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getGraphData();

		expect(result).toHaveLength(1);
	});

	it('excludes dormant sessions with no cue config', () => {
		const session = makeSession('s1');
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => null,
		});
		expect(createCueQueryService(deps).getGraphData()).toHaveLength(0);
	});

	it('filters dormant subscriptions via isSubscriptionParticipant - owned by other agent excluded', () => {
		const session = makeSession('s1', 'A');
		const ownedBySelf: CueSubscription = {
			name: 'mine',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 30,
			agent_id: 's1',
		};
		const ownedByOther: CueSubscription = {
			name: 'theirs',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 30,
			agent_id: 'other-session',
		};
		const config = makeConfig([ownedBySelf, ownedByOther]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getGraphData();

		expect(result[0].subscriptions).toHaveLength(1);
		expect(result[0].subscriptions[0].name).toBe('mine');
	});

	it('includes fan-out target sessions in dormant graph data', () => {
		const owner = makeSession('owner', 'Owner');
		const target = makeSession('target', 'Target');
		const sub: CueSubscription = {
			name: 'fanout-sub',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 60,
			agent_id: 'owner',
			fan_out: ['Target'],
		};
		const config = makeConfig([sub]);
		// Neither session is initialized (both dormant)
		const deps = makeDeps({
			getAllSessions: () => [owner, target],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getGraphData();

		// Both owner and fan-out target should appear with the sub
		expect(result).toHaveLength(2);
		const targetEntry = result.find((r) => r.sessionId === 'target');
		expect(targetEntry?.subscriptions).toHaveLength(1);
		expect(targetEntry?.subscriptions[0].name).toBe('fanout-sub');
	});
});

// ─── getSettings ─────────────────────────────────────────────────────────────

describe('getSettings', () => {
	it('returns settings from an initialized session', () => {
		const state = makeState(
			makeConfig([], {
				timeout_minutes: 99,
				timeout_on_fail: 'continue',
				max_concurrent: 5,
				queue_size: 20,
			})
		);
		const deps = makeDeps({ getSessionStates: () => new Map([['s1', state]]) });
		const settings = createCueQueryService(deps).getSettings();

		expect(settings.timeout_minutes).toBe(99);
		expect(settings.max_concurrent).toBe(5);
	});

	it('falls back to DEFAULT_CUE_SETTINGS when no sessions are initialized', () => {
		const deps = makeDeps({ getSessionStates: () => new Map() });
		const settings = createCueQueryService(deps).getSettings();

		expect(settings).toEqual(DEFAULT_CUE_SETTINGS);
	});

	it('strips per-root owner_agent_id so it is never exposed as a global setting', () => {
		// Regression: owner_agent_id is per-root (it names an agent that must live
		// at that cue.yaml's root). When getSettings surfaced the first session's
		// owner_agent_id, the Settings modal read it and saveSettings broadcast it
		// into every cue.yaml - flagging unrelated single-agent projects with a
		// bogus "owner_agent_id does not match any agent" warning.
		const state = makeState(
			makeConfig([], {
				timeout_minutes: 60,
				timeout_on_fail: 'continue',
				max_concurrent: 1,
				queue_size: 50,
				owner_agent_id: 'pedsidian-uuid',
			})
		);
		const deps = makeDeps({ getSessionStates: () => new Map([['s1', state]]) });
		const settings = createCueQueryService(deps).getSettings();

		expect(settings.owner_agent_id).toBeUndefined();
		// Non-ownership global fields still flow through.
		expect(settings.timeout_minutes).toBe(60);
		expect(settings.max_concurrent).toBe(1);
	});
});
