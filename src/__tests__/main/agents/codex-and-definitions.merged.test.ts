// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/agents/codex-usage-sampler.test.ts
//   - src/__tests__/main/agents/definitions.test.ts
//   - src/__tests__/main/agents/opencode-config.test.ts

import {
	AGENT_DEFINITIONS,
	getAgentDefinition,
	getAgentIds,
	getVisibleAgentDefinitions,
} from '../../../main/agents';
import type { AgentConfigOption, AgentDefinition } from '../../../main/agents';
import { sampleCodexUsage } from '../../../main/agents/codex-usage-sampler';
import {
	discoverModelsFromLocalConfigs,
	extractModelsFromConfig,
	getOpenCodeCommandDirs,
	getOpenCodeConfigPaths,
	parseOpenCodeConfig,
} from '../../../main/agents/opencode-config';
import { isWindows } from '../../../shared/platformDetection';
import * as fs_1 from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessageMock } = vi.hoisted(() => ({
	captureMessageMock: vi.fn(),
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));
vi.mock('fs', () => ({
	promises: {
		readFile: vi.fn(),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

// ===== from src/__tests__/main/agents/codex-usage-sampler.test.ts =====

const TEST_ROOT = path.join(process.cwd(), '.tmp-codex-usage-sampler');

async function writeAuth(): Promise<void> {
	await fs.writeFile(
		path.join(TEST_ROOT, 'auth.json'),
		JSON.stringify({ tokens: { access_token: 'redacted-token' } })
	);
}

function respondWith(body: unknown): void {
	vi.mocked(globalThis.fetch).mockResolvedValue({
		ok: true,
		status: 200,
		json: vi.fn().mockResolvedValue(body),
	} as unknown as Response);
}

describe('codex-usage-sampler', () => {
	beforeEach(async () => {
		await fs.rm(TEST_ROOT, { recursive: true, force: true });
		await fs.mkdir(TEST_ROOT, { recursive: true });
		captureMessageMock.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await fs.rm(TEST_ROOT, { recursive: true, force: true });
	});

	it('returns a missing_auth snapshot when auth.json is absent', async () => {
		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot).toMatchObject({
			codexHomeKey: TEST_ROOT,
			authState: 'missing_auth',
		});
		expect(snapshot.error).toContain('No auth.json');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('maps wham usage windows into a sanitized Codex snapshot', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({
				tokens: {
					access_token: 'redacted-token',
					account_id: 'account-123',
				},
			})
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					email: 'codex@example.com',
					plan_type: 'pro',
					rate_limit: {
						primary_window: {
							used_percent: 12,
							reset_at: 1779550000,
							limit_window_seconds: 18000,
						},
						secondary_window: {
							used_percent: 34,
							reset_at: 1779900000,
							limit_window_seconds: 604800,
						},
					},
					additional_rate_limits: [
						{
							limit_name: 'gpt-5.3-codex',
							rate_limit: {
								primary_window: { used_percent: 5, reset_at: 1779560000 },
							},
						},
					],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://chatgpt.com/backend-api/wham/usage',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer redacted-token',
					'ChatGPT-Account-Id': 'account-123',
				}),
			})
		);
		expect(snapshot).toMatchObject({
			codexHomeKey: TEST_ROOT,
			authState: 'authenticated',
			email: 'codex@example.com',
			planType: 'pro',
			session: { percent: 12, resetsAt: '2026-05-23T15:26:40.000Z', windowSeconds: 18000 },
			weekly: { percent: 34, resetsAt: '2026-05-27T16:40:00.000Z', windowSeconds: 604800 },
			additionalLimits: [
				{
					name: 'gpt-5.3-codex',
					percent: 5,
					resetsAt: '2026-05-23T18:13:20.000Z',
				},
			],
		});
	});

	it('drops non-finite usage percentages from quota windows', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({
				tokens: {
					access_token: 'redacted-token',
				},
			})
		);
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue({
				email: 'codex@example.com',
				rate_limit: {
					primary_window: { used_percent: Number.NaN, reset_at: 1779550000 },
					secondary_window: { used_percent: Number.POSITIVE_INFINITY, reset_at: 1779900000 },
				},
				additional_rate_limits: [
					{
						limit_name: 'bad-window',
						rate_limit: {
							primary_window: { used_percent: Number.NaN, reset_at: 1779560000 },
						},
					},
				],
			}),
		} as unknown as Response);

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('authenticated');
		expect(snapshot.session).toBeUndefined();
		expect(snapshot.weekly).toBeUndefined();
		expect(snapshot.additionalLimits).toEqual([]);
	});

	it('files a weekly primary_window as weekly, not as a 5h session (#1596)', async () => {
		// A `prolite` plan reports its ONLY window - a weekly one - in
		// `primary_window`, which the old positional map filed as a 5h session
		// while reporting no weekly limit at all.
		await writeAuth();
		respondWith({
			plan_type: 'prolite',
			rate_limit: {
				primary_window: {
					used_percent: 25,
					reset_at: 1779900000,
					limit_window_seconds: 604800,
				},
				secondary_window: null,
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session).toBeUndefined();
		expect(snapshot.weekly).toEqual({
			percent: 25,
			resetsAt: '2026-05-27T16:40:00.000Z',
			windowSeconds: 604800,
		});
	});

	it('files windows by duration even when the slots arrive reversed', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 40, reset_at: 1779900000, limit_window_seconds: 604800 },
				secondary_window: { used_percent: 10, reset_at: 1779550000, limit_window_seconds: 18000 },
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session?.percent).toBe(10);
		expect(snapshot.weekly?.percent).toBe(40);
	});

	it('falls back to slot position when no window declares its length', async () => {
		// Older responses omit `limit_window_seconds` entirely; those keep the
		// original positional meaning rather than being dropped.
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 12, reset_at: 1779550000 },
				secondary_window: { used_percent: 34, reset_at: 1779900000 },
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session?.percent).toBe(12);
		expect(snapshot.session?.windowSeconds).toBeUndefined();
		expect(snapshot.weekly?.percent).toBe(34);
	});

	it('keeps both windows of a sublimit under distinct names', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {},
			additional_rate_limits: [
				{
					limit_name: 'gpt-5.3-codex',
					rate_limit: {
						primary_window: {
							used_percent: 5,
							reset_at: 1779560000,
							limit_window_seconds: 18000,
						},
						secondary_window: {
							used_percent: 60,
							reset_at: 1779900000,
							limit_window_seconds: 604800,
						},
					},
				},
			],
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.additionalLimits).toEqual([
			{
				name: 'gpt-5.3-codex (5h)',
				percent: 5,
				resetsAt: '2026-05-23T18:13:20.000Z',
				windowSeconds: 18000,
			},
			{
				name: 'gpt-5.3-codex (7d)',
				percent: 60,
				resetsAt: '2026-05-27T16:40:00.000Z',
				windowSeconds: 604800,
			},
		]);
	});

	it('leaves a single-window sublimit name unsuffixed', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {},
			additional_rate_limits: [
				{
					metered_feature: 'sora',
					rate_limit: {
						primary_window: { used_percent: 7, reset_at: 1779560000 },
					},
				},
			],
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.additionalLimits).toEqual([
			{ name: 'sora', percent: 7, resetsAt: '2026-05-23T18:13:20.000Z' },
		]);
	});

	it('never files a long window as a session, even when the weekly bucket is taken', async () => {
		// Two declared windows on the same side of the boundary is not a shape
		// any Codex plan reports, but if it ever appears the longer one must not
		// spill into the session bucket and render as `Session (30d)` - that is
		// the exact mislabel this classification exists to prevent.
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 40, reset_at: 1779900000, limit_window_seconds: 604800 },
				secondary_window: {
					used_percent: 70,
					reset_at: 1779900000,
					limit_window_seconds: 2592000,
				},
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.weekly?.percent).toBe(40);
		expect(snapshot.session).toBeUndefined();
	});

	it('treats HTTP 401 as unauthenticated without reporting to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'expired-token' } })
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('unauthenticated');
		expect(captureMessageMock).not.toHaveBeenCalled();
	});

	it('does not report network request failures to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'redacted-token' } })
		);
		// A thrown fetch (offline, DNS/TLS failure, unreachable endpoint, or our
		// own abort timeout) is the dominant MAESTRO-RR cause - an expected,
		// recoverable user-environment condition, not a Sentry-worthy crash.
		vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('error');
		expect(snapshot.error).toContain('Failed to request Codex quota metadata');
		expect(captureMessageMock).not.toHaveBeenCalled();
	});

	it.each([408, 429, 500, 502, 503, 504])(
		'does not report a throttled or degraded upstream (HTTP %i) to Sentry (MAESTRO-RR)',
		async (status) => {
			await fs.writeFile(
				path.join(TEST_ROOT, 'auth.json'),
				JSON.stringify({ tokens: { access_token: 'redacted-token' } })
			);
			// The sampler runs on a timer, so one ChatGPT outage would otherwise
			// report once per tick per install - the dominant MAESTRO-RR volume.
			vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Upstream error', { status }));

			const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

			expect(snapshot.authState).toBe('error');
			expect(captureMessageMock).not.toHaveBeenCalled();
		}
	);

	it('reports unexpected HTTP errors to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'redacted-token' } })
		);
		// A 400 implies we sent a malformed request - that would be our bug.
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Bad request', { status: 400 }));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('error');
		expect(captureMessageMock).toHaveBeenCalledWith(
			'codex usage sample failed',
			'warning',
			expect.objectContaining({ reason: 'http 400' })
		);
	});

	// The reset-credit counts ride the usage payload, so the sampler is where
	// they enter the app. `applicable` is the one that must survive the trip
	// unchanged: absent means UNKNOWN, and coercing it to 0 here would tell
	// every surface downstream that the account's credits are all useless.
	describe('reset credit counts', () => {
		async function sampleWithBody(body: Record<string, unknown>) {
			await fs.writeFile(
				path.join(TEST_ROOT, 'auth.json'),
				JSON.stringify({ tokens: { access_token: 'redacted-token' } })
			);
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(body),
			} as unknown as Response);
			return sampleCodexUsage({ codexHome: TEST_ROOT });
		}

		it('carries both counts through when the payload reports them', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
			});

			expect(snapshot.resetCredits).toEqual({ available: 2, applicable: 1 });
		});

		it('keeps an applicable count of zero distinct from an absent one', async () => {
			// The live shape that motivated the split: the account owns credits and
			// none of them would do anything right now.
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
			});

			expect(snapshot.resetCredits).toEqual({ available: 2, applicable: 0 });
		});

		it('leaves an omitted applicable count undefined rather than zero', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 3 },
			});

			expect(snapshot.resetCredits?.available).toBe(3);
			expect(snapshot.resetCredits?.applicable).toBeUndefined();
			expect(snapshot.resetCredits).not.toHaveProperty('applicable', 0);
		});

		it('reports nothing at all when the payload omits the block', async () => {
			const snapshot = await sampleWithBody({ email: 'codex@example.com' });

			expect(snapshot.resetCredits).toBeUndefined();
		});

		it('ignores a malformed available count', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 'two', applicable_available_count: 1 },
			});

			expect(snapshot.resetCredits).toBeUndefined();
		});
	});
});

