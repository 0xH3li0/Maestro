/**
 * What an agent sees of a sketch: the views behind the read tools T1, T3 and
 * T4 (spec section 4) and the change digest (digest.ts).
 *
 * Two rules shape every view here:
 *
 * - Authorship comes from the session's author map (spec section 7), never
 *   from `customData`, which any client can forge. `customData` is stripped
 *   from every element an agent receives. An element whose current version
 *   has no author map entry has an unknown author.
 * - Third-party text is gated (spec section 8). An element is third-party when
 *   a guest has ever written its text (`guestTouched`) or its author is
 *   unknown. The caller screens those (`screenForAgent()` in main) and passes
 *   the withheld ids in; a withheld element is reduced to
 *   `{id, type, author, withheld}`, and its text never reaches another field
 *   either: a container it labels gets `labelWithheld`, and an arrow bound to
 *   it names it `type#id-prefix`.
 *
 * Pure, so the tools, the bot relay and the tests share it. Bundled into the
 * renderer and the CLI: no Electron or Node imports.
 */

import type { ElementAuthorship } from './attribution';
import {
	SKETCH_CONNECTOR_TYPES,
	sketchAnonymousName,
	sketchBoundElementId,
	sketchNumberField,
	sketchStringField,
} from './commands';
import type { SketchWireElement } from './payloads';
import type { SketchActorKind, WithheldReason } from './types';

/** Most freedraw points an element keeps in an agent read (spec section 4, T3). */
export const SKETCH_MAX_FREEDRAW_POINTS = 200;

/** Frame element types. A frame's `name` is screened text (spec section 8.2, I2). */
const FRAME_TYPES: ReadonlySet<string> = new Set(['frame', 'magicframe']);

/** Who wrote an element version, as an agent sees it: the envelope actor, without its cap. */
export interface SketchAuthor {
	id: string;
	kind: SketchActorKind;
	name: string;
}

/** Ids of the elements the gate withheld, with the reason (spec section 8.3 rule 5). */
export type SketchWithheldMap = ReadonlyMap<string, WithheldReason>;

/**
 * Excalidraw's scene version (`getSceneVersion`): the sum of every element's
 * `version`, deleted ones included. It only grows, and it is saved with the
 * file, so it means the same thing after a restart.
 */
export function sketchSceneVersion(elements: readonly SketchWireElement[]): number {
	let sum = 0;
	for (const element of elements) sum += element.version;
	return sum;
}

/** Each element's id and version: the baseline `sketch_changes` diffs against. */
export function sketchVersionMap(elements: readonly SketchWireElement[]): Record<string, number> {
	const versions: Record<string, number> = {};
	for (const element of elements) versions[element.id] = element.version;
	return versions;
}

/**
 * The author map entry for the element's CURRENT version, or null. An entry
 * for an older version does not name who wrote this one, so it is unknown.
 */
export function currentAuthorship(
	element: SketchWireElement,
	authors: Readonly<Record<string, ElementAuthorship>>
): ElementAuthorship | null {
	const entry = authors[element.id];
	return entry && entry.version === element.version ? entry : null;
}

/** The author of the element's current version, or null when unknown. */
export function sketchElementAuthor(
	element: SketchWireElement,
	authors: Readonly<Record<string, ElementAuthorship>>
): SketchAuthor | null {
	const entry = currentAuthorship(element, authors);
	if (!entry) return null;
	return { id: entry.actor.id, kind: entry.actor.kind, name: entry.actor.name };
}

/**
 * True when the gate must screen the element (spec section 8.2, I2): a guest
 * has written its text, or its current version has no known author.
 */
export function isThirdPartyElement(
	element: SketchWireElement,
	authors: Readonly<Record<string, ElementAuthorship>>
): boolean {
	const entry = currentAuthorship(element, authors);
	return !entry || entry.guestTouched;
}

/** A scene-coordinate box (`sketch_read_scene.bbox`). */
export interface SketchBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What a read covers: every live element, or only the named ones, or those in a box. */
export interface SketchReadScope {
	elementIds?: readonly string[];
	bbox?: SketchBox;
}

/** The box an element covers, from its position and size, or its points for a line. */
function elementBounds(element: SketchWireElement) {
	const x = sketchNumberField(element, 'x');
	const y = sketchNumberField(element, 'y');
	const width = sketchNumberField(element, 'width');
	const height = sketchNumberField(element, 'height');
	let minX = Math.min(x, x + width);
	let minY = Math.min(y, y + height);
	let maxX = Math.max(x, x + width);
	let maxY = Math.max(y, y + height);
	if (Array.isArray(element.points)) {
		for (const point of element.points) {
			if (!Array.isArray(point)) continue;
			const [px, py] = point;
			if (typeof px !== 'number' || typeof py !== 'number') continue;
			minX = Math.min(minX, x + px);
			minY = Math.min(minY, y + py);
			maxX = Math.max(maxX, x + px);
			maxY = Math.max(maxY, y + py);
		}
	}
	return { minX, minY, maxX, maxY };
}

