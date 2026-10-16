// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/bmad-manager.test.ts
//   - src/__tests__/main/cross-agent-router.test.ts
//   - src/__tests__/main/openspec-manager.test.ts

import {
	getBmadCommand,
	getBmadCommandBySlash,
	getBmadMetadata,
	getBmadPrompts,
	resetBmadPrompt,
	saveBmadPrompt,
} from '../../main/bmad-manager';
import type { BmadMetadata } from '../../main/bmad-manager';
import {
	buildCrossAgentPrompt,
	cancelCrossAgentRequestsForSource,
	serializeTranscript,
	startCrossAgentRequest,
} from '../../main/cross-agent/cross-agent-router';
import type { CrossAgentTargetSession } from '../../main/cross-agent/cross-agent-router';
import { spawnGroupChatAgent } from '../../main/group-chat/spawnGroupChatAgent';
import {
	OpenSpecCommand,
	OpenSpecMetadata,
	getOpenSpecCommand,
	getOpenSpecCommandBySlash,
	getOpenSpecMetadata,
	getOpenSpecPrompts,
	resetOpenSpecPrompt,
	saveOpenSpecPrompt,
} from '../../main/openspec-manager';
import type {
	CrossAgentRequest,
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../shared/crossAgentTypes';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/userData'),
		isPackaged: false,
	},
}));
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));
vi.mock('../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: vi.fn(async () => ({ pid: 123, success: true })),
}));
vi.mock('../../main/group-chat/output-parser', () => ({
	extractTextFromStreamJson: vi.fn((raw: string) => raw),
}));
vi.mock('../../main/utils/sentry', () => ({ captureException: vi.fn() }));

// ===== from src/__tests__/main/bmad-manager.test.ts =====

describe('bmad-manager', () => {
	const mockBundledPrompt = '# Test Prompt\n\nThis is a test prompt.';
	const mockMetadata: BmadMetadata = {
		lastRefreshed: '2026-03-14T00:00:00Z',
		commitSha: 'ac769b2',
		sourceVersion: '6.1.0',
		sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('getBmadMetadata', () => {
		it('should return bundled metadata when no customizations exist', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const metadata = await getBmadMetadata();
			expect(metadata).toEqual(mockMetadata);
		});
	});

	describe('getBmadPrompts', () => {
		it('should return bundled commands', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const commands = await getBmadPrompts();

			expect(commands.length).toBeGreaterThan(20);
			expect(commands.some((cmd) => cmd.command === '/bmad-help')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/bmad-bmm-create-prd')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/bmad-bmm-quick-spec')).toBe(true);
			expect(commands.every((cmd) => cmd.command.startsWith('/bmad'))).toBe(true);
		});
	});

	describe('saveBmadPrompt', () => {
		it('should persist a customized prompt', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			await saveBmadPrompt('help', '# Custom Help');

			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('bmad-customizations.json'),
				expect.stringContaining('# Custom Help'),
				'utf-8'
			);
		});
	});

	describe('resetBmadPrompt', () => {
		it('should reset a customized prompt to the bundled default', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							help: {
								content: '# Customized Help',
								isModified: true,
							},
						},
					});
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const prompt = await resetBmadPrompt('help');

			expect(prompt).toBe(mockBundledPrompt);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('bmad-customizations.json'),
				expect.not.stringContaining('# Customized Help'),
				'utf-8'
			);
		});

		it('should throw for an unknown command', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

			await expect(resetBmadPrompt('missing')).rejects.toThrow('Unknown BMAD command');
		});
	});

	describe('command lookup helpers', () => {
		it('should find a command by slash command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('bmad-customizations.json')) {
					throw new Error('ENOENT');
				}
				if (pathStr.includes('bmad-prompts')) {
					throw new Error('ENOENT');
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				if (pathStr.endsWith('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw new Error('ENOENT');
			});

			const byId = await getBmadCommand('help');
			const bySlash = await getBmadCommandBySlash('/bmad-help');

			expect(byId?.command).toBe('/bmad-help');
			expect(bySlash?.id).toBe('help');
		});
	});
});

