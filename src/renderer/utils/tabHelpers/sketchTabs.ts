import type { SketchTab } from '../../../shared/sketch/types';
import type { Session } from '../../types';
import { generateId } from '../ids';
import { insertAfterActiveInUnifiedTabOrder } from '../unifiedTabOrderUtils';
import { sketchTabFocusFields } from './focusFields';
import { findGroupPaneForTab, groupFocusFields } from './groupFocus';

/** What a sketch tab chip and its tiled pane bar read: the name, or "Sketch Book". */
export function getSketchTabLabel(tab: Pick<SketchTab, 'name'>): string {
	return tab.name.trim() || 'Sketch Book';
}

/** A new tab pointing at `sketchId`. The tab label starts as the sketch's name. */
export function createSketchTab(sketchId: string, name: string): SketchTab {
	return { id: generateId(), sketchId, name, createdAt: Date.now() };
}

export interface OpenSketchTabResult {
	tab: SketchTab;
	session: Session;
	/** False when the sketch already had a tab, which was reused. */
	created: boolean;
}

/**
 * Show a sketch in this agent: reuse the tab already pointing at it, or add
 * one at the user's new-tab placement. One sketch never gets two tabs on the
 * same agent, so two views can never race the same autosave.
 *
 * `background: true` adds the tab without moving the view (spec Q5: an agent
 * or `maestro-cli sketch new` creates a sketch in the background). Otherwise
 * the tab is focused; a tab tiled into a group activates its group and pane.
 */
export function openSketchTab(
	session: Session,
	sketch: { sketchId: string; name: string },
	options: { background?: boolean } = {}
): OpenSketchTabResult {
	const existing = session.sketchTabs?.find((tab) => tab.sketchId === sketch.sketchId);
	const tab = existing ?? createSketchTab(sketch.sketchId, sketch.name);
	let next: Session = existing
		? session
		: {
				...session,
				sketchTabs: [...(session.sketchTabs ?? []), tab],
				unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(session, {
					type: 'sketch',
					id: tab.id,
				}),
			};
	if (!options.background) {
		const pane = findGroupPaneForTab(next, 'sketch', tab.id);
		const group = pane ? next.tabGroups.find((candidate) => candidate.id === pane.groupId) : null;
		next =
			pane && group
				? {
						...next,
						tabGroups: next.tabGroups.map((candidate) =>
							candidate.id === group.id ? { ...candidate, focusedPaneId: pane.leafId } : candidate
						),
						...groupFocusFields({ ...group, focusedPaneId: pane.leafId }),
					}
				: { ...next, ...sketchTabFocusFields(tab.id) };
	}
	return { tab, session: next, created: !existing };
}

/**
 * Rename a sketch tab. The label is the tab's own: the record's name in the
 * sketch store is left alone. An empty name shows the "Sketch Book" fallback
 * (`resolveTabRefTitle()`). Returns the session unchanged for an unknown tab.
 */
export function renameSketchTab(session: Session, tabId: string, name: string): Session {
	if (!session.sketchTabs?.some((tab) => tab.id === tabId)) return session;
	return {
		...session,
		sketchTabs: session.sketchTabs.map((tab) =>
			tab.id === tabId ? { ...tab, name: name.trim() } : tab
		),
	};
}
