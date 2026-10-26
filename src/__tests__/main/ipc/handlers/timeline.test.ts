/**
 * Timeline IPC (`timeline:read`).
 *
 * The handler is a thin pass-through to `readAgentTimeline()`, so what these
 * tests defend is the wiring: the synthetic `_event` is stripped, untrusted
 * options are filtered to well-typed fields, an unknown agent reads as empty,
 * git is left out for an SSH agent, and Computer History is read only while
 * its Encore Feature is on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registeredHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
			registeredHandlers.set(channel, handler);
		}),
	},
	app: { getPath: vi.fn(() => '/data') },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let storedSessions: Array<Record<string, unknown>> = [];
let settings: Record<string, unknown> = {};

vi.mock('../../../../main/utils/maestro-system-prompt', () => ({
	findStoredSession: (id: string) => storedSessions.find((s) => s.id === id),
	isSshRecord: (record: Record<string, any>) =>
		!!record.sessionSshRemoteConfig?.enabled || !!record.sshRemoteId,
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => settings[key] }),
}));

const readAgentTimeline = vi.fn();
vi.mock('../../../../main/agent-timeline', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/agent-timeline')>()),
	readAgentTimeline: (...args: unknown[]) => readAgentTimeline(...args),
}));

import { registerTimelineHandlers } from '../../../../main/ipc/handlers/timeline';

function invoke(...args: unknown[]): Promise<any> {
	const handler = registeredHandlers.get('timeline:read');
	if (!handler) throw new Error('timeline:read not registered');
	return handler({}, ...args);
}

const EVENT = { ts: 1, source: 'history', agentId: 'agent-1', text: 'USER: x', ref: 'h-1' };

describe('timeline handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		storedSessions = [{ id: 'agent-1', cwd: '/proj', projectRoot: '/proj', isGitRepo: true }];
		settings = {};
		readAgentTimeline.mockResolvedValue([EVENT]);
		registerTimelineHandlers();
	});

	it('registers timeline:read', () => {
		expect([...registeredHandlers.keys()]).toEqual(['timeline:read']);
	});

	it('reads one agent with only the well-typed options', async () => {
		await expect(
			invoke('agent-1', { sinceMs: 100, tail: 15.7, perSourceTail: 'x', sources: ['git', 'bogus'] })
		).resolves.toEqual([EVENT]);
		expect(readAgentTimeline).toHaveBeenCalledWith(
			{ id: 'agent-1', cwd: '/proj', gitCwd: '/proj' },
			{
				sinceMs: 100,
				untilMs: undefined,
				tail: 15,
				perSourceTail: undefined,
				sources: ['git'],
				computerHistory: false,
			}
		);
	});

	it('uses the default sources and leaves git out for an SSH agent', async () => {
		storedSessions = [{ ...storedSessions[0], sessionSshRemoteConfig: { enabled: true } }];
		await invoke('agent-1', { sinceMs: 100 });
		const [agent, options] = readAgentTimeline.mock.calls[0];
		expect(agent.gitCwd).toBeUndefined();
		expect(options.sources).toEqual(['history', 'journey', 'git']);
	});

	it('reads Computer History only while its Encore Feature is on', async () => {
		await invoke('agent-1', { sinceMs: 100, sources: ['computer'] });
		expect(readAgentTimeline.mock.calls[0][1].computerHistory).toBe(false);
		settings.encoreFeatures = { computerHistory: true };
		await invoke('agent-1', { sinceMs: 100, sources: ['computer'] });
		expect(readAgentTimeline.mock.calls[1][1].computerHistory).toBe(true);
	});

	it('reads an unknown agent as empty', async () => {
		await expect(invoke('nobody', { sinceMs: 100 })).resolves.toEqual([]);
		expect(readAgentTimeline).not.toHaveBeenCalled();
	});

	it('rejects a missing agent id or window start', async () => {
		await expect(invoke('', { sinceMs: 100 })).rejects.toThrow('agentId');
		await expect(invoke('agent-1', {})).rejects.toThrow('sinceMs');
		expect(readAgentTimeline).not.toHaveBeenCalled();
	});
});