// ===== from src/__tests__/main/agents/definitions.test.ts =====

describe('agent-definitions', () => {
	describe('AGENT_DEFINITIONS', () => {
		it('should contain all expected agents', () => {
			const agentIds = AGENT_DEFINITIONS.map((def) => def.id);

			expect(agentIds).toContain('terminal');
			expect(agentIds).toContain('claude-code');
			expect(agentIds).toContain('codex');
			expect(agentIds).toContain('opencode');
			expect(agentIds).toContain('gemini-cli');
			expect(agentIds).toContain('qwen3-coder');
			expect(agentIds).toContain('copilot-cli');
			expect(agentIds).toContain('hermes');
			expect(agentIds).toContain('pi');
			expect(agentIds).toContain('omp');
		});

		it('should have omp with batch mode and json output configuration', () => {
			const omp = AGENT_DEFINITIONS.find((def) => def.id === 'omp');
			expect(omp).toBeDefined();
			expect(omp?.name).toBe('Oh My Pi');
			expect(omp?.command).toBe('omp');
			expect(omp?.binaryName).toBe('omp');
			expect(omp?.batchModePrefix).toEqual(['-p']);
			expect(omp?.jsonOutputArgs).toEqual(['--mode', 'json']);
			expect(omp?.resumeArgs?.('abc')).toEqual(['--resume', 'abc']);
			expect(omp?.modelArgs?.('opus')).toEqual(['--model', 'opus']);
			expect(omp?.hidden).toBeFalsy();
		});

		it('should have required properties on all definitions', () => {
			for (const def of AGENT_DEFINITIONS) {
				expect(def.id).toBeDefined();
				expect(def.name).toBeDefined();
				expect(def.binaryName).toBeDefined();
				expect(def.command).toBeDefined();
				expect(def.args).toBeDefined();
				expect(Array.isArray(def.args)).toBe(true);
			}
		});

		it('should have terminal as a hidden agent', () => {
			const terminal = AGENT_DEFINITIONS.find((def) => def.id === 'terminal');
			expect(terminal?.hidden).toBe(true);
		});

		it('should have claude-code with correct base args', () => {
			const claudeCode = AGENT_DEFINITIONS.find((def) => def.id === 'claude-code');
			expect(claudeCode).toBeDefined();
			expect(claudeCode?.args).toContain('--print');
			expect(claudeCode?.args).toContain('--verbose');
			expect(claudeCode?.args).toContain('--output-format');
			expect(claudeCode?.args).toContain('stream-json');
			// Base args are the standard-permission default; --dangerously-skip-permissions
			// only applies in full permission mode via fullAccessArgs.
			expect(claudeCode?.args).not.toContain('--dangerously-skip-permissions');
			expect(claudeCode?.fullAccessArgs).toContain('--dangerously-skip-permissions');
		});

		it('should have codex with batch mode configuration', () => {
			const codex = AGENT_DEFINITIONS.find((def) => def.id === 'codex');
			expect(codex).toBeDefined();
			expect(codex?.batchModePrefix).toEqual(['exec']);
			expect(codex?.batchModeArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(codex?.jsonOutputArgs).toEqual(['--json']);
		});

		it('codex read-only must not carry the sandbox bypass flag', () => {
			const codex = AGENT_DEFINITIONS.find((def) => def.id === 'codex');
			// --dangerously-bypass-approvals-and-sandbox NULLIFIES --sandbox
			// read-only, so carrying it in readOnlyArgs let read-only consults
			// write files. `exec` is non-interactive on its own; the sandbox
			// denial feeds back to the model and the run continues.
			expect(codex?.readOnlyArgs).toEqual(['--sandbox', 'read-only', '--skip-git-repo-check']);
		});

		it('should have opencode with batch mode configuration', () => {
			const opencode = AGENT_DEFINITIONS.find((def) => def.id === 'opencode');
			expect(opencode).toBeDefined();
			expect(opencode?.batchModePrefix).toEqual(['run']);
			expect(opencode?.jsonOutputArgs).toEqual(['--format', 'json']);
			// noPromptSeparator removed: '--' separator prevents yargs from misinterpreting prompt content (#527)
			expect(opencode?.noPromptSeparator).toBeUndefined();
		});

		it('should have copilot configured to use a PTY for interactive sessions', () => {
			const copilot = AGENT_DEFINITIONS.find((def) => def.id === 'copilot-cli');
			expect(copilot).toBeDefined();
			expect(copilot?.requiresPty).toBe(true);
			expect(copilot?.jsonOutputArgs).toEqual(['--output-format', 'json']);
			expect(copilot?.readOnlyArgs).toEqual([
				'--allow-tool=read,url',
				'--deny-tool=write,shell,memory,github',
				'--no-ask-user',
			]);
			expect(copilot?.readOnlyCliEnforced).toBe(true);
		});

		it('should configure Pi for documented JSONL batch output', () => {
			const pi = AGENT_DEFINITIONS.find((def) => def.id === 'pi');
			expect(pi?.batchModePrefix).toEqual(['-p']);
			expect(pi?.jsonOutputArgs).toEqual(['--mode', 'json']);
			expect(pi?.noPromptSeparator).toBe(true);
			expect(pi?.resumeArgs?.('pi-session-1')).toEqual(['--session', 'pi-session-1']);
			expect(pi?.readOnlyArgs).toEqual(['--tools', 'read,grep,find,ls']);
			expect(pi?.readOnlyCliEnforced).toBe(true);
			expect(pi?.noToolsArgs).toEqual(['--no-tools']);
			expect(pi?.modelArgs?.('anthropic/claude-sonnet-4')).toEqual([
				'--model',
				'anthropic/claude-sonnet-4',
			]);
			expect(pi?.imageArgs?.('/tmp/image.png')).toEqual(['@/tmp/image.png']);
		});

		it('should keep Hermes on the documented plain-text batch path', () => {
			const hermes = AGENT_DEFINITIONS.find((def) => def.id === 'hermes');
			expect(hermes?.batchModePrefix).toEqual(['chat']);
			expect(hermes?.batchModeArgs).toEqual(['-Q', '--yolo']);
			expect(hermes?.jsonOutputArgs).toBeUndefined();
			expect(hermes?.resumeArgs).toBeUndefined();
			expect(hermes?.promptArgs?.('hello')).toEqual(['-q', 'hello']);
		});

		it('should have opencode with default env vars for YOLO mode and disabled question tool', () => {
			const opencode = AGENT_DEFINITIONS.find((def) => def.id === 'opencode');
			expect(opencode?.defaultEnvVars).toBeDefined();
			const configContent = opencode?.defaultEnvVars?.OPENCODE_CONFIG_CONTENT;
			expect(configContent).toBeDefined();

			// Verify it's valid JSON
			const config = JSON.parse(configContent!);

			// Should have permission settings for YOLO mode
			expect(config.permission).toBeDefined();
			expect(config.permission['*']).toBe('allow');
			expect(config.permission.external_directory).toBe('allow');

			// Should disable the question tool to prevent batch mode hangs
			// The question tool waits for stdin input which causes hangs in batch mode
			expect(config.tools).toBeDefined();
			expect(config.tools.question).toBe(false);
		});

		it('should have claude-code with defaultEnvVars disabling background tasks', () => {
			// Background tasks are disabled across every spawn path (desktop UI, CLI batch, --live, SSH).
			// Two motivations: short-lived batch sessions exit before background tasks finish (#861), and
			// the run_in_background + Monitor poll wrapper deadlocks on a self-matching `pgrep -f` when
			// the watched regex appears in the wrapper's own argv - observed in long-running desktop tabs.
			const claudeCode = AGENT_DEFINITIONS.find((def) => def.id === 'claude-code');
			expect(claudeCode?.defaultEnvVars).toBeDefined();
			expect(claudeCode?.defaultEnvVars?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
		});
	});

	describe('getAgentDefinition', () => {
		it('should return definition for valid agent ID', () => {
			const claudeCode = getAgentDefinition('claude-code');
			expect(claudeCode).toBeDefined();
			expect(claudeCode?.id).toBe('claude-code');
			expect(claudeCode?.name).toBe('Claude Code');
		});

		it('should return undefined for invalid agent ID', () => {
			const invalid = getAgentDefinition('non-existent-agent');
			expect(invalid).toBeUndefined();
		});

		it('should return definition for all known agents', () => {
			const knownAgents = [
				'terminal',
				'claude-code',
				'codex',
				'opencode',
				'gemini-cli',
				'copilot-cli',
				'omp',
				'qwen3-coder',
			];
			for (const agentId of knownAgents) {
				const def = getAgentDefinition(agentId);
				expect(def).toBeDefined();
				expect(def?.id).toBe(agentId);
			}
		});
	});

	describe('getAgentIds', () => {
		it('should return array of all agent IDs', () => {
			const ids = getAgentIds();
			expect(Array.isArray(ids)).toBe(true);
			expect(ids.length).toBeGreaterThan(0);
			expect(ids).toContain('claude-code');
			expect(ids).toContain('terminal');
		});

		it('should match AGENT_DEFINITIONS length', () => {
			const ids = getAgentIds();
			expect(ids.length).toBe(AGENT_DEFINITIONS.length);
		});
	});

	describe('getVisibleAgentDefinitions', () => {
		it('should not include hidden agents', () => {
			const visible = getVisibleAgentDefinitions();
			const visibleIds = visible.map((def) => def.id);

			// Terminal should be hidden
			expect(visibleIds).not.toContain('terminal');
		});

		it('should include visible agents', () => {
			const visible = getVisibleAgentDefinitions();
			const visibleIds = visible.map((def) => def.id);

			expect(visibleIds).toContain('claude-code');
			expect(visibleIds).toContain('codex');
			expect(visibleIds).toContain('opencode');
		});

		it('should return fewer items than AGENT_DEFINITIONS', () => {
			const visible = getVisibleAgentDefinitions();
			expect(visible.length).toBeLessThan(AGENT_DEFINITIONS.length);
		});
	});

	describe('Agent argument builders', () => {
		it('should have resumeArgs function for claude-code', () => {
			const claudeCode = getAgentDefinition('claude-code');
			expect(claudeCode?.resumeArgs).toBeDefined();
			expect(typeof claudeCode?.resumeArgs).toBe('function');

			const args = claudeCode?.resumeArgs?.('test-session-123');
			expect(args).toEqual(['--resume', 'test-session-123']);
		});

		it('should have resumeArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.resumeArgs).toBeDefined();

			const args = codex?.resumeArgs?.('thread-456');
			expect(args).toEqual(['resume', 'thread-456']);
		});

		it('should have resumeArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.resumeArgs).toBeDefined();

			const args = opencode?.resumeArgs?.('session-789');
			expect(args).toEqual(['--session', 'session-789']);
		});

		it('should have modelArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.modelArgs).toBeDefined();

			const args = opencode?.modelArgs?.('ollama/qwen3:8b');
			expect(args).toEqual(['--model', 'ollama/qwen3:8b']);
		});

		it('should have workingDirArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.workingDirArgs).toBeDefined();

			const args = codex?.workingDirArgs?.('/path/to/project');
			expect(args).toEqual(['-C', '/path/to/project']);
		});

		it('should use = syntax for Copilot resume args', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.resumeArgs).toBeDefined();

			const args = copilot?.resumeArgs?.('session-789');
			expect(args).toEqual(['--resume=session-789']);
		});

		it('should have imageArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.imageArgs).toBeDefined();

			const args = codex?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-i', '/path/to/image.png']);
		});

		it('should have imageArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.imageArgs).toBeDefined();

			const args = opencode?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-f', '/path/to/image.png']);
		});

		it('should embed Copilot images into prompts using @mentions', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.imagePromptBuilder).toBeDefined();

			const promptPrefix = copilot?.imagePromptBuilder?.([
				'/tmp/screenshot-1.png',
				'/tmp/screenshot-2.jpg',
			]);
			expect(promptPrefix).toContain('@/tmp/screenshot-1.png');
			expect(promptPrefix).toContain('@/tmp/screenshot-2.jpg');
		});
	});

	describe('Agent config options', () => {
		it('should have configOptions for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.configOptions).toBeDefined();
			expect(Array.isArray(codex?.configOptions)).toBe(true);

			const modelOption = codex?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');

			const reasoningOption = codex?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningOption).toBeDefined();
			expect(reasoningOption?.type).toBe('select');
			expect((reasoningOption as any)?.dynamic).toBe(true);
		});

		it('should have configOptions for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.configOptions).toBeDefined();

			const modelOption = opencode?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');
			expect(modelOption?.default).toBe('');

			// Test argBuilder
			expect(modelOption?.argBuilder).toBeDefined();
			expect(modelOption?.argBuilder?.('ollama/qwen3:8b')).toEqual(['--model', 'ollama/qwen3:8b']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});

		it('should expose only the batch-meaningful Copilot config knobs', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.configOptions).toBeDefined();

			// The only user-facing knobs we expose are model, contextWindow, and
			// reasoningEffort. The autopilot / allow-all-paths / allow-all-urls /
			// experimental / screen-reader flags are intentionally omitted: batch
			// mode already runs with --allow-all, and the rest are either
			// interactive-only or general user preferences (see definitions.ts).
			const keys = (copilot?.configOptions || []).map((opt) => opt.key).sort();
			expect(keys).toEqual(['contextWindow', 'model', 'reasoningEffort']);

			const reasoningEffort = copilot?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningEffort?.type).toBe('select');
			expect(reasoningEffort?.argBuilder?.('high')).toEqual(['--reasoning-effort', 'high']);
			expect(reasoningEffort?.argBuilder?.('')).toEqual([]);
		});

		it('should run Grok batch with --always-approve matching yoloModeArgs', () => {
			const grok = getAgentDefinition('grok');
			// batchModeArgs must equal yoloModeArgs (same pattern as Copilot's
			// --allow-all) so the CLI spawner's read-only filter strips the approve
			// flag: grok's clap hard-errors on a repeated --permission-mode
			// ("cannot be used multiple times"), so batchModeArgs must never carry
			// ['--permission-mode', 'bypassPermissions'] alongside readOnlyArgs'
			// ['--permission-mode', 'plan'].
			expect(grok?.batchModeArgs).toEqual(['--always-approve']);
			expect(grok?.yoloModeArgs).toEqual(['--always-approve']);
			// --deny Bash(*) keeps headless read-only turns alive: without it a
			// shell command classified non-read-only PROMPTS, headless grok answers
			// every prompt with "cancelled", and a cancelled prompt kills the whole
			// turn. A policy deny feeds back to the model and the turn continues.
			expect(grok?.readOnlyArgs).toEqual(['--permission-mode', 'plan', '--deny', 'Bash(*)']);
		});

		it('should define the Grok model option as a dynamic select with static fallback', () => {
			const grok = getAgentDefinition('grok');
			expect(grok?.configOptions).toBeDefined();

			const modelOption = grok?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('select');
			expect((modelOption as any)?.dynamic).toBe(true);
			// Static fallback for fresh installs where ~/.grok/models_cache.json
			// hasn't been written yet (per `grok models` v0.2.93).
			expect((modelOption as any)?.options).toEqual(['', 'grok-4.5', 'grok-composer-2.5-fast']);
			expect(modelOption?.default).toBe('');
			expect(modelOption?.argBuilder?.('grok-4.5')).toEqual(['-m', 'grok-4.5']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});

		it('should expose the full Grok reasoning-effort ladder the CLI accepts', () => {
			const grok = getAgentDefinition('grok');
			const reasoningEffort = grok?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningEffort?.type).toBe('select');
			// Empirically discovered from grok v0.2.93: passing a bogus value errors
			// with "Use none, minimal, low, medium, high, xhigh, max, or a model menu
			// option id".
			expect((reasoningEffort as any)?.options).toEqual([
				'',
				'none',
				'minimal',
				'low',
				'medium',
				'high',
				'xhigh',
				'max',
			]);
			expect(reasoningEffort?.default).toBe('');
			expect(reasoningEffort?.argBuilder?.('xhigh')).toEqual(['--reasoning-effort', 'xhigh']);
			expect(reasoningEffort?.argBuilder?.('')).toEqual([]);
			expect(reasoningEffort?.argBuilder?.('  ')).toEqual([]);
		});

		it('should run Copilot batch with --allow-all (no --silent, no per-flag toggles)', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.batchModeArgs).toEqual(['--allow-all']);
			expect(copilot?.batchModeArgs).not.toContain('--silent');
			expect(copilot?.yoloModeArgs).toEqual(['--allow-all']);
		});
	});

	describe('Qwen3 Coder agent', () => {
		it('should be a visible, real agent (not hidden)', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen).toBeDefined();
			expect(qwen?.hidden).toBeFalsy();
			expect(qwen?.binaryName).toBe('qwen');
			expect(qwen?.command).toBe('qwen');
		});

		it('should build modelArgs and stream-json output args', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen?.modelArgs?.('qwen3-coder-plus')).toEqual(['-m', 'qwen3-coder-plus']);
			expect(qwen?.jsonOutputArgs).toEqual(['--output-format', 'stream-json']);
			expect(qwen?.promptArgs?.('hello')).toEqual(['-p', 'hello']);
		});

		it('should expose a free-text model config option with trimming argBuilder', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			const modelOption = qwen?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');
			expect(modelOption?.default).toBe('');
			expect(modelOption?.argBuilder?.('qwen3-coder-plus')).toEqual(['-m', 'qwen3-coder-plus']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});

		it('should use --approval-mode plan for CLI-enforced read-only (never -y)', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen?.readOnlyArgs).toEqual(['--approval-mode', 'plan']);
			expect(qwen?.readOnlyCliEnforced).toBe(true);
			expect(qwen?.readOnlyArgs).not.toContain('-y');
		});
	});

	describe('Oh My Pi agent', () => {
		it('should restrict to read-only tools for CLI-enforced read-only', () => {
			const omp = getAgentDefinition('omp');
			expect(omp?.readOnlyArgs).toEqual(['--tools', 'read,grep,glob']);
			expect(omp?.readOnlyCliEnforced).toBe(true);
		});
	});

	describe('Type definitions', () => {
		it('should export AgentDefinition type', () => {
			const def: AgentDefinition = {
				id: 'test',
				name: 'Test Agent',
				binaryName: 'test',
				command: 'test',
				args: [],
			};
			expect(def.id).toBe('test');
		});

		it('should export AgentConfigOption type', () => {
			const option: AgentConfigOption = {
				key: 'testKey',
				type: 'text',
				label: 'Test Label',
				description: 'Test description',
				default: 'default value',
			};
			expect(option.key).toBe('testKey');
		});
	});
});

