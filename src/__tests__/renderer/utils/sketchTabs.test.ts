/**
 * Tests for the Sketch Book tab type (spec section 3): creating, focusing,
 * closing, reopening, tiling and snoozing a `sketch` tab through the shared
 * tab helpers, plus the strip-level helpers that must know the kind.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session, UnifiedTabRef } from '../../../renderer/types';
import {
	aiTabFocusFields,
	browserTabFocusFields,
	buildUnifiedTabs,
	closeFileTab,
	closeSketchTab,
	createSketchTab,
	getRepairedUnifiedTabOrder,
	getSketchTabLabel,
	navigateToUnifiedTabByIndex,
	openSketchTab,
	renameSketchTab,
	reopenUnifiedClosedTab,
	setActiveTab,
	sketchTabFocusFields,
	standaloneFocusPatch,
} from '../../../renderer/utils/tabHelpers';
import {
	agentHasVisibleTab,
	findActiveUnifiedTabIndex,
} from '../../../renderer/utils/unifiedTabOrderUtils';
import {
	createGroupFromTabRefs,
	normalizeTabGroups,
	resolveSingleViewTabRef,
	resolveTabRefRenameValue,
	resolveTabRefTitle,
	tileTabIntoGroup,
} from '../../../renderer/utils/panelLayout';
import { snoozeTab, wakeSnoozedTab } from '../../../renderer/utils/snoozeHelpers';
import { isUnifiedTabActive } from '../../../renderer/components/TabBar/tabBarUtils';
import { snoozedEntryLabel } from '../../../shared/snooze';
import { projectClosedTabHistory } from '../../../shared/closedTabHistory';
import { createMockAITab, createMockFileTab, createMockSketchTab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

const ai = createMockAITab({ id: 'ai-1' });
const sketch = createMockSketchTab({ id: 'sk-1', sketchId: 'sketch-a', name: 'Plan' });

/** An agent with one AI tab and one sketch tab, AI tab on screen. */
function sessionWithSketch(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		aiTabs: [ai],
		activeTabId: ai.id,
		sketchTabs: [sketch],
		activeSketchTabId: null,
		unifiedTabOrder: [
			{ type: 'ai', id: ai.id },
			{ type: 'sketch', id: sketch.id },
		],
		...overrides,
	});
}

beforeEach(() => {
	useSettingsStore.setState({ newTabPlacement: 'end' });
});

describe('createSketchTab', () => {
	it('points a fresh tab at the sketch and labels it with the sketch name', () => {
		const tab = createSketchTab('sketch-b', 'Roadmap');
		expect(tab.sketchId).toBe('sketch-b');
		expect(tab.name).toBe('Roadmap');
		expect(tab.id).toBeTruthy();
		expect(typeof tab.createdAt).toBe('number');
	});

	it('gives each tab its own id', () => {
		expect(createSketchTab('s', 'a').id).not.toBe(createSketchTab('s', 'a').id);
	});
});

describe('openSketchTab', () => {
	it('adds the tab to the strip and lands on it', () => {
		const session = createMockSession({
			aiTabs: [ai],
			activeTabId: ai.id,
			activeFileTabId: 'stale-file',
			unifiedTabOrder: [{ type: 'ai', id: ai.id }],
		});
		const result = openSketchTab(session, { sketchId: 'sketch-b', name: 'Roadmap' });

		expect(result.created).toBe(true);
		expect(result.session.sketchTabs).toEqual([result.tab]);
		expect(result.session.unifiedTabOrder).toEqual([
			{ type: 'ai', id: ai.id },
			{ type: 'sketch', id: result.tab.id },
		]);
		expect(result.session.activeSketchTabId).toBe(result.tab.id);
		expect(result.session.activeFileTabId).toBeNull();
		expect(result.session.inputMode).toBe('ai');
		expect(resolveSingleViewTabRef(result.session)).toEqual({
			type: 'sketch',
			id: result.tab.id,
		});
	});

	it('in the background, adds the tab without moving the view (spec Q5)', () => {
		const session = createMockSession({
			aiTabs: [ai],
			activeTabId: ai.id,
			unifiedTabOrder: [{ type: 'ai', id: ai.id }],
		});
		const result = openSketchTab(
			session,
			{ sketchId: 'sketch-b', name: 'Roadmap' },
			{ background: true }
		);

		expect(result.session.sketchTabs).toHaveLength(1);
		expect(result.session.activeSketchTabId).toBeUndefined();
		expect(resolveSingleViewTabRef(result.session)).toEqual({ type: 'ai', id: ai.id });
	});

	it('reuses the tab already pointing at the sketch', () => {
		const result = openSketchTab(sessionWithSketch(), { sketchId: 'sketch-a', name: 'Plan' });

		expect(result.created).toBe(false);
		expect(result.tab.id).toBe(sketch.id);
		expect(result.session.sketchTabs).toHaveLength(1);
		expect(result.session.activeSketchTabId).toBe(sketch.id);
	});

	it('opens a tiled sketch by activating its group on its pane', () => {
		const group = createGroupFromTabRefs(
			[
				{ type: 'ai', id: ai.id },
				{ type: 'sketch', id: sketch.id },
			],
			'Pair'
		);
		const session = sessionWithSketch({
			tabGroups: [group],
			unifiedTabOrder: [{ type: 'group', id: group.id }],
		});
		const result = openSketchTab(session, { sketchId: 'sketch-a', name: 'Plan' });
		const layout = result.session.tabGroups[0].layout;
		const sketchLeaf =
			layout.kind === 'split'
				? layout.children.find((c) => c.kind === 'leaf' && c.tab.type === 'sketch')
				: undefined;

		expect(result.session.activeGroupId).toBe(group.id);
		expect(result.session.tabGroups[0].focusedPaneId).toBe(sketchLeaf?.id);
		expect(result.session.activeSketchTabId).toBeNull();
	});
});

