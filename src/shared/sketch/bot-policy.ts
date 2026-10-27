/**
 * Who may ask a shared sketch's bot (spec sections 5 and 8.3, rule 2): the
 * conductor alone (B1, `botPolicy: 'conductor'`) or read-write guests too
 * (B2, `'writers'`).
 *
 * - B2 is offered only while `isB2Available()` says so (the screen is usable,
 *   a cloud engine has consent, and the owner's provider can run restricted
 *   turns). Otherwise the toggle is greyed out with the reason, and while the
 *   screen is merely `off` it offers one click that downloads and assigns
 *   Prompt Guard 2 ({@link sketchScreenDownloadLabel}).
 * - Turning B2 on asks first with {@link sketchB2TrustWarning}: in the Sketch
 *   tab as an in-place confirmation, on the CLI as the terminal prompt or, for
 *   an agent caller, the desktop confirmation (A1).
 * - A room on `writers` whose screen becomes unusable is put back on
 *   `conductor` at once, and the Sketch tab says why
 *   ({@link sketchBotPolicyDemotion}, {@link sketchBotPolicyDemotedNotice}).
 * - The toggle is a small state machine ({@link reduceSketchBotPolicyToggle},
 *   {@link sketchBotPolicyToggleView}), so its rules are tested without a DOM.
 *
 * Pure. Bundled into the renderer and the CLI: no Electron or Node imports.
 */

import { getLocalModel, PROMPT_GUARD_2_22M_ID } from '../local-models/model-catalog';
import type { BotPolicy } from './types';

/** Whether B2 can be offered for a sketch's owner agent, and why not. */
export type SketchB2Availability =
	| { ok: true }
	| {
			ok: false;
			reason: string;
			/**
			 * The screen is `off`: the toggle offers "Download Prompt Guard 2",
			 * which installs the model and assigns it (spec section 8.3, rule 2).
			 */
			offerScreenDownload?: true;
	  };

/** One sketch's policy and whether B2 may be turned on (`maestro-cli sketch bot-policy`). */
export interface SketchBotPolicyStatus {
	sketchId: string;
	/** The room's policy as this desktop last saw it, or null when the sketch is not shared. */
	policy: BotPolicy | null;
	availability: SketchB2Availability;
}

/** What the one-click screen download did. */
export interface SketchScreenInstallResult {
	/** The model and its runtime are installed. */
	installed: boolean;
	/** `injection-screen` now points at it. False when another source was assigned meanwhile. */
	assigned: boolean;
	/** Why it did not finish. */
	error?: string;
}

/** The model the one-click download installs: the default local screen (G1). */
export const SKETCH_DEFAULT_SCREEN_MODEL_ID = PROMPT_GUARD_2_22M_ID;

/** "Download Prompt Guard 2 (77 MB)": the size comes from the catalog, so it cannot drift. */
export function sketchScreenDownloadLabel(): string {
	const bytes = getLocalModel(SKETCH_DEFAULT_SCREEN_MODEL_ID)?.bytes ?? 0;
	const megabytes = Math.round(bytes / (1024 * 1024));
	return megabytes > 0 ? `Download Prompt Guard 2 (${megabytes} MB)` : 'Download Prompt Guard 2';
}

/** The toggle's label in the Share panel. */
export const SKETCH_B2_TOGGLE_LABEL = 'Let collaborators ask the agent';

/**
 * The trust warning shown before B2 is turned on (spec section 5): who can
 * ask, what a run can do, and what it costs. One text for the Sketch tab, the
 * terminal prompt and the desktop confirmation.
 */
export function sketchB2TrustWarning(sketchName: string): {
	title: string;
	message: string;
	detail: string;
} {
	return {
		title: 'Let collaborators ask the agent?',
		message: `Anyone with an edit link to ${JSON.stringify(sketchName)} can ask the agent to work on it.`,
		detail:
			'Each request is screened for prompt injection, then waits for you to press Run. A request you run uses your model quota and runs restricted: the agent can read your project and draw on this sketch, but cannot run commands or change files. Everything the agent posts is visible to everyone in the room. Run only requests you would type yourself.',
	};
}

/**
 * Why a room on `writers` must go back to `conductor` now, or null. A room on
 * `conductor` (or not shared) never needs it.
 */
export function sketchBotPolicyDemotion(
	policy: BotPolicy | null,
	availability: SketchB2Availability
): string | null {
	if (policy !== 'writers' || availability.ok) return null;
	return availability.reason;
}

/** The Sketch tab's line after a demotion. */
export function sketchBotPolicyDemotedNotice(reason: string): string {
	return `Collaborators can no longer ask the agent: ${reason}`;
}

// ------------------------------------------------------------ toggle state

/** Where the toggle stands between the user and the room. */
export type SketchBotPolicyTogglePhase =
	| { kind: 'idle' }
	/** The trust warning is up; nothing is sent until Confirm. */
	| { kind: 'confirming' }
	/** `policy.set` is on its way. */
	| { kind: 'sending'; want: BotPolicy };

export interface SketchBotPolicyToggleState {
	phase: SketchBotPolicyTogglePhase;
	/** Why the last attempt did not go through, until the next one. */
	error: string | null;
}

