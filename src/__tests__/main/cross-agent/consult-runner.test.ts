import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopConsultRunner } from '../../../main/cross-agent/consult-runner';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import type { ProcessManager } from '../../../main/process-manager';
import type { ConsultObserver } from '../../../shared/maestro-lib/agents/consult';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

vi.mock('../../../main/group-chat/spawnGroupChatAgent', () => ({ spawnGroupChatAgent: vi.fn() }));
vi.mock('../../../main/group-chat/spawn-config', () => ({
	toSpawnGroupChatAgentConfig: () => ({}),
}));

const spawn = { processId: 'cross-agent-auth', providerId: 'codex' } as GroupChatSpawn;

describe('desktop consult listener lifecycle', () => {
	beforeEach(() =>
		vi.mocked(spawnGroupChatAgent).mockReset().mockResolvedValue({ success: true, pid: 123 })
	);

	it('forwards only the first matching error and detaches on exit', async () => {
		const emitter = new EventEmitter();
		const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		await runner.start(spawn, observer);
		emitter.emit('agent-error', 'other', { message: 'unrelated' });
		emitter.emit('agent-error', spawn.processId, { message: 'Authentication blocked' });
		emitter.emit('agent-error', spawn.processId, { message: 'secondary error' });
		emitter.emit('exit', 'other', 0);
		expect(observer.onEnd).not.toHaveBeenCalled();
		emitter.emit('exit', spawn.processId, 0);
		expect(observer.onEnd).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ exitCode: 0, error: 'Authentication blocked' })
		);
		expect(emitter.eventNames()).toEqual([]);
	});

	it('detaches on stop', async () => {
		const emitter = Object.assign(new EventEmitter(), { kill: vi.fn() });
		const runner = createDesktopConsultRunner(emitter as unknown as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		await runner.start(spawn, observer);
		runner.stop(spawn.processId);
		expect(emitter.kill).toHaveBeenCalledWith(spawn.processId);
		expect(emitter.eventNames()).toEqual([]);
		emitter.emit('exit', spawn.processId, 0);
		expect(observer.onEnd).not.toHaveBeenCalled();
	});

	it.each(['refused', 'thrown'])('detaches when spawn is %s', async (failure) => {
		const emitter = new EventEmitter();
		const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		if (failure === 'refused')
			vi.mocked(spawnGroupChatAgent).mockResolvedValueOnce({ success: false, pid: -1 });
		else vi.mocked(spawnGroupChatAgent).mockRejectedValueOnce(new Error('spawn failed'));
		if (failure === 'refused')
			expect(await runner.start(spawn, observer)).toMatchObject({ success: false });
		else await expect(runner.start(spawn, observer)).rejects.toThrow('spawn failed');
		expect(emitter.eventNames()).toEqual([]);
	});
});
