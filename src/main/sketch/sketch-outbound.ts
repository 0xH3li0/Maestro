/**
 * The Sketch Book outbound screen (spec section 8.5, risk R3: the canvas as an
 * exfiltration channel). Every text an agent write would put on the board or
 * in the chat (T5, T6, T8 text fields, T12, `bot.reply`) passes
 * `screenOutbound()` before the window sees it, in one batch per write.
 *
 * 1. `redactSecrets()` replaces credential-shaped text.
 * 2. The `screenForSecrets()` pattern pass runs on the redacted texts. It also
 *    knows the values of the secret env vars Maestro is configured with, which
 *    redaction cannot. A finding refuses the whole write (no partial write) and
 *    names the finding kinds, so the agent can remove them and retry.
 * 3. Only for a chat message (T12, `bot.reply`), and only once the patterns
 *    are clean, the `secret-screen` model pass runs, once per message. A model
 *    flag holds the message (`held: true`) for the conductor's "Publish anyway"
 *    chip; it never refuses. A model that cannot run adds a note and never
 *    blocks. A cloud System One engine runs only under the room's cloud
 *    screening consent (section 8.10); without it the pass is skipped with a
 *    note.
 *
 * The patterns run before the model in a separate call on purpose: a single
 * call would hand a configured secret's value to the model engine (possibly a
 * cloud one) before the pattern pass could refuse it.
 */

import type { InjectionSourceInfo } from '../../shared/local-models/injection-screen';
import { redactSecrets } from '../../shared/redactSecrets';
import {
	SECRET_KIND_LABELS,
	type SecretFinding,
	type SecretKind,
	type SecretScanEnv,
} from '../../shared/secretScan';
import { screenForSecrets, type SecretScreenPart } from '../local-models/secret-screen';
import { getSketchCloudScreeningPolicy, type SketchCloudScreeningPolicy } from './sketch-guardrail';

/**
 * What the texts are: element fields (T5, T6, T8), the agent's chat post
 * (T12), or the bot's reply in a shared room (`bot.reply`).
 */
export type OutboundPurpose = 'element' | 'chat' | 'bot-reply';

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
			/**
			 * The model pass flagged the message: show it to the conductor with a
			 * "Publish anyway" chip instead of sending it. Chat purposes only.
			 */
			held?: true;
			/** Why it is held, naming the model or engine. Present with `held`. */
			heldReason?: string;
			/** Why the model pass did not run. Never a block. */
			note?: string;
	  }
	| {
			ok: false;
			/** Why the whole write is refused, in words the agent can act on. */
			reason: string;
			/** The pattern finding kinds, never a value or a preview. */
			kinds: SecretKind[];
	  };

export interface SketchOutboundDeps {
	/** The secret screen. Defaults to {@link screenForSecrets}. */
	screen?: typeof screenForSecrets;
	/** Configured variables to match values of. Defaults to the screen's own `knownSecretEnv()`. */
	env?: SecretScanEnv;
	/** The cloud screening consent. Defaults to the policy the consent module registered. */
	cloudPolicy?: () => SketchCloudScreeningPolicy;
}

/** Where the refused text was, for the agent. */
const PURPOSE_WHAT: Record<OutboundPurpose, string> = {
	element: 'element text',
	chat: 'chat message',
	'bot-reply': 'bot reply',
};

/** Whether the purpose is one message that runs the model pass. */
function isMessage(purpose: OutboundPurpose): boolean {
	return purpose === 'chat' || purpose === 'bot-reply';
}

/**
 * Screen one write's outbound texts. A refusal refuses the whole write (no
 * partial write, spec section 8.5).
 */
export async function screenOutbound(
	request: OutboundScreenRequest,
	deps: SketchOutboundDeps = {}
): Promise<OutboundScreenResult> {
	const screen = deps.screen ?? screenForSecrets;
	const envOption = deps.env ? { env: deps.env } : {};

	let redactedCount = 0;
	const texts = request.texts.map((text) => {
		const result = redactSecrets(text);
		if (result.redacted) redactedCount += 1;
		return result.text;
	});
	const parts: SecretScreenPart[] = texts.map((text, index) => ({
		source: texts.length > 1 ? `text ${index + 1}` : undefined,
		text,
	}));

	const patterns = await screen(parts, { ...envOption, modelPass: false });
	const found = patterns.findings.filter((finding) => finding.kind !== 'model-flagged');
	if (found.length > 0) {
		const kinds = [...new Set(found.map((finding) => finding.kind))];
		return { ok: false, reason: refusalReason(request.purpose, kinds, found), kinds };
	}

	if (!isMessage(request.purpose)) return { ok: true, texts, redactedCount };

	const policy = (deps.cloudPolicy ?? getSketchCloudScreeningPolicy)();
	const allowSource = (source: InjectionSourceInfo): boolean =>
		source.locality === 'local' || policy.isCloudScreeningAllowed(request.sketchId, source);
	const model = await screen(parts, { ...envOption, allowSource });
	const flag = model.findings.find((finding) => finding.kind === 'model-flagged');
	return {
		ok: true,
		texts,
		redactedCount,
		...(flag ? { held: true as const, heldReason: heldReason(flag) } : {}),
		...(model.note ? { note: model.note } : {}),
	};
}

/** "Found a GitHub token (text 2) in the element text; remove it and retry. Nothing was written." */
function refusalReason(
	purpose: OutboundPurpose,
	kinds: SecretKind[],
	findings: SecretFinding[]
): string {
	const labels = kinds.map((kind) => {
		const where = [
			...new Set(
				findings
					.filter((finding) => finding.kind === kind && finding.source)
					.map((finding) => finding.source)
			),
		];
		return `${SECRET_KIND_LABELS[kind]}${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
	});
	return `credential-shaped text in the ${PURPOSE_WHAT[purpose]}: ${labels.join('; ')}. Remove it and retry. Nothing was written.`;
}

/** Why a message is held, naming the model or engine and its score. */
function heldReason(flag: SecretFinding): string {
	const by = flag.name ? ` by ${flag.name}` : '';
	return `Flagged${by} (${flag.preview}) as possibly holding a secret. The conductor can publish it anyway.`;
}