// ===== from src/__tests__/main/cross-agent-router.test.ts =====

/**
 * Pure prompt-assembly tests for the cross-agent router. The dispatch itself
 * (spawn + stream) needs a live ProcessManager and is exercised end-to-end.
 */

const entry = (source: string, text?: string): CrossAgentTranscriptEntry => ({ source, text });

function request(overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: 'What is your take?',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
		...overrides,
	};
}

describe('serializeTranscript', () => {
	it('labels user and assistant turns', () => {
		const out = serializeTranscript([entry('user', 'Hi'), entry('ai', 'Hello there')]);
		expect(out).toBe('**User:** Hi\n**Assistant:** Hello there');
	});

	it('drops entries with no visible text', () => {
		const out = serializeTranscript([
			entry('user', 'Question'),
			entry('ai', '   '),
			entry('ai', undefined),
			entry('tool'),
		]);
		expect(out).toBe('**User:** Question');
	});

	it('keeps tool/thinking entries only when they carry visible text', () => {
		const out = serializeTranscript([
			entry('thinking', 'pondering...'),
			entry('tool', 'ran a search'),
		]);
		expect(out).toContain('pondering...');
		expect(out).toContain('ran a search');
	});

	it('returns an empty string for an empty transcript', () => {
		expect(serializeTranscript([])).toBe('');
	});
});

describe('buildCrossAgentPrompt', () => {
	it('prepends the consult header, then transcript, then the relayed question', () => {
		const prompt = buildCrossAgentPrompt(
			request({
				transcript: [entry('user', 'Hi'), entry('ai', 'Yo')],
				userPrompt: 'Thoughts?',
			})
		);
		expect(prompt).toMatch(/^You are being consulted by another agent in Maestro\./);
		expect(prompt).toContain('**User:** Hi');
		expect(prompt).toContain('**Assistant:** Yo');
		expect(prompt).toContain(
			'**Question from the user (relayed via the source agent):**\nThoughts?'
		);
		// The header comes before the transcript, which comes before the question.
		expect(prompt.indexOf('consulted')).toBeLessThan(prompt.indexOf('**User:** Hi'));
		expect(prompt.indexOf('**Assistant:** Yo')).toBeLessThan(
			prompt.indexOf('Question from the user')
		);
	});

	it('omits the transcript block entirely when there is nothing to forward', () => {
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('You are being consulted');
		expect(prompt).toContain('Just this');
		// No stray blank transcript section: header flows straight into the question.
		expect(prompt).not.toContain('**User:**');
	});

	it('does not announce a transcript when none was forwarded', () => {
		// `maestro-cli ask` sends a self-contained question with no transcript.
		// Telling the target to read "the conversation transcript so far" sends it
		// hunting for context that is not in the prompt.
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('no prior conversation to read');
		expect(prompt).not.toContain('conversation transcript so far');
	});

	it('still announces the transcript when one was forwarded', () => {
		const prompt = buildCrossAgentPrompt(
			request({ transcript: [entry('user', 'Hi')], userPrompt: 'Thoughts?' })
		);
		expect(prompt).toContain('conversation transcript so far');
		expect(prompt).not.toContain('no prior conversation to read');
	});

	it('grants read access to the source cwd when forwarded, before the question', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Look at the config' })
		);
		expect(prompt).toContain('`/Users/me/proj`');
		expect(prompt).toContain('permission to READ');
		expect(prompt).toContain('Do NOT modify or create files');
		// The grant rides with the header, ahead of the relayed question.
		expect(prompt.indexOf('/Users/me/proj')).toBeLessThan(prompt.indexOf('Look at the config'));
	});

	it('omits the cwd grant entirely when no source cwd is forwarded', () => {
		const prompt = buildCrossAgentPrompt(request({ sourceCwd: undefined }));
		expect(prompt).not.toContain('permission to READ');
	});

	it('tells the target how to lift the read-only restriction when read-only', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' })
		);
		expect(prompt).toContain('Settings > General > Cross-Agent Mentions');
		// The remedy has to name the setting as the user sees it in Settings, or
		// the target sends them hunting for a control that is labeled otherwise.
		expect(prompt).toContain('Consult or Delegate');
	});

	it('names the read-only mode a consult so the target can say which mode it is in', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' })
		);
		expect(prompt).toContain('consults (read-only)');
		expect(prompt).not.toContain('DELEGATION');
	});

	it('grants write access and drops the prohibition when writable is opted into', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' }),
			true
		);
		expect(prompt).toContain('permission to READ and MODIFY');
		expect(prompt).not.toContain('Do NOT modify or create files');
		expect(prompt).not.toContain('Settings > General > Cross-Agent Mentions');
	});

	it('names the writable mode a delegation so the target knows it may apply changes', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' }),
			true
		);
		expect(prompt).toContain('DELEGATION');
	});
});

