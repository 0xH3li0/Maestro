/**
 * Routing of Codex turns between `codex exec --json` (the default) and the
 * opt-in `codex app-server` transport.
 *
 * Contracts under test:
 *  - A Codex agent with no transport (or `exec`) runs on the CLI child spawner.
 *  - An interactive Codex prompt turn on an `app-server` agent routes to the
 *    CodexAppServerSpawner, with the coworking env injected like any CLI spawn.
 *  - SSH, image, no-prompt, Auto Run and Cue turns stay on exec even when the
 *    agent opted in.
 *  - The transport field is ignored on a non-Codex agent.
 *
 * The spawners are capture-only stubs, so nothing is launched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessConfig, SpawnResult } from '../../../main/process-manager';

const SPAWN_RESULT: SpawnResult = { pid: 4242, success: true };

const captured = vi.hoisted(() => ({
	child: [] as ProcessConfig[],
	pty: [] as ProcessConfig[],
	appServer: [] as ProcessConfig[],
	appServerOptions: [] as unknown[],
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/test-bridge.sock',
}));

vi.mock('../../../main/process-manager/spawners/ChildProcessSpawner', () => ({
	ChildProcessSpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.child.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/PtySpawner', () => ({
	PtySpawner: class {
		spawn(config: ProcessConfig): SpawnResult {
			captured.pty.push(config);
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/OpencodeServerSpawner', () => ({
	OpencodeServerSpawner: class {
		spawn(): SpawnResult {
			return SPAWN_RESULT;
		}
	},
}));
vi.mock('../../../main/process-manager/spawners/CodexAppServerSpawner', () => ({
	CodexAppServerSpawner: class {
		constructor(...args: unknown[]) {
			captured.appServerOptions.push(args[4]);
		}
		spawn(config: ProcessConfig): SpawnResult {
			captured.appServer.push(config);
			return SPAWN_RESULT;
		}
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

import { ProcessManager } from '../../../main/process-manager';

let nextId = 0;

function codexTurn(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	nextId += 1;
	return {
		sessionId: `codex-agent-ai-tab-${nextId}`,
		toolType: 'codex',
		cwd: '/tmp',
		command: 'codex',
		args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
		prompt: 'fix the bug',
		codexTransport: 'app-server',
		querySource: 'user',
		...overrides,
	};
}

describe('ProcessManager Codex transport routing', () => {
	let pm: ProcessManager;

	beforeEach(() => {
		captured.child.length = 0;
		captured.pty.length = 0;
		captured.appServer.length = 0;
		captured.appServerOptions.length = 0;
		pm = new ProcessManager(undefined, { appVersion: '9.9.9' });
	});

	it('hands the app version to the app-server spawner', () => {
		expect(captured.appServerOptions).toEqual([{ clientVersion: '9.9.9' }]);
	});

	it('runs a Codex turn with no transport on exec (the default)', () => {
		pm.spawn(codexTurn({ codexTransport: undefined }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('runs a Codex turn set to exec on exec', () => {
		pm.spawn(codexTurn({ codexTransport: 'exec' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('routes an interactive prompt turn on an app-server agent to the app-server spawner', () => {
		pm.spawn(codexTurn());

		expect(captured.appServer).toHaveLength(1);
		expect(captured.child).toHaveLength(0);
		expect(captured.pty).toHaveLength(0);
		// A per-turn child, so it gets the coworking env like any CLI spawn.
		expect(captured.appServer[0].customEnvVars?.MAESTRO_COWORKING_SESSION_ID).toBe('codex-agent');
	});

	it('treats a turn with no querySource as interactive', () => {
		pm.spawn(codexTurn({ querySource: undefined }));

		expect(captured.appServer).toHaveLength(1);
	});

	it('emits spawn for an app-server turn', () => {
		const onSpawn = vi.fn();
		pm.on('spawn', onSpawn);
		const config = codexTurn();

		pm.spawn(config);

		expect(onSpawn).toHaveBeenCalledWith(config);
	});

	it('keeps an SSH turn on exec', () => {
		pm.spawn(codexTurn({ sshRemoteId: 'remote-1' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps an image turn on exec', () => {
		pm.spawn(codexTurn({ images: ['data:image/png;base64,AAAA'] }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps a spawn with no prompt on exec', () => {
		pm.spawn(codexTurn({ prompt: undefined }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps an Auto Run (batch) turn on exec', () => {
		pm.spawn(codexTurn({ querySource: 'auto' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('keeps a Cue turn on exec', () => {
		// Cue claims its own origin; ProcessConfig narrows the type, the wire does not.
		pm.spawn(codexTurn({ querySource: 'cue' as unknown as ProcessConfig['querySource'] }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});

	it('ignores the transport on a non-Codex agent', () => {
		pm.spawn(codexTurn({ toolType: 'claude-code', command: 'claude' }));

		expect(captured.child).toHaveLength(1);
		expect(captured.appServer).toHaveLength(0);
	});
});
