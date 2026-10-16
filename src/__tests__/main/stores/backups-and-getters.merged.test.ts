// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/stores/groups-backup.test.ts
//   - src/__tests__/main/stores/sessions-backup.test.ts
//   - src/__tests__/main/stores/getters.test.ts

import {
	getAgentConfigsStore,
	getAgentSessionOriginsStore,
	getBootstrapStore,
	getClaudeSessionOriginsStore,
	getGroupsStore,
	getProductionDataPath,
	getSessionsStore,
	getSettingsStore,
	getSshRemoteById,
	getSyncPath,
	getWindowStateStore,
} from '../../../main/stores/getters';
import { GROUPS_BACKUP_FILENAME, backupGroupsBeforeWipe } from '../../../main/stores/groups-backup';
import type { GroupsBackupStore } from '../../../main/stores/groups-backup';
import { getCachedPaths, getStoreInstances, isInitialized } from '../../../main/stores/instances';
import {
	SESSIONS_BACKUP_FILENAME,
	backupSessionsBeforeWipe,
} from '../../../main/stores/sessions-backup';
import type { StoredSession } from '../../../main/stores/types';
import { atomicWriteJson } from '../../../main/utils/atomic-json-store';
import type { Group } from '../../../shared/types';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/atomic-json-store', () => ({
	atomicWriteJson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../main/stores/instances', () => ({
	isInitialized: vi.fn(),
	getStoreInstances: vi.fn(),
	getCachedPaths: vi.fn(),
}));

// ===== from src/__tests__/main/stores/groups-backup.test.ts =====

const mockWrite = atomicWriteJson as unknown as ReturnType<typeof vi.fn>;

function makeGroup(id: string): Group {
	return { id, name: `Group ${id}`, emoji: '', collapsed: false } as Group;
}

function makeStore(stored: Group[] | (() => never)): GroupsBackupStore {
	return {
		get: typeof stored === 'function' ? (stored as () => never) : () => stored,
		path: '/tmp/maestro-test/maestro-groups.json',
	};
}

describe('backupGroupsBeforeWipe', () => {
	beforeEach(() => {
		mockWrite.mockClear();
		mockWrite.mockResolvedValue(undefined);
	});

	it('backs up the stored registry when an empty one replaces it', async () => {
		const stored = [makeGroup('g1'), makeGroup('g2')];

		await backupGroupsBeforeWipe(makeStore(stored), []);

		expect(mockWrite).toHaveBeenCalledTimes(1);
		const [writtenPath, payload] = mockWrite.mock.calls[0];
		expect(writtenPath).toContain(GROUPS_BACKUP_FILENAME);
		expect((payload as { entries: Group[] }).entries).toEqual(stored);
		expect((payload as { reason: string }).reason).toBe('registry-emptied');
	});

	it('does not back up when the incoming registry still has groups', async () => {
		await backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), [makeGroup('g1')]);

		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('does not back up when there was nothing stored to lose', async () => {
		await backupGroupsBeforeWipe(makeStore([]), []);

		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('treats a null incoming registry as a wipe', async () => {
		await backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), null);

		expect(mockWrite).toHaveBeenCalledTimes(1);
	});

	it('does not throw when the store cannot be read', async () => {
		const store = makeStore((() => {
			throw new Error('corrupt registry');
		}) as () => never);

		await expect(backupGroupsBeforeWipe(store, [])).resolves.toBeUndefined();
		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('does not throw when the backup write fails', async () => {
		mockWrite.mockRejectedValueOnce(new Error('disk full'));

		// A snapshot that cannot be written must not stop the user's actual
		// change from being saved.
		await expect(backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), [])).resolves.toBeUndefined();
	});
});

// ===== from src/__tests__/main/stores/sessions-backup.test.ts =====

const mockWrite_1 = atomicWriteJson as unknown as ReturnType<typeof vi.fn>;

const STORE_PATH = '/tmp/maestro-test/maestro-sessions.json';

function makeSession(id: string): StoredSession {
	return { id, name: `Agent ${id}`, toolType: 'claude-code', cwd: '/tmp' } as StoredSession;
}

