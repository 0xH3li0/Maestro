/**
 * Covers the Local Models gateway on the `create_session` path in
 * useAppRemoteEventListeners - where `maestro-cli create-agent --gateway-url`
 * lands. The CLI checks the URL first; the renderer checks it again against the
 * provider, because a direct WebSocket caller skips the CLI. A refused gateway
 * refuses the create: dropping it would make an agent the caller did not ask for.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn().mockResolvedValue(false) },
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));

const respond = vi.fn();
const setMany = vi.fn().mockResolvedValue(undefined);

function setup() {
	const setSessions = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [] },
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setSessions };
}

/** The agent the handler added, from the updater it handed setSessions. */
function createdSession(setSessions: ReturnType<typeof vi.fn>): Session {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater([])[0];
}

function dispatchCreate(toolType: string, config?: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteCreateSession', {
			detail: {
				name: 'CLI Agent',
				toolType,
				cwd: '/tmp/project',
				groupId: undefined,
				config,
				responseChannel: 'ch',
				background: true,
			},
		})
	);
}

/** Let the handler's awaited lookups, persist and response settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		agents: { get: vi.fn(async (id: string) => ({ id })) },
		process: { sendRemoteCreateSessionResponse: respond },
		sessions: { setMany },
		stats: { recordSessionCreated: vi.fn() },
	};
});

describe('maestro:remoteCreateSession gateway', () => {
	it('stores the normalized gateway on the new agent, with no proxy mode', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { gatewayUrl: 'http://127.0.0.1:8787/' });
		await flush();

		const session = createdSession(setSessions);
		expect(session.gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(session.tokenProxyMode).toBeUndefined();
		expect(respond).toHaveBeenCalledWith('ch', { sessionId: session.id });
	});

	it('creates the agent with no gateway when none was sent', async () => {
		const { setSessions } = setup();

		dispatchCreate('codex');
		await flush();

		expect(createdSession(setSessions).gatewayUrl).toBeUndefined();
	});

	it('refuses the create when the provider cannot use a gateway', async () => {
		const { setSessions } = setup();

		dispatchCreate('copilot-cli', { gatewayUrl: 'http://127.0.0.1:8787' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(setMany).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith('ch', null);
	});

	it('refuses the create when the gateway is not a string', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { gatewayUrl: 8787 });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith('ch', null);
	});
});
