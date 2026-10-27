/**
 * Sketch Book bot turn delivery (spec section 5): the runner the bot relay
 * hands every approved `@bot` request and every conductor message.
 *
 * 1. Main checks the posture and builds the gated change digest
 *    (`sketch:prepareBotTurn`). A restricted turn on a provider whose
 *    read-only mode cannot hold the sketch tools (risk K1) ends here.
 * 2. The prompt (digest first, then the request; a guest's inside the
 *    untrusted-data envelope, `buildSketchBotPrompt()`) is QUEUED with
 *    `enqueuePromptForTab()`, never spawned, on the owner agent's dedicated
 *    "Sketch: <name>" tab (`sketchOrigin`). The tab runs on the sketch's own
 *    provider session (Q3): a new tab starts a fresh one, and its id is kept
 *    on the sketch record (`botSessionId`) so a closed tab comes back on the
 *    same conversation. A restricted turn is queued read-only, so the spawn
 *    applies the provider's `readOnlyArgs`; the `maestro-sketch` MCP server
 *    is in every set-up provider's config while Sketch Book is on.
 * 3. The turn is followed in the store (`readQueuedTurn()`) until it ends.
 *    Stop, an error, a removed queue item, a closed tab, or no answer at all
 *    is a failure (`bot.failed`, X5). There is no timeout: the server's
 *    120 min clock never stops a turn (Y3).
 * 4. The answer goes through the outbound screen (`sketch:screenBotReply`).
 *    A refusal goes back to the agent once ({@link SKETCH_BOT_REPLY_RETRIES});
 *    a second refusal is a failure. A model flag holds the reply: the request
 *    shows `held` with a "Publish anyway" chip, and Discard is a failure.
 * 5. A reply over 4,000 characters is cut in chat and the whole answer goes
 *    on the board as a text element (`capSketchBotReply()`).
 */

import {
	SKETCH_BOT_REPLY_RETRIES,
	buildSketchBotPrompt,
	buildSketchBotRetryPrompt,
	capSketchBotReply,
	sketchBotTabName,
} from '../../shared/sketch/bot-turn';
import { logsToQuickChatMessages } from '../../shared/quickChat';
import type {
	SketchBotReplyScreen,
	SketchBotTurnContext,
	SketchTurnPosture,
} from '../../shared/sketch/types';
import { useRetryStore } from '../stores/retryStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSketchSessionStore, type SketchAgentIdentity } from '../stores/sketchSessionStore';
import type { LogEntry, Session } from '../types';
import { createTab } from '../utils/tabHelpers';
import { logger } from '../utils/logger';
import { enqueuePromptForTab, readQueuedTurn } from './queuedPrompt';
import { applySketchAgentWrite } from './sketchAgentWrites';
import type {
	SketchBotTurnRequest,
	SketchBotTurnResult,
	SketchBotTurnRunner,
} from './sketchBotRelay';
import { TURN_CANCELED_NOTE, TURN_FORCE_KILLED_NOTE } from './turnInterrupt';

const LOG_CTX = '[SketchBook][BotTurns]';

/** How one queued turn ended. */
type QueuedTurnOutcome =
	| { ok: true; text: string; agentSessionId: string | null }
	| { ok: false; reason: string };

export interface SketchBotTurnDeps {
	prepare?: (sketchId: string, posture: SketchTurnPosture) => Promise<SketchBotTurnContext>;
	screenReply?: (sketchId: string, text: string) => Promise<SketchBotReplyScreen>;
	saveBotSessionId?: (sketchId: string, botSessionId: string) => Promise<unknown>;
	enqueue?: typeof enqueuePromptForTab;
	/** Put the whole answer on the board. Resolves with the new element ids. */
	writeOverflow?: (sketchId: string, agent: SketchAgentIdentity, text: string) => Promise<string[]>;
	getSession?: (agentId: string) => Session | undefined;
	/** Called on every change that can move a turn along. Returns the unsubscribe. */
	subscribe?: (listener: () => void) => () => void;
}

