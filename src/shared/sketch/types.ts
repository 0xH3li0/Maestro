/**
 * Sketch Book shared types: the binding record (spec section 3), the
 * server-stamped actor (wire contract section 5), and the guardrail
 * vocabulary (spec section 8). Bundled into the renderer and the CLI, so it
 * imports nothing from Electron or Node.
 */

import type { SketchWireElement } from './payloads';

/** Who wrote a frame. Stamped by the server; clients never trust ciphertext for it. */
export type SketchActorKind = 'conductor' | 'guest' | 'bot';

/** A socket's role in a room. A share link is `ro` or `rw`. */
export type SketchRole = 'ro' | 'rw' | 'conductor';

/** The role a share link grants. */
export type SketchLinkRole = Exclude<SketchRole, 'conductor'>;

export const SKETCH_ACTOR_KINDS: readonly SketchActorKind[] = ['conductor', 'guest', 'bot'];
export const SKETCH_ROLES: readonly SketchRole[] = ['ro', 'rw', 'conductor'];
export const SKETCH_LINK_ROLES: readonly SketchLinkRole[] = ['ro', 'rw'];

/** Wire contract section 5. The envelope actor, the only identity the desktop trusts. */
export interface SketchActor {
	id: string;
	kind: SketchActorKind;
	name: string;
	capId?: string;
	capLabel?: string;
	role: SketchRole;
}

/** Who may ask the bot: the conductor alone (B1) or read-write guests too (B2). */
export type BotPolicy = 'conductor' | 'writers';
export const BOT_POLICIES: readonly BotPolicy[] = ['conductor', 'writers'];

/** Wire contract section 5, including `failed` (X5). */
export type BotStatus =
	| 'queued'
	| 'screening'
	| 'awaiting_approval'
	| 'running'
	| 'done'
	| 'denied'
	| 'failed'
	| 'rejected'
	| 'unavailable'
	| 'bot_offline'
	| 'rate_limited'
	| 'locked_out'
	| 'forbidden'
	| 'expired';

export const BOT_STATUSES: readonly BotStatus[] = [
	'queued',
	'screening',
	'awaiting_approval',
	'running',
	'done',
	'denied',
	'failed',
	'rejected',
	'unavailable',
	'bot_offline',
	'rate_limited',
	'locked_out',
	'forbidden',
	'expired',
];

/** The statuses the conductor may report with `bot.progress`. */
export type BotProgressStatus = Extract<BotStatus, 'screening' | 'awaiting_approval' | 'running'>;
export const BOT_PROGRESS_STATUSES: readonly BotProgressStatus[] = [
	'screening',
	'awaiting_approval',
	'running',
];

/** What the conductor reports in `guardrail_rejected` (contract section 4). */
export type GuardrailReason = 'injection' | 'screen_unavailable' | 'other';
export const GUARDRAIL_REASONS: readonly GuardrailReason[] = [
	'injection',
	'screen_unavailable',
	'other',
];

/**
 * What the flagged sender sees (contract section 5). It hides which check
 * fired: `injection` and `other` both read `rejected`.
 */
export type GuardrailNotice = 'rejected' | 'unavailable';
export const GUARDRAIL_NOTICES: readonly GuardrailNotice[] = ['rejected', 'unavailable'];

/** Why the gate kept third-party text from the agent (spec section 8.3 rule 5). */
export type WithheldReason = 'flagged' | 'unscreened';

/** What the gate decides for one value (spec section 8.3). */
export type SketchScreenStatus = 'clean' | 'flagged' | 'unscreened';

/** Where screened text went: `cloud` when it left this machine. */
export type SketchScreenLocality = 'local' | 'cloud';

/** One gate decision (spec section 8.3). Never carries the text. */
export interface SketchScreenVerdict {
	status: SketchScreenStatus;
	score?: number;
	/** The source as a person reads it ("Prompt Guard 2 22M", "Screen off"). */
	sourceLabel: string;
	locality: SketchScreenLocality;
	/** Why the text is `unscreened`. */
	reason?: string;
	/** `unscreened` because the task is `off` (D2 needs this; `unavailable` never sets it). */
	off?: true;
	/** Conductor or bot input: nothing was screened (spec section 8.2). */
	skipped?: true;
	/** Canvas only: this decision sent the one server report for `(actorId, elementId)`. */
	reported?: true;
}