const IDLE_MS = 10 * 60 * 1000;

const HARD_MS = 30 * 60 * 1000;

/** Minimal ProcessManager stand-in: the router only uses on/off/kill. */
class FakeProcessManager extends EventEmitter {
	kill = vi.fn();
}

const targetSession = (): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Maestro Marketing',
	toolType: 'claude-code',
	cwd: '/proj',
});

function harness(
	overrides: {
		getTargetSession?: () => CrossAgentTargetSession | null;
		writable?: boolean;
	} = {}
) {
	const processManager = new FakeProcessManager();
	const chunks: CrossAgentResponseChunk[] = [];
	const dispatch = () =>
		startCrossAgentRequest(request(), {
			processManager: processManager as never,
			agentDetector: {
				getAgent: async () => ({
					id: 'claude-code',
					name: 'Claude Code',
					command: 'claude',
					path: 'claude',
					args: [],
					available: true,
					// Mirrors the real claude-code definition. Both permission branches
					// have to be present or `buildAgentArgs` emits nothing either way
					// and the flag assertions below silently pass on any input.
					fullAccessArgs: ['--dangerously-skip-permissions'],
					readOnlyArgs: ['--permission-mode', 'plan'],
					readOnlyCliEnforced: true,
				}),
			} as never,
			sshStore: null,
			getTargetSession: overrides.getTargetSession ?? targetSession,
			writable: overrides.writable,
			onChunk: (c) => chunks.push(c),
		});
	// The router keys its listeners on `cross-agent-<requestId>`; request() uses 'r1'.
	const emitData = (text: string) => processManager.emit('data', 'cross-agent-r1', text);
	const emitExit = (code: number) => processManager.emit('exit', 'cross-agent-r1', code);
	// A `--print` claude run signals progress through these, NOT through `data`.
	const emitThinking = (text: string) =>
		processManager.emit('thinking-chunk', 'cross-agent-r1', text);
	const emitTool = () => processManager.emit('tool-execution', 'cross-agent-r1', { name: 'Read' });
	const emitUsage = () => processManager.emit('usage', 'cross-agent-r1', { inputTokens: 1 });
	return {
		processManager,
		chunks,
		dispatch,
		emitData,
		emitExit,
		emitThinking,
		emitTool,
		emitUsage,
	};
}