/** What the toggle knows about the room and the screen. */
export interface SketchBotPolicyToggleContext {
	/** The live room's policy, or null when this window has no live room for the sketch. */
	policy: BotPolicy | null;
	/** Null until the first read. */
	availability: SketchB2Availability | null;
}

export type SketchBotPolicyToggleEvent =
	/** The user flipped the switch. */
	| { type: 'toggle' }
	/** The user accepted the trust warning. */
	| { type: 'confirm' }
	/** The user dismissed the trust warning. */
	| { type: 'cancel' }
	/** `setBotPolicy` resolved. */
	| { type: 'sent' }
	/** `setBotPolicy` rejected. */
	| { type: 'failed'; error: string }
	/** The context changed (a policy frame, a new availability read). */
	| { type: 'context' };

export const INITIAL_SKETCH_BOT_POLICY_TOGGLE: SketchBotPolicyToggleState = Object.freeze({
	phase: Object.freeze({ kind: 'idle' }) as SketchBotPolicyTogglePhase,
	error: null,
});

/** One step: the next state, and the policy to send when the step sends one. */
export interface SketchBotPolicyToggleStep {
	state: SketchBotPolicyToggleState;
	send?: BotPolicy;
}

/**
 * The toggle's rules:
 *
 * - Off to on goes through the trust warning; on to off sends at once.
 * - `writers` is sent only while B2 is available, checked at Confirm too, so
 *   availability lost while the warning is up withdraws it with the reason.
 * - Nothing is sent without a live room, or while a send is in flight.
 */
export function reduceSketchBotPolicyToggle(
	state: SketchBotPolicyToggleState,
	event: SketchBotPolicyToggleEvent,
	context: SketchBotPolicyToggleContext
): SketchBotPolicyToggleStep {
	const { phase } = state;
	switch (event.type) {
		case 'toggle': {
			if (phase.kind === 'sending' || context.policy === null) return { state };
			if (context.policy === 'writers') {
				return {
					state: { phase: { kind: 'sending', want: 'conductor' }, error: null },
					send: 'conductor',
				};
			}
			if (phase.kind === 'confirming') return { state: { phase: { kind: 'idle' }, error: null } };
			if (!context.availability?.ok) return { state };
			return { state: { phase: { kind: 'confirming' }, error: null } };
		}
		case 'confirm': {
			if (phase.kind !== 'confirming') return { state };
			if (context.policy === null) {
				return {
					state: {
						phase: { kind: 'idle' },
						error: 'The room is not connected. Try again once it is.',
					},
				};
			}
			if (!context.availability?.ok) {
				return {
					state: {
						phase: { kind: 'idle' },
						error: context.availability?.reason ?? 'The screen is not ready yet.',
					},
				};
			}
			return {
				state: { phase: { kind: 'sending', want: 'writers' }, error: null },
				send: 'writers',
			};
		}
		case 'cancel':
			return phase.kind === 'confirming'
				? { state: { phase: { kind: 'idle' }, error: null } }
				: { state };
		case 'sent':
			return phase.kind === 'sending'
				? { state: { phase: { kind: 'idle' }, error: null } }
				: { state };
		case 'failed':
			return phase.kind === 'sending'
				? { state: { phase: { kind: 'idle' }, error: event.error } }
				: { state };
		case 'context': {
			// The warning is withdrawn when B2 stops being available, or the room is gone.
			if (
				phase.kind === 'confirming' &&
				(context.policy !== 'conductor' || !context.availability?.ok)
			) {
				return {
					state: {
						phase: { kind: 'idle' },
						error:
							context.policy === 'writers'
								? null
								: context.availability && !context.availability.ok
									? context.availability.reason
									: null,
					},
				};
			}
			return { state };
		}
	}
}

/** What the toggle draws. */
export interface SketchBotPolicyToggleView {
	/** The switch reads on: the room is on `writers`, or a send for it is in flight. */
	checked: boolean;
	disabled: boolean;
	busy: boolean;
	/** The trust warning is up. */
	confirming: boolean;
	/** Why the switch is greyed out, when it is. */
	reason: string | null;
	/** Offer the one-click Prompt Guard 2 download beside it. */
	offerScreenDownload: boolean;
	error: string | null;
}

export function sketchBotPolicyToggleView(
	state: SketchBotPolicyToggleState,
	context: SketchBotPolicyToggleContext
): SketchBotPolicyToggleView {
	const busy = state.phase.kind === 'sending';
	const checked =
		state.phase.kind === 'sending' ? state.phase.want === 'writers' : context.policy === 'writers';
	const availability = context.availability;
	const unavailable = availability !== null && !availability.ok ? availability : null;
	let reason: string | null = null;
	if (context.policy === null)
		reason = 'Collaborators can ask the agent once the room is connected.';
	else if (context.policy === 'conductor' && unavailable) reason = unavailable.reason;
	const disabled =
		busy ||
		context.policy === null ||
		(context.policy === 'conductor' && (availability === null || unavailable !== null));
	return {
		checked,
		disabled,
		busy,
		confirming: state.phase.kind === 'confirming',
		reason,
		offerScreenDownload: unavailable?.offerScreenDownload === true,
		error: state.error,
	};
}
