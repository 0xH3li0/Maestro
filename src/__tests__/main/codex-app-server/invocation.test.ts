import { describe, it, expect } from 'vitest';
import {
	parseCodexAppServerInvocation,
	codexAppServerConfigBlocker,
	codexThreadPolicyMismatch,
} from '../../../main/codex-app-server/invocation';
import type { ProcessConfig } from '../../../main/process-manager/types';

function config(args: string[], overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 's',
		toolType: 'codex',
		cwd: '/spawn/cwd',
		command: 'codex',
		args,
		prompt: 'hi',
		...overrides,
	};
}

const EXEC = ['exec', '--json', '--skip-git-repo-check'];

describe('parseCodexAppServerInvocation', () => {
	it('maps the default bypass invocation to danger-full-access', () => {
		const result = parseCodexAppServerInvocation(
			config(['-C', '/proj', ...EXEC, '--dangerously-bypass-approvals-and-sandbox'])
		);
		expect(result).toEqual({
			ok: true,
			invocation: { cwd: '/proj', sandbox: 'danger-full-access', configArgs: [] },
		});
	});

	it('maps read-only, model, overrides and resume', () => {
		const result = parseCodexAppServerInvocation(
			config([
				...EXEC,
				'--sandbox',
				'read-only',
				'-m',
				'gpt-5.3-codex',
				'-c',
				'model_reasoning_effort="xhigh"',
				'-c',
				"model_reasoning_summary='detailed'",
				'--config=foo.bar=1',
				'resume',
				'thread-123',
			])
		);
		expect(result).toEqual({
			ok: true,
			invocation: {
				cwd: '/spawn/cwd',
				sandbox: 'read-only',
				model: 'gpt-5.3-codex',
				effort: 'xhigh',
				summary: 'detailed',
				resumeId: 'thread-123',
				configArgs: [
					'-c',
					'model_reasoning_effort="xhigh"',
					'-c',
					"model_reasoning_summary='detailed'",
					'-c',
					'foo.bar=1',
				],
			},
		});
	});

	it('lets the bypass flag win over --sandbox, as exec does', () => {
		const result = parseCodexAppServerInvocation(
			config([...EXEC, '--sandbox', 'read-only', '--dangerously-bypass-approvals-and-sandbox'])
		);
		expect(result.ok && result.invocation.sandbox).toBe('danger-full-access');
	});

	it('leaves the sandbox to config.toml when the args name none', () => {
		const result = parseCodexAppServerInvocation(config(EXEC));
		expect(result.ok && result.invocation.sandbox).toBeUndefined();
	});

	it('never resumes from agentSessionId alone', () => {
		const result = parseCodexAppServerInvocation(config(EXEC, { agentSessionId: 'old-thread' }));
		expect(result.ok && result.invocation.resumeId).toBeUndefined();
	});

	it.each([
		[['--add-dir', '/other'], 'unsupported argument: --add-dir'],
		[['-i', '/tmp/a.png'], 'unsupported argument: -i'],
		[['--', 'prompt'], 'unsupported argument: --'],
		[['--sandbox', 'bogus'], 'unknown sandbox mode: bogus'],
		[['resume'], 'resume without a thread id'],
		[['-c', 'novalue'], 'malformed config override: novalue'],
	])('refuses %j', (extra, reason) => {
		expect(parseCodexAppServerInvocation(config([...EXEC, ...extra]))).toEqual({
			ok: false,
			reason,
		});
	});

	it('refuses an invocation that is not codex exec', () => {
		expect(parseCodexAppServerInvocation(config(['--json']))).toEqual({
			ok: false,
			reason: 'not an exec invocation',
		});
	});
});

describe('codexAppServerConfigBlocker', () => {
	it.each([
		[{ prompt: undefined }, 'no prompt'],
		[{ images: ['data:x'] }, 'image prompt'],
		[{ sshRemoteId: 'remote-1' }, 'SSH remote'],
		[{ promptAlreadyInArgs: true }, 'prompt embedded in args'],
	] as Array<[Partial<ProcessConfig>, string]>)('blocks %j', (overrides, reason) => {
		expect(codexAppServerConfigBlocker(config(EXEC, overrides))).toBe(reason);
	});

	it('allows a plain local text turn', () => {
		expect(codexAppServerConfigBlocker(config(EXEC))).toBeNull();
	});
});

describe('codexThreadPolicyMismatch', () => {
	const echo = (sandbox: unknown, approvalPolicy: unknown = 'never') => ({
		thread: { id: 't' },
		sandbox,
		approvalPolicy,
	});

	it('accepts the sandbox the server echoes for each restricted mode', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'readOnly' }))
		).toBeNull();
		expect(
			codexThreadPolicyMismatch(
				{ sandbox: 'workspace-write' },
				echo({ type: 'workspaceWrite', writableRoots: [] })
			)
		).toBeNull();
	});

	it('flags a resumed thread that kept a wider persisted sandbox', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'dangerFullAccess' }))
		).toMatch(/read-only.*dangerFullAccess/);
		expect(
			codexThreadPolicyMismatch({ sandbox: 'workspace-write' }, echo({ type: 'readOnly' }))
		).toMatch(/workspace-write/);
	});

	it('flags a response that does not say which sandbox the thread runs in', () => {
		expect(codexThreadPolicyMismatch({ sandbox: 'read-only' }, { thread: { id: 't' } })).toMatch(
			/unreported/
		);
		expect(codexThreadPolicyMismatch({ sandbox: 'read-only' }, null)).toMatch(/unreported/);
	});

	it('does not check full access or a sandbox left to config.toml', () => {
		expect(codexThreadPolicyMismatch({ sandbox: 'danger-full-access' }, {})).toBeNull();
		expect(codexThreadPolicyMismatch({}, {})).toBeNull();
	});

	it('does not check the approval policy, which cannot widen a restricted turn', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'readOnly' }, 'on-request'))
		).toBeNull();
	});
});