describe('backupSessionsBeforeWipe', () => {
	beforeEach(() => {
		mockWrite_1.mockClear();
		mockWrite_1.mockResolvedValue(undefined);
	});

	it('backs up the stored tree when an empty one replaces it', async () => {
		const stored = [makeSession('a'), makeSession('b')];

		await backupSessionsBeforeWipe(stored, [], STORE_PATH);

		expect(mockWrite_1).toHaveBeenCalledTimes(1);
		const [writtenPath, payload] = mockWrite_1.mock.calls[0];
		expect(writtenPath).toBe(path.join(path.dirname(STORE_PATH), SESSIONS_BACKUP_FILENAME));
		expect((payload as { entries: StoredSession[] }).entries).toEqual(stored);
	});

	it('does not back up when the incoming tree still has agents', async () => {
		await backupSessionsBeforeWipe([makeSession('a')], [makeSession('a')], STORE_PATH);
		expect(mockWrite_1).not.toHaveBeenCalled();
	});

	it('does not back up when there was nothing stored to lose', async () => {
		await backupSessionsBeforeWipe([], [], STORE_PATH);
		expect(mockWrite_1).not.toHaveBeenCalled();
	});

	it('does not throw when the backup write fails', async () => {
		mockWrite_1.mockRejectedValueOnce(new Error('disk full'));
		await expect(
			backupSessionsBeforeWipe([makeSession('a')], [], STORE_PATH)
		).resolves.toBeUndefined();
	});
});

// ===== from src/__tests__/main/stores/getters.test.ts =====

const mockedIsInitialized = vi.mocked(isInitialized);

const mockedGetStoreInstances = vi.mocked(getStoreInstances);

const mockedGetCachedPaths = vi.mocked(getCachedPaths);

