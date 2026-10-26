/**
 * Sketch Book live sessions (spec sections 2 and 7): one `SketchSession` per
 * open sketch, keyed by sketch id.
 *
 * The session is the runtime owner of a drawing, not the React tab. Closing,
 * tiling, snoozing or moving the tab only unmounts a view; the scene, the
 * author map and any unsaved change stay here, so the next view picks up
 * exactly where the last one left off. (The room socket and the bot join the
 * session in later phases for the same reason.)
 *
 * - `scene` is the last synced scene: what the store last read or stamped.
 *   `stampLocalEdits()` diffs each Excalidraw change against it by `version`.
 * - `authors` is the author map (`elementId -> ElementAuthorship`). It is kept
 *   from the edits this desktop makes and, later, from incoming ops; never
 *   from `customData`. An element with no entry has an unknown author, which
 *   the gate treats as third-party (spec section 7): a scene loaded from disk
 *   starts with an empty map on purpose.
 * - `dirty` is true while a change has not reached disk. Saves go through
 *   `window.maestro.sketch.writeScene`, one at a time per sketch.
 */

import { create } from 'zustand';
import {
	conductorEditor,
	localConductorActor,
	nextElementAuthorship,
	sketchTextHash,
	stampLocalEdits,
	type AuthorshipUpdate,
	type ElementAuthorship,
	type SketchEditor,
} from '../../shared/sketch/attribution';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type { SketchWireElement } from '../../shared/sketch/payloads';
import type { SketchActor, SketchScene } from '../../shared/sketch/types';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** How long a view waits after the last change before it autosaves. */
export const SKETCH_AUTOSAVE_DEBOUNCE_MS = 1000;

/**
 * The `appState` keys a sketch file keeps: what Excalidraw's own export keeps
 * for the canvas, minus the view (scroll, zoom, selection), which is per user.
 */
export const PERSISTED_SKETCH_APP_STATE_KEYS = [
	'viewBackgroundColor',
	'gridSize',
	'gridStep',
	'gridModeEnabled',
] as const;

/** The persisted part of an Excalidraw `appState`. */
export function pickPersistedAppState(appState: Record<string, unknown>): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of PERSISTED_SKETCH_APP_STATE_KEYS) {
		if (appState[key] !== undefined) picked[key] = appState[key];
	}
	return picked;
}

export type SketchSessionStatus = 'loading' | 'ready' | 'error';

export interface SketchSession {
	sketchId: string;
	status: SketchSessionStatus;
	/** Why the scene could not be read. Set only while `status` is `error`. */
	loadError: string | null;
	/** The last synced scene. Null until the first read finishes. */
	scene: SketchScene | null;
	/** The author map (spec section 7). */
	authors: Record<string, ElementAuthorship>;
	/** A change has not reached disk yet. */
	dirty: boolean;
	/** Bumped on every change, so a save can tell whether it caught up. */
	revision: number;
	/** Why the last save failed, until a save succeeds. */
	saveError: string | null;
}

/** One Excalidraw `onChange`, as the session takes it. */
export interface SketchLocalChange {
	elements: readonly SketchWireElement[];
	/** The full Excalidraw `appState`; only the persisted keys are kept. */
	appState: Record<string, unknown>;
	/** Excalidraw's `BinaryFiles`. */
	files: Record<string, unknown>;
}

export interface SketchLocalChangeResult {
	/** False when nothing the file keeps changed (a pointer move, a selection). */
	changed: boolean;
	/** The stamped copies of the elements this change created, edited or deleted. */
	stamped: SketchWireElement[];
}

interface SketchSessionState {
	sessions: Record<string, SketchSession>;
	/**
	 * Read the sketch's scene into a session. A ready or loading session is
	 * left alone; a failed one is read again.
	 */
	openSketchSession: (sketchId: string) => Promise<void>;
	/**
	 * Fold one local change into the session: stamp what changed (spec
	 * section 7), update the author map, and mark the session dirty.
	 */
	applyLocalChange: (
		sketchId: string,
		change: SketchLocalChange,
		editor?: SketchEditor,
		actor?: SketchActor
	) => SketchLocalChangeResult;
	/** Record a delivered version in the author map. A stale version is ignored. */
	recordAuthorship: (sketchId: string, elementId: string, update: AuthorshipUpdate) => void;
	/** Write the scene to disk now. Saves of one sketch never overlap. */
	saveSketchSession: (sketchId: string) => Promise<void>;
	/** Forget a session (the sketch was deleted). Unsaved changes are dropped. */
	dropSketchSession: (sketchId: string) => void;
}

