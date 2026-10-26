/**
 * The renderer half of the agent write tools (spec section 4): T5
 * `sketch_add_elements`, T6 `sketch_update_elements`, T7
 * `sketch_delete_elements`, T8 `sketch_from_mermaid`, T11 `sketch_focus` and
 * T12 `sketch_chat_post`.
 *
 * Main has already checked who is calling, that the sketch is theirs, the
 * caps and the rate guard, and has run every outbound text through its
 * screen. What is left needs this window: Excalidraw's converters measure
 * text in a DOM, and the live `SketchSession` lives here.
 *
 * Every scene change goes through `applyAgentChange()`, which stamps it
 * `kind: 'bot'`, `id: 'agent:<agentId>'` (spec section 7), records the agent
 * in the author map, saves, and pushes it to any mounted view. A write that
 * changes nothing makes no version.
 */

import type {
	SketchAgentWrite,
	SketchAgentWriteResult,
	SketchElementPatch,
	SketchElementSkeleton,
} from '../../shared/sketch/commands';
import { sketchSceneVersion } from '../../shared/sketch/agent-view';
import { botActor, type ElementAuthorship } from '../../shared/sketch/attribution';
import type { SketchWireElement } from '../../shared/sketch/payloads';
import {
	openReadySketchSession,
	useSketchSessionStore,
	type SketchAgentIdentity,
} from '../stores/sketchSessionStore';

/** Space between the drawing and a diagram placed below it, in scene pixels. */
export const SKETCH_PLACE_BELOW_GAP = 80;

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');

async function excalidraw(): Promise<ExcalidrawModule> {
	// Imported here so the asset module stays its own lazy chunk (excalidrawAssets.ts).
	const { loadExcalidraw } = await import('../components/SketchBook/excalidrawAssets');
	return loadExcalidraw();
}

/** The fields restoreElements() repairs on a text element after its text changed. */
const TEXT_LAYOUT_FIELDS = ['x', 'y', 'width', 'height', 'text', 'originalText', 'lineHeight'];

function typeOf(element: SketchWireElement): string {
	return String(element.type ?? 'unknown');
}

function liveById(elements: readonly SketchWireElement[]): Map<string, SketchWireElement> {
	const byId = new Map<string, SketchWireElement>();
	for (const element of elements) if (element.isDeleted !== true) byId.set(element.id, element);
	return byId;
}

/** The scene after replacing elements by id, keeping order. */
function replaceById(
	elements: readonly SketchWireElement[],
	replaced: ReadonlyMap<string, SketchWireElement>
): SketchWireElement[] {
	return elements.map((element) => replaced.get(element.id) ?? element);
}

/**
 * Give `added` fractional indices that sort after `current` (Excalidraw's
 * ordering key). `convertToExcalidrawElements` numbers a batch from scratch,
 * and a view would repair the clash with a version bump, which it would then
 * stamp as the conductor's edit. `restoreElements` assigns valid indices to
 * copies; only the new elements are taken from it.
 */
function withAppendedIndices(
	restoreElements: ExcalidrawModule['restoreElements'],
	current: readonly SketchWireElement[],
	added: readonly SketchWireElement[]
): SketchWireElement[] {
	const restored = restoreElements(
		[...current, ...added] as unknown as Parameters<ExcalidrawModule['restoreElements']>[0],
		null
	) as unknown as SketchWireElement[];
	const restoredById = new Map(restored.map((element) => [element.id, element]));
	return added.map((element) => {
		const index = restoredById.get(element.id)?.index;
		return typeof index === 'string' ? { ...element, index } : element;
	});
}

/** Move `added` so its top edge sits below the live drawing. */
function placeBelow(
	module: ExcalidrawModule,
	current: readonly SketchWireElement[],
	added: SketchWireElement[]
): SketchWireElement[] {
	const live = current.filter((element) => element.isDeleted !== true);
	if (live.length === 0 || added.length === 0) return added;
	type Bounded = Parameters<ExcalidrawModule['getCommonBounds']>[0];
	const [sceneMinX, , , sceneMaxY] = module.getCommonBounds(live as unknown as Bounded);
	const [addedMinX, addedMinY] = module.getCommonBounds(added as unknown as Bounded);
	const dx = sceneMinX - addedMinX;
	const dy = sceneMaxY + SKETCH_PLACE_BELOW_GAP - addedMinY;
	return added.map((element) => ({
		...element,
		x: (typeof element.x === 'number' ? element.x : 0) + dx,
		y: (typeof element.y === 'number' ? element.y : 0) + dy,
	}));
}