function intersects(element: SketchWireElement, box: SketchBox): boolean {
	const bounds = elementBounds(element);
	return (
		bounds.maxX >= box.x &&
		bounds.minX <= box.x + box.width &&
		bounds.maxY >= box.y &&
		bounds.minY <= box.y + box.height
	);
}

/** The live elements a read covers, in scene order. Both filters apply when both are set. */
export function selectSketchElements(
	elements: readonly SketchWireElement[],
	scope: SketchReadScope = {}
): SketchWireElement[] {
	const ids = scope.elementIds ? new Set(scope.elementIds) : null;
	return elements.filter(
		(element) =>
			element.isDeleted !== true &&
			(!ids || ids.has(element.id)) &&
			(!scope.bbox || intersects(element, scope.bbox))
	);
}

/** The live scene as the views look it up: elements by id and bound text by container. */
interface SceneIndex {
	byId: Map<string, SketchWireElement>;
	/** Container id -> the live text element bound to it. */
	boundText: Map<string, SketchWireElement>;
}

function indexScene(elements: readonly SketchWireElement[]): SceneIndex {
	const byId = new Map<string, SketchWireElement>();
	for (const element of elements) {
		if (element.isDeleted !== true) byId.set(element.id, element);
	}
	const boundText = new Map<string, SketchWireElement>();
	for (const element of byId.values()) {
		const containerId = sketchStringField(element, 'containerId');
		if (element.type === 'text' && containerId && byId.has(containerId)) {
			boundText.set(containerId, element);
		}
	}
	return { byId, boundText };
}

/**
 * The ids the gate must decide before a view of `selected` can be built: the
 * selected elements, the text bound to them, and the shapes their arrows end
 * at (with those shapes' bound text), since a label or an end name reads text
 * from each. Only third-party ones are returned; the rest skip the gate.
 */
export function sketchElementsToScreen(
	elements: readonly SketchWireElement[],
	selected: readonly SketchWireElement[],
	authors: Readonly<Record<string, ElementAuthorship>>
): SketchWireElement[] {
	const { byId, boundText } = indexScene(elements);
	const needed = new Map<string, SketchWireElement>();
	const add = (element: SketchWireElement | undefined) => {
		if (!element || needed.has(element.id)) return;
		needed.set(element.id, element);
		const label = boundText.get(element.id);
		if (label) needed.set(label.id, label);
	};
	for (const element of selected) {
		add(element);
		if (SKETCH_CONNECTOR_TYPES.has(String(element.type))) {
			for (const field of ['startBinding', 'endBinding']) {
				const endId = sketchBoundElementId(element, field);
				if (endId) add(byId.get(endId));
			}
		}
	}
	return [...needed.values()].filter((element) => isThirdPartyElement(element, authors));
}

/** An element's readable text: the unwrapped `originalText` when it has one. */
function readableText(element: SketchWireElement): string | undefined {
	return sketchStringField(element, 'originalText') ?? sketchStringField(element, 'text');
}

/** A label, or the reason it was withheld. Empty when the element has none. */
interface LabelState {
	label?: string;
	labelWithheld?: WithheldReason;
}

function createViewHelpers(elements: readonly SketchWireElement[], withheld: SketchWithheldMap) {
	const index = indexScene(elements);

	const labelOf = (element: SketchWireElement): LabelState => {
		const bound = index.boundText.get(element.id);
		if (bound) {
			const reason = withheld.get(bound.id);
			if (reason) return { labelWithheld: reason };
			const label = readableText(bound);
			return label ? { label } : {};
		}
		if (element.type !== 'text' || withheld.has(element.id)) return {};
		const label = readableText(element);
		return label ? { label } : {};
	};

	/** The name an arrow end shows: the shape's label, or `type#id-prefix`. */
	const endName = (id: string | null): string | null => {
		if (!id) return null;
		const end = index.byId.get(id);
		if (!end) return null;
		if (withheld.has(end.id)) return sketchAnonymousName(end);
		return labelOf(end).label ?? sketchAnonymousName(end);
	};

	return { index, labelOf, endName };
}

/** A shape (or text, image, freedraw) in a summary. */
export interface SketchAgentShape extends LabelState {
	id: string;
	type: string;
	author: SketchAuthor | null;
	withheld?: WithheldReason;
	frameId?: string;
	groupIds?: string[];
}

