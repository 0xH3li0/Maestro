/**
 * @file groupChatSteering.test.ts
 * @description Tests for src/shared/groupChatSteering.ts - which turns of a
 * running group chat round a steered message goes to, how the per-turn socket
 * answers fold into one result, and the `|steered:` chat log field.
 */

import { describe, expect, it } from 'vitest';

import { STEERING_MAX_TEXT_BYTES, type SteeringResultFrame } from '../../shared/chatSteering';
import {
	formatSteeredLogField,
	GROUP_CHAT_MODERATOR_STEER_TARGET,
	GROUP_CHAT_STEER_BLOCKED_DETAILS,
	groupChatSteerBlockedReason,
	parseSteeredLogField,
	pickGroupChatSteerTargets,
	STEERED_LOG_FIELD_PREFIX,
	summarizeGroupChatSteer,
	type GroupChatSteerAttempt,
	type GroupChatSteerTarget,
} from '../../shared/groupChatSteering';

const alice: GroupChatSteerTarget = {
	name: 'Alice',
	processId: 'group-chat-1-participant-Alice-1',
};
const bob: GroupChatSteerTarget = { name: 'Bob', processId: 'group-chat-1-participant-Bob-1' };

function attempt(
	target: GroupChatSteerTarget,
	verdict: SteeringResultFrame['verdict'],
	extra: Partial<SteeringResultFrame> = {}
): GroupChatSteerAttempt {
	return { target, result: { type: 'steering', id: `id-${target.name}`, verdict, ...extra } };
}

describe('groupChatSteerBlockedReason', () => {
	it('allows a plain message into a busy room', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'look at the tests too' })).toBeNull();
	});

	it('reports a message already on its way first, even in an idle room', () => {
		expect(groupChatSteerBlockedReason({ busy: false, text: 'hi', sending: true })).toBe('sending');
	});

	it('blocks an idle room', () => {
		expect(groupChatSteerBlockedReason({ busy: false, text: 'hi' })).toBe('room-idle');
	});

	it('blocks empty and whitespace-only text', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: undefined })).toBe('nothing-to-type');
		expect(groupChatSteerBlockedReason({ busy: true, text: '  \n ' })).toBe('nothing-to-type');
	});

	it('blocks a message with images, but not an empty image list', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'see', images: ['data:x'] })).toBe(
			'has-images'
		);
		expect(groupChatSteerBlockedReason({ busy: true, text: 'see', images: [] })).toBeNull();
	});

	it('blocks text over the steering limit', () => {
		expect(
			groupChatSteerBlockedReason({ busy: true, text: 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1) })
		).toBe('too-long');
	});

	it('words every blocked reason', () => {
		for (const detail of Object.values(GROUP_CHAT_STEER_BLOCKED_DETAILS)) {
			expect(detail.length).toBeGreaterThan(0);
		}
	});
});

describe('pickGroupChatSteerTargets', () => {
	it('picks the moderator when its turn is running, whatever the message mentions', () => {
		expect(
			pickGroupChatSteerTargets('@Alice stop', {
				moderator: 'group-chat-1-moderator-1',
				participants: [alice],
			})
		).toEqual({
			targets: [{ name: GROUP_CHAT_MODERATOR_STEER_TARGET, processId: 'group-chat-1-moderator-1' }],
		});
	});

	it('blocks when nothing is running', () => {
		expect(pickGroupChatSteerTargets('hello', { participants: [] })).toEqual({
			blocked: 'no-running-turn',
		});
	});

	it('picks every working participant when the message mentions nobody', () => {
		expect(pickGroupChatSteerTargets('also check docs', { participants: [alice, bob] })).toEqual({
			targets: [alice, bob],
		});
	});

	it('narrows to the working participants the message mentions', () => {
		expect(
			pickGroupChatSteerTargets('@Bob use the new API', { participants: [alice, bob] })
		).toEqual({ targets: [bob] });
	});

	it('lists a participant mentioned twice once', () => {
		expect(
			pickGroupChatSteerTargets('@Alice and @Bob, @Alice again', { participants: [alice, bob] })
		).toEqual({ targets: [alice, bob] });
	});

	it('blocks when any mention names an agent that is not working', () => {
		expect(
			pickGroupChatSteerTargets('@Alice and @Carol please', { participants: [alice, bob] })
		).toEqual({ blocked: 'mention-not-working' });
	});
});