function writeResult(
	sketchId: string,
	elements: { id: string; type: string }[],
	missing: string[] = [],
	conflicts: SketchWireElement[] = []
): SketchAgentWriteResult {
	const session = useSketchSessionStore.getState().sessions[sketchId];
	const authors: Record<string, ElementAuthorship> = {};
	for (const element of conflicts) {
		const entry = session?.authors[element.id];
		if (entry) authors[element.id] = entry;
	}
	return {
		sceneVersion: sketchSceneVersion(session?.scene?.elements ?? []),
		elements,
		missing,
		conflicts: { elements: conflicts, authors, fileCount: 0 },
	};
}

/** T5 and T8: convert skeletons and append them to the scene. */
async function addElements(
	sketchId: string,
	agent: SketchAgentIdentity,
	write: Extract<SketchAgentWrite, { op: 'add' }>
): Promise<SketchAgentWriteResult> {
	const module = await excalidraw();
	const before = (await openReadySketchSession(sketchId)).scene.elements;
	if (!write.regenerateIds) {
		const taken = new Set(before.map((element) => element.id));
		for (const skeleton of write.skeletons) {
			const id = skeleton.id;
			if (typeof id !== 'string') continue;
			if (taken.has(id)) {
				throw new Error(`An element with the id "${id}" already exists in this sketch.`);
			}
			taken.add(id);
		}
	}
	type Skeletons = Parameters<ExcalidrawModule['convertToExcalidrawElements']>[0];
	let added = module.convertToExcalidrawElements(write.skeletons as unknown as Skeletons, {
		regenerateIds: write.regenerateIds,
	}) as unknown as SketchWireElement[];

	// Read again: the scene may have changed while Excalidraw loaded.
	const current = (await openReadySketchSession(sketchId)).scene.elements;
	if (write.placeBelowScene) added = placeBelow(module, current, added);
	added = withAppendedIndices(module.restoreElements, current, added);
	useSketchSessionStore.getState().applyAgentChange(sketchId, [...current, ...added], agent);
	return writeResult(
		sketchId,
		added.map((element) => ({ id: element.id, type: typeOf(element) }))
	);
}

/** A text element's layout after its text changed, measured by Excalidraw. */
function refreshTextLayout(
	module: ExcalidrawModule,
	element: SketchWireElement,
	container: SketchWireElement | undefined
): SketchWireElement {
	type Restorable = Parameters<ExcalidrawModule['restoreElements']>[0];
	const restored = module.restoreElements(
		(container ? [container, element] : [element]) as unknown as Restorable,
		null,
		{ repairBindings: true, refreshDimensions: true }
	) as unknown as SketchWireElement[];
	const measured = restored.find((candidate) => candidate.id === element.id);
	if (!measured) return element;
	const layout: Record<string, unknown> = {};
	for (const field of TEXT_LAYOUT_FIELDS) {
		if (measured[field] !== undefined) layout[field] = measured[field];
	}
	return { ...element, ...layout };
}

/** T6: patch elements; a stale `baseVersion` refuses that patch alone. */
async function updateElements(
	sketchId: string,
	agent: SketchAgentIdentity,
	patches: readonly SketchElementPatch[]
): Promise<SketchAgentWriteResult> {
	const module = await excalidraw();
	const current = (await openReadySketchSession(sketchId)).scene.elements;
	const byId = liveById(current);
	const updated = new Map<string, SketchWireElement>();
	const missing: string[] = [];
	const conflicts: SketchWireElement[] = [];

	for (const patch of patches) {
		const element = updated.get(patch.id) ?? byId.get(patch.id);
		if (!element) {
			missing.push(patch.id);
			continue;
		}
		const original = byId.get(patch.id) as SketchWireElement;
		if (patch.baseVersion !== undefined && patch.baseVersion !== original.version) {
			conflicts.push(original);
			continue;
		}
		const props: Record<string, unknown> = { ...patch.props };
		const textChanged = typeof props.text === 'string' && props.text !== element.text;
		// The unwrapped text follows the text unless the patch sets it too.
		if (textChanged && props.originalText === undefined) props.originalText = props.text;
		type Element = Parameters<ExcalidrawModule['newElementWith']>[0];
		let next = module.newElementWith(
			element as unknown as Element,
			props as never
		) as unknown as SketchWireElement;
		if (textChanged && next.type === 'text') {
			const containerId = typeof next.containerId === 'string' ? next.containerId : null;
			next = refreshTextLayout(module, next, containerId ? byId.get(containerId) : undefined);
		}
		updated.set(patch.id, next);
	}

	if (updated.size > 0) {
		useSketchSessionStore
			.getState()
			.applyAgentChange(sketchId, replaceById(current, updated), agent);
	}
	return writeResult(
		sketchId,
		[...updated.values()].map((element) => ({ id: element.id, type: typeOf(element) })),
		missing,
		conflicts
	);
}