describe('startCrossAgentRequest dispatch lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('spawns the consult read-only and caps maestro-p idle wait to the idle budget', async () => {
		const { dispatch } = harness();
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		// The consult prompt promises the target it will not write; the spawn is what
		// actually enforces it.
		expect(config.readOnlyMode).toBe(true);
		expect(config.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
		expect(config.maxWaitSeconds).toBe(IDLE_MS / 1000);
	});

	it('spawns a writable delegation with FULL access, not merely "not read-only"', async () => {
		const { dispatch } = harness({ writable: true });
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.readOnlyMode).toBe(false);
		// The regression this guards: turning read-only OFF selects buildAgentArgs'
		// standard branch, which emits no permission flags and leaves the agent on
		// its interactive default. A `--print` run has no approver, so the first
		// write tool call blocks forever - no output, no exit - while the prompt has
		// already told the agent it may apply changes directly.
		expect(config.args).toContain('--dangerously-skip-permissions');
		expect(config.args).not.toContain('plan');
	});

	it('spawns the binary the agent is configured with, not the auto-detected one', async () => {
		// Detection probes known install dirs before PATH, so a stale nvm stub can
		// win over the codex the user pointed the agent at. The tab honors
		// customPath; the consult must too, or the two run different binaries.
		const { dispatch } = harness({
			getTargetSession: () => ({ ...targetSession(), customPath: '/opt/custom/claude' }),
		});
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.command).toBe('/opt/custom/claude');
	});

	it('falls back to the detected binary when the agent has no customPath', async () => {
		const { dispatch } = harness();
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.command).toBe('claude');
	});

	it('does not kill a target that keeps streaming past the idle budget', async () => {
		const { chunks, dispatch, emitData } = harness();
		await dispatch();

		// Nine minutes of silence, a byte of output, then nine more: a wall-clock
		// budget would have fired by now. The idle budget must not.
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		emitData('still working');
		vi.advanceTimersByTime(IDLE_MS - 60_000);

		expect(chunks).toHaveLength(0);
	});

	// Regression: a `--print` stream-json consult emits `data` ONLY at the terminal
	// result message - intermediate progress goes to thinking-chunk /
	// tool-execution / usage. Arming the silence budget on `data` alone made it a
	// hard N-minute deadline that killed agents which were working perfectly.
	it('does not kill a target that is thinking but has emitted no data', async () => {
		const { chunks, dispatch, emitThinking } = harness();
		await dispatch();

		for (let elapsed = 0; elapsed < HARD_MS - IDLE_MS; elapsed += IDLE_MS - 60_000) {
			vi.advanceTimersByTime(IDLE_MS - 60_000);
			emitThinking('reasoning...');
		}

		expect(chunks).toHaveLength(0);
	});

	it('does not kill a target that is running tools but has emitted no data', async () => {
		const { chunks, dispatch, emitTool } = harness();
		await dispatch();

		vi.advanceTimersByTime(IDLE_MS - 60_000);
		emitTool();
		vi.advanceTimersByTime(IDLE_MS - 60_000);

		expect(chunks).toHaveLength(0);
	});

	it('treats a usage report as proof of life', async () => {
		const { chunks, dispatch, emitUsage } = harness();
		await dispatch();

		vi.advanceTimersByTime(IDLE_MS - 60_000);
		emitUsage();
		vi.advanceTimersByTime(IDLE_MS - 60_000);

		expect(chunks).toHaveLength(0);
	});

	it('ignores liveness signals belonging to a different session', async () => {
		// The ProcessManager emitter is shared app-wide; another agent's activity
		// must not keep a genuinely wedged consult alive forever.
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		vi.advanceTimersByTime(IDLE_MS - 60_000);
		processManager.emit('thinking-chunk', 'some-other-session', 'not ours');
		vi.advanceTimersByTime(60_000);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('went silent');
	});

	it('still stops a target that is truly wedged on every channel', async () => {
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		vi.advanceTimersByTime(IDLE_MS);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks[0].error).toContain('went silent');
	});

	it('removes every liveness listener once the consult settles', async () => {
		// These attach to the shared ProcessManager; leaking one per consult would
		// accumulate for the life of the app.
		const { dispatch, emitExit, processManager } = harness();
		await dispatch();

		const before = ['data', 'thinking-chunk', 'tool-execution', 'usage', 'exit'].map((e) =>
			processManager.listenerCount(e)
		);
		expect(before.every((n) => n > 0)).toBe(true);

		emitExit(0);

		for (const evt of ['data', 'thinking-chunk', 'tool-execution', 'usage', 'exit']) {
			expect(processManager.listenerCount(evt)).toBe(0);
		}
	});

	it('kills the target and flushes partial output once it goes silent', async () => {
		const { chunks, dispatch, emitData, processManager } = harness();
		await dispatch();

		emitData('half an answer');
		vi.advanceTimersByTime(IDLE_MS);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		// The work the target DID do survives; it is stamped as a failure, not dropped.
		expect(chunks[0].chunk).toBe('half an answer');
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toContain('went silent');
		// A killed run must not seed a resume id for the next consult.
		expect(chunks[0].targetAgentSessionId).toBeUndefined();
	});

	it('stops a chattering target at the hard ceiling even though it never idles', async () => {
		const { chunks, dispatch, emitData } = harness();
		await dispatch();

		// Output every five minutes forever: the idle timer never fires.
		for (let elapsed = 0; elapsed < HARD_MS; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			emitData('.');
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('exceeded the 30-minute limit');
	});

	it('settles once: a timeout after exit does not emit a second chunk', async () => {
		const { chunks, dispatch, emitData, emitExit } = harness();
		await dispatch();

		emitData('the answer');
		emitExit(0);
		vi.advanceTimersByTime(HARD_MS * 2);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toBeUndefined();
		expect(chunks[0].chunk).toBe('the answer');
	});

	it('fails fast when the spawner reports failure instead of throwing', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch } = harness();
		await dispatch();

		// A spawner that returns `success: false` emits no 'exit' event. Without an
		// explicit check the user waits out the full budget for a process that never
		// existed, so the error must land immediately - before any timer advances.
		expect(chunks).toHaveLength(1);
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toContain('could not be started');
	});

	it('stops the timers when the spawn fails, so no late chunk follows', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch } = harness();
		await dispatch();

		vi.advanceTimersByTime(HARD_MS * 2);
		expect(chunks).toHaveLength(1);
	});
});