describe('summarizeGroupChatSteer', () => {
	it('reports delivered with every target that took it and the ones that refused', () => {
		expect(
			summarizeGroupChatSteer([
				attempt(alice, 'delivered'),
				attempt(bob, 'refused', { refusal: 'blocking-dialog' }),
			])
		).toEqual({
			outcome: 'delivered',
			verdict: 'delivered',
			targets: ['Alice'],
			refusedBy: ['Bob'],
		});
	});

	it('leaves refusedBy out when nobody refused', () => {
		const result = summarizeGroupChatSteer([attempt(alice, 'delivered'), attempt(bob, 'queued')]);
		expect(result).toEqual({
			outcome: 'delivered',
			verdict: 'delivered',
			targets: ['Alice', 'Bob'],
		});
		expect(result).not.toHaveProperty('refusedBy');
	});

	it('reports settled with the first verdict when every taker already settled', () => {
		expect(summarizeGroupChatSteer([attempt(alice, 'queued'), attempt(bob, 'absorbed')])).toEqual({
			outcome: 'settled',
			verdict: 'queued',
			targets: ['Alice', 'Bob'],
		});
	});

	it('counts a taken message as delivered even when another target is unknown', () => {
		const result = summarizeGroupChatSteer([attempt(alice, 'unknown'), attempt(bob, 'delivered')]);
		expect(result.outcome).toBe('delivered');
		expect(result.targets).toEqual(['Bob']);
	});

	it('reports unconfirmed, never refused, when nobody took it and one might have', () => {
		expect(
			summarizeGroupChatSteer([
				attempt(alice, 'refused', { detail: 'busy' }),
				attempt(bob, 'unknown', { detail: 'socket timed out' }),
			])
		).toEqual({ outcome: 'unconfirmed', verdict: 'unknown', detail: 'socket timed out' });
	});

	it('treats a socket-level dropped as unconfirmed', () => {
		expect(summarizeGroupChatSteer([attempt(alice, 'dropped')]).outcome).toBe('unconfirmed');
	});

	it('reports refused with the first refusal when every target refused', () => {
		expect(
			summarizeGroupChatSteer([
				attempt(alice, 'refused', { refusal: 'blocking-dialog', detail: 'a permission prompt' }),
				attempt(bob, 'refused', { refusal: 'not-running', detail: 'turn ended' }),
			])
		).toEqual({
			outcome: 'refused',
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt',
		});
	});
});

describe('steered log field', () => {
	it('round-trips plain names', () => {
		const field = formatSteeredLogField(['Moderator']);
		expect(field).toBe(`${STEERED_LOG_FIELD_PREFIX}Moderator`);
		expect(parseSteeredLogField(field)).toEqual(['Moderator']);
	});

	it('round-trips names holding commas and pipes without leaking either into the field', () => {
		const names = ['Smith, Jane', 'a|b', 'Bob'];
		const field = formatSteeredLogField(names);
		expect(field.slice(STEERED_LOG_FIELD_PREFIX.length)).not.toMatch(/\|/);
		expect(field.slice(STEERED_LOG_FIELD_PREFIX.length).split(',')).toHaveLength(3);
		expect(parseSteeredLogField(field)).toEqual(names);
	});

	it('returns null for any other field', () => {
		expect(parseSteeredLogField('readOnly')).toBeNull();
		expect(parseSteeredLogField('images:a.png')).toBeNull();
	});

	it('returns null for a field with no names', () => {
		expect(parseSteeredLogField(STEERED_LOG_FIELD_PREFIX)).toBeNull();
		expect(parseSteeredLogField(`${STEERED_LOG_FIELD_PREFIX},,`)).toBeNull();
	});

	it('keeps a name that is not valid percent-encoding as written', () => {
		expect(parseSteeredLogField(`${STEERED_LOG_FIELD_PREFIX}100%,Bob`)).toEqual(['100%', 'Bob']);
	});
});
