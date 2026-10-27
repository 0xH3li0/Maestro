/**
 * Sketch Book attribution (spec section 7). Two separate records, on purpose:
 *
 * - The display stamp, `customData.createdBy / lastEditedBy / lastEditedAt`,
 *   written on each element this desktop changed. It sits inside the
 *   ciphertext, so any client can forge it: it is for the hover card only.
 * - The author map, `elementId -> ElementAuthorship`, which the desktop keeps
 *   from the envelope `actor` of the op that delivered each version. The gate,
 *   the digest and the read tools (T3, T4) trust this one, never `customData`.
 *
 * Everything here is pure, so the renderer store and the tests share it.
 * Bundled into the renderer and the CLI: no Electron or Node imports.
 */

import type { SketchWireElement } from './payloads';
import type { SketchActor, SketchActorKind } from './types';

/** Who made an edit, as the display stamp shows it. */
export interface SketchEditor {
	id: string;
	name: string;
	kind: SketchActorKind;
	/** Bot edits only: the human whose request started the turn. */
	onBehalfOf?: { id: string; name: string };
}

/** The stamp in an element's `customData` (spec section 7). */
export interface SketchElementStamp {
	createdBy: SketchEditor;
	lastEditedBy: SketchEditor;
	lastEditedAt: number;
}

/** The display stamp's keys, in the order they appear in `customData`. */
export const SKETCH_STAMP_KEYS = ['createdBy', 'lastEditedBy', 'lastEditedAt'] as const;

/**
 * The authoritative author of one element version (spec section 7). Kept
 * from incoming ops, never from `customData`.
 */
export interface ElementAuthorship {
	version: number;
	/** Envelope actor of the op that delivered this version. */
	actor: SketchActor;
	/** Absent when the version came from a snapshot (or is a local edit not yet acked). */
	opSeq?: number;
	/** sha256 of the screened fields (section 8.4), lowercase hex. */
	textHash: string;
	/** Server `ts` of the latest op in which a GUEST changed the text fields. */
	guestTextAt?: number;
	/** A guest has ever changed this element's text. Never cleared. */
	guestTouched: boolean;
}

/** The id the conductor's local edits carry until a room assigns one. */
export const LOCAL_CONDUCTOR_ID = 'conductor';

/** The conductor at this desktop, as the display stamp names them. */
export function conductorEditor(name = 'Conductor', id = LOCAL_CONDUCTOR_ID): SketchEditor {
	return { id, name, kind: 'conductor' };
}

/** An agent edit: `id: 'agent:<maestroAgentId>'`, naming who asked (spec section 7). */
export function botEditor(
	agentId: string,
	agentName: string,
	onBehalfOf?: { id: string; name: string }
): SketchEditor {
	const editor: SketchEditor = { id: `agent:${agentId}`, name: agentName, kind: 'bot' };
	if (onBehalfOf) editor.onBehalfOf = { id: onBehalfOf.id, name: onBehalfOf.name };
	return editor;
}

/**
 * An agent as an envelope actor, for the author map of its writes. It writes
 * through the conductor's desktop (`delta.asBot`, wire contract X2), so it
 * holds the conductor's role.
 */
export function botActor(agentId: string, agentName: string): SketchActor {
	return { id: `agent:${agentId}`, kind: 'bot', name: agentName, role: 'conductor' };
}

/** The local conductor as an envelope actor, for the author map of local edits. */
export function localConductorActor(name = 'Conductor', id = LOCAL_CONDUCTOR_ID): SketchActor {
	return { id, kind: 'conductor', name, role: 'conductor' };
}

/** Longest actor name {@link describeSketchActor} quotes, in characters. */
export const SKETCH_ACTOR_NAME_MAX_CHARS = 60;

/**
 * The server-stamped actor as one line (A2, M2): `"Sam" · guest, read-write
 * link #3, not verified`. The name is chosen by a person, so it is capped and
 * JSON-quoted: it cannot break out of its quotes or onto a line of its own.
 * The link label is the conductor's own, kept on one line. Every guest is
 * "not verified": v1 has no guest accounts.
 */
export function describeSketchActor(actor: SketchActor): string {
	const chars = Array.from(actor.name);
	const name =
		chars.length > SKETCH_ACTOR_NAME_MAX_CHARS
			? `${chars.slice(0, SKETCH_ACTOR_NAME_MAX_CHARS - 1).join('')}…`
			: actor.name;
	const quoted = JSON.stringify(name);
	if (actor.kind !== 'guest') return `${quoted} · ${actor.kind}`;
	const link = actor.role === 'rw' ? 'read-write link' : 'view-only link';
	const capLabel = actor.capLabel?.replace(/\s+/g, ' ').trim();
	const label = capLabel ? ` ${capLabel}` : '';
	return `${quoted} · guest, ${link}${label}, not verified`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyEditor(editor: SketchEditor): SketchEditor {
	const copy: SketchEditor = { id: editor.id, name: editor.name, kind: editor.kind };
	if (editor.onBehalfOf) {
		copy.onBehalfOf = { id: editor.onBehalfOf.id, name: editor.onBehalfOf.name };
	}
	return copy;
}

function isEditor(value: unknown): value is SketchEditor {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		(value.kind === 'conductor' || value.kind === 'guest' || value.kind === 'bot')
	);
}

