/**
 * Sketch Book bot turn delivery (src/renderer/services/sketchBotTurns.ts,
 * spec section 5): the "Sketch: <name>" tab on the owner agent, the queued
 * prompt and its posture, following the turn to its end, the outbound screen
 * (one retry, the "Publish anyway" hold), and the 4,000 character cap.
 *
 * The session store is real: the runner creates its tab there and reads the
 * turn back from it. The queue is a fake that records what was queued; each
 * test plays the turn by writing the tab the way a dispatch and its output do.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createSketchBotTurns,
	readSketchTurnAnswer,
	type SketchBotTurnDeps,
	type SketchBotTurns,
} from '../../../renderer/services/sketchBotTurns';
import type { SketchBotTurnRequest } from '../../../renderer/services/sketchBotRelay';
import { TURN_CANCELED_NOTE } from '../../../renderer/services/turnInterrupt';
import { useRetryStore } from '../../../renderer/stores/retryStore';
import { updateSessionWith, useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	useSketchSessionStore,
	type SketchSession,
} from '../../../renderer/stores/sketchSessionStore';
import type { AITab, LogEntry, QueuedItem } from '../../../renderer/types';
import {
	SKETCH_BOT_REPLY_OVERFLOW_NOTE,
	SKETCH_UNTRUSTED_REQUEST_BEGIN,
} from '../../../shared/sketch/bot-turn';
import { CHAT_MAX_CHARS } from '../../../shared/sketch/payloads';
import type {
	SketchActor,
	SketchBotReplyScreen,
	SketchBotTurnContext,
} from '../../../shared/sketch/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The real module pulls in the Excalidraw writer; the overflow writer is injected.
vi.mock('../../../renderer/services/sketchAgentWrites', () => ({ applySketchAgentWrite: vi.fn() }));

const AGENT_ID = 'agent-1';
const SKETCH_ID = 'sketch-1';

const guest: SketchActor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw', capLabel: '#3' };
const conductor: SketchActor = { id: 'c', kind: 'conductor', name: 'Pedram', role: 'conductor' };

const READY: SketchBotTurnContext = {
	ok: true,
	agentId: AGENT_ID,
	agentName: 'Builder',
	sketchName: 'Board',
	digest: 'No changes since your last read.',
	sceneVersion: 3,
	botSessionId: null,
};

function guestRequest(overrides: Partial<SketchBotTurnRequest> = {}): SketchBotTurnRequest {
	return {
		sketchId: SKETCH_ID,
		replyTo: 'm1',
		actor: guest,
		from: 'guest',
		text: 'draw a box',
		posture: 'restricted',
		escalated: false,
		verdict: { status: 'clean', score: 0.04, sourceLabel: 'Prompt Guard 2', locality: 'local' },
		...overrides,
	};
}

function conductorRequest(overrides: Partial<SketchBotTurnRequest> = {}): SketchBotTurnRequest {
	return guestRequest({
		actor: conductor,
		from: 'conductor',
		posture: 'full',
		verdict: null,
		text: 'draw the flow',
		...overrides,
	});
}

let queued: QueuedItem[];
let deps: Required<
	Pick<
		SketchBotTurnDeps,
		'prepare' | 'screenReply' | 'saveBotSessionId' | 'enqueue' | 'writeOverflow'
	>
>;
let turns: SketchBotTurns;
let itemCounter: number;

function sketchTab(): AITab | undefined {
	return useSessionStore
		.getState()
		.sessions.find((s) => s.id === AGENT_ID)
		?.aiTabs.find((tab) => tab.sketchOrigin?.sketchId === SKETCH_ID);
}

/** Play the last queued item: its card, the output, then the tab going idle. */
function playTurn(output: LogEntry[], agentSessionId = 'provider-session-1'): void {
	const item = queued.at(-1)!;
	updateSessionWith(AGENT_ID, (session) => ({
		...session,
		executionQueue: session.executionQueue.filter((i) => i.id !== item.id),
		aiTabs: session.aiTabs.map((tab) =>
			tab.id === item.tabId
				? {
						...tab,
						state: 'idle',
						agentSessionId,
						logs: [
							...tab.logs,
							{
								id: `card-${item.id}`,
								timestamp: 1,
								source: 'user',
								text: item.text ?? '',
								queuedItemId: item.id,
							},
							...output,
						],
					}
				: tab
		),
	}));
}

