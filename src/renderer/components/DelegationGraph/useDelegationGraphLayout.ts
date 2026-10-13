/**
 * useDelegationGraphLayout - one scope's saved arrangement, and the three ways
 * it changes.
 *
 * The record itself lives in the settings store
 * (`settingsDelegationGraphSlice.ts`). This hook is the canvas's view of it:
 * it reads the entry for the scope on screen, and it owns WHEN a change is
 * written, which the store cannot know.
 *
 *   - A drag fires on every mouse move, so its writes are debounced. A write
 *     per event would send the whole record through IPC dozens of times a
 *     second.
 *   - Applying an algorithm and resetting are single, deliberate actions, so
 *     they write at once, and they cancel a drag write that is still waiting.
 *     Otherwise the stale drag would land afterwards and put the scope back on
 *     `manual`.
 *
 * A drag write that is still waiting is flushed when the scope changes and
 * when the canvas unmounts, so switching scope or closing the graph inside the
 * debounce window does not lose the last move.
 */

import { useEffect } from 'react';
import type { DelegationGraphScope } from '../../../shared/delegationGraph';
import {
	prunePositions,
	scopeStorageKey,
	type DelegationSavedPositions,
} from '../../../shared/delegationGraphLayout';
import { useDebouncedCallback } from '../../hooks/utils/useThrottle';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	DEFAULT_DELEGATION_LAYOUT,
	type DelegationAlgorithmLayout,
	type DelegationLayoutType,
} from './delegationLayoutTypes';

/** How long a drag must rest before its positions are written. */
export const DELEGATION_POSITION_SAVE_DEBOUNCE_MS = 300;

/** What a scope with nothing saved reads as. One object, so memo deps stay stable. */
const NO_SAVED_POSITIONS: DelegationSavedPositions = Object.freeze({});

export interface DelegationGraphLayoutControls {
	/** The scope's layout. The default until the user picks one or drags a node. */
	layout: DelegationLayoutType;
	/** Where the user left each agent in this scope. Empty when nothing is saved. */
	positions: DelegationSavedPositions;
	/**
	 * A node was dragged: the scope becomes `manual` and keeps these positions.
	 * Pass EVERY node on the canvas, not only the one that moved. The first drag
	 * is what turns an algorithm's arrangement into a saved one, and a node left
	 * out of it has no saved position on the next open.
	 */
	saveDraggedPositions: (positions: DelegationSavedPositions) => void;
	/** An algorithm was applied: its positions REPLACE everything saved for the scope. */
	saveAlgorithmLayout: (
		layout: DelegationAlgorithmLayout,
		positions: DelegationSavedPositions
	) => void;
	/** Forget the scope's arrangement. It opens on the default layout again. */
	resetLayout: () => void;
}

/**
 * Fold dragged positions into what the scope already has saved, and store the
 * result as `manual`. Reads the store when it RUNS, not when it was scheduled,
 * so a debounced call never writes over a newer record with an older one.
 */
function writeDraggedPositions(
	scope: DelegationGraphScope,
	positions: DelegationSavedPositions
): void {
	const { delegationGraphLayouts, setDelegationScopeLayout } = useSettingsStore.getState();
	const saved = delegationGraphLayouts[scopeStorageKey(scope)]?.positions;
	const liveSessionIds = useSessionStore.getState().sessions.map((session) => session.id);
	setDelegationScopeLayout(scope, {
		layout: 'manual',
		positions: prunePositions({ ...saved, ...positions }, liveSessionIds),
	});
}

export function useDelegationGraphLayout(
	scope: DelegationGraphScope
): DelegationGraphLayoutControls {
	const scopeKey = scopeStorageKey(scope);
	const saved = useSettingsStore((state) => state.delegationGraphLayouts[scopeKey]);

	const { debouncedCallback, flush, cancel } = useDebouncedCallback(
		writeDraggedPositions,
		DELEGATION_POSITION_SAVE_DEBOUNCE_MS,
		{ flushOnUnmount: true }
	);

	// The pending write carries the scope it was made for, so flushing it after
	// the scope has changed still writes to the scope the drag happened in.
	useEffect(() => flush, [scopeKey, flush]);

	const saveDraggedPositions = useStableCallback((positions: DelegationSavedPositions) => {
		const stored = useSettingsStore.getState().delegationGraphLayouts[scopeKey];
		if (stored?.layout !== 'manual') {
			// The first move of a hand arrangement is written at once, so the
			// toolbar reads Manual while the node is still in the user's hand. Every
			// move after it finds `manual` already stored and waits for the debounce.
			cancel();
			writeDraggedPositions(scope, positions);
			return;
		}
		debouncedCallback(scope, positions);
	});

	const saveAlgorithmLayout = useStableCallback(
		(layout: DelegationAlgorithmLayout, positions: DelegationSavedPositions) => {
			cancel();
			useSettingsStore.getState().setDelegationScopeLayout(scope, { layout, positions });
		}
	);

	const resetLayout = useStableCallback(() => {
		cancel();
		useSettingsStore.getState().resetDelegationScopeLayout(scope);
	});

	return {
		layout: saved?.layout ?? DEFAULT_DELEGATION_LAYOUT,
		positions: saved?.positions ?? NO_SAVED_POSITIONS,
		saveDraggedPositions,
		saveAlgorithmLayout,
		resetLayout,
	};
}