/** The display stamp on an element, or null when it has none (or a malformed one). */
export function readElementStamp(element: SketchWireElement): SketchElementStamp | null {
	const data = element.customData;
	if (!isRecord(data)) return null;
	const { createdBy, lastEditedBy, lastEditedAt } = data;
	if (!isEditor(createdBy) || !isEditor(lastEditedBy)) return null;
	if (typeof lastEditedAt !== 'number' || !Number.isFinite(lastEditedAt)) return null;
	return { createdBy, lastEditedBy, lastEditedAt };
}

export interface StampLocalEditsResult {
	/**
	 * The scene in `next`'s order. An element whose version matches the synced
	 * scene is the synced object itself; a changed one is a new, stamped copy.
	 */
	elements: SketchWireElement[];
	/** Ids of the elements stamped by this call (new, edited or deleted). */
	changedIds: string[];
}

/**
 * Stamp every element whose `version` differs from the last synced scene
 * (spec section 7). The stamp lands in the same version: nothing here bumps
 * `version`, so stamping causes no echo.
 *
 * - A new element gets `createdBy` and `lastEditedBy` = `editor`, even when it
 *   arrived carrying another stamp (a paste copies `customData`).
 * - An edited element keeps its `createdBy` and gets `lastEditedBy` = `editor`.
 *   One without a `createdBy` keeps none: an unknown creator is not invented.
 * - A deletion is an edit: the `isDeleted` tombstone records the deleter.
 * - Other `customData` keys are kept.
 *
 * Changed elements are shallow-copied, so the result never aliases an object
 * the caller may mutate later (Excalidraw mutates its elements in place).
 */
export function stampLocalEdits(
	synced: readonly SketchWireElement[],
	next: readonly SketchWireElement[],
	editor: SketchEditor,
	now: number
): StampLocalEditsResult {
	const syncedById = new Map<string, SketchWireElement>();
	for (const element of synced) syncedById.set(element.id, element);

	const elements: SketchWireElement[] = [];
	const changedIds: string[] = [];
	for (const element of next) {
		const previous = syncedById.get(element.id);
		if (previous && previous.version === element.version) {
			elements.push(previous);
			continue;
		}
		const existing = isRecord(element.customData) ? element.customData : {};
		const createdBy = previous
			? isEditor(existing.createdBy)
				? copyEditor(existing.createdBy)
				: undefined
			: copyEditor(editor);
		const customData: Record<string, unknown> = { ...existing };
		if (createdBy) customData.createdBy = createdBy;
		else delete customData.createdBy;
		customData.lastEditedBy = copyEditor(editor);
		customData.lastEditedAt = now;
		elements.push({ ...element, customData });
		changedIds.push(element.id);
	}
	return { elements, changedIds };
}

/**
 * The screened fields of an element (spec section 8.2, I2): `text`,
 * `originalText`, a frame's `name`, and `link` (also an embeddable's URL).
 * A missing field reads as null, so the order and arity never change.
 */
export function sketchTextFields(element: SketchWireElement): (string | null)[] {
	const field = (key: string) => {
		const value = element[key];
		return typeof value === 'string' ? value : null;
	};
	return [field('text'), field('originalText'), field('name'), field('link')];
}

function toHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `sha256(screened fields)`, lowercase hex: the verdict cache key (section
 * 8.4). Moving or restyling an element leaves it unchanged.
 */
export async function sketchTextHash(element: SketchWireElement): Promise<string> {
	const canonical = JSON.stringify(sketchTextFields(element));
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical)
	);
	return toHex(digest);
}

/** One delivered element version, as the author map records it. */
export interface AuthorshipUpdate {
	version: number;
	actor: SketchActor;
	textHash: string;
	opSeq?: number;
	/** Server ms of the delivering op. Never a client clock; absent for a local edit. */
	ts?: number;
}

/**
 * The author map entry after `update` delivers a new version (spec section 7).
 *
 * Text authorship is separate from version authorship: a guest version that
 * changes the text (or creates the element) sets `guestTouched` and moves
 * `guestTextAt` to the op's server `ts`. Any version with the same text hash
 * (a move or restyle) keeps both as they were, whoever wrote it, so a
 * conductor or bot edit never launders a guest's text.
 */
export function nextElementAuthorship(
	previous: ElementAuthorship | undefined,
	update: AuthorshipUpdate
): ElementAuthorship {
	const textChanged = !previous || previous.textHash !== update.textHash;
	const guestWroteText = update.actor.kind === 'guest' && textChanged;
	const entry: ElementAuthorship = {
		version: update.version,
		actor: update.actor,
		textHash: update.textHash,
		guestTouched: (previous?.guestTouched ?? false) || guestWroteText,
	};
	if (update.opSeq !== undefined) entry.opSeq = update.opSeq;
	const guestTextAt = guestWroteText ? update.ts : previous?.guestTextAt;
	if (guestTextAt !== undefined) entry.guestTextAt = guestTextAt;
	return entry;
}