// ---------------------------------------------------------------------------
// Additional Directories: per-provider grant mapping
// ---------------------------------------------------------------------------
describe('additionalDirArgs', () => {
	const GRANTS = [
		{ path: '/ref/docs', read: true, write: false }, // read-only
		{ path: '/out/drop', read: false, write: true }, // write-only
		{ path: '/shared/src', read: true, write: true }, // read + write
		{ path: '/ignored', read: false, write: false }, // inert
	];

	const argsFor = (id: string) => {
		const def = AGENT_DEFINITIONS.find((d) => d.id === id);
		return def?.additionalDirArgs?.(GRANTS);
	};

	it('claude-code: --add-dir allows tool access, so every granted dir maps', () => {
		// `--add-dir` is access (read AND write). It cannot express write-only, so
		// the write-only dir is still passed and the prompt enforces "never read it".
		expect(argsFor('claude-code')).toEqual([
			'--add-dir',
			'/ref/docs',
			'--add-dir',
			'/out/drop',
			'--add-dir',
			'/shared/src',
		]);
	});

	it('copilot-cli: same access semantics as Claude Code', () => {
		expect(argsFor('copilot-cli')).toEqual([
			'--add-dir',
			'/ref/docs',
			'--add-dir',
			'/out/drop',
			'--add-dir',
			'/shared/src',
		]);
	});

	it('codex: --add-dir adds a WRITABLE sandbox root, so read-only grants do not map', () => {
		// Codex's flag is narrower than Claude's. Passing a read-only dir here would
		// hand the sandbox write access the user never granted.
		expect(argsFor('codex')).toEqual(['--add-dir', '/out/drop', '--add-dir', '/shared/src']);
	});

	it('drops inert grants for every provider that has a builder', () => {
		for (const def of AGENT_DEFINITIONS) {
			const args = def.additionalDirArgs?.(GRANTS);
			if (!args) continue;
			expect(args, `${def.id} leaked a grant with neither read nor write`).not.toContain(
				'/ignored'
			);
		}
	});

	it('opencode has no native mechanism and falls back to the prompt', () => {
		expect(argsFor('opencode')).toBeUndefined();
	});
});

