/**
 * Tab Windows, D4: the owner window treats a tab popped out into a tab window as
 * "not here". These cases cover every tabHelpers function that picks or lists
 * tabs for the owner: buildUnifiedTabs, getNavigableTabs, getActiveTab,
 * closeTab, leftNeighborRef, repickPoppedOutActiveTab, and the unified
 * navigation that reads getNavigableUnifiedTabOrder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildUnifiedTabs,
	closeTab,
	getActiveTab,
	getNavigableTabs,
	leftNeighborRef,
	navigateToNextUnifiedTab,
	navigateToUnifiedTabByIndex,
	repickPoppedOutActiveTab,
} from '../../../renderer/utils/tabHelpers';
import { useTabWindowStore } from '../../../renderer/stores/tabWindowStore';
import type { Session, UnifiedTabRef } from '../../../renderer/types';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'fresh-tab'),
}));

const AGENT = 'session-1';

function popOut(tabRefs: TabWindowTabRef[], agentId = AGENT) {
	useTabWindowStore
		.getState()
		.setWindows([{ windowId: 'tw-1', agentId, tabRefs, activeTabRef: tabRefs[0] ?? null }]);
}

function terminalTab(id: string) {
	return { id, name: null, shellType: 'zsh', pid: 0, cwd: '/test', createdAt: 0, state: 'idle' };
}

function browserTab(id: string) {
	return {
		id,
		url: 'https://example.com/',
		title: 'Example',
		createdAt: 0,
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	};
}

/** a1 | f1 | a2 | t1 | a3 | b1, with a2 active. */
function mixedSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		aiTabs: [
			createMockAITab({ id: 'a1' }),
			createMockAITab({ id: 'a2' }),
			createMockAITab({ id: 'a3' }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'f1' })],
		terminalTabs: [terminalTab('t1')] as unknown as Session['terminalTabs'],
		browserTabs: [browserTab('b1')] as unknown as Session['browserTabs'],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a1' },
			{ type: 'file', id: 'f1' },
			{ type: 'ai', id: 'a2' },
			{ type: 'terminal', id: 't1' },
			{ type: 'ai', id: 'a3' },
			{ type: 'browser', id: 'b1' },
		],
		activeTabId: 'a2',
		...overrides,
	});
}

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);