/**
 * Stop is an AGENT-level action, and a `@mention` fans one turn out across an
 * ephemeral `cross-agent-*` process per consulted target. None of those carry
 * the source agent's process id, so cancellation is addressed by SOURCE agent.
 */
describe('cancelCrossAgentRequestsForSource', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		// Leave no live consult behind for the next test to cancel.
		cancelCrossAgentRequestsForSource('src');
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('kills a running consult and settles it as canceled, not as a failure', async () => {
		const { chunks, dispatch, processManager, emitData } = harness();
		await dispatch();
		emitData('half an answer');

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].canceled).toBe(true);
		// The user stopping a consult is not the target failing to answer, so the
		// bubble must not be stamped with an error.
		expect(chunks[0].error).toBeUndefined();
		// Whatever the target managed to say before the plug was pulled is kept.
		expect(chunks[0].chunk).toBe('half an answer');
	});

	it('leaves consults belonging to another source agent alone', async () => {
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(cancelCrossAgentRequestsForSource('some-other-agent')).toBe(0);
		expect(processManager.kill).not.toHaveBeenCalled();
		expect(chunks).toHaveLength(0);
	});

	it('is a no-op for a consult that already finished', async () => {
		const { chunks, dispatch, emitData, emitExit } = harness();
		await dispatch();
		emitData('the answer');
		emitExit(0);

		expect(cancelCrossAgentRequestsForSource('src')).toBe(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBeUndefined();
	});

	it('settles only once when Stop is pressed twice', async () => {
		const { chunks, dispatch } = harness();
		await dispatch();

		cancelCrossAgentRequestsForSource('src');
		cancelCrossAgentRequestsForSource('src');

		expect(chunks).toHaveLength(1);
	});

	it('emits no late chunk after a cancel, even past both budgets', async () => {
		const { chunks, dispatch } = harness();
		await dispatch();

		cancelCrossAgentRequestsForSource('src');
		vi.advanceTimersByTime(HARD_MS * 2);

		expect(chunks).toHaveLength(1);
	});

	it('cancels a consult that has not reached the spawn yet', async () => {
		// Stop can land while the target agent's binary is still being resolved.
		// The consult is registered before that await precisely so this lands.
		const { chunks, dispatch } = harness();
		const pending = dispatch();

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		await pending;

		expect(spawnGroupChatAgent).not.toHaveBeenCalled();
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});

	it('kills a process that finished spawning after the Stop that ended it', async () => {
		// The other side of the same race: Stop lands once the timers are armed but
		// while `spawnGroupChatAgent` is still in flight. The terminal path already
		// killed a process id that did not exist yet, so the one that arrives a
		// moment later has to be killed on the way out or it outlives its own Stop.
		const { chunks, dispatch, processManager } = harness();
		let releaseSpawn: () => void = () => {};
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseSpawn = () => resolve({ pid: 123, success: true } as never);
				})
		);

		const pending = dispatch();
		// Let the binary resolve so the real cancel path is live, then stop.
		await vi.waitFor(() => expect(spawnGroupChatAgent).toHaveBeenCalled());
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		processManager.kill.mockClear();

		releaseSpawn();
		await pending;

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		// Still exactly one terminal chunk - the late spawn must not produce a second.
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});
});

