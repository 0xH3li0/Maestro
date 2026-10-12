/**
 * @file system-prompt.test.ts
 * @description Tests for `prepareMaestroSystemPromptCli` - the CLI-side
 * builder that loads `maestro-system-prompt`, threads in branch / history /
 * conductor context, and returns the substituted template for use as
 * `appendSystemPrompt`. Mirrors the renderer's `prepareMaestroSystemPrompt`
 * in `src/renderer/utils/spawnHelpers.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => '/mock/config'),
	readSettingValue: vi.fn(),
	resolveSessionHistoryFilePath: vi.fn(),
}));

vi.mock('../../../shared/maestro-run/state-file', () => ({
	readMaestroRunReadyPath: vi.fn(),
}));

vi.mock('../../../cli/services/git-utils', () => ({
	getGitBranch: vi.fn(),
	isGitRepo: vi.fn(),
}));

// The desktop app, as the CLI reaches it. `desktop.reply` is what it answers
// `system_one_access` with; `null` is a desktop that is not running.
const desktop = vi.hoisted(() => ({
	reply: null as Record<string, unknown> | null,
	sendCommand: (async () => null) as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(async (action: (client: unknown) => Promise<unknown>) => {
		if (desktop.reply === null) throw new Error('Maestro desktop app is not running');
		return action({ sendCommand: (...args: unknown[]) => desktop.sendCommand(...args) });
	}),
}));

import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import {
	SYSTEM_ONE_ACCESS_TIMEOUT_MS,
	readSystemOneAccessFromDesktop,
} from '../../../cli/services/system-one-access';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../../helpers/systemOneAccess';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import { readSettingValue, resolveSessionHistoryFilePath } from '../../../cli/services/storage';
import { getGitBranch, isGitRepo } from '../../../cli/services/git-utils';
import { readMaestroRunReadyPath } from '../../../shared/maestro-run/state-file';

const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-abc-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/path/to/project',
	projectRoot: '/path/to/project',
	...overrides,
});

describe('prepareMaestroSystemPromptCli', () => {
	beforeEach(() => {
		// Clear call history but keep implementations - explicit per-test
		// defaults below so behavior is unambiguous.
		vi.clearAllMocks();
		// Re-establish the mocked storage default since resetAllMocks would
		// nuke it, and we want a stable getConfigDirectory return value.
		vi.mocked(isGitRepo).mockReturnValue(true);
		vi.mocked(getGitBranch).mockReturnValue('main');
		vi.mocked(readSettingValue).mockReturnValue('');
		// Default: history file does NOT exist (fresh session)
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue(undefined);
		// Default: the app has not recorded MaestroRun as ready.
		vi.mocked(readMaestroRunReadyPath).mockReturnValue(undefined);
		// Default: the desktop app is not running, so System One cannot be asked about.
		desktop.reply = null;
		desktop.sendCommand = vi.fn(async () => desktop.reply);
	});

	it('substitutes agent identity, branch, and conductor profile into the template', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue(
			'You are {{AGENT_NAME}} on branch {{GIT_BRANCH}}.\nConductor: {{CONDUCTOR_PROFILE}}'
		);
		vi.mocked(readSettingValue).mockReturnValue('senior engineer, prefers concise');

		const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'Codex Bot' }));

		expect(result).toContain('You are Codex Bot on branch main.');
		expect(result).toContain('Conductor: senior engineer, prefers concise');
	});

	it('substitutes the configured worktree directory, and leaves it empty when unset', async () => {
		// Headless spawns get the same Worktree Directory line as desktop tabs, so
		// an agent started from the CLI creates worktrees where the app will see them.
		vi.mocked(getCliPrompt).mockResolvedValue('Worktrees: [{{WORKTREE_BASE_PATH}}]');

		const configured = await prepareMaestroSystemPromptCli(
			mockSession({
				worktreeConfig: { basePath: '/home/me/Project-WorkTrees', watchEnabled: true },
			})
		);
		expect(configured).toContain('Worktrees: [/home/me/Project-WorkTrees]');

		const unset = await prepareMaestroSystemPromptCli(mockSession({ worktreeConfig: undefined }));
		expect(unset).toContain('Worktrees: []');
	});

	it('returns undefined when the prompt template fails to load (non-fatal)', async () => {
		vi.mocked(getCliPrompt).mockRejectedValue(
			new Error('Failed to load prompt "maestro-system-prompt" (maestro-system-prompt.md)')
		);

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBeUndefined();
	});

	it('re-throws unexpected errors so genuine bugs surface (not just "failed to load")', async () => {
		// A non-"Failed to load…" error indicates a bug in the loader or a
		// caller misuse - those must propagate so the user sees them rather
		// than silently spawning without a system prompt.
		vi.mocked(getCliPrompt).mockRejectedValue(new TypeError('something is undefined'));

		await expect(prepareMaestroSystemPromptCli(mockSession())).rejects.toThrow(
			/something is undefined/
		);
	});

	it('skips git branch lookup when the cwd is not a git repo', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('branch=[{{GIT_BRANCH}}]');
		vi.mocked(isGitRepo).mockReturnValue(false);

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(getGitBranch).not.toHaveBeenCalled();
		expect(result).toBe('branch=[]');
	});

	it('omits the history file path when one is not yet written (fresh session)', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('history=[]');
	});

	it('includes the history file path when the file exists locally', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue('/mock/config/history/sess-1.jsonl');

		const result = await prepareMaestroSystemPromptCli(mockSession({ id: 'sess-1' }));

		expect(resolveSessionHistoryFilePath).toHaveBeenCalledWith('sess-1');
		expect(result).toBe('history=[/mock/config/history/sess-1.jsonl]');
	});

	it('skips the history file pointer for SSH sessions (path is local-only)', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue('/mock/config/history/x.jsonl');

		const result = await prepareMaestroSystemPromptCli(
			mockSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote1' },
			})
		);

		expect(result).toBe('history=[]');
	});

	it('tolerates a non-string conductor profile setting', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('cond=[{{CONDUCTOR_PROFILE}}]');
		// e.g. a malformed settings file with a non-string value
		vi.mocked(readSettingValue).mockReturnValue({ accidentallyAnObject: true });

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('cond=[]');
	});

	describe('role and plugin sections', () => {
		const prompts: Record<string, string> = {
			'maestro-system-prompt': 'BASE {{AGENT_NAME}}',
			'pianola-system': 'PIANOLA',
			'computer-history-system': 'HISTORY at {{COMPUTER_HISTORY_DIR}}',
		};
		const settings = (encoreFeatures: unknown) => (key: string) =>
			key === 'encoreFeatures' ? encoreFeatures : '';

		beforeEach(() => {
			vi.mocked(getCliPrompt).mockImplementation(async (id: string) => {
				if (id in prompts) return prompts[id];
				throw new Error(`Failed to load prompt "${id}" (${id}.md)`);
			});
		});

		it('appends nothing extra while every section flag is off (default)', async () => {
			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
			expect(result).toBe('BASE A');
		});

		it('appends the Pianola role section for the Pianola agent', async () => {
			const result = await prepareMaestroSystemPromptCli(
				mockSession({ name: 'A', isPianola: true })
			);
			expect(result).toBe('BASE A\n\n---\n\nPIANOLA');
		});

		it('appends the Computer History section with the local store path when enabled', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));

			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));

			expect(result).toBe('BASE A\n\n---\n\nHISTORY at /mock/config/computer-history');
		});

		describe('MaestroRun', () => {
			const LAUNCHER = '/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run';

			beforeEach(() => {
				prompts['maestro-run-system'] = 'RUN {{MAESTRO_RUN_PATH}}';
				vi.mocked(readSettingValue).mockImplementation(settings({ maestroRun: true }));
			});

			it('is left out while the app has not recorded the launcher as ready', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe('BASE A');
				expect(readMaestroRunReadyPath).toHaveBeenCalledWith('/mock/config');
			});

			it('is appended with the launcher path once the state file says ready', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe(`BASE A\n\n---\n\nRUN ${LAUNCHER}`);
			});

			it('is left out when ready but the flag is off', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				vi.mocked(readSettingValue).mockImplementation(settings({ maestroRun: false }));
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
			});

			it('is never given to an SSH agent, and the state file is not read', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				const result = await prepareMaestroSystemPromptCli(
					mockSession({ name: 'A', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
				);
				expect(result).toBe('BASE A');
				expect(readMaestroRunReadyPath).not.toHaveBeenCalled();
			});
		});

		describe('System One', () => {
			const SSH = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };
			const SECTION =
				'S1 Jev (TypeSafe cloud)|calibrated: of the answers it gives 0.8, about 80% are true, so act on thresholds|$1.00 a day across all agents; more than half is left today';

			beforeEach(() => {
				prompts['system-one-system'] =
					'S1 {{SYSTEM_ONE_ENGINE}}|{{SYSTEM_ONE_CALIBRATED}}|{{SYSTEM_ONE_BUDGET}}';
				desktop.reply = { success: true, access: systemOneAccess() };
			});

			it('is appended when the desktop says a request from this agent would be answered', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe(`BASE A\n\n---\n\n${SECTION}`);
				// Asked about the agent being spawned, with a wait that cannot hold a spawn long.
				expect(desktop.sendCommand).toHaveBeenCalledWith(
					{ type: 'system_one_access', agentId: 'agent-abc-123' },
					'system_one_access_result',
					SYSTEM_ONE_ACCESS_TIMEOUT_MS
				);
			});

			it('is left out behind each gate that refuses the agent', async () => {
				for (const gate of SYSTEM_ONE_GATES) {
					desktop.reply = { success: true, access: refusedSystemOneAccess(gate) };
					expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' })), gate).toBe(
						'BASE A'
					);
				}
			});

			it('is left out when the desktop app is not running: the verbs could not reach it either', async () => {
				desktop.reply = null;
				const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				// A closed desktop is a normal state for a headless run: nothing is printed.
				expect(errSpy).not.toHaveBeenCalled();
				errSpy.mockRestore();
			});

			it('is left out when the desktop is too old for the question, or refuses it', async () => {
				desktop.sendCommand = vi.fn(async () => {
					throw new Error('Unsupported command: system_one_access');
				});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');

				desktop.sendCommand = vi.fn(async () => ({ success: false, error: 'no' }));
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				await expect(readSystemOneAccessFromDesktop('agent-abc-123')).resolves.toBeUndefined();
			});

			it('is never given to an SSH remote agent, and the desktop is not asked', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A', ...SSH }));
				expect(result).toBe('BASE A');
				expect(withMaestroClient).not.toHaveBeenCalled();
			});

			it('asks the reader it is handed instead of the desktop (the builder inside the app)', async () => {
				desktop.reply = null;
				const readSystemOneAccess = vi.fn(async () => systemOneAccess());
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }), {
					readSystemOneAccess,
				});
				expect(result).toBe(`BASE A\n\n---\n\n${SECTION}`);
				expect(readSystemOneAccess).toHaveBeenCalledWith('agent-abc-123');
				expect(withMaestroClient).not.toHaveBeenCalled();
			});

			it('sits after the role section and before the plugin sections', async () => {
				vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));
				const result = await prepareMaestroSystemPromptCli(
					mockSession({ name: 'A', isPianola: true })
				);
				expect(result?.split('\n\n---\n\n').map((part) => part.slice(0, 4))).toEqual([
					'BASE',
					'PIAN',
					'S1 J',
					'HIST',
				]);
			});

			it('skips the section when its prompt file is missing', async () => {
				delete prompts['system-one-system'];
				const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				errSpy.mockRestore();
			});
		});

		it('skips the localOnly Computer History section for SSH agents', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));

			const result = await prepareMaestroSystemPromptCli(
				mockSession({ name: 'A', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
			);

			expect(result).toBe('BASE A');
		});

		it('skips a section whose prompt file is missing instead of dropping the whole prompt', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));
			delete prompts['computer-history-system'];
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));

			expect(result).toBe('BASE A');
			expect(errSpy).toHaveBeenCalled();
			errSpy.mockRestore();
			prompts['computer-history-system'] = 'HISTORY at {{COMPUTER_HISTORY_DIR}}';
		});
	});
});
