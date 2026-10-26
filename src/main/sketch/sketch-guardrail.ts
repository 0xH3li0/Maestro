/**
 * The Sketch Book guardrail gate (spec section 8): every third-party input
 * passes `screenForAgent()` before an agent can read it.
 *
 * PHASE 03 STUB. The real gate (the `injection-screen` task, the verdict
 * cache, the audit log, cloud consent) lands in phase 04. Until then the gate
 * fails closed (spec section 8.3 rule 1): it screens nothing and withholds
 * every subject as `unscreened`. The callers already route every third-party
 * element through here, so phase 04 replaces only this module.
 */

import type { SketchActor, WithheldReason } from '../../shared/sketch/types';

/** One element version the gate must decide (spec section 8.2, I2 and I3). */
export interface AgentScreenSubject {
	elementId: string;
	version: number;
	type: string;
	/** Envelope actor of the current version, or null when unknown (section 7). */
	author: SketchActor | null;
	/** The verdict cache key (section 8.4), when the author map has it. */
	textHash?: string;
	/** The screened fields, `sketchTextFields()` order: text, originalText, name, link. */
	fields: (string | null)[];
}

export interface AgentScreenRequest {
	sketchId: string;
	/** The agent that will read the result. */
	agentId: string;
	subjects: AgentScreenSubject[];
}

/** What the gate decided for one subject. */
export type AgentScreenVerdict =
	| { status: 'clear' }
	| { status: 'withheld'; reason: WithheldReason };

/**
 * Decide every subject, keyed by element id. A subject the result does not
 * name must be treated as withheld by the caller (fail closed).
 *
 * Stub: nothing is screened yet, so every subject is withheld `unscreened`.
 */
export async function screenForAgent(
	request: AgentScreenRequest
): Promise<Map<string, AgentScreenVerdict>> {
	const verdicts = new Map<string, AgentScreenVerdict>();
	for (const subject of request.subjects) {
		verdicts.set(subject.elementId, { status: 'withheld', reason: 'unscreened' });
	}
	return verdicts;
}