function answer(text: string): LogEntry[] {
	return [{ id: `out-${itemCounter}`, timestamp: 2, source: 'stdout', text }];
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function readySketch(): SketchSession {
	return {
		sketchId: SKETCH_ID,
		status: 'ready',
		loadError: null,
		scene: null,
		authors: {},
		dirty: false,
		revision: 0,
		saveError: null,
		externalRevision: 0,
		focusRequest: null,
		chat: [],
		botRequests: [
			{
				replyTo: 'm1',
				actor: guest,
				text: 'draw a box',
				ts: 1,
				status: 'running',
				verdict: null,
				posture: 'restricted',
			},
		],
		approvedImages: {},
		room: null,
	};
}

beforeEach(() => {
	queued = [];
	itemCounter = 0;
	useRetryStore.setState({ retries: {} });
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: AGENT_ID,
				aiTabs: [createMockAITab({ id: 'main', name: 'Main' })],
				activeTabId: 'main',
				unifiedTabOrder: [{ type: 'ai', id: 'main' }],
				executionQueue: [],
			}),
		],
		activeSessionId: AGENT_ID,
	});
	useSketchSessionStore.setState({ sessions: { [SKETCH_ID]: readySketch() } });
	// The sketch record: what saveBotSessionId writes, prepare reads back.
	let storedSessionId: string | null = null;
	deps = {
		prepare: vi.fn(async () => ({ ...READY, botSessionId: storedSessionId })),
		screenReply: vi.fn(
			async (_id: string, text: string): Promise<SketchBotReplyScreen> => ({ ok: true, text })
		),
		saveBotSessionId: vi.fn(async (_id: string, sessionId: string) => {
			storedSessionId = sessionId;
		}),
		enqueue: vi.fn((options) => {
			itemCounter += 1;
			const item: QueuedItem = {
				id: `item-${itemCounter}`,
				timestamp: 1,
				tabId: options.tabId,
				type: 'message',
				text: options.text,
				readOnlyMode: options.readOnlyMode === true,
				...(options.sketchRestricted ? { sketchRestricted: true } : {}),
			};
			queued.push(item);
			updateSessionWith(options.sessionId, (session) => ({
				...session,
				executionQueue: [...session.executionQueue, item],
			}));
			return item;
		}),
		writeOverflow: vi.fn(async () => ['overflow-text']),
	};
	turns = createSketchBotTurns(deps);
});

describe('turn delivery', () => {
	it("runs a conductor's full turn in a background Sketch tab and returns the answer", async () => {
		const result = turns.run(conductorRequest());
		await settle();

		const tab = sketchTab();
		expect(tab?.name).toBe('Sketch: Board');
		expect(tab?.agentSessionId).toBeNull();
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('main');
		expect(deps.prepare).toHaveBeenCalledWith(SKETCH_ID, 'full');
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ tabId: tab?.id, readOnlyMode: false });
		expect(queued[0].sketchRestricted).toBeUndefined();
		expect(queued[0].text).toContain('No changes since your last read.');
		expect(queued[0].text).not.toContain(SKETCH_UNTRUSTED_REQUEST_BEGIN);

		playTurn(answer('Drew the flow.'));
		await expect(result).resolves.toEqual({
			status: 'reply',
			text: 'Drew the flow.',
			agent: { id: AGENT_ID, name: 'Builder' },
		});
		// The sketch keeps its own provider session (Q3).
		expect(deps.saveBotSessionId).toHaveBeenCalledWith(SKETCH_ID, 'provider-session-1');
	});

	it("queues a guest's turn read-only with the envelope, on the same tab every time", async () => {
		const first = turns.run(guestRequest());
		await settle();
		const tabId = sketchTab()?.id;
		expect(queued[0].readOnlyMode).toBe(true);
		// Marked, so main runs it with the provider's restricted recipe.
		expect(queued[0].sketchRestricted).toBe(true);
		expect(queued[0].text).toContain(SKETCH_UNTRUSTED_REQUEST_BEGIN);
		expect(queued[0].text).toContain('"Sam" · guest, read-write link #3, not verified');
		playTurn(answer('Done.'));
		await first;

		const second = turns.run(guestRequest({ replyTo: 'm2', text: 'and a circle' }));
		await settle();
		expect(queued[1].tabId).toBe(tabId);
		playTurn(answer('Done again.'));
		await expect(second).resolves.toMatchObject({ status: 'reply', text: 'Done again.' });
		expect(
			useSessionStore.getState().sessions[0].aiTabs.filter((tab) => tab.sketchOrigin)
		).toHaveLength(1);
		// The session did not change, so it is stored once.
		expect(deps.saveBotSessionId).toHaveBeenCalledTimes(1);
	});

	it('reopens a closed Sketch tab on the stored session', async () => {
		deps.prepare = vi.fn(async () => ({ ...READY, botSessionId: 'provider-session-1' }));
		turns = createSketchBotTurns(deps);
		void turns.run(conductorRequest());
		await settle();
		expect(sketchTab()?.agentSessionId).toBe('provider-session-1');
	});
});

