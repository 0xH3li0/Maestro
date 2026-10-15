/**
 * Group chat steering: hand a message to a round that is ALREADY RUNNING
 * instead of waiting for the room to go idle.
 *
 * Rides the same mechanism as tab steering (src/shared/chatSteering.ts): each
 * moderator and participant turn is its own maestro-p process with its own
 * steering socket, and `ProcessManager.steer()` types into it. What is
 * group-chat-specific is WHICH turn a message goes to, and that rule lives here
 * so the Steer button, the main process and `maestro-cli group-chat steer` all
 * apply the same one:
 *
 *   1. The moderator's turn, when one is running. It is the router: a steer it
 *      absorbs can still change who it @mentions.
 *   2. Otherwise the participants that are working. A message that @mentions
 *      anyone goes only to the participants it names, and only when EVERY name
 *      is one of them. A mention of an idle or absent agent is a routing request
 *      only the moderator can act on, so that message stays queued for it.
 *
 * Pure and renderer-safe: no Node imports.
 */

import {
	steeringTextTooLong,
	STEERING_TOO_LONG_DETAIL,
	type QueueSteerResult,
	type SteeringResultFrame,
} from './chatSteering';
import { extractAllMentions, mentionMatches } from './group-chat-types';

/** The name a steer into the moderator's turn is recorded under. */
export const GROUP_CHAT_MODERATOR_STEER_TARGET = 'Moderator';

/** Why a group chat message cannot be steered into the running round right now. */
export type GroupChatSteerBlockedReason =
	| 'room-idle'
	| 'nothing-to-type'
	| 'has-images'
	| 'too-long'
	| 'sending'
	| 'steer-in-flight'
	| 'read-only'
	| 'no-running-turn'
	| 'mention-not-working';

/** Each blocked reason as a sentence for the user. A Record so a new reason must be worded. */
export const GROUP_CHAT_STEER_BLOCKED_DETAILS: Record<GroupChatSteerBlockedReason, string> = {
	'room-idle': 'Nothing is running in this room, so there is nothing to steer.',
	'nothing-to-type': 'The message is empty.',
	'has-images':
		'Images cannot be typed into a running turn. The message sends when the round ends.',
	'too-long': `${STEERING_TOO_LONG_DETAIL}. It sends when the round ends.`,
	sending: 'This message is already on its way to the moderator.',
	'steer-in-flight': 'A message is being handed to this room already. Try again in a moment.',
	'read-only':
		'This message asks for read-only mode and the running round is not read-only. It sends when the round ends.',
	'no-running-turn': 'No turn in this room is running right now, so there is nothing to steer.',
	'mention-not-working':
		'The message @mentions an agent that is not working right now. The moderator routes it when the round ends.',
};

/**
 * What can be decided about a message without knowing which processes run:
 * the room's state and the message itself. Main re-checks this and then the
 * facts only it holds (running turns, read-only round).
 */
export function groupChatSteerBlockedReason(input: {
	/** Whether anything in the room is running (any state but `idle`). */
	busy: boolean;
	text: string | undefined;
	images?: readonly string[];
	sending?: boolean;
}): GroupChatSteerBlockedReason | null {
	if (input.sending) return 'sending';
	if (!input.busy) return 'room-idle';
	const text = input.text?.trim();
	if (!text) return 'nothing-to-type';
	if (input.images && input.images.length > 0) return 'has-images';
	if (steeringTextTooLong(text)) return 'too-long';
	return null;
}

/** One turn a steer can be typed into. */
export interface GroupChatSteerTarget {
	/** Participant name, or {@link GROUP_CHAT_MODERATOR_STEER_TARGET}. */
	name: string;
	/** The turn's FULL process id (what `ProcessManager.steer` is keyed by). */
	processId: string;
}

/** The turns running in a room right now. */
export interface GroupChatRunningTurns {
	moderator?: string;
	participants: GroupChatSteerTarget[];
}