describe('focusing a sketch tab', () => {
	it('sketchTabFocusFields clears every selection that outranks a sketch', () => {
		expect(sketchTabFocusFields('sk-1')).toEqual({
			activeSketchTabId: 'sk-1',
			activeBrowserTabId: null,
			activeFileTabId: null,
			activeTerminalTabId: null,
			inputMode: 'ai',
			activeGroupId: null,
		});
	});

	it('every other focus helper clears the sketch selection', () => {
		expect(aiTabFocusFields('ai-1').activeSketchTabId).toBeNull();
		expect(browserTabFocusFields('b-1').activeSketchTabId).toBeNull();
		expect(standaloneFocusPatch({ type: 'file', id: 'f-1' }).activeSketchTabId).toBeNull();
		expect(standaloneFocusPatch({ type: 'sketch', id: 'sk-1' })).toMatchObject({
			activeSketchTabId: 'sk-1',
			activeBrowserTabId: null,
			inputMode: 'ai',
		});
	});

	it('ranks below browser and above the AI tab', () => {
		const order = getRepairedUnifiedTabOrder(sessionWithSketch());
		const onSketch = sessionWithSketch({ activeSketchTabId: sketch.id });
		expect(findActiveUnifiedTabIndex(onSketch, order)).toBe(1);
		expect(resolveSingleViewTabRef(onSketch)).toEqual({ type: 'sketch', id: sketch.id });
		expect(resolveSingleViewTabRef({ ...onSketch, activeBrowserTabId: 'b-1' })?.type).toBe(
			'browser'
		);
	});

	it('Cmd+N navigation lands on a sketch and back to the AI tab', () => {
		const onSketch = navigateToUnifiedTabByIndex(sessionWithSketch(), 1);
		expect(onSketch?.type).toBe('sketch');
		expect(onSketch?.session.activeSketchTabId).toBe(sketch.id);

		const back = navigateToUnifiedTabByIndex(onSketch!.session, 0);
		expect(back?.type).toBe('ai');
		expect(back?.session.activeSketchTabId).toBeNull();
	});

	it('selecting the already-active AI tab still clears a sketch selection', () => {
		const result = setActiveTab(sessionWithSketch({ activeSketchTabId: sketch.id }), ai.id);
		expect(result?.session.activeSketchTabId).toBeNull();
	});

	it('the strip shows the sketch chip, and only it as active', () => {
		const session = sessionWithSketch({ activeSketchTabId: sketch.id });
		const tabs = buildUnifiedTabs(session);
		expect(tabs.map((t) => t.type)).toEqual(['ai', 'sketch']);
		const active = tabs.map((t) =>
			isUnifiedTabActive(t, ai.id, null, null, null, 'ai', null, session.activeSketchTabId)
		);
		expect(active).toEqual([false, true]);
	});
});

describe('the strip order', () => {
	it('appends a sketch tab missing from the order and drops a dead sketch ref', () => {
		const session = sessionWithSketch({
			unifiedTabOrder: [
				{ type: 'ai', id: ai.id },
				{ type: 'sketch', id: 'gone' },
			],
		});
		expect(getRepairedUnifiedTabOrder(session)).toEqual([
			{ type: 'ai', id: ai.id },
			{ type: 'sketch', id: sketch.id },
		]);
	});

	it('a lone sketch tab counts as a visible tab', () => {
		expect(agentHasVisibleTab(createMockSession({ sketchTabs: [sketch], aiTabs: [] }))).toBe(true);
	});
});