describe('tabHelpers with popped-out tabs (Tab Windows D4)', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	describe('buildUnifiedTabs', () => {
		it('drops popped tabs of every kind from the owner strip', () => {
			popOut([
				{ type: 'ai', id: 'a2' },
				{ type: 'file', id: 'f1' },
				{ type: 'terminal', id: 't1' },
				{ type: 'browser', id: 'b1' },
			]);
			expect(ids(buildUnifiedTabs(mixedSession()))).toEqual(['a1', 'a3']);
		});

		it('does not re-surface a popped tab through the orphan fallback', () => {
			popOut([{ type: 'ai', id: 'orphan' }]);
			const session = mixedSession({
				aiTabs: [...mixedSession().aiTabs, createMockAITab({ id: 'orphan' })],
			});
			expect(ids(buildUnifiedTabs(session))).not.toContain('orphan');
		});

		it('ignores tabs popped out of another agent', () => {
			popOut([{ type: 'ai', id: 'a2' }], 'other-agent');
			expect(ids(buildUnifiedTabs(mixedSession()))).toEqual(['a1', 'f1', 'a2', 't1', 'a3', 'b1']);
		});
	});

	describe('getNavigableTabs', () => {
		it('leaves out popped AI tabs', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			expect(ids(getNavigableTabs(mixedSession()))).toEqual(['a2', 'a3']);
		});

		it('returns aiTabs by reference when none of them is popped', () => {
			popOut([{ type: 'file', id: 'f1' }]);
			const session = mixedSession();
			expect(getNavigableTabs(session)).toBe(session.aiTabs);
		});
	});

	describe('getActiveTab', () => {
		it('never falls back onto a popped tab', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			expect(getActiveTab(mixedSession({ activeTabId: 'gone' }))?.id).toBe('a2');
		});
	});

	describe('closeTab', () => {
		it('skips a popped left neighbor and lands on the next tab the owner draws', () => {
			popOut([
				{ type: 'ai', id: 'a2' },
				{ type: 'terminal', id: 't1' },
			]);
			const result = closeTab(mixedSession({ activeTabId: 'a3' }), 'a3', false);
			expect(result?.session.activeFileTabId).toBe('f1');
		});

		it('creates a fresh AI tab when every surviving tab is popped out', () => {
			popOut([
				{ type: 'ai', id: 'a1' },
				{ type: 'ai', id: 'a3' },
				{ type: 'file', id: 'f1' },
				{ type: 'terminal', id: 't1' },
				{ type: 'browser', id: 'b1' },
			]);
			const result = closeTab(mixedSession(), 'a2', false);
			expect(result?.session.activeTabId).toBe('fresh-tab');
			expect(ids(result!.session.aiTabs)).toEqual(['a1', 'a3', 'fresh-tab']);
			// The popped tabs keep their refs (the dock slots).
			expect(result!.session.unifiedTabOrder).toContainEqual({ type: 'ai', id: 'a1' });
		});

		it('closing a popped tab leaves the owner on its own tab', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			const result = closeTab(mixedSession(), 'a1', false);
			expect(result?.session.activeTabId).toBe('a2');
			expect(result!.session.unifiedTabOrder).not.toContainEqual({ type: 'ai', id: 'a1' });
		});
	});

	describe('unified navigation', () => {
		it('next-tab skips a popped tab', () => {
			popOut([{ type: 'terminal', id: 't1' }]);
			const result = navigateToNextUnifiedTab(mixedSession());
			expect(result?.session.activeTabId).toBe('a3');
		});

		it('Cmd+N counts only the tabs the owner draws', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			const result = navigateToUnifiedTabByIndex(mixedSession(), 0);
			expect(result?.session.activeFileTabId).toBe('f1');
		});
	});

	describe('leftNeighborRef', () => {
		const order: UnifiedTabRef[] = [
			{ type: 'ai', id: 'x' },
			{ type: 'file', id: 'y' },
			{ type: 'ai', id: 'z' },
		];

		it('picks the ref to the left', () => {
			expect(leftNeighborRef(order, { type: 'ai', id: 'z' })).toEqual({ type: 'file', id: 'y' });
		});

		it('picks the new first ref when the target was first', () => {
			expect(leftNeighborRef(order, { type: 'ai', id: 'x' })).toEqual({ type: 'file', id: 'y' });
		});

		it('is null when the target is absent or alone', () => {
			expect(leftNeighborRef(order, { type: 'ai', id: 'missing' })).toBeNull();
			expect(leftNeighborRef([{ type: 'ai', id: 'x' }], { type: 'ai', id: 'x' })).toBeNull();
		});
	});

	describe('repickPoppedOutActiveTab', () => {
		it('returns the session by reference when nothing is popped', () => {
			const session = mixedSession();
			expect(repickPoppedOutActiveTab(session)).toBe(session);
		});

		it('returns the session by reference when the active tab is not popped', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			const session = mixedSession();
			expect(repickPoppedOutActiveTab(session)).toBe(session);
		});

		it('moves off a popped active tab to the left neighbor of its slot and keeps its ref', () => {
			popOut([{ type: 'ai', id: 'a2' }]);
			const session = mixedSession();
			const next = repickPoppedOutActiveTab(session);
			expect(next.activeFileTabId).toBe('f1');
			// The AI pointer behind the file tab moves off the popped tab too.
			expect(next.activeTabId).toBe('a1');
			expect(next.unifiedTabOrder).toBe(session.unifiedTabOrder);
		});

		it('skips popped neighbors with the same rule closeTab uses', () => {
			popOut([
				{ type: 'ai', id: 'a3' },
				{ type: 'terminal', id: 't1' },
			]);
			const next = repickPoppedOutActiveTab(mixedSession({ activeTabId: 'a3' }));
			expect(next.activeTabId).toBe('a2');
			expect(next.activeFileTabId).toBeNull();
			expect(next.inputMode).toBe('ai');
		});

		it('takes the right neighbor when the popped tab was first', () => {
			popOut([{ type: 'ai', id: 'a1' }]);
			const next = repickPoppedOutActiveTab(mixedSession({ activeTabId: 'a1' }));
			expect(next.activeFileTabId).toBe('f1');
			expect(next.activeTabId).toBe('a2');
		});

		it('opens a fresh AI tab when nothing visible survives', () => {
			popOut([
				{ type: 'ai', id: 'a1' },
				{ type: 'ai', id: 'a2' },
				{ type: 'ai', id: 'a3' },
				{ type: 'file', id: 'f1' },
				{ type: 'terminal', id: 't1' },
				{ type: 'browser', id: 'b1' },
			]);
			const next = repickPoppedOutActiveTab(mixedSession());
			expect(next.activeTabId).toBe('fresh-tab');
			expect(next.inputMode).toBe('ai');
			expect(next.unifiedTabOrder[next.unifiedTabOrder.length - 1]).toEqual({
				type: 'ai',
				id: 'fresh-tab',
			});
			expect(next.unifiedTabOrder).toContainEqual({ type: 'ai', id: 'a2' });
		});

		it('moves off a popped terminal on screen', () => {
			popOut([{ type: 'terminal', id: 't1' }]);
			const next = repickPoppedOutActiveTab(
				mixedSession({ inputMode: 'terminal', activeTerminalTabId: 't1' })
			);
			expect(next.inputMode).toBe('ai');
			expect(next.activeTerminalTabId).toBeNull();
			expect(next.activeTabId).toBe('a2');
		});

		it('moves a remembered AI pointer behind a file tab without changing the view', () => {
			popOut([{ type: 'ai', id: 'a2' }]);
			const next = repickPoppedOutActiveTab(mixedSession({ activeFileTabId: 'f1' }));
			expect(next.activeFileTabId).toBe('f1');
			expect(next.activeTabId).toBe('a1');
		});

		it('clears a remembered terminal pointer in AI mode', () => {
			popOut([{ type: 'terminal', id: 't1' }]);
			const next = repickPoppedOutActiveTab(mixedSession({ activeTerminalTabId: 't1' }));
			expect(next.activeTerminalTabId).toBeNull();
			expect(next.activeTabId).toBe('a2');
		});
	});
});