/** Which turns `text` goes to, by the rule in this file's header. */
export function pickGroupChatSteerTargets(
	text: string,
	running: GroupChatRunningTurns
):
	| { targets: GroupChatSteerTarget[] }
	| { blocked: Extract<GroupChatSteerBlockedReason, 'no-running-turn' | 'mention-not-working'> } {
	if (running.moderator) {
		return {
			targets: [{ name: GROUP_CHAT_MODERATOR_STEER_TARGET, processId: running.moderator }],
		};
	}
	if (running.participants.length === 0) return { blocked: 'no-running-turn' };

	const mentions = extractAllMentions(text);
	if (mentions.length === 0) return { targets: running.participants };

	const targets: GroupChatSteerTarget[] = [];
	for (const mention of mentions) {
		const matched = running.participants.filter((p) => mentionMatches(mention, p.name));
		if (matched.length === 0) return { blocked: 'mention-not-working' };
		for (const target of matched) {
			if (!targets.includes(target)) targets.push(target);
		}
	}
	return { targets };
}

/** What a group chat steer did. The tab result, plus who took it. */
export interface GroupChatSteerResult extends QueueSteerResult {
	/** The turns that took the message (delivered, absorbed or queued). */
	targets?: string[];
	/** The turns that refused it, when others took it. */
	refusedBy?: string[];
}

/** One target's socket answer. */
export interface GroupChatSteerAttempt {
	target: GroupChatSteerTarget;
	result: SteeringResultFrame;
}

const TAKEN = new Set(['delivered', 'absorbed', 'queued']);

/**
 * Fold the per-target socket answers into one result.
 *
 * Any target that took the message means it was delivered: the user's words
 * reached the round and must not be sent again. Only when nobody took it does
 * the outcome depend on whether a target MIGHT have (`unknown` / a socket-level
 * `dropped`): then it is `unconfirmed`, never `refused`, so the caller holds the
 * message rather than inviting a re-send that could double it.
 */
export function summarizeGroupChatSteer(attempts: GroupChatSteerAttempt[]): GroupChatSteerResult {
	const taken = attempts.filter((a) => TAKEN.has(a.result.verdict));
	const refused = attempts.filter((a) => a.result.verdict === 'refused');

	if (taken.length > 0) {
		const settled = taken.every((a) => a.result.verdict !== 'delivered');
		return {
			outcome: settled ? 'settled' : 'delivered',
			verdict: settled ? taken[0].result.verdict : 'delivered',
			targets: taken.map((a) => a.target.name),
			...(refused.length > 0 && { refusedBy: refused.map((a) => a.target.name) }),
		};
	}

	const uncertain = attempts.find((a) => a.result.verdict !== 'refused');
	if (uncertain) {
		return {
			outcome: 'unconfirmed',
			verdict: uncertain.result.verdict,
			detail: uncertain.result.detail,
		};
	}

	const first = refused[0]?.result;
	return {
		outcome: 'refused',
		verdict: 'refused',
		refusal: first?.refusal,
		detail: first?.detail,
	};
}

/** The `|steered:` field a steered user line carries in the chat log. */
export const STEERED_LOG_FIELD_PREFIX = 'steered:';

/** Serialize the targets for the log. Names are encoded: they may hold commas or pipes. */
export function formatSteeredLogField(targets: readonly string[]): string {
	return `${STEERED_LOG_FIELD_PREFIX}${targets.map(encodeURIComponent).join(',')}`;
}

/** Read a `|steered:` field back. Returns null for any other field. */
export function parseSteeredLogField(field: string): string[] | null {
	if (!field.startsWith(STEERED_LOG_FIELD_PREFIX)) return null;
	const names = field
		.slice(STEERED_LOG_FIELD_PREFIX.length)
		.split(',')
		.filter(Boolean)
		.map((name) => {
			try {
				return decodeURIComponent(name);
			} catch {
				return name;
			}
		});
	return names.length > 0 ? names : null;
}