describe('stores/getters', () => {
	const mockStores = {
		bootstrapStore: { get: vi.fn(), set: vi.fn() },
		settingsStore: { get: vi.fn(), set: vi.fn() },
		sessionsStore: { get: vi.fn(), set: vi.fn() },
		groupsStore: { get: vi.fn(), set: vi.fn() },
		agentConfigsStore: { get: vi.fn(), set: vi.fn() },
		windowStateStore: { get: vi.fn(), set: vi.fn() },
		claudeSessionOriginsStore: { get: vi.fn(), set: vi.fn() },
		agentSessionOriginsStore: { get: vi.fn(), set: vi.fn() },
	};

	const mockPaths = {
		syncPath: '/test/sync/path',
		productionDataPath: '/test/production/path',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockedIsInitialized.mockReturnValue(true);
		mockedGetStoreInstances.mockReturnValue(mockStores as any);
		mockedGetCachedPaths.mockReturnValue(mockPaths);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('error handling when not initialized', () => {
		beforeEach(() => {
			mockedIsInitialized.mockReturnValue(false);
			mockedGetStoreInstances.mockReturnValue({
				bootstrapStore: null,
				settingsStore: null,
				sessionsStore: null,
				groupsStore: null,
				agentConfigsStore: null,
				windowStateStore: null,
				claudeSessionOriginsStore: null,
				agentSessionOriginsStore: null,
			} as any);
			mockedGetCachedPaths.mockReturnValue({
				syncPath: null,
				productionDataPath: null,
			});
		});

		it('getBootstrapStore should throw when not initialized', () => {
			expect(() => getBootstrapStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSettingsStore should throw when not initialized', () => {
			expect(() => getSettingsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSessionsStore should throw when not initialized', () => {
			expect(() => getSessionsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getGroupsStore should throw when not initialized', () => {
			expect(() => getGroupsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getAgentConfigsStore should throw when not initialized', () => {
			expect(() => getAgentConfigsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getWindowStateStore should throw when not initialized', () => {
			expect(() => getWindowStateStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getClaudeSessionOriginsStore should throw when not initialized', () => {
			expect(() => getClaudeSessionOriginsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getAgentSessionOriginsStore should throw when not initialized', () => {
			expect(() => getAgentSessionOriginsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSyncPath should throw when not initialized', () => {
			expect(() => getSyncPath()).toThrow('Stores not initialized. Call initializeStores() first.');
		});

		it('getProductionDataPath should throw when not initialized', () => {
			expect(() => getProductionDataPath()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});
	});

	describe('successful getters when initialized', () => {
		it('getBootstrapStore should return bootstrap store', () => {
			const result = getBootstrapStore();
			expect(result).toBe(mockStores.bootstrapStore);
		});

		it('getSettingsStore should return settings store', () => {
			const result = getSettingsStore();
			expect(result).toBe(mockStores.settingsStore);
		});

		it('getSessionsStore should return sessions store', () => {
			const result = getSessionsStore();
			expect(result).toBe(mockStores.sessionsStore);
		});

		it('getGroupsStore should return groups store', () => {
			const result = getGroupsStore();
			expect(result).toBe(mockStores.groupsStore);
		});

		it('getAgentConfigsStore should return agent configs store', () => {
			const result = getAgentConfigsStore();
			expect(result).toBe(mockStores.agentConfigsStore);
		});

		it('getWindowStateStore should return window state store', () => {
			const result = getWindowStateStore();
			expect(result).toBe(mockStores.windowStateStore);
		});

		it('getClaudeSessionOriginsStore should return claude session origins store', () => {
			const result = getClaudeSessionOriginsStore();
			expect(result).toBe(mockStores.claudeSessionOriginsStore);
		});

		it('getAgentSessionOriginsStore should return agent session origins store', () => {
			const result = getAgentSessionOriginsStore();
			expect(result).toBe(mockStores.agentSessionOriginsStore);
		});

		it('getSyncPath should return sync path', () => {
			const result = getSyncPath();
			expect(result).toBe('/test/sync/path');
		});

		it('getProductionDataPath should return production data path', () => {
			const result = getProductionDataPath();
			expect(result).toBe('/test/production/path');
		});
	});

	describe('getSshRemoteById', () => {
		it('should find SSH remote by ID', () => {
			const mockSshRemotes = [
				{ id: 'remote-1', name: 'Server 1', host: 'server1.com', username: 'user1' },
				{ id: 'remote-2', name: 'Server 2', host: 'server2.com', username: 'user2' },
			];

			mockStores.settingsStore.get.mockReturnValue(mockSshRemotes);

			const result = getSshRemoteById('remote-2');

			expect(result).toEqual(mockSshRemotes[1]);
			expect(mockStores.settingsStore.get).toHaveBeenCalledWith('sshRemotes', []);
		});

		it('should return undefined for non-existent ID', () => {
			mockStores.settingsStore.get.mockReturnValue([
				{ id: 'remote-1', name: 'Server 1', host: 'server1.com', username: 'user1' },
			]);

			const result = getSshRemoteById('non-existent');

			expect(result).toBeUndefined();
		});

		it('should return undefined when no remotes configured', () => {
			mockStores.settingsStore.get.mockReturnValue([]);

			const result = getSshRemoteById('remote-1');

			expect(result).toBeUndefined();
		});

		// electron-store only substitutes the `[]` default when the key is absent,
		// so a hand-edited or sync-mangled settings.json can hand back a non-array.
		// That used to throw `sshRemotes.find is not a function` and take down
		// unrelated callers - git:status/git:numstat polls on agents with no SSH
		// remote at all (MAESTRO-YB/YC).
		it.each([
			['an object', {}],
			['a string', 'remote-1'],
			['null', null],
		])('should return undefined when sshRemotes is %s', (_label, stored) => {
			mockStores.settingsStore.get.mockReturnValue(stored);

			expect(() => getSshRemoteById('remote-1')).not.toThrow();
			expect(getSshRemoteById('remote-1')).toBeUndefined();
		});

		// Same corruption, one level down: the value is an array but its entries
		// are not objects, so reading `.id` off one throws the same way.
		it.each([
			['null entries', [null, { id: 'remote-1', name: 'Server 1' }]],
			['string entries', ['remote-1', 'remote-2']],
			['undefined entries', [undefined]],
		])('should survive %s in sshRemotes', (_label, stored) => {
			mockStores.settingsStore.get.mockReturnValue(stored);

			expect(() => getSshRemoteById('remote-1')).not.toThrow();
		});

		it('should still find a valid remote alongside malformed entries', () => {
			const valid = { id: 'remote-1', name: 'Server 1', host: 'server1.com', username: 'user1' };
			mockStores.settingsStore.get.mockReturnValue([null, 'junk', valid]);

			expect(getSshRemoteById('remote-1')).toEqual(valid);
		});
	});
});
