/**
 * The prompt-injection screen as every caller sees it: the result of scoring
 * one untrusted value, the source that would score it, and the threshold.
 *
 * The `injection-screen` Local Models task scores text other people wrote
 * before an agent reads it. Cue (`src/shared/cue/injection-screen.ts`) and
 * Sketch Book are its callers; neither owns it. The model call is main-process
 * only (`src/main/local-models/injection-screen.ts`). Everything here is pure.
 */

import type { SystemOneFailPolicy } from './system-one';

/** A score at or above this is an injection, unless a caller sets its own. */
export const DEFAULT_INJECTION_THRESHOLD = 0.8;

/**
 * What scoring one value found. `off` is kept apart from `unavailable`
 * because callers treat them differently: `off` means nobody assigned the task
 * a model, `unavailable` means someone did and it could not run.
 */
export type InjectionScore =
	| { status: 'scored'; score: number }
	| { status: 'off'; reason: string }
	| InjectionUnavailable;

/** The screen was asked for and could not score. */
export interface InjectionUnavailable {
	status: 'unavailable';
	reason: string;
	/**
	 * What the task's own fail policy says, when the scorer applied one (a
	 * System One engine gave no answer). `closed` blocks every action.
	 */
	failPolicy?: SystemOneFailPolicy;
}

/** Who asks for a score, for the decision record and the log. */
export type InjectionScreenPurpose = 'cue' | 'sketch-book';

/**
 * The source that would score a value, found without sending anything.
 *
 * "Cloud" means the text leaves this machine: the System One engine in force
 * is Jev or an OpenJev server (an OpenJev the user runs still counts, because
 * nobody else can verify who owns it). A local classifier and the local judge
 * are local.
 */
export interface InjectionSourceInfo {
	kind: 'local-classifier' | 'local-judge' | 'jev' | 'openjev';
	locality: 'local' | 'cloud';
	/** Jev and OpenJev: the server host, so a consent can be bound to it. */
	host?: string;
	/** The source as a person reads it ("Jev (TypeSafe cloud)", "Prompt Guard 2 22M"). */
	label: string;
}

/**
 * The source in force, or why there is none. `off` is the task's default
 * assignment (nobody asked for a screen). `unavailable` means a screen was
 * asked for and nothing can answer it as set up (System One with no engine
 * chosen, a source a classifier cannot run on).
 */
export type InjectionSourceResolution =
	| InjectionSourceInfo
	| { status: 'off' }
	| { status: 'unavailable'; reason: string };