/** An arrow or line in a summary, with its ends as `A -> B`. */
export interface SketchAgentConnection extends SketchAgentShape {
	from: string | null;
	to: string | null;
	/** `from -> to`; a loose end reads `?`. */
	edge: string;
}

/** A frame in a summary, with the elements inside it. */
export interface SketchAgentFrame {
	id: string;
	type: string;
	author: SketchAuthor | null;
	name?: string;
	withheld?: WithheldReason;
	elementIds: string[];
}

/** A group in a summary. Its members are the elements in view that carry its id. */
export interface SketchAgentGroup {
	id: string;
	elementIds: string[];
}

/** `sketch_read_scene` with `format: 'summary'`. */
export interface SketchAgentSummary {
	elementCount: number;
	byType: Record<string, number>;
	shapes: SketchAgentShape[];
	connections: SketchAgentConnection[];
	frames: SketchAgentFrame[];
	groups: SketchAgentGroup[];
	bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

function groupIdsOf(element: SketchWireElement): string[] {
	return Array.isArray(element.groupIds)
		? element.groupIds.filter((id): id is string => typeof id === 'string')
		: [];
}

/**
 * The summary of `selected`: bound text folded into its container, arrows as
 * `A -> B`, frames with their members, groups with theirs. `elements` is the
 * whole scene, so labels and arrow ends resolve outside the selection too.
 */
export function buildSketchAgentSummary(
	elements: readonly SketchWireElement[],
	selected: readonly SketchWireElement[],
	authors: Readonly<Record<string, ElementAuthorship>>,
	withheld: SketchWithheldMap
): SketchAgentSummary {
	const { index, labelOf, endName } = createViewHelpers(elements, withheld);
	const byType: Record<string, number> = {};
	const shapes: SketchAgentShape[] = [];
	const connections: SketchAgentConnection[] = [];
	const frames: SketchAgentFrame[] = [];
	const frameMembers = new Map<string, string[]>();
	const groups = new Map<string, string[]>();
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const element of selected) {
		const type = String(element.type ?? 'unknown');
		byType[type] = (byType[type] ?? 0) + 1;
		const bounds = elementBounds(element);
		minX = Math.min(minX, bounds.minX);
		minY = Math.min(minY, bounds.minY);
		maxX = Math.max(maxX, bounds.maxX);
		maxY = Math.max(maxY, bounds.maxY);

		const author = sketchElementAuthor(element, authors);
		const reason = withheld.get(element.id);
		const frameId = sketchStringField(element, 'frameId');
		const groupIds = groupIdsOf(element);
		if (frameId) frameMembers.set(frameId, [...(frameMembers.get(frameId) ?? []), element.id]);
		for (const groupId of groupIds)
			groups.set(groupId, [...(groups.get(groupId) ?? []), element.id]);

		if (FRAME_TYPES.has(type)) {
			const name = reason ? undefined : sketchStringField(element, 'name');
			frames.push({
				id: element.id,
				type,
				author,
				...(name ? { name } : {}),
				...(reason ? { withheld: reason } : {}),
				elementIds: [],
			});
			continue;
		}
		// Bound text is already its container's label.
		const containerId = sketchStringField(element, 'containerId');
		if (type === 'text' && containerId && index.byId.has(containerId)) continue;

		const base: SketchAgentShape = {
			id: element.id,
			type,
			author,
			...(reason ? { withheld: reason } : labelOf(element)),
			...(frameId ? { frameId } : {}),
			...(groupIds.length > 0 ? { groupIds } : {}),
		};
		if (SKETCH_CONNECTOR_TYPES.has(type)) {
			const from = endName(sketchBoundElementId(element, 'startBinding'));
			const to = endName(sketchBoundElementId(element, 'endBinding'));
			connections.push({ ...base, from, to, edge: `${from ?? '?'} -> ${to ?? '?'}` });
			continue;
		}
		shapes.push(base);
	}

	for (const frame of frames) frame.elementIds = frameMembers.get(frame.id) ?? [];

	return {
		elementCount: selected.length,
		byType,
		shapes,
		connections,
		frames,
		groups: [...groups].map(([id, elementIds]) => ({ id, elementIds })),
		bounds: selected.length > 0 ? { minX, minY, maxX, maxY } : null,
	};
}

/** A withheld element in `format: 'elements'`: no text, no geometry. */
export interface SketchWithheldElement {
	id: string;
	type: string;
	author: SketchAuthor | null;
	withheld: WithheldReason;
}

/** An element in `format: 'elements'`: Excalidraw's own fields, without `customData`. */
export type SketchAgentElement =
	| SketchWithheldElement
	| (SketchWireElement & { author: SketchAuthor | null });

