/**
 * The Sketch Book outbound screen (spec section 8.5, risk R3: the canvas as an
 * exfiltration channel). Every text an agent write would put on the board or
 * in the chat (T5, T6, T8 text fields, T12) passes `screenOutbound()` before
 * the window sees it, in one batch per write.
 *
 * PHASE 03 STUB. Step 1 runs: `redactSecrets()` replaces credential-shaped
 * text. Step 2, `screenForSecrets()` (its pattern pass, which also knows the
 * values of the configured secret env vars, refuses the write; its model pass
 * on T12 holds the message), lands in phase 04. The result type already has
 * the refusal, so the callers handle it from day one.
 */

import { redactSecrets } from '../../shared/redactSecrets';

/** What the texts are, for the refusal wording and (phase 04) the model pass. */
export type OutboundPurpose = 'element' | 'chat';

export interface OutboundScreenRequest {
	sketchId: string;
	agentId: string;
	purpose: OutboundPurpose;
	/** The outbound texts of one write, in a fixed order. */
	texts: string[];
}

export type OutboundScreenResult =
	| {
			ok: true;
			/** The texts to write, in the request's order. */
			texts: string[];
			/** How many texts redaction changed. */
			redactedCount: number;
	  }
	| {
			ok: false;
			/** Why the whole write is refused, in words the agent can act on. */
			reason: string;
	  };

/**
 * Screen one write's outbound texts. A refusal refuses the whole write (no
 * partial write, spec section 8.5).
 *
 * Stub: redaction only; nothing is refused yet.
 */
export async function screenOutbound(
	request: OutboundScreenRequest
): Promise<OutboundScreenResult> {
	let redactedCount = 0;
	const texts = request.texts.map((text) => {
		const result = redactSecrets(text);
		if (result.redacted) redactedCount += 1;
		return result.text;
	});
	return { ok: true, texts, redactedCount };
}