describe('closeSketchTab', () => {
	it('removes the tab, records it for reopen, and hands the view to the left neighbor', () => {
		const session = sessionWithSketch({ activeSketchTabId: sketch.id });
		const result = closeSketchTab(session, sketch.id);

		expect(result?.session.sketchTabs).toEqual([]);
		expect(result?.session.unifiedTabOrder).toEqual([{ type: 'ai', id: ai.id }]);
		expect(result?.session.activeSketchTabId).toBeNull();
		expect(result?.session.activeTabId).toBe(ai.id);
		expect(result?.closedTabEntry).toMatchObject({ type: 'sketch', unifiedIndex: 1 });
		expect(result?.session.unifiedClosedTabHistory[0]).toBe(result?.closedTabEntry);
	});

	it('leaves the view alone when the closed sketch was not on screen', () => {
		const session = sessionWithSketch();
		const result = closeSketchTab(session, sketch.id);
		expect(result?.session.activeTabId).toBe(ai.id);
		expect(result?.session.activeSketchTabId).toBeNull();
		expect(resolveSingleViewTabRef(result!.session)).toEqual({ type: 'ai', id: ai.id });
	});

	it('mints a blank AI tab when the sketch was the last tab', () => {
		const session = createMockSession({
			sketchTabs: [sketch],
			activeSketchTabId: sketch.id,
			unifiedTabOrder: [{ type: 'sketch', id: sketch.id }],
		});
		const result = closeSketchTab(session, sketch.id);
		expect(result?.session.aiTabs).toHaveLength(1);
		expect(result?.session.activeTabId).toBe(result?.session.aiTabs[0].id);
		expect(result?.session.activeSketchTabId).toBeNull();
	});

	it('answers null for an unknown tab', () => {
		expect(closeSketchTab(sessionWithSketch(), 'nope')).toBeNull();
	});

	it('closing the active file tab can hand the view to a sketch neighbor', () => {
		const file = createMockFileTab({ id: 'f-1' });
		const session = sessionWithSketch({
			filePreviewTabs: [file],
			activeFileTabId: file.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai.id },
				{ type: 'sketch', id: sketch.id },
				{ type: 'file', id: file.id },
			],
		});
		const result = closeFileTab(session, file.id);
		expect(result?.session.activeFileTabId).toBeNull();
		expect(result?.session.activeSketchTabId).toBe(sketch.id);
		expect(resolveSingleViewTabRef(result!.session)).toEqual({ type: 'sketch', id: sketch.id });
	});
});

describe('reopening a closed sketch tab', () => {
	it('brings the tab back in its slot under a new id, on screen', () => {
		const closed = closeSketchTab(sessionWithSketch({ activeSketchTabId: sketch.id }), sketch.id)!;
		const reopened = reopenUnifiedClosedTab(closed.session);

		expect(reopened?.tabType).toBe('sketch');
		expect(reopened?.wasDuplicate).toBe(false);
		expect(reopened?.tabId).not.toBe(sketch.id);
		expect(reopened?.session.sketchTabs).toEqual([{ ...sketch, id: reopened?.tabId }]);
		expect(reopened?.session.unifiedTabOrder).toEqual([
			{ type: 'ai', id: ai.id },
			{ type: 'sketch', id: reopened?.tabId },
		]);
		expect(reopened?.session.activeSketchTabId).toBe(reopened?.tabId);
		expect(reopened?.session.unifiedClosedTabHistory).toEqual([]);
	});

	it('focuses the open tab instead of doubling a sketch that is open again', () => {
		const closed = closeSketchTab(sessionWithSketch(), sketch.id)!;
		const reopenedElsewhere = openSketchTab(
			closed.session,
			{ sketchId: sketch.sketchId, name: 'Plan' },
			{ background: true }
		).session;
		const reopened = reopenUnifiedClosedTab(reopenedElsewhere);

		expect(reopened?.wasDuplicate).toBe(true);
		expect(reopened?.session.sketchTabs).toHaveLength(1);
		expect(reopened?.session.activeSketchTabId).toBe(reopened?.tabId);
	});

	it('the closed-tab stack stores a sketch entry as is', () => {
		const closed = closeSketchTab(sessionWithSketch(), sketch.id)!;
		const stored = projectClosedTabHistory(closed.session.unifiedClosedTabHistory, {
			toolType: 'claude-code',
			sshRemote: false,
		});
		expect(stored).toEqual(closed.session.unifiedClosedTabHistory);
	});
});