/** Every `step`-th item of `values`, keeping the first and the last, at most `max` long. */
function evenSample<T>(values: readonly T[], max: number): T[] {
	if (values.length <= max) return [...values];
	const sampled: T[] = [];
	const step = (values.length - 1) / (max - 1);
	for (let index = 0; index < max; index += 1) sampled.push(values[Math.round(index * step)]);
	return sampled;
}

/** A freedraw element with at most `SKETCH_MAX_FREEDRAW_POINTS` points (and pressures). */
function capFreedrawPoints(element: SketchWireElement): SketchWireElement {
	const points = element.points;
	if (
		element.type !== 'freedraw' ||
		!Array.isArray(points) ||
		points.length <= SKETCH_MAX_FREEDRAW_POINTS
	) {
		return element;
	}
	const capped: SketchWireElement = {
		...element,
		points: evenSample(points, SKETCH_MAX_FREEDRAW_POINTS),
		pointCount: points.length,
		pointsCapped: true,
	};
	const pressures = element.pressures;
	if (Array.isArray(pressures) && pressures.length === points.length) {
		capped.pressures = evenSample(pressures, SKETCH_MAX_FREEDRAW_POINTS);
	} else {
		delete capped.pressures;
	}
	return capped;
}

/** `selected` as an agent receives them in `format: 'elements'`. */
export function buildSketchAgentElements(
	selected: readonly SketchWireElement[],
	authors: Readonly<Record<string, ElementAuthorship>>,
	withheld: SketchWithheldMap
): SketchAgentElement[] {
	return selected.map((element) => {
		const author = sketchElementAuthor(element, authors);
		const reason = withheld.get(element.id);
		if (reason)
			return { id: element.id, type: String(element.type ?? 'unknown'), author, withheld: reason };
		const { customData: _forgeable, ...rest } = capFreedrawPoints(element);
		return { ...rest, id: element.id, version: element.version, author };
	});
}

/** One element in `sketch_changes`. */
export interface SketchChangeEntry extends LabelState {
	id: string;
	type: string;
	/** The author of the element's current version (the deleter, for a deletion). */
	lastEditedBy: SketchAuthor | null;
	withheld?: WithheldReason;
}

/** `sketch_changes`: what changed since a scene version. */
export interface SketchChangeSet {
	sinceVersion: number;
	sceneVersion: number;
	/**
	 * `known`: diffed against what the scene held at `sinceVersion`. `unknown`:
	 * no read at that version is on record (an app restart, a guessed number),
	 * so every live element is listed as added.
	 */
	baseline: 'known' | 'unknown';
	added: SketchChangeEntry[];
	updated: SketchChangeEntry[];
	deleted: SketchChangeEntry[];
}

/** The elements that changed against a baseline, by kind of change. */
export interface SketchElementDiff {
	added: SketchWireElement[];
	updated: SketchWireElement[];
	deleted: SketchWireElement[];
}

/**
 * Diff the scene against a baseline version map. A null baseline lists every
 * live element as added. An element created and deleted since the baseline
 * never existed for the reader, so it is left out.
 */
export function diffSketchElements(
	baseline: Readonly<Record<string, number>> | null,
	elements: readonly SketchWireElement[]
): SketchElementDiff {
	const diff: SketchElementDiff = { added: [], updated: [], deleted: [] };
	for (const element of elements) {
		const deleted = element.isDeleted === true;
		if (!baseline) {
			if (!deleted) diff.added.push(element);
			continue;
		}
		const previous = baseline[element.id];
		if (previous === undefined) {
			if (!deleted) diff.added.push(element);
		} else if (element.version > previous) {
			(deleted ? diff.deleted : diff.updated).push(element);
		}
	}
	return diff;
}

/** The change entries for a diff. Deletions carry no label: the text is gone with them. */
export function buildSketchChangeEntries(
	elements: readonly SketchWireElement[],
	diff: SketchElementDiff,
	authors: Readonly<Record<string, ElementAuthorship>>,
	withheld: SketchWithheldMap
): Pick<SketchChangeSet, 'added' | 'updated' | 'deleted'> {
	const { labelOf } = createViewHelpers(elements, withheld);
	const entry = (element: SketchWireElement, withLabel: boolean): SketchChangeEntry => {
		const reason = withheld.get(element.id);
		return {
			id: element.id,
			type: String(element.type ?? 'unknown'),
			lastEditedBy: sketchElementAuthor(element, authors),
			...(reason ? { withheld: reason } : withLabel ? labelOf(element) : {}),
		};
	};
	return {
		added: diff.added.map((element) => entry(element, true)),
		updated: diff.updated.map((element) => entry(element, true)),
		deleted: diff.deleted.map((element) => entry(element, false)),
	};
}
