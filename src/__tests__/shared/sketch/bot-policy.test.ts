/**
 * The B2 toggle's state machine and helpers (src/shared/sketch/bot-policy.ts,
 * spec sections 5 and 8.3 rule 2): off to on goes through the trust warning,
 * `writers` is sent only while B2 is available, on to off sends at once, and
 * nothing is sent without a live room or while a send is in flight.
 */

import { describe, expect, it } from 'vitest';
import {
	INITIAL_SKETCH_BOT_POLICY_TOGGLE,
	reduceSketchBotPolicyToggle,
	sketchB2TrustWarning,
	sketchBotPolicyDemotedNotice,
	sketchBotPolicyDemotion,
	sketchBotPolicyToggleView,
	sketchScreenDownloadLabel,
	type SketchB2Availability,
	type SketchBotPolicyToggleContext,
	type SketchBotPolicyToggleEvent,
	type SketchBotPolicyToggleState,
} from '../../../shared/sketch/bot-policy';

const OK: SketchB2Availability = { ok: true };
const OFF: SketchB2Availability = {
	ok: false,
	reason: 'The prompt-injection screen is off.',
	offerScreenDownload: true,
};
const BLOCKED: SketchB2Availability = { ok: false, reason: 'Claude Code cannot run restricted.' };

const conductorOk: SketchBotPolicyToggleContext = { policy: 'conductor', availability: OK };
const writersOk: SketchBotPolicyToggleContext = { policy: 'writers', availability: OK };

const idle = INITIAL_SKETCH_BOT_POLICY_TOGGLE;
const confirming: SketchBotPolicyToggleState = { phase: { kind: 'confirming' }, error: null };

/** Run events in order and collect what each step sent. */
function run(
	events: { event: SketchBotPolicyToggleEvent; context: SketchBotPolicyToggleContext }[],
	start: SketchBotPolicyToggleState = idle
) {
	let state = start;
	const sent: string[] = [];
	for (const { event, context } of events) {
		const step = reduceSketchBotPolicyToggle(state, event, context);
		state = step.state;
		if (step.send) sent.push(step.send);
	}
	return { state, sent };
}

describe('reduceSketchBotPolicyToggle', () => {
	it('turns B2 on only after the trust warning is confirmed', () => {
		const opened = reduceSketchBotPolicyToggle(idle, { type: 'toggle' }, conductorOk);
		expect(opened).toEqual({ state: confirming });

		const confirmed = reduceSketchBotPolicyToggle(opened.state, { type: 'confirm' }, conductorOk);
		expect(confirmed.send).toBe('writers');
		expect(confirmed.state.phase).toEqual({ kind: 'sending', want: 'writers' });

		const done = reduceSketchBotPolicyToggle(confirmed.state, { type: 'sent' }, writersOk);
		expect(done).toEqual({ state: { phase: { kind: 'idle' }, error: null } });
	});

	it('sends nothing when the warning is cancelled or toggled away', () => {
		expect(
			run([
				{ event: { type: 'toggle' }, context: conductorOk },
				{ event: { type: 'cancel' }, context: conductorOk },
			])
		).toEqual({ state: { phase: { kind: 'idle' }, error: null }, sent: [] });
		expect(
			run([
				{ event: { type: 'toggle' }, context: conductorOk },
				{ event: { type: 'toggle' }, context: conductorOk },
			])
		).toEqual({ state: { phase: { kind: 'idle' }, error: null }, sent: [] });
	});

	it('turns B2 off at once, with no warning', () => {
		const step = reduceSketchBotPolicyToggle(idle, { type: 'toggle' }, writersOk);
		expect(step.send).toBe('conductor');
		expect(step.state.phase).toEqual({ kind: 'sending', want: 'conductor' });
	});

	it('turns B2 off even while it is unavailable', () => {
		const step = reduceSketchBotPolicyToggle(
			idle,
			{ type: 'toggle' },
			{ policy: 'writers', availability: BLOCKED }
		);
		expect(step.send).toBe('conductor');
	});

	it('does not open the warning while B2 is unavailable or not read yet', () => {
		for (const availability of [OFF, BLOCKED, null]) {
			const step = reduceSketchBotPolicyToggle(
				idle,
				{ type: 'toggle' },
				{ policy: 'conductor', availability }
			);
			expect(step).toEqual({ state: idle });
		}
	});

	it('refuses at Confirm when availability was lost while the warning was up', () => {
		const step = reduceSketchBotPolicyToggle(
			confirming,
			{ type: 'confirm' },
			{ policy: 'conductor', availability: BLOCKED }
		);
		expect(step.send).toBeUndefined();
		expect(step.state).toEqual({ phase: { kind: 'idle' }, error: BLOCKED.reason });
	});

	it('refuses at Confirm when the room went away', () => {
		const step = reduceSketchBotPolicyToggle(
			confirming,
			{ type: 'confirm' },
			{ policy: null, availability: OK }
		);
		expect(step.send).toBeUndefined();
		expect(step.state.phase).toEqual({ kind: 'idle' });
		expect(step.state.error).toMatch(/not connected/);
	});

	it('does nothing without a live room', () => {
		expect(
			reduceSketchBotPolicyToggle(idle, { type: 'toggle' }, { policy: null, availability: OK })
		).toEqual({ state: idle });
	});

	it('ignores the switch while a send is in flight', () => {
		const sending: SketchBotPolicyToggleState = {
			phase: { kind: 'sending', want: 'writers' },
			error: null,
		};
		expect(reduceSketchBotPolicyToggle(sending, { type: 'toggle' }, writersOk)).toEqual({
			state: sending,
		});
		expect(reduceSketchBotPolicyToggle(sending, { type: 'confirm' }, writersOk)).toEqual({
			state: sending,
		});
	});

	it('keeps the error of a failed send until the next attempt', () => {
		const { state } = run([
			{ event: { type: 'toggle' }, context: conductorOk },
			{ event: { type: 'confirm' }, context: conductorOk },
			{ event: { type: 'failed', error: 'The room is not connected yet.' }, context: conductorOk },
		]);
		expect(state).toEqual({ phase: { kind: 'idle' }, error: 'The room is not connected yet.' });

		const retried = reduceSketchBotPolicyToggle(state, { type: 'toggle' }, conductorOk);
		expect(retried.state).toEqual(confirming);
	});

	it('ignores sent and failed outside a send', () => {
		expect(reduceSketchBotPolicyToggle(idle, { type: 'sent' }, conductorOk)).toEqual({
			state: idle,
		});
		expect(reduceSketchBotPolicyToggle(idle, { type: 'failed', error: 'x' }, conductorOk)).toEqual({
			state: idle,
		});
	});

	it('withdraws an open warning when B2 stops being available, with the reason', () => {
		const step = reduceSketchBotPolicyToggle(
			confirming,
			{ type: 'context' },
			{ policy: 'conductor', availability: OFF }
		);
		expect(step.state).toEqual({ phase: { kind: 'idle' }, error: OFF.reason });
	});

	it('withdraws an open warning when the room goes away or is already on writers', () => {
		expect(
			reduceSketchBotPolicyToggle(
				confirming,
				{ type: 'context' },
				{ policy: null, availability: OK }
			).state.phase
		).toEqual({ kind: 'idle' });
		expect(reduceSketchBotPolicyToggle(confirming, { type: 'context' }, writersOk).state).toEqual({
			phase: { kind: 'idle' },
			error: null,
		});
	});

	it('keeps an open warning across a context change that changes nothing', () => {
		expect(reduceSketchBotPolicyToggle(confirming, { type: 'context' }, conductorOk)).toEqual({
			state: confirming,
		});
	});
});