describe('refusals before the turn', () => {
	it('tells the conductor to send with full access when the posture cannot run (K1)', async () => {
		deps.prepare = vi.fn(async () => ({
			ok: false as const,
			reason: 'Plan mode refuses the sketch tools.',
			blockedByPosture: true as const,
		}));
		turns = createSketchBotTurns(deps);
		const result = await turns.run(conductorRequest({ posture: 'restricted' }));
		expect(result.status).toBe('failed');
		expect(result.status === 'failed' && result.reason).toMatch(
			/^Plan mode refuses the sketch tools\. A guest has edited .* full access/
		);
		expect(queued).toHaveLength(0);
		expect(sketchTab()).toBeUndefined();

		const guestResult = await turns.run(guestRequest());
		expect(guestResult).toEqual({
			status: 'failed',
			reason: 'Plan mode refuses the sketch tools.',
		});
	});
});

describe('how a turn ends', () => {
	it('fails a stopped turn, an errored turn, and a turn with no answer', async () => {
		const stopped = turns.run(conductorRequest());
		await settle();
		playTurn([
			...answer('half an answer'),
			{ id: 'stop', timestamp: 3, source: 'system', text: TURN_CANCELED_NOTE },
		]);
		await expect(stopped).resolves.toEqual({ status: 'failed', reason: 'The turn was stopped.' });

		const errored = turns.run(conductorRequest());
		await settle();
		playTurn([{ id: 'err', timestamp: 3, source: 'error', text: 'Rate limited.' }]);
		await expect(errored).resolves.toEqual({ status: 'failed', reason: 'Rate limited.' });

		const silent = turns.run(conductorRequest());
		await settle();
		playTurn([]);
		await expect(silent).resolves.toEqual({
			status: 'failed',
			reason: 'The turn ended without an answer.',
		});
	});

	it('fails when the Sketch tab closes or the item leaves the queue unrun', async () => {
		const closed = turns.run(conductorRequest());
		await settle();
		const tabId = sketchTab()!.id;
		updateSessionWith(AGENT_ID, (session) => ({
			...session,
			executionQueue: [],
			aiTabs: session.aiTabs.filter((tab) => tab.id !== tabId),
		}));
		await expect(closed).resolves.toMatchObject({ status: 'failed' });

		const removed = turns.run(conductorRequest());
		await settle();
		updateSessionWith(AGENT_ID, (session) => ({ ...session, executionQueue: [] }));
		await expect(removed).resolves.toEqual({
			status: 'failed',
			reason: 'The turn was taken out of the queue.',
		});
	});

	it('keeps waiting while the item is still queued or the turn still runs', async () => {
		let done = false;
		const result = turns.run(conductorRequest()).then((value) => {
			done = true;
			return value;
		});
		await settle();
		const item = queued[0];
		// Dispatched and busy: the card is in, the turn is not over.
		updateSessionWith(AGENT_ID, (session) => ({
			...session,
			executionQueue: [],
			aiTabs: session.aiTabs.map((tab) =>
				tab.id === item.tabId
					? {
							...tab,
							state: 'busy',
							logs: [
								{ id: 'card', timestamp: 1, source: 'user', text: 'x', queuedItemId: item.id },
							],
						}
					: tab
			),
		}));
		await settle();
		expect(done).toBe(false);
		updateSessionWith(AGENT_ID, (session) => ({
			...session,
			aiTabs: session.aiTabs.map((tab) =>
				tab.id === item.tabId
					? {
							...tab,
							state: 'idle',
							logs: [...tab.logs, { id: 'a', timestamp: 2, source: 'stdout', text: 'Late.' }],
						}
					: tab
			),
		}));
		await expect(result).resolves.toMatchObject({ status: 'reply', text: 'Late.' });
	});
});