const saveQueue = createKeyedWriteQueue();

function newSession(sketchId: string): SketchSession {
	return {
		sketchId,
		status: 'loading',
		loadError: null,
		scene: null,
		authors: {},
		dirty: false,
		revision: 0,
		saveError: null,
	};
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key));
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	return sameKeys(a, b) && Object.keys(a).every((key) => a[key] === b[key]);
}

export const useSketchSessionStore = create<SketchSessionState>((set, get) => {
	function patchSession(sketchId: string, patch: (session: SketchSession) => SketchSession) {
		set((state) => {
			const session = state.sessions[sketchId];
			if (!session) return state;
			const next = patch(session);
			return next === session ? state : { sessions: { ...state.sessions, [sketchId]: next } };
		});
	}

	/** Hash each stamped element's text, then record the version it delivered. */
	async function recordLocalAuthorship(
		sketchId: string,
		elements: SketchWireElement[],
		actor: SketchActor
	): Promise<void> {
		const hashes = await Promise.all(elements.map((element) => sketchTextHash(element)));
		elements.forEach((element, index) => {
			get().recordAuthorship(sketchId, element.id, {
				version: element.version,
				actor,
				textHash: hashes[index],
			});
		});
	}

	return {
		sessions: {},

		openSketchSession: async (sketchId) => {
			const existing = get().sessions[sketchId];
			if (existing && existing.status !== 'error') return;
			set((state) => ({ sessions: { ...state.sessions, [sketchId]: newSession(sketchId) } }));
			try {
				const scene = await window.maestro.sketch.readScene(sketchId);
				patchSession(sketchId, (session) => ({ ...session, status: 'ready', scene }));
			} catch (error) {
				patchSession(sketchId, (session) => ({
					...session,
					status: 'error',
					loadError: ipcErrorMessage(error),
				}));
			}
		},

		applyLocalChange: (
			sketchId,
			change,
			editor = conductorEditor(),
			actor = localConductorActor()
		) => {
			const session = get().sessions[sketchId];
			if (!session?.scene) return { changed: false, stamped: [] };
			const scene = session.scene;
			const { elements, changedIds } = stampLocalEdits(
				scene.elements,
				change.elements,
				editor,
				Date.now()
			);
			const appState = pickPersistedAppState(change.appState);
			const sameElements = changedIds.length === 0 && elements.length === scene.elements.length;
			const sameAppState = sameValues(appState, pickPersistedAppState(scene.appState));
			const sameFiles = sameKeys(change.files, scene.files);
			if (sameElements && sameAppState && sameFiles) return { changed: false, stamped: [] };

			const nextScene: SketchScene = {
				...scene,
				elements,
				appState: sameAppState ? scene.appState : { ...scene.appState, ...appState },
				files: sameFiles ? scene.files : { ...change.files },
			};
			patchSession(sketchId, (current) => ({
				...current,
				scene: nextScene,
				dirty: true,
				revision: current.revision + 1,
			}));

			const changed = new Set(changedIds);
			const stamped = elements.filter((element) => changed.has(element.id));
			if (stamped.length > 0) void recordLocalAuthorship(sketchId, stamped, actor);
			return { changed: true, stamped };
		},

		recordAuthorship: (sketchId, elementId, update) => {
			patchSession(sketchId, (session) => {
				const previous = session.authors[elementId];
				if (previous && previous.version >= update.version) return session;
				return {
					...session,
					authors: {
						...session.authors,
						[elementId]: nextElementAuthorship(previous, update),
					},
				};
			});
		},

		saveSketchSession: (sketchId) =>
			saveQueue.enqueue(sketchId, async () => {
				const session = get().sessions[sketchId];
				if (!session?.scene || !session.dirty) return;
				const { scene, revision } = session;
				try {
					await window.maestro.sketch.writeScene(sketchId, scene);
				} catch (error) {
					patchSession(sketchId, (current) => ({
						...current,
						saveError: ipcErrorMessage(error),
					}));
					return;
				}
				patchSession(sketchId, (current) => ({
					...current,
					dirty: current.revision !== revision,
					saveError: null,
				}));
			}),

		dropSketchSession: (sketchId) => {
			set((state) => {
				if (!state.sessions[sketchId]) return state;
				const { [sketchId]: _dropped, ...sessions } = state.sessions;
				return { sessions };
			});
		},
	};
});