/** T7: tombstone elements, with the text bound to them, as Excalidraw's own delete does. */
async function deleteElements(
	sketchId: string,
	agent: SketchAgentIdentity,
	ids: readonly string[]
): Promise<SketchAgentWriteResult> {
	const module = await excalidraw();
	const current = (await openReadySketchSession(sketchId)).scene.elements;
	const byId = liveById(current);
	const targets = new Set<string>();
	const missing: string[] = [];
	for (const id of ids) {
		if (byId.has(id)) targets.add(id);
		else missing.push(id);
	}
	for (const element of byId.values()) {
		if (typeof element.containerId === 'string' && targets.has(element.containerId)) {
			targets.add(element.id);
		}
	}
	type Element = Parameters<ExcalidrawModule['newElementWith']>[0];
	const deleted = new Map<string, SketchWireElement>();
	for (const id of targets) {
		const element = byId.get(id) as SketchWireElement;
		deleted.set(
			id,
			module.newElementWith(element as unknown as Element, {
				isDeleted: true,
			}) as unknown as SketchWireElement
		);
	}
	if (deleted.size > 0) {
		useSketchSessionStore
			.getState()
			.applyAgentChange(sketchId, replaceById(current, deleted), agent);
	}
	return writeResult(
		sketchId,
		[...deleted.values()].map((element) => ({ id: element.id, type: typeOf(element) })),
		missing
	);
}

/** T11: ask the views to show these elements. A view scrolls when it is mounted. */
async function focusElements(
	sketchId: string,
	elementIds: readonly string[]
): Promise<SketchAgentWriteResult> {
	const byId = liveById((await openReadySketchSession(sketchId)).scene.elements);
	const found = elementIds.filter((id) => byId.has(id));
	const missing = elementIds.filter((id) => !byId.has(id));
	if (found.length > 0) useSketchSessionStore.getState().requestSketchFocus(sketchId, found);
	return writeResult(
		sketchId,
		found.map((id) => ({ id, type: typeOf(byId.get(id) as SketchWireElement) })),
		missing
	);
}

/** T12: post in the local chat pane as the agent. */
async function postChat(
	sketchId: string,
	agent: SketchAgentIdentity,
	text: string
): Promise<SketchAgentWriteResult> {
	await openReadySketchSession(sketchId);
	useSketchSessionStore
		.getState()
		.postSketchChat(sketchId, { actor: botActor(agent.id, agent.name), text });
	return writeResult(sketchId, []);
}

/** Run one agent write on a live session and report what it did. */
export async function applySketchAgentWrite(
	sketchId: string,
	agent: SketchAgentIdentity,
	write: SketchAgentWrite
): Promise<SketchAgentWriteResult> {
	switch (write.op) {
		case 'add':
			return addElements(sketchId, agent, write);
		case 'update':
			return updateElements(sketchId, agent, write.patches);
		case 'delete':
			return deleteElements(sketchId, agent, write.ids);
		case 'focus':
			return focusElements(sketchId, write.elementIds);
		case 'chat':
			return postChat(sketchId, agent, write.text);
		default:
			throw new Error('Unknown Sketch Book write.');
	}
}

/**
 * T8, first half: Mermaid source to element skeletons, through
 * `@excalidraw/mermaid-to-excalidraw`. Main screens their text and adds them
 * the T5 way. A diagram type the converter can only draw as a picture is
 * refused: an image cannot be screened or edited.
 */
export async function convertMermaidToSkeletons(mermaid: string): Promise<SketchElementSkeleton[]> {
	const { loadMermaidToExcalidraw } = await import('../components/SketchBook/excalidrawAssets');
	const { parseMermaidToExcalidraw } = await loadMermaidToExcalidraw();
	const { elements, files } = await parseMermaidToExcalidraw(mermaid);
	if (files && Object.keys(files).length > 0) {
		throw new Error(
			'This Mermaid diagram type converts only to an image. Use a flowchart, sequence or class diagram.'
		);
	}
	return elements as unknown as SketchElementSkeleton[];
}