// ===== from src/__tests__/main/openspec-manager.test.ts =====

/** Create a Node.js-style ENOENT error with .code property */
function enoent(): NodeJS.ErrnoException {
	const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
	err.code = 'ENOENT';
	return err;
}

describe('openspec-manager', () => {
	const mockBundledPrompt = '# Test Prompt\n\nThis is a test prompt.';
	const mockMetadata: OpenSpecMetadata = {
		lastRefreshed: '2025-01-01T00:00:00Z',
		commitSha: 'abc1234',
		sourceVersion: '0.1.0',
		sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('getOpenSpecMetadata', () => {
		it('should return bundled metadata when no customizations exist', async () => {
			// No user customizations file
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw enoent();
			});

			const metadata = await getOpenSpecMetadata();

			expect(metadata).toEqual(mockMetadata);
		});

		it('should return customized metadata when available', async () => {
			const customMetadata: OpenSpecMetadata = {
				lastRefreshed: '2025-06-15T12:00:00Z',
				commitSha: 'def5678',
				sourceVersion: '0.2.0',
				sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: customMetadata,
						prompts: {},
					});
				}
				throw enoent();
			});

			const metadata = await getOpenSpecMetadata();

			expect(metadata).toEqual(customMetadata);
		});

		it('should return default metadata when no files exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(enoent());

			const metadata = await getOpenSpecMetadata();

			expect(metadata.sourceUrl).toBe('https://github.com/Fission-AI/OpenSpec');
			// Check structure rather than specific version (which changes with releases)
			expect(metadata.sourceVersion).toMatch(/^\d+\.\d+\.\d+$/);
			expect(metadata.commitSha).toBeDefined();
			expect(metadata.lastRefreshed).toBeDefined();
		});
	});

	describe('getOpenSpecPrompts', () => {
		it('should return all bundled commands', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();

			expect(commands.length).toBeGreaterThan(0);
			expect(commands.some((cmd) => cmd.command === '/openspec.help')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.proposal')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.apply')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.archive')).toBe(true);
			expect(commands.some((cmd) => cmd.command === '/openspec.implement')).toBe(true);
		});

		it('should return commands with correct structure', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();

			for (const cmd of commands) {
				expect(cmd).toHaveProperty('id');
				expect(cmd).toHaveProperty('command');
				expect(cmd).toHaveProperty('description');
				expect(cmd).toHaveProperty('prompt');
				expect(cmd).toHaveProperty('isCustom');
				expect(cmd).toHaveProperty('isModified');
				expect(cmd.command.startsWith('/openspec.')).toBe(true);
			}
		});

		it('should mark custom commands correctly', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();

			const helpCmd = commands.find((cmd) => cmd.id === 'help');
			const implementCmd = commands.find((cmd) => cmd.id === 'implement');
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(helpCmd?.isCustom).toBe(true);
			expect(implementCmd?.isCustom).toBe(true);
			expect(proposalCmd?.isCustom).toBe(false);
		});

		it('should use customized prompt when available', async () => {
			const customContent = '# Custom Proposal\n\nThis is my custom prompt.';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify({
						metadata: mockMetadata,
						prompts: {
							proposal: {
								content: customContent,
								isModified: true,
								modifiedAt: '2025-06-15T12:00:00Z',
							},
						},
					});
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(proposalCmd?.prompt).toBe(customContent);
			expect(proposalCmd?.isModified).toBe(true);
		});
	});

	describe('saveOpenSpecPrompt', () => {
		it('should save customization to disk', async () => {
			const customContent = '# My Custom Prompt';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('metadata.json')) {
					return JSON.stringify(mockMetadata);
				}
				throw enoent();
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveOpenSpecPrompt('proposal', customContent);

			expect(fs.writeFile).toHaveBeenCalled();
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writtenContent.prompts.proposal.content).toBe(customContent);
			expect(writtenContent.prompts.proposal.isModified).toBe(true);
			expect(writtenContent.prompts.proposal.modifiedAt).toBeDefined();
		});

		it('should preserve existing customizations', async () => {
			const existingCustomizations = {
				metadata: mockMetadata,
				prompts: {
					apply: {
						content: '# Existing Apply',
						isModified: true,
						modifiedAt: '2025-01-01T00:00:00Z',
					},
				},
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify(existingCustomizations);
				}
				throw enoent();
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await saveOpenSpecPrompt('proposal', '# New Proposal');

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);

			expect(writtenContent.prompts.apply.content).toBe('# Existing Apply');
			expect(writtenContent.prompts.proposal.content).toBe('# New Proposal');
		});
	});

	describe('resetOpenSpecPrompt', () => {
		it('should reset prompt to bundled default', async () => {
			const customizations = {
				metadata: mockMetadata,
				prompts: {
					proposal: {
						content: '# Custom',
						isModified: true,
					},
				},
			};

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					return JSON.stringify(customizations);
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const result = await resetOpenSpecPrompt('proposal');

			expect(result).toBe(mockBundledPrompt);
			expect(fs.writeFile).toHaveBeenCalled();

			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenContent = JSON.parse(writeCall[1] as string);
			expect(writtenContent.prompts.proposal).toBeUndefined();
		});

		it('should throw for unknown command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					throw enoent();
				}
				throw enoent();
			});

			await expect(resetOpenSpecPrompt('nonexistent')).rejects.toThrow('Unknown openspec command');
		});
	});

	describe('getOpenSpecCommand', () => {
		it('should return command by ID', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const command = await getOpenSpecCommand('proposal');

			expect(command).not.toBeNull();
			expect(command?.id).toBe('proposal');
			expect(command?.command).toBe('/openspec.proposal');
		});

		it('should return null for unknown ID', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const command = await getOpenSpecCommand('nonexistent');

			expect(command).toBeNull();
		});
	});

	describe('getOpenSpecCommandBySlash', () => {
		it('should return command by slash command string', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const command = await getOpenSpecCommandBySlash('/openspec.proposal');

			expect(command).not.toBeNull();
			expect(command?.id).toBe('proposal');
			expect(command?.command).toBe('/openspec.proposal');
		});

		it('should return null for unknown slash command', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const command = await getOpenSpecCommandBySlash('/openspec.nonexistent');

			expect(command).toBeNull();
		});
	});

	describe('user prompts directory priority', () => {
		it('should prefer user prompts directory over bundled for upstream commands', async () => {
			const userPromptContent = '# User Updated Proposal';

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				// User prompts directory (downloaded updates)
				if (pathStr.includes('openspec-prompts') && pathStr.includes('openspec.proposal.md')) {
					return userPromptContent;
				}
				if (pathStr.includes('openspec-prompts')) {
					throw enoent();
				}
				// Bundled prompts (fallback)
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();
			const proposalCmd = commands.find((cmd) => cmd.id === 'proposal');

			expect(proposalCmd?.prompt).toBe(userPromptContent);
		});

		it('should always use bundled for custom commands (help, implement)', async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const pathStr = filePath.toString();
				if (pathStr.includes('openspec-customizations.json')) {
					throw enoent();
				}
				if (pathStr.includes('openspec-prompts')) {
					return '# Should not be used for custom commands';
				}
				if (pathStr.endsWith('.md')) {
					return mockBundledPrompt;
				}
				throw enoent();
			});

			const commands = await getOpenSpecPrompts();
			const helpCmd = commands.find((cmd) => cmd.id === 'help');
			const implementCmd = commands.find((cmd) => cmd.id === 'implement');

			// Custom commands should use bundled, not user prompts directory
			expect(helpCmd?.prompt).toBe(mockBundledPrompt);
			expect(implementCmd?.prompt).toBe(mockBundledPrompt);
		});
	});
});