export interface SketchBotTurns {
	run: SketchBotTurnRunner;
	/** The held reply's "Publish anyway". False when no reply is held for it. */
	publishHeld(sketchId: string, replyTo: string): boolean;
	/** The held reply's "Discard": the request ends as `bot.failed`. */
	discardHeld(sketchId: string, replyTo: string): boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Put the whole answer on the board, below the drawing, as the agent. */
async function writeOverflowText(
	sketchId: string,
	agent: SketchAgentIdentity,
	text: string
): Promise<string[]> {
	const result = await applySketchAgentWrite(sketchId, agent, {
		op: 'add',
		skeletons: [{ type: 'text', x: 0, y: 0, text }],
		regenerateIds: true,
		placeBelowScene: true,
	});
	return result.elements.map((element) => element.id);
}

/** The reply a finished turn wrote, or why it does not count as one. */
export function readSketchTurnAnswer(
	logs: readonly LogEntry[]
): { text: string } | { reason: string } {
	if (
		logs.some(
			(log) =>
				log.source === 'system' &&
				(log.text === TURN_CANCELED_NOTE || log.text === TURN_FORCE_KILLED_NOTE)
		)
	) {
		return { reason: 'The turn was stopped.' };
	}
	const messages = logsToQuickChatMessages(logs, { thinking: 'off', maxMessages: logs.length + 1 });
	const last = messages.at(-1);
	if (last?.role === 'error') return { reason: last.text.trim() };
	const answer = [...messages].reverse().find((message) => message.role === 'assistant');
	const text = answer?.text.trim() ?? '';
	return text ? { text } : { reason: 'The turn ended without an answer.' };
}

export function createSketchBotTurns(deps: SketchBotTurnDeps = {}): SketchBotTurns {
	const prepare =
		deps.prepare ??
		((sketchId: string, posture: SketchTurnPosture) =>
			window.maestro.sketch.prepareBotTurn(sketchId, posture));
	const screenReply =
		deps.screenReply ??
		((sketchId: string, text: string) => window.maestro.sketch.screenBotReply(sketchId, text));
	const saveBotSessionId =
		deps.saveBotSessionId ??
		((sketchId: string, botSessionId: string) =>
			window.maestro.sketch.setBotSessionId(sketchId, botSessionId));
	const enqueue = deps.enqueue ?? enqueuePromptForTab;
	const writeOverflow = deps.writeOverflow ?? writeOverflowText;
	const getSession =
		deps.getSession ??
		((agentId: string) => useSessionStore.getState().sessions.find((s) => s.id === agentId));
	const subscribe =
		deps.subscribe ??
		((listener: () => void) => {
			const offSessions = useSessionStore.subscribe(listener);
			// A retry that gives up changes no session, only the retry store.
			const offRetries = useRetryStore.subscribe(listener);
			return () => {
				offSessions();
				offRetries();
			};
		});

	/** Decisions waiting on a held reply, keyed `sketchId|replyTo`. */
	const holds = new Map<string, (publish: boolean) => void>();
	const keyOf = (sketchId: string, replyTo: string) => `${sketchId}|${replyTo}`;

	/** The sketch's "Sketch: <name>" tab on its owner, created in the background when missing. */
	function ensureTab(
		agentId: string,
		sketchId: string,
		name: string,
		botSessionId: string | null
	): string | null {
		let tabId: string | null = null;
		updateSessionWith(agentId, (session) => {
			const existing = session.aiTabs.find((tab) => tab.sketchOrigin?.sketchId === sketchId);
			if (existing) {
				tabId = existing.id;
				return session;
			}
			const created = createTab(session, {
				name,
				// Resumes the sketch's own conversation (Q3); a first turn starts a fresh one.
				agentSessionId: botSessionId,
				// Bot turns answer a board, not work the conductor wants a synopsis of.
				saveToHistory: false,
				activate: false,
			});
			if (!created) return session;
			tabId = created.tab.id;
			return {
				...created.session,
				aiTabs: created.session.aiTabs.map((tab) =>
					tab.id === created.tab.id ? { ...tab, sketchOrigin: { sketchId } } : tab
				),
			};
		});
		return tabId;
	}

	/** Queue one prompt on the tab and resolve once its turn has ended. */
	function runQueued(
		agentId: string,
		tabId: string,
		text: string,
		readOnly: boolean
	): Promise<QueuedTurnOutcome> {
		const item = enqueue({ sessionId: agentId, tabId, text, readOnlyMode: readOnly });
		if (!item) return Promise.resolve({ ok: false, reason: 'The owner agent is gone.' });
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | null = null;
			const check = () => {
				if (settled) return;
				const state = readQueuedTurn(getSession(agentId), tabId, item.id);
				let outcome: QueuedTurnOutcome | null = null;
				if (state.phase === 'gone') {
					outcome = { ok: false, reason: 'The Sketch tab closed before the turn finished.' };
				} else if (state.phase === 'unseen') {
					outcome = { ok: false, reason: 'The turn was taken out of the queue.' };
				} else if (state.phase === 'done') {
					const answer = readSketchTurnAnswer(state.logs);
					outcome =
						'text' in answer
							? { ok: true, text: answer.text, agentSessionId: state.tab.agentSessionId ?? null }
							: { ok: false, reason: answer.reason };
				}
				if (!outcome) return;
				settled = true;
				unsubscribe?.();
				resolve(outcome);
			};
			unsubscribe = subscribe(check);
			check();
		});
	}

	/** Hold a reply for the conductor. Resolves true on "Publish anyway". */
	function holdReply(sketchId: string, replyTo: string, reason: string): Promise<boolean> {
		const store = useSketchSessionStore.getState();
		store.updateSketchBotRequest(sketchId, replyTo, (request) => ({
			...request,
			status: 'held',
			heldReason: reason,
		}));
		return new Promise((resolve) => {
			holds.set(keyOf(sketchId, replyTo), (publish) => {
				holds.delete(keyOf(sketchId, replyTo));
				useSketchSessionStore
					.getState()
					.updateSketchBotRequest(sketchId, replyTo, ({ heldReason: _reason, ...request }) => ({
						...request,
						status: 'running',
					}));
				resolve(publish);
			});
		});
	}

	function decide(sketchId: string, replyTo: string, publish: boolean): boolean {
		const resolve = holds.get(keyOf(sketchId, replyTo));
		if (!resolve) return false;
		resolve(publish);
		return true;
	}

	async function run(request: SketchBotTurnRequest): Promise<SketchBotTurnResult> {
		const failed = (reason: string): SketchBotTurnResult => ({ status: 'failed', reason });
		const context = await prepare(request.sketchId, request.posture);
		if (!context.ok) {
			// A conductor message runs restricted only because a guest edited the board (Q2).
			return failed(
				context.blockedByPosture && request.from === 'conductor'
					? `${context.reason} A guest has edited this sketch, so your message runs restricted; send it with full access instead.`
					: context.reason
			);
		}
		const tabId = ensureTab(
			context.agentId,
			request.sketchId,
			sketchBotTabName(context.sketchName),
			context.botSessionId
		);
		if (!tabId) return failed('The owner agent is gone.');

		let prompt = buildSketchBotPrompt({
			sketchId: request.sketchId,
			sketchName: context.sketchName,
			digest: context.digest,
			actor: request.actor,
			from: request.from,
			text: request.text,
			posture: request.posture,
			verdict: request.verdict,
		});
		let knownSessionId = context.botSessionId;
		for (let attempt = 0; ; attempt++) {
			const outcome = await runQueued(
				context.agentId,
				tabId,
				prompt,
				request.posture === 'restricted'
			);
			if (!outcome.ok) return failed(outcome.reason);
			if (outcome.agentSessionId && outcome.agentSessionId !== knownSessionId) {
				knownSessionId = outcome.agentSessionId;
				// Best effort: the tab keeps the session either way; only a closed tab needs it.
				void saveBotSessionId(request.sketchId, outcome.agentSessionId).catch((error) => {
					logger.warn('Could not keep the Sketch Book bot session', LOG_CTX, {
						error: errorMessage(error),
					});
				});
			}

			const screened = await screenReply(request.sketchId, outcome.text);
			if (!screened.ok) {
				if (attempt < SKETCH_BOT_REPLY_RETRIES) {
					prompt = buildSketchBotRetryPrompt(screened.reason);
					continue;
				}
				return failed(`The outbound screen refused the reply: ${screened.reason}`);
			}
			if (screened.held) {
				const publish = await holdReply(
					request.sketchId,
					request.replyTo,
					screened.heldReason ?? 'The secret screen flagged the reply.'
				);
				if (!publish) return failed('The conductor discarded the held reply.');
			}

			const agent = { id: context.agentId, name: context.agentName };
			const capped = capSketchBotReply(screened.text);
			let elementIds: string[] = [];
			if (capped.overflow) {
				try {
					elementIds = await writeOverflow(request.sketchId, agent, capped.overflow);
				} catch (error) {
					return failed(`The full answer could not be put on the board: ${errorMessage(error)}`);
				}
			}
			return {
				status: 'reply',
				text: capped.text,
				...(elementIds.length > 0 ? { elementIds } : {}),
				agent,
			};
		}
	}

	return {
		run,
		publishHeld: (sketchId, replyTo) => decide(sketchId, replyTo, true),
		discardHeld: (sketchId, replyTo) => decide(sketchId, replyTo, false),
	};
}

// ---------------------------------------------------------------- the app's turns

let appTurns: SketchBotTurns | null = null;

function turns(): SketchBotTurns {
	appTurns ??= createSketchBotTurns();
	return appTurns;
}

/** The app's turn runner, registered with the bot relay. */
export const runSketchBotTurn: SketchBotTurnRunner = (request) => turns().run(request);

/** The held reply chip's "Publish anyway". */
export function publishHeldSketchReply(sketchId: string, replyTo: string): boolean {
	return turns().publishHeld(sketchId, replyTo);
}

/** The held reply chip's "Discard". */
export function discardHeldSketchReply(sketchId: string, replyTo: string): boolean {
	return turns().discardHeld(sketchId, replyTo);
}