describe('naming a sketch tab', () => {
	it('renames the tab label only', () => {
		const renamed = renameSketchTab(sessionWithSketch(), sketch.id, '  Sprint board ');
		expect(renamed.sketchTabs?.[0]).toEqual({ ...sketch, name: 'Sprint board' });
		expect(resolveTabRefTitle(renamed, { type: 'sketch', id: sketch.id })).toBe('Sprint board');
		expect(resolveTabRefRenameValue(renamed, { type: 'sketch', id: sketch.id })).toBe(
			'Sprint board'
		);
	});

	it('an empty name falls back to "Sketch Book"', () => {
		const renamed = renameSketchTab(sessionWithSketch(), sketch.id, '   ');
		expect(getSketchTabLabel(renamed.sketchTabs![0])).toBe('Sketch Book');
	});

	it('leaves an unknown tab id alone', () => {
		const session = sessionWithSketch();
		expect(renameSketchTab(session, 'nope', 'x')).toBe(session);
	});
});

describe('tiling a sketch tab', () => {
	it('tiles into a group, leaves the strip, and survives group normalization', () => {
		const file = createMockFileTab({ id: 'f-1' });
		const group = createGroupFromTabRefs(
			[
				{ type: 'ai', id: ai.id },
				{ type: 'file', id: file.id },
			],
			'Pair'
		);
		const session = sessionWithSketch({
			filePreviewTabs: [file],
			tabGroups: [group],
			unifiedTabOrder: [
				{ type: 'group', id: group.id },
				{ type: 'sketch', id: sketch.id },
			],
		});
		const targetLeaf = group.layout.kind === 'split' ? group.layout.children[0].id : '';
		const sketchRef: UnifiedTabRef = { type: 'sketch', id: sketch.id };
		const tiled = tileTabIntoGroup(session, group.id, targetLeaf, 'right', sketchRef);

		expect(tiled.unifiedTabOrder).toEqual([{ type: 'group', id: group.id }]);
		expect(buildUnifiedTabs(tiled).map((t) => t.type)).toEqual(['group']);

		const normalized = normalizeTabGroups(tiled);
		const json = JSON.stringify(normalized.tabGroups[0].layout);
		expect(json).toContain(`"type":"sketch","id":"${sketch.id}"`);
	});
});

describe('snoozing a sketch tab', () => {
	it('parks the tab and wakes it back into its slot', () => {
		const session = sessionWithSketch({ activeSketchTabId: sketch.id });
		const parked = snoozeTab(session, sketch.id, Date.now() + 60_000);

		expect(parked?.entry.type).toBe('sketch');
		expect(parked?.session.sketchTabs).toEqual([]);
		expect(parked?.session.activeSketchTabId).toBeNull();
		expect(parked?.session.unifiedTabOrder).toEqual([{ type: 'ai', id: ai.id }]);

		const woken = wakeSnoozedTab(parked!.session, parked!.entry.id);
		expect(woken?.wasDuplicate).toBe(false);
		expect(woken?.tabId).toBe(sketch.id);
		expect(woken?.session.sketchTabs).toEqual([sketch]);
		expect(woken?.session.unifiedTabOrder).toEqual([
			{ type: 'ai', id: ai.id },
			{ type: 'sketch', id: sketch.id },
		]);
		expect(woken?.session.snoozedTabs).toEqual([]);
	});

	it('a sketch reopened while it slept is focused, not doubled', () => {
		const parked = snoozeTab(sessionWithSketch(), sketch.id, Date.now() + 60_000)!;
		const reopened = openSketchTab(
			parked.session,
			{ sketchId: sketch.sketchId, name: 'Plan' },
			{ background: true }
		);
		const woken = wakeSnoozedTab(reopened.session, parked.entry.id);

		expect(woken?.wasDuplicate).toBe(true);
		expect(woken?.tabId).toBe(reopened.tab.id);
		expect(woken?.session.sketchTabs).toHaveLength(1);
		expect(woken?.session.activeSketchTabId).toBe(reopened.tab.id);
	});

	it('names a parked sketch by its tab name', () => {
		expect(snoozedEntryLabel({ type: 'sketch', tab: { name: 'Plan' } })).toBe('Plan');
		expect(snoozedEntryLabel({ type: 'sketch', tab: { name: '' } })).toBe('Sketch Book');
	});
});