// ===== from src/__tests__/main/agents/opencode-config.test.ts =====

describe('opencode-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('parseOpenCodeConfig', () => {
		it('should parse valid JSON config', () => {
			const config = parseOpenCodeConfig('{"model": "ollama/qwen3:8b"}');
			expect(config).toEqual({ model: 'ollama/qwen3:8b' });
		});

		it('should return null for invalid JSON', () => {
			expect(parseOpenCodeConfig('not json')).toBeNull();
			expect(parseOpenCodeConfig('')).toBeNull();
		});
	});

	describe('extractModelsFromConfig', () => {
		it('should extract models from provider definitions', () => {
			const config = {
				provider: {
					ollama: {
						models: {
							'gpt-oss:latest': { name: 'GPT OSS' },
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
					anthropic: {
						models: {
							'claude-sonnet-4-20250514': { name: 'Claude Sonnet' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual([
				'ollama/gpt-oss:latest',
				'ollama/qwen3:8b',
				'anthropic/claude-sonnet-4-20250514',
			]);
		});

		it('should include top-level model override', () => {
			const config = {
				model: 'anthropic/claude-sonnet-4-20250514',
				provider: {
					ollama: {
						models: {
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual(['anthropic/claude-sonnet-4-20250514', 'ollama/qwen3:8b']);
		});

		it('should deduplicate top-level model when it matches a provider model', () => {
			const config = {
				model: 'ollama/qwen3:8b',
				provider: {
					ollama: {
						models: {
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual(['ollama/qwen3:8b']);
		});

		it('should return empty array for config without providers or model', () => {
			expect(extractModelsFromConfig({})).toEqual([]);
			expect(extractModelsFromConfig({ provider: {} })).toEqual([]);
		});

		it('should skip providers without models property', () => {
			const config = {
				provider: {
					ollama: { npm: '@ai-sdk/openai-compatible' },
				},
			};
			expect(extractModelsFromConfig(config)).toEqual([]);
		});

		it('should ignore empty or whitespace model override', () => {
			expect(extractModelsFromConfig({ model: '' })).toEqual([]);
			expect(extractModelsFromConfig({ model: '   ' })).toEqual([]);
		});
	});

	describe('getOpenCodeConfigPaths', () => {
		it('should return POSIX paths in correct order', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths('/project', {});
			// The product assembles these with `path.join`, so route the expected
			// values through the same primitive to stay platform-symmetric (`\`
			// separators on Windows, `/` on POSIX).
			expect(paths).toEqual([
				path.join('/project', 'opencode.json'),
				expect.stringContaining(path.join('.opencode', 'opencode.json')),
				expect.stringContaining('.opencode.json'),
				expect.stringContaining(path.join('.config', 'opencode', 'opencode.json')),
			]);
		});

		it('should prepend OPENCODE_CONFIG env var when set', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths('/project', {
				OPENCODE_CONFIG: '/custom/opencode.json',
			});
			expect(paths[0]).toBe('/custom/opencode.json');
			expect(paths.length).toBe(5);
		});

		it('should return paths without project-local when cwd is undefined', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths(undefined, {});
			expect(paths.every((p) => !p.includes('undefined'))).toBe(true);
			expect(paths.length).toBe(3);
		});
	});

	describe('getOpenCodeCommandDirs', () => {
		it('should return POSIX dirs in correct order', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const dirs = getOpenCodeCommandDirs('/project');
			expect(dirs).toEqual([
				path.join('/project', '.opencode', 'commands'),
				expect.stringContaining(path.join('.opencode', 'commands')),
				expect.stringContaining(path.join('.config', 'opencode', 'commands')),
			]);
		});

		it('should exclude project dir when cwd is undefined', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const dirs = getOpenCodeCommandDirs(undefined);
			expect(dirs.length).toBe(2);
		});
	});

	describe('discoverModelsFromLocalConfigs', () => {
		it('should merge models from multiple config files', async () => {
			// Simulate two config files found
			vi.mocked(fs_1.promises.readFile).mockImplementation(async (filePath: any) => {
				// Normalize separators: the product builds these paths with
				// `path.join`, which emits `\` on Windows. On POSIX this is a no-op.
				const p = String(filePath).replace(/\\/g, '/');
				if (p.includes('.opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							ollama: {
								models: {
									'qwen3:8b': { name: 'Qwen3' },
								},
							},
						},
					});
				}
				if (p.includes('.config/opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							anthropic: {
								models: {
									'claude-sonnet-4-20250514': { name: 'Claude Sonnet' },
								},
							},
						},
					});
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs('/project');
			expect(models).toContain('ollama/qwen3:8b');
			expect(models).toContain('anthropic/claude-sonnet-4-20250514');
		});

		it('should deduplicate models across config files', async () => {
			vi.mocked(fs_1.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath).replace(/\\/g, '/');
				if (p.includes('.opencode/opencode.json') || p.includes('.config/opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							ollama: {
								models: { 'qwen3:8b': { name: 'Qwen3' } },
							},
						},
					});
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs('/project');
			const count = models.filter((m) => m === 'ollama/qwen3:8b').length;
			expect(count).toBe(1);
		});

		it('should return empty array when no config files exist', async () => {
			vi.mocked(fs_1.promises.readFile).mockImplementation(async () => {
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs();
			expect(models).toEqual([]);
		});

		it('should skip invalid JSON config files', async () => {
			vi.mocked(fs_1.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p.includes('.opencode/opencode.json')) {
					return 'not valid json';
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs();
			expect(models).toEqual([]);
		});
	});
});