/** Whether a `@bot` turn runs restricted or with the agent's full access (spec section 5). */
export type SketchTurnPosture = 'restricted' | 'full';

/** What a bot turn starts from (`sketch:prepareBotTurn`), or why it cannot run. */
export type SketchBotTurnContext =
	| {
			ok: true;
			/** The owning agent, which runs the turn. */
			agentId: string;
			agentName: string;
			sketchName: string;
			/** The gated change digest since the agent's last read (spec section 4). */
			digest: string;
			sceneVersion: number;
			/** The sketch's own provider session (Q3), once its first turn has run. */
			botSessionId: string | null;
	  }
	| {
			ok: false;
			reason: string;
			/** The owner's provider cannot run the turn's restricted posture (risk K1). */
			blockedByPosture?: true;
	  };

/** The outbound screen's decision on a bot reply (spec section 8.5), as the renderer sees it. */
export type SketchBotReplyScreen =
	| {
			ok: true;
			/** The reply to post, after redaction. */
			text: string;
			/** The model pass flagged it: hold it for the conductor's "Publish anyway". */
			held?: true;
			heldReason?: string;
			/** Why the model pass did not run. Never a block. */
			note?: string;
	  }
	| {
			ok: false;
			/** Why the reply is refused, in words the agent can act on. */
			reason: string;
	  };

/** A guest's `@bot` chat for the gate (spec section 8.2, I1), as the bot relay hands it over. */
export interface SketchBotScreenRequest {
	/** The chat message id: the `replyTo` of every frame that answers it. */
	replyTo: string;
	/** The server `chat.ts` (ms), for H1. */
	ts: number;
	/** The envelope actor. The relay sends only guest requests. */
	actor: SketchActor;
	/** The decrypted chat text. */
	text: string;
}

/**
 * One share link. The cap secret itself is never stored here: main seals it
 * beside the room key (`cap:<capId>` in the sketch store) so Copy link can
 * rebuild the URL, and the record keeps only what the Collaborate panel shows.
 */
export interface SketchLink {
	capId: string;
	role: SketchLinkRole;
	label: string;
	createdAt: number;
	/** Server expiry in ms, or null for a link that never expires. */
	expiresAt: number | null;
	revoked: boolean;
}

/** The share state of a sketch. The AES room key is sealed elsewhere, never here. */
export interface SketchShare {
	roomId: string;
	keyEpoch: number;
	links: SketchLink[];
	botPolicy: BotPolicy;
	/**
	 * The server the room lives on (`sketchBook.serverUrl` when it was made).
	 * Absent on a record from before it was kept: the hosted server.
	 */
	serverUrl?: string;
}

/** Spec section 3, binding record. One per sketch in `userData/sketches/index.json`. */
export interface SketchRecord {
	/** `generateUUID()`. */
	sketchId: string;
	/** The spawning agent. Immutable. */
	ownerAgentId: string;
	name: string;
	/** `userData/sketches/<agentId>/<sketchId>.excalidraw`. */
	filePath: string;
	createdAt: number;
	share: SketchShare | null;
	/** The fresh provider session for bot turns (Q3). */
	botSessionId?: string;
	/** Mirror of the server flag (M5). Never set locally. */
	guestEdited: boolean;
}

/**
 * A scene as it is saved to `<sketchId>.excalidraw`: Excalidraw's own file
 * format, so the file opens in excalidraw.com and in Obsidian unchanged.
 * Elements and files stay whole; only the fields the store checks are named.
 */
export interface SketchScene {
	type: 'excalidraw';
	version: number;
	source?: string;
	elements: SketchWireElement[];
	appState: Record<string, unknown>;
	/** Excalidraw's `BinaryFiles`, keyed by file id. */
	files: Record<string, unknown>;
}

/**
 * A Sketch Book tab on an agent (spec section 3). It only points at a sketch:
 * the scene lives in the store and the live session in the renderer's
 * `sketchSessionStore`, so tiling, snoozing, closing or moving the tab to
 * another window never copies or drops the drawing. `name` is the tab label,
 * renamed like any tab; the record's own name stays in `index.json`.
 */
export interface SketchTab {
	id: string;
	sketchId: string;
	name: string;
	createdAt: number;
}
