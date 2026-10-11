/**
 * Tests for src/renderer/services/chatSteering.ts - the renderer half of chat
 * steering, and in particular the SECOND answer: the transcript verdict that
 * arrives on maestro-p's stdout after the socket already said `delivered`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueuedItem, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import {
	applySteeringVerdict,
	pendingSteerCount,
	resetPendingSteersForTests,
	settlePendingSteersOnExit,
	steerQueuedItem,
} from '../../../renderer/services/chatSteering';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';

const PROCESS_KEY = 'sess-1-ai-tab-1';

const steer = vi.fn();
const maestroProcess = (window as unknown as { maestro: { process: Record<string, unknown> } })
	.maestro.process;

function item(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'item-a',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'go left instead',
		...overrides,
	};
}

// A Claude interactive turn in flight on tab-1: the only shape that can steer.
function steerableSession(queue: QueuedItem[]): Session {
	return createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		activeTabId: 'tab-1',
		claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		executionQueue: queue,
	} as Partial<Session>);
}

function queue(): QueuedItem[] {
	return useSessionStore.getState().sessions[0].executionQueue;
}

/** Steer `item-a` with the socket answering `delivered` under steer id `steer-1`. */
async function deliver(queued: QueuedItem[] = [item()]): Promise<void> {
	useSessionStore.setState({ sessions: [steerableSession(queued)] });
	steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
	const result = await steerQueuedItem('sess-1', 'item-a');
	expect(result).toEqual({ outcome: 'delivered', verdict: 'delivered' });
}

beforeEach(() => {
	vi.clearAllMocks();
	resetPendingSteersForTests();
	maestroProcess.steer = steer;
});
afterEach(() => {
	delete maestroProcess.steer;
});

describe('steerQueuedItem', () => {
	it('takes the item out of the queue and holds it until the transcript answers', async () => {
		await deliver();

		expect(steer).toHaveBeenCalledWith(PROCESS_KEY, 'go left instead');
		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('does not hold a refused steer: it never left the queue', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockResolvedValue({
			type: 'steering',
			id: 'steer-1',
			verdict: 'refused',
			refusal: 'blocking-dialog',
		});

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'refused', refusal: 'blocking-dialog' });
		expect(queue()).toEqual([item()]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('reports an unknown item as not-found without steering', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });

		const result = await steerQueuedItem('sess-1', 'ghost');

		expect(result.outcome).toBe('not-found');
		expect(steer).not.toHaveBeenCalled();
	});

	it('reports why an item is not steerable instead of steering it', async () => {
		// The CLI surfaces this reason; the button never renders for it. A Codex agent
		// on the default exec transport has no steering channel.
		useSessionStore.setState({
			sessions: [{ ...steerableSession([item()]), toolType: 'codex' } as Session],
		});

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'not-steerable', blockedReason: 'codex-exec' });
		expect(steer).not.toHaveBeenCalled();
		expect(queue()).toEqual([item()]);
	});

	it('pauses the item and reports unconfirmed when the socket answer is unknown', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'unknown' });

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result.outcome).toBe('unconfirmed');
		expect(queue()).toEqual([{ ...item(), paused: true }]);
	});
});

describe('applySteeringVerdict', () => {
	it('settles an absorbed steer without putting anything back', async () => {
		await deliver();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('settles a queued steer and says it runs as a follow-up', async () => {
		await deliver();
		vi.mocked(notifyToast).mockClear();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'queued' });

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Steer runs after this turn' })
		);
	});

	it('puts a dropped steer back at the head of the queue, live', async () => {
		// The turn ended without claude taking it. Live, not paused: the queue then
		// sends it normally, which is the re-send the verdict asks for.
		const behind = item({ id: 'item-b', text: 'queued after' });
		await deliver([item(), behind]);
		expect(queue().map((i) => i.id)).toEqual(['item-b']);

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'dropped' });

		expect(queue().map((i) => i.id)).toEqual(['item-a', 'item-b']);
		expect(queue()[0].paused).toBeUndefined();
		expect(pendingSteerCount()).toBe(0);
	});

	it('ignores a verdict for a steer this client did not send', async () => {
		await deliver();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'other', verdict: 'dropped' });
		applySteeringVerdict('sess-1-ai-tab-2', {
			type: 'steering',
			id: 'steer-1',
			verdict: 'dropped',
		});

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('restores a dropped steer once, even if the verdict repeats', async () => {
		await deliver();
		const dropped = { type: 'steering' as const, id: 'steer-1', verdict: 'dropped' as const };

		applySteeringVerdict(PROCESS_KEY, dropped);
		applySteeringVerdict(PROCESS_KEY, dropped);

		expect(queue().map((i) => i.id)).toEqual(['item-a']);
	});
});

describe('settlePendingSteersOnExit', () => {
	it('restores an unsettled steer PAUSED when its process exits without a verdict', async () => {
		// Nobody knows whether claude answered it, so it is kept but never sent twice
		// without asking.
		await deliver();

		settlePendingSteersOnExit(PROCESS_KEY);

		expect(queue()).toEqual([{ ...item(), paused: true }]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('leaves steers for other processes alone', async () => {
		await deliver();

		settlePendingSteersOnExit('sess-1-ai-tab-2');

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('does nothing for a steer the transcript already settled', async () => {
		await deliver();
		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });

		settlePendingSteersOnExit(PROCESS_KEY);

		expect(queue()).toEqual([]);
	});
});