describe('the outbound screen', () => {
	it('sends a refused reply back to the agent once, then posts the clean retry', async () => {
		deps.screenReply = vi
			.fn<(id: string, text: string) => Promise<SketchBotReplyScreen>>()
			.mockResolvedValueOnce({ ok: false, reason: 'credential-shaped text in the bot reply.' })
			.mockResolvedValueOnce({ ok: true, text: 'Clean now.' });
		turns = createSketchBotTurns(deps);
		const result = turns.run(conductorRequest());
		await settle();
		playTurn(answer('token ghp_x'));
		await settle();
		expect(queued).toHaveLength(2);
		expect(queued[1].tabId).toBe(queued[0].tabId);
		expect(queued[1].text).toContain('refused it: credential-shaped text in the bot reply.');
		playTurn(answer('Clean now.'));
		await expect(result).resolves.toMatchObject({ status: 'reply', text: 'Clean now.' });
	});

	it('fails after a second refusal', async () => {
		deps.screenReply = vi.fn(async () => ({ ok: false as const, reason: 'still a token.' }));
		turns = createSketchBotTurns(deps);
		const result = turns.run(conductorRequest());
		await settle();
		playTurn(answer('one'));
		await settle();
		playTurn(answer('two'));
		await expect(result).resolves.toEqual({
			status: 'failed',
			reason: 'The outbound screen refused the reply: still a token.',
		});
		expect(queued).toHaveLength(2);
	});

	it('holds a flagged reply for Publish anyway', async () => {
		deps.screenReply = vi.fn(async () => ({
			ok: true as const,
			text: 'Maybe a secret.',
			held: true as const,
			heldReason: 'Flagged by Prompt Guard 2 (0.91).',
		}));
		turns = createSketchBotTurns(deps);
		const result = turns.run(guestRequest());
		await settle();
		playTurn(answer('Maybe a secret.'));
		await settle();

		const request = useSketchSessionStore.getState().sessions[SKETCH_ID].botRequests[0];
		expect(request).toMatchObject({
			status: 'held',
			heldReason: 'Flagged by Prompt Guard 2 (0.91).',
		});
		expect(turns.publishHeld(SKETCH_ID, 'unknown')).toBe(false);
		expect(turns.publishHeld(SKETCH_ID, 'm1')).toBe(true);
		await expect(result).resolves.toMatchObject({ status: 'reply', text: 'Maybe a secret.' });
		const after = useSketchSessionStore.getState().sessions[SKETCH_ID].botRequests[0];
		expect(after.status).toBe('running');
		expect(after.heldReason).toBeUndefined();
	});

	it('fails a held reply the conductor discards', async () => {
		deps.screenReply = vi.fn(async () => ({
			ok: true as const,
			text: 'x',
			held: true as const,
			heldReason: 'Flagged.',
		}));
		turns = createSketchBotTurns(deps);
		const result = turns.run(guestRequest());
		await settle();
		playTurn(answer('x'));
		await settle();
		expect(turns.discardHeld(SKETCH_ID, 'm1')).toBe(true);
		await expect(result).resolves.toEqual({
			status: 'failed',
			reason: 'The conductor discarded the held reply.',
		});
	});
});

describe('the reply cap', () => {
	it('cuts a long reply in chat and puts the whole answer on the board', async () => {
		const long = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ');
		const result = turns.run(conductorRequest());
		await settle();
		playTurn(answer(long));
		const reply = await result;
		expect(reply.status).toBe('reply');
		if (reply.status !== 'reply') return;
		expect(Array.from(reply.text).length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
		expect(reply.text.endsWith(SKETCH_BOT_REPLY_OVERFLOW_NOTE)).toBe(true);
		expect(reply.elementIds).toEqual(['overflow-text']);
		expect(deps.writeOverflow).toHaveBeenCalledWith(
			SKETCH_ID,
			{ id: AGENT_ID, name: 'Builder' },
			long
		);
	});

	it('fails when the board cannot take the full answer', async () => {
		deps.writeOverflow = vi.fn(async () => {
			throw new Error('sketch closed');
		});
		turns = createSketchBotTurns(deps);
		const result = turns.run(conductorRequest());
		await settle();
		playTurn(answer('x '.repeat(CHAT_MAX_CHARS)));
		await expect(result).resolves.toEqual({
			status: 'failed',
			reason: 'The full answer could not be put on the board: sketch closed',
		});
	});
});

describe('readSketchTurnAnswer', () => {
	it('joins the streamed output into one answer and ignores tool and thinking rows', () => {
		expect(
			readSketchTurnAnswer([
				{ id: '1', timestamp: 1, source: 'thinking', text: 'hmm' },
				{ id: '2', timestamp: 1, source: 'stdout', text: 'Drew ' },
				{ id: '3', timestamp: 1, source: 'tool', text: 'sketch_add_elements' },
				{ id: '4', timestamp: 1, source: 'stdout', text: 'the box.' },
			])
		).toEqual({ text: 'Drew the box.' });
	});
});
