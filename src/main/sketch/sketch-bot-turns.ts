/**
 * The main-process half of Sketch Book bot turns (spec section 5). The turn
 * itself runs in the window (`sketchBotTurns.ts`, a queued prompt on the
 * owner agent's "Sketch: <name>" tab); this module answers the three things
 * only main can:
 *
 * - `prepareBotTurn`: whether the owner can run the turn in its posture, and
 *   the gated change digest it starts with (spec section 4). A restricted
 *   turn on a provider whose read-only mode cannot hold the sketch tools
 *   (risk K1, `sketchAgentRestrictedPostureBlocker()`) is refused before the
 *   digest is read, so a refused turn does not count as the agent's read.
 * - `screenBotReply`: the outbound screen on the final reply (spec section
 *   8.5, purpose `bot-reply`): a pattern finding refuses it, a model flag
 *   holds it for "Publish anyway".
 * - `setBotSessionId`: remember the sketch's own provider session (Q3), so a
 *   closed "Sketch: <name>" tab comes back on the same conversation.
 *
 * Every call reads the sketch through the SketchService first, so the
 * `sketchBook` Encore gate applies here too.
 */

import type {
	SketchBotReplyScreen,
	SketchBotTurnContext,
	SketchRecord,
	SketchTurnPosture,
} from '../../shared/sketch/types';
import { sketchAgentRestrictedPostureBlocker } from './sketch-guardrail';
import { screenOutbound } from './sketch-outbound';
import { findSketchOwnerAgent, getSketchService, type SketchOwnerAgent } from './sketch-service';
import { getSketchStore } from './sketch-store';
import { getSketchToolRuntime, type SketchToolRuntime } from './sketch-tools';

const POSTURES: readonly SketchTurnPosture[] = ['restricted', 'full'];

export interface SketchBotTurnService {
	prepareBotTurn(sketchId: string, posture: SketchTurnPosture): Promise<SketchBotTurnContext>;
	screenBotReply(sketchId: string, text: string): Promise<SketchBotReplyScreen>;
	setBotSessionId(sketchId: string, botSessionId: string | null): Promise<SketchRecord>;
}

export interface SketchBotTurnServiceDeps {
	/** The record, through the gated service. */
	getSketch?: (sketchId: string) => Promise<SketchRecord | null>;
	storeBotSessionId?: (sketchId: string, botSessionId: string | null) => Promise<SketchRecord>;
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	postureBlocker?: (agentId: string) => string | null;
	changeDigest?: SketchToolRuntime['changeDigest'];
	outbound?: typeof screenOutbound;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`Sketch Book: ${field} must be a non-empty string.`);
	}
	return value;
}

export function createSketchBotTurnService(
	deps: SketchBotTurnServiceDeps = {}
): SketchBotTurnService {
	const getSketch = deps.getSketch ?? ((sketchId) => getSketchService().getSketch(sketchId));
	const storeBotSessionId =
		deps.storeBotSessionId ??
		((sketchId, botSessionId) => getSketchStore().setBotSessionId(sketchId, botSessionId));
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const postureBlocker = deps.postureBlocker ?? sketchAgentRestrictedPostureBlocker;
	const changeDigest =
		deps.changeDigest ?? ((request) => getSketchToolRuntime().changeDigest(request));
	const outbound = deps.outbound ?? screenOutbound;

	async function requireSketch(sketchId: unknown): Promise<SketchRecord> {
		const id = requireString(sketchId, 'sketchId');
		const record = await getSketch(id);
		if (!record) throw new Error(`Sketch Book: no sketch has the id "${id}".`);
		return record;
	}

	return {
		async prepareBotTurn(sketchId, posture) {
			if (!POSTURES.includes(posture)) {
				throw new Error('Sketch Book: posture must be "restricted" or "full".');
			}
			const record = await requireSketch(sketchId);
			const agent = findAgent(record.ownerAgentId);
			if (!agent) return { ok: false, reason: 'The owner agent was removed.' };
			if (agent.sshRemote) {
				return {
					ok: false,
					reason: 'The owner agent runs over SSH, which Sketch Book does not support.',
				};
			}
			if (posture === 'restricted') {
				const blocker = postureBlocker(agent.id);
				if (blocker) return { ok: false, reason: blocker, blockedByPosture: true };
			}
			const { digest, sceneVersion } = await changeDigest({
				agentId: agent.id,
				sketchId: record.sketchId,
				posture,
			});
			return {
				ok: true,
				agentId: agent.id,
				agentName: agent.name,
				sketchName: record.name,
				digest,
				sceneVersion,
				botSessionId: record.botSessionId ?? null,
			};
		},

		async screenBotReply(sketchId, text) {
			if (typeof text !== 'string') throw new Error('Sketch Book: text must be a string.');
			const record = await requireSketch(sketchId);
			const result = await outbound({
				sketchId: record.sketchId,
				agentId: record.ownerAgentId,
				purpose: 'bot-reply',
				texts: [text],
			});
			if (!result.ok) return { ok: false, reason: result.reason };
			return {
				ok: true,
				text: result.texts[0] ?? '',
				...(result.held ? { held: true as const, heldReason: result.heldReason } : {}),
				...(result.note ? { note: result.note } : {}),
			};
		},

		async setBotSessionId(sketchId, botSessionId) {
			if (botSessionId !== null) requireString(botSessionId, 'botSessionId');
			const record = await requireSketch(sketchId);
			return storeBotSessionId(record.sketchId, botSessionId);
		},
	};
}

let defaultService: SketchBotTurnService | null = null;

/** The app's bot turn service. */
export function getSketchBotTurnService(): SketchBotTurnService {
	defaultService ??= createSketchBotTurnService();
	return defaultService;
}