describe('sketchBotPolicyToggleView', () => {
	it('is off and usable on conductor with B2 available', () => {
		expect(sketchBotPolicyToggleView(idle, conductorOk)).toEqual({
			checked: false,
			disabled: false,
			busy: false,
			confirming: false,
			reason: null,
			offerScreenDownload: false,
			error: null,
		});
	});

	it('is on on writers', () => {
		expect(sketchBotPolicyToggleView(idle, writersOk)).toMatchObject({
			checked: true,
			disabled: false,
		});
	});

	it('is greyed out with the reason, and offers the download only while the screen is off', () => {
		expect(
			sketchBotPolicyToggleView(idle, { policy: 'conductor', availability: OFF })
		).toMatchObject({ disabled: true, reason: OFF.reason, offerScreenDownload: true });
		expect(
			sketchBotPolicyToggleView(idle, { policy: 'conductor', availability: BLOCKED })
		).toMatchObject({ disabled: true, reason: BLOCKED.reason, offerScreenDownload: false });
	});

	it('stays usable on writers while unavailable, so it can be turned off', () => {
		expect(
			sketchBotPolicyToggleView(idle, { policy: 'writers', availability: BLOCKED })
		).toMatchObject({ checked: true, disabled: false, reason: null });
	});

	it('is disabled without a live room, or before the first read', () => {
		expect(sketchBotPolicyToggleView(idle, { policy: null, availability: OK })).toMatchObject({
			disabled: true,
			reason: expect.stringMatching(/room is connected/),
		});
		expect(
			sketchBotPolicyToggleView(idle, { policy: 'conductor', availability: null })
		).toMatchObject({ disabled: true, reason: null });
	});

	it('shows the wanted policy and is busy while a send is in flight', () => {
		expect(
			sketchBotPolicyToggleView(
				{ phase: { kind: 'sending', want: 'writers' }, error: null },
				conductorOk
			)
		).toMatchObject({ checked: true, busy: true, disabled: true });
		expect(
			sketchBotPolicyToggleView(
				{ phase: { kind: 'sending', want: 'conductor' }, error: null },
				writersOk
			)
		).toMatchObject({ checked: false, busy: true });
	});

	it('reports the open warning and the last error', () => {
		expect(sketchBotPolicyToggleView(confirming, conductorOk).confirming).toBe(true);
		expect(
			sketchBotPolicyToggleView({ phase: { kind: 'idle' }, error: 'No.' }, conductorOk).error
		).toBe('No.');
	});
});

describe('sketchBotPolicyDemotion', () => {
	it('demotes only a room on writers whose B2 is gone', () => {
		expect(sketchBotPolicyDemotion('writers', BLOCKED)).toBe(BLOCKED.reason);
		expect(sketchBotPolicyDemotion('writers', OK)).toBeNull();
		expect(sketchBotPolicyDemotion('conductor', BLOCKED)).toBeNull();
		expect(sketchBotPolicyDemotion(null, BLOCKED)).toBeNull();
	});

	it('words the Sketch tab notice around the reason', () => {
		expect(sketchBotPolicyDemotedNotice('The screen is off.')).toBe(
			'Collaborators can no longer ask the agent: The screen is off.'
		);
	});
});

describe('copy', () => {
	it('labels the download with the size from the catalog', () => {
		expect(sketchScreenDownloadLabel()).toBe('Download Prompt Guard 2 (77 MB)');
	});

	it('names the sketch in the trust warning and states what a run may do', () => {
		const warning = sketchB2TrustWarning('Roadmap');
		expect(warning.title).toBe('Let collaborators ask the agent?');
		expect(warning.message).toContain('"Roadmap"');
		expect(warning.detail).toMatch(/press Run/);
		expect(warning.detail).toMatch(/restricted/);
		expect(warning.detail).toMatch(/model quota/);
	});
});
