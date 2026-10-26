/**
 * Sketch Book agent writes (spec section 4, T5-T8 and T12): the pure pieces
 * that main and the renderer share.
 *
 * - The outbound text walk. Every text an agent write would put on the board
 *   or in the chat passes main's outbound screen (`screenOutbound()`, spec
 *   section 8.5) before the window sees it. `collectSketchOutboundTexts()`
 *   lists those texts in a fixed order and `replaceSketchOutboundTexts()`
 *   puts the screened texts back in the same order, so the screen sees one
 *   batch per write and the caller never rebuilds a skeleton by hand.
 * - The patch rules for `sketch_update_elements`: the fields an agent may
 *   not set, because the session, the stamp or Excalidraw's bindings own them.
 * - `mergeNewerSketchElements()`: how a mounted view takes a change the
 *   session made without it (an agent write), keeping whatever is newer.
 *
 * Bundled into the renderer and the CLI: no Electron or Node imports.
 */

import type { SketchWireElement } from './payloads';

/**
 * The fields that carry text an agent writes (spec section 8.2, I2): element
 * `text` and `originalText`, a frame's `name`, and `link`. They are found at
 * any depth, so a skeleton's `label.text` and an arrow end's `text` count.
 */
export const SKETCH_OUTBOUND_TEXT_KEYS: ReadonlySet<string> = new Set([
	'text',
	'originalText',
	'name',
	'link',
]);

/** Deeper than any skeleton nests; past it the walk refuses rather than recursing. */
const MAX_OUTBOUND_DEPTH = 32;

function walkOutboundTexts(
	value: unknown,
	visit: (text: string) => string,
	depth: number
): unknown {
	if (depth > MAX_OUTBOUND_DEPTH) {
		throw new Error('Sketch Book: the element description is nested too deeply.');
	}
	if (Array.isArray(value)) return value.map((item) => walkOutboundTexts(item, visit, depth + 1));
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) {
		out[key] =
			typeof field === 'string' && SKETCH_OUTBOUND_TEXT_KEYS.has(key)
				? visit(field)
				: walkOutboundTexts(field, visit, depth + 1);
	}
	return out;
}

/** Every outbound text in `value`, in walk order. */
export function collectSketchOutboundTexts(value: unknown): string[] {
	const texts: string[] = [];
	walkOutboundTexts(
		value,
		(text) => {
			texts.push(text);
			return text;
		},
		0
	);
	return texts;
}

/**
 * A copy of `value` with its outbound texts replaced by `texts`, in the order
 * `collectSketchOutboundTexts()` listed them. Throws when the counts differ.
 */
export function replaceSketchOutboundTexts<T>(value: T, texts: readonly string[]): T {
	let index = 0;
	const replaced = walkOutboundTexts(
		value,
		() => {
			if (index >= texts.length) throw new Error('Sketch Book: outbound text count mismatch.');
			return texts[index++];
		},
		0
	) as T;
	if (index !== texts.length) throw new Error('Sketch Book: outbound text count mismatch.');
	return replaced;
}

/**
 * Fields a `sketch_update_elements` patch may not set. Identity, version and
 * order belong to Excalidraw, the stamp to the session (spec section 7), the
 * tombstone to `sketch_delete_elements`, and the bindings to Excalidraw's own
 * bookkeeping, which a hand-set value would break.
 */
export const SKETCH_PATCH_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
	'id',
	'type',
	'version',
	'versionNonce',
	'updated',
	'index',
	'isDeleted',
	'customData',
	'boundElements',
	'containerId',
]);

/** The forbidden keys a patch names, sorted. Empty when the patch is allowed. */
export function forbiddenSketchPatchKeys(props: Readonly<Record<string, unknown>>): string[] {
	return Object.keys(props)
		.filter((key) => SKETCH_PATCH_FORBIDDEN_KEYS.has(key))
		.sort();
}

/**
 * The view's elements after taking `incoming`: an element keeps the view's
 * copy unless `incoming` has a newer version of it, and an element only
 * `incoming` holds is appended (a copy, since Excalidraw mutates in place).
 * Order follows the view, so nothing the user is looking at jumps.
 */
export function mergeNewerSketchElements(
	current: readonly SketchWireElement[],
	incoming: readonly SketchWireElement[]
): SketchWireElement[] {
	const incomingById = new Map(incoming.map((element) => [element.id, element]));
	const seen = new Set<string>();
	const merged = current.map((element) => {
		seen.add(element.id);
		const next = incomingById.get(element.id);
		return next && next.version > element.version ? { ...next } : element;
	});
	for (const element of incoming) {
		if (!seen.has(element.id)) merged.push({ ...element });
	}
	return merged;
}
