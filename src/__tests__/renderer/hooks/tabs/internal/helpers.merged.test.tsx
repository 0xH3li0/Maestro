// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
	createBrowserTab,
	normalizeBrowserTabUpdates,
} from '../../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../../renderer/utils/browserTabPersistence';
import {
	createMockBrowserTab,
	createMockFileTab,
	createMockAITab,
	createMockTerminalTab,
	setupSession,
	getSession,
	resetTabHandlerStores,
} from './testUtils';
import {
	buildFileTabDisplayNames,
	buildReplacementNavigationHistory,
	getFileNameParts,
} from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import {
	applyUnifiedTabClosures,
	excludeDraftRefs,
	excludeHiddenAiRefs,
	excludePreservedRefs,
	getActiveUnifiedRef,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTerminalTabIds,
	getWizardTabIds,
} from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { setLiveDraft, getLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAITabHandlers } from '../../../../../renderer/hooks/tabs/internal/useAITabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	clearDesktopAiTabSelections,
	consumeDesktopAiTabSelection,
} from '../../../../../renderer/utils/desktopTabSelectionSync';
import { useScrollLogHandlers } from '../../../../../renderer/hooks/tabs/internal/useScrollLogHandlers';
import {
	getTabDerivedState,
	useTabDerivedState,
} from '../../../../../renderer/hooks/tabs/internal/useTabDerivedState';
import { useTerminalTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useTerminalTabHandlers';

// ===== from src/__tests__/renderer/hooks/tabs/internal/browserTabHelpers.test.ts =====
describe('browserTabHelpers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a home browser tab with partition and default title', () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);

		const tab = createBrowserTab('session/one', DEFAULT_BROWSER_TAB_URL, { isLoading: false });

		expect(tab.title).toBe('New Tab');
		expect(tab.createdAt).toBe(1234);
		expect(tab.partition).toBe('persist:maestro-browser-session-session-one');
		expect(tab.isLoading).toBe(false);
	});

	it('creates a loading browser tab for an explicit URL', () => {
		const tab = createBrowserTab('session-1', 'https://example.com/docs', {
			title: 'Docs',
			isLoading: true,
		});

		expect(tab.url).toBe('https://example.com/docs');
		expect(tab.title).toBe('Docs');
		expect(tab.isLoading).toBe(true);
	});

	it('normalizes updated URLs and derives the title when blank', () => {
		const tab = createMockBrowserTab({
			url: 'https://old.example/',
			title: '',
		});

		expect(normalizeBrowserTabUpdates(tab, { url: 'example.com/path', title: '' })).toMatchObject({
			url: 'https://example.com/path',
			title: 'example.com',
		});
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/filePreviewTabHelpers.test.ts =====
describe('filePreviewTabHelpers', () => {
	describe('getFileNameParts', () => {
		it('splits a normal filename into name and extension', () => {
			expect(getFileNameParts('index.test.ts')).toEqual({
				nameWithoutExtension: 'index.test',
				extension: '.ts',
			});
		});

		it('keeps extension empty when no dot exists', () => {
			expect(getFileNameParts('README')).toEqual({
				nameWithoutExtension: 'README',
				extension: '',
			});
		});

		it('preserves the legacy hidden-file behavior', () => {
			expect(getFileNameParts('.env')).toEqual({
				nameWithoutExtension: '',
				extension: '.env',
			});
		});
	});

	describe('buildReplacementNavigationHistory', () => {
		it('adds current file and replacement file when history is empty', () => {
			const tab = createMockFileTab({ path: '/old.ts', name: 'old', scrollTop: 42 });

			expect(
				buildReplacementNavigationHistory(
					tab,
					tab,
					{ path: '/new.ts', name: 'new.ts', content: 'new' },
					'new'
				)
			).toEqual([
				{ path: '/old.ts', name: 'old', scrollTop: 42 },
				{ path: '/new.ts', name: 'new', scrollTop: 0 },
			]);
		});

		it('truncates forward history before adding the replacement file', () => {
			const tab = createMockFileTab({
				path: '/b.ts',
				name: 'b',
				scrollTop: 10,
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 1 },
					{ path: '/b.ts', name: 'b', scrollTop: 2 },
					{ path: '/c.ts', name: 'c', scrollTop: 3 },
				],
				navigationIndex: 1,
			});

			expect(
				buildReplacementNavigationHistory(
					tab,
					tab,
					{ path: '/d.ts', name: 'd.ts', content: 'd' },
					'd'
				)
			).toEqual([
				{ path: '/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/d.ts', name: 'd', scrollTop: 0 },
			]);
		});
	});

	describe('buildFileTabDisplayNames', () => {
		const tab = (id: string, path: string) => {
			const { nameWithoutExtension, extension } = getFileNameParts(
				path.split(/[/\\]+/).pop() ?? ''
			);
			return { id, path, name: nameWithoutExtension, extension };
		};

		it('leaves uniquely-named tabs as the bare filename', () => {
			const result = buildFileTabDisplayNames([tab('1', '/a/ioc.go'), tab('2', '/b/service.go')]);
			expect(result.get('1')).toBe('ioc');
			expect(result.get('2')).toBe('service');
		});

		it('prefixes the immediate folder when two filenames collide', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/ioc/service.go'),
				tab('2', '/proj/api/service.go'),
			]);
			expect(result.get('1')).toBe('ioc/service');
			expect(result.get('2')).toBe('api/service');
		});

		it('deepens the prefix until labels are unique', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/a/shared/service.go'),
				tab('2', '/proj/b/shared/service.go'),
			]);
			// One folder (shared) collides, so walk up another level.
			expect(result.get('1')).toBe('a/shared/service');
			expect(result.get('2')).toBe('b/shared/service');
		});

		it('does not prefix tabs that share a name but differ in extension', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/service.go'),
				tab('2', '/proj/service.ts'),
			]);
			expect(result.get('1')).toBe('service');
			expect(result.get('2')).toBe('service');
		});

		it('handles paths of unequal depth without collisions', () => {
			const result = buildFileTabDisplayNames([tab('1', '/service.go'), tab('2', '/x/service.go')]);
			expect(result.get('1')).toBe('service');
			expect(result.get('2')).toBe('x/service');
		});

		it('disambiguates three or more colliding files', () => {
			const result = buildFileTabDisplayNames([
				tab('1', '/proj/ioc/service.go'),
				tab('2', '/proj/api/service.go'),
				tab('3', '/proj/db/service.go'),
			]);
			expect(result.get('1')).toBe('ioc/service');
			expect(result.get('2')).toBe('api/service');
			expect(result.get('3')).toBe('db/service');
		});
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/unifiedCloseHelpers.test.ts =====
describe('unifiedCloseHelpers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	it('resolves the active unified ref using terminal only when terminal mode is active', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [aiTab],
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'ai',
		});

		expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'ai', id: 'ai-1' });

		setupSession({
			aiTabs: [aiTab],
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});

		expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'terminal', id: 'term-1' });
	});

	it('returns refs left, right, and except active in unified order', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({
			aiTabs: [ai1, ai2],
			filePreviewTabs: [fileTab],
			activeFileTabId: fileTab.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'ai', id: ai2.id },
			],
		});

		expect(getRefsLeftOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-1' }]);
		expect(getRefsRightOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-2' }]);
		expect(getRefsExceptActive(getSession())).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-2' },
		]);
	});

	it('pivots on an explicit clicked tab id, not the active tab', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const ai3 = createMockAITab({ id: 'ai-3' });
		setupSession({
			aiTabs: [ai1, ai2, ai3],
			// Active is the LAST tab - a naive "close right of active" would close nothing.
			activeTabId: ai3.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'ai', id: ai2.id },
				{ type: 'ai', id: ai3.id },
			],
		});

		// Pivot explicitly on the clicked middle tab (ai2).
		expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
		expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
		expect(getRefsExceptActive(getSession(), 'ai-2')).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-3' },
		]);
	});

	it('computes close sets against the repaired order, ignoring stale unified refs', () => {
		// Raw unifiedTabOrder carries a stale ref ('ghost', no live tab) plus a
		// duplicate. The repaired order the tab bar renders is [ai-1, ai-2, ai-3].
		// Slicing the raw order (the old behavior) would mis-place the pivot and
		// could close the wrong set; the repaired order keeps it correct.
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const ai3 = createMockAITab({ id: 'ai-3' });
		setupSession({
			aiTabs: [ai1, ai2, ai3],
			activeTabId: ai1.id,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ghost' },
				{ type: 'ai', id: ai1.id },
				{ type: 'ai', id: ai1.id }, // duplicate
				{ type: 'ai', id: ai2.id },
				{ type: 'ai', id: ai3.id },
			],
		});

		// Pivot ai-1 is visually first → close-right is everything else; close-left empty.
		expect(getRefsRightOfActive(getSession(), 'ai-1')).toEqual([
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-3' },
		]);
		expect(getRefsLeftOfActive(getSession(), 'ai-1')).toEqual([]);
		// Pivot ai-2 (visually middle) → exactly ai-3 to the right, ai-1 to the left.
		expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
		expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('collects terminal and wizard tab ids from refs', () => {
		const wizardTab = createMockAITab({
			id: 'wizard',
			wizardState: { isActive: true } as any,
		});
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [wizardTab],
			terminalTabs: [terminalTab],
		});
		const refs = [
			{ type: 'ai' as const, id: 'wizard' },
			{ type: 'terminal' as const, id: 'term-1' },
		];

		expect(getTerminalTabIds(refs)).toEqual(['term-1']);
		expect(getWizardTabIds(getSession(), refs)).toEqual(['wizard']);
	});

	it('excludes only AI refs that hold an unsent draft from the close set', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({ aiTabs: [ai1, ai2], filePreviewTabs: [fileTab] });
		setLiveDraft('ai-2', 'pending text');

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'ai-2' },
			{ type: 'file' as const, id: 'file-1' },
		];

		// ai-2 (the draft tab) is preserved; ai-1 and the file tab still close.
		expect(excludeDraftRefs(getSession(), refs)).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'file', id: 'file-1' },
		]);
	});

	it('returns the same ref array when no tab has a draft', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [ai1] });
		const refs = [{ type: 'ai' as const, id: 'ai-1' }];
		expect(excludeDraftRefs(getSession(), refs)).toBe(refs);
	});

	it('excludes hidden consult tabs from the close set', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({ aiTabs: [ai1, consult] });

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'consult' },
		];

		expect(excludeHiddenAiRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('returns the same ref array when no tab is hidden', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [ai1] });
		const refs = [{ type: 'ai' as const, id: 'ai-1' }];
		expect(excludeHiddenAiRefs(getSession(), refs)).toBe(refs);
	});

	it('preserves both drafts and hidden consult tabs in one pass', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({ aiTabs: [ai1, ai2, consult] });
		setLiveDraft('ai-2', 'pending text');

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'ai-2' },
			{ type: 'ai' as const, id: 'consult' },
		];

		expect(excludePreservedRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('closes mixed tab refs while preserving browser unified history', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [ai1, ai2],
			filePreviewTabs: [fileTab],
			browserTabs: [browserTab],
			activeTabId: ai1.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'ai', id: ai2.id },
			],
		});

		const nextSession = applyUnifiedTabClosures(getSession(), [
			{ type: 'file', id: fileTab.id },
			{ type: 'browser', id: browserTab.id },
			{ type: 'ai', id: ai2.id },
		]);

		expect(nextSession.filePreviewTabs).toEqual([]);
		expect(nextSession.browserTabs).toEqual([]);
		expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
		expect(nextSession.unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-1' }]);
		// Both the browser tab and the bulk-closed AI tab are recorded so they can
		// be reopened via Cmd+Shift+T. ai-2 is closed last, so it is most-recent.
		const history = nextSession.unifiedClosedTabHistory ?? [];
		const historyTypes = history.map((e) => e.type);
		expect(historyTypes).toContain('browser');
		expect(historyTypes).toContain('ai');
		const mostRecent = history[0];
		expect(mostRecent.type).toBe('ai');
		expect(mostRecent.tab.id).toBe('ai-2');
	});

	it('does not record wizard tabs into the unified history on bulk close', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const wizardTab = createMockAITab({ id: 'wizard', wizardState: { isActive: true } as any });
		setupSession({
			aiTabs: [ai1, wizardTab],
			activeTabId: ai1.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'ai', id: wizardTab.id },
			],
		});

		const nextSession = applyUnifiedTabClosures(getSession(), [{ type: 'ai', id: wizardTab.id }]);

		expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
		expect(nextSession.unifiedClosedTabHistory ?? []).toEqual([]);
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useAITabHandlers.test.ts =====
const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

const runtimeMocks = vi.hoisted(() => ({
	isWebDesktop: vi.fn(() => false),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

vi.mock('../../../../../renderer/utils/runtimeContext', () => runtimeMocks);

describe('useAITabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		clearDesktopAiTabSelections();
		inlineWizardMocks.endWizard.mockClear();
		runtimeMocks.isWebDesktop.mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
	});

	it('creates a new AI tab with default settings', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			inputMode: 'terminal',
			activeTerminalTabId: 'terminal-1',
		});
		useSettingsStore.setState({
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
		} as any);

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleNewTab();
		});

		const session = getSession();
		expect(session.aiTabs).toHaveLength(2);
		expect(session.aiTabs[1]).toMatchObject({
			saveToHistory: false,
			showThinking: 'sticky',
		});
		expect(session.activeTabId).toBe(session.aiTabs[1].id);
		expect(session.inputMode).toBe('ai');
		expect(session.activeTerminalTabId).toBeNull();
	});

	it('asks the desktop for the tab rather than minting a browser-local id', () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		const requestNewTab = vi.fn(() => new Promise(() => {}));
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleNewTab();
		});

		// The desktop owns the tab inventory, so the id has to come from there.
		// Inventing one here would be drawn now and then added a SECOND time
		// under the desktop's id by the next inventory broadcast.
		expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
	});

	it('draws and selects the desktop-minted tab as soon as the answer lands', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		useSettingsStore.setState({
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
		} as any);
		const requestNewTab = vi.fn().mockResolvedValue({ tabId: 'ai-2' });
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		await act(async () => {
			result.current.handleNewTab();
		});

		// Waiting for the desktop's inventory broadcast instead would leave the
		// tap doing nothing for up to the 500ms poll interval.
		const session = getSession();
		expect(session.aiTabs.map((tab) => tab.id)).toEqual(['ai-1', 'ai-2']);
		expect(session.aiTabs[1]).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });
		expect(session.activeTabId).toBe('ai-2');
		expect(session.inputMode).toBe('ai');
	});

	it('only selects the tab when the inventory broadcast wins the race', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		const requestNewTab = vi.fn(async () => {
			// The desktop commits the tab before it answers, so its 500ms poll can
			// broadcast the new inventory first. Adopting the id again here would
			// put the same tab in the strip twice.
			setupSession({
				id: 'session-1',
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			});
			return { tabId: 'ai-2' };
		});
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		await act(async () => {
			result.current.handleNewTab();
		});

		const session = getSession();
		expect(session.aiTabs.map((tab) => tab.id)).toEqual(['ai-1', 'ai-2']);
		expect(session.activeTabId).toBe('ai-2');
	});

	it('focuses the composer inside the tap, not when the answer arrives', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		let resolveRequest: (value: { tabId: string }) => void = () => {};
		const requestNewTab = vi.fn(
			() =>
				new Promise<{ tabId: string }>((resolve) => {
					resolveRequest = resolve;
				})
		);
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;
		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const inputRef = { current: textarea };

		const { result } = renderHook(() => useAITabHandlers(inputRef));
		act(() => {
			result.current.handleNewTab();
		});

		// iOS raises the on-screen keyboard only for a focus() that runs in the
		// user gesture's own call stack. Deferring it to the round trip's answer
		// moves the caret and leaves the keyboard down, so the phone user still
		// has to tap the composer - which is the whole point of focusing it.
		expect(document.activeElement).toBe(textarea);

		await act(async () => {
			resolveRequest({ tabId: 'ai-2' });
		});
		expect(document.activeElement).toBe(textarea);
		textarea.remove();
	});

	it('restores an orphaned thinking tab when selected', () => {
		const orphan = createMockAITab({ id: 'orphan-1', state: 'busy' });
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			orphanedThinkingTabs: [orphan],
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('orphan-1');
		});

		expect(getSession().aiTabs.map((tab) => tab.id)).toContain('orphan-1');
		expect(getSession().activeTabId).toBe('orphan-1');
		expect(getSession().orphanedThinkingTabs).toBeUndefined();
	});

	it('records desktop AI-tab selections as explicit focus intent', () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('ai-2');
		});

		expect(consumeDesktopAiTabSelection('session-1', 'ai-2')).toBe(true);
	});

	it('does not record Web-Desktop selections as desktop focus intent', () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});
		runtimeMocks.isWebDesktop.mockReturnValue(true);

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('ai-2');
		});

		expect(consumeDesktopAiTabSelection('session-1', 'ai-2')).toBe(false);
	});

	it('opens draft confirmation and clears live draft after confirm', () => {
		const tab = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [tab] });
		setLiveDraft('ai-1', 'pending prompt');

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabClose('ai-1');
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.message).toBe(
			'This tab has an unsent draft. Are you sure you want to close it?'
		);

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(getLiveDraft('ai-1')).toBeUndefined();
		expect(getSession().aiTabs).toHaveLength(1);
	});

	it('ends wizard state when a wizard tab closes directly', async () => {
		const wizardTab = createMockAITab({
			id: 'wizard-1',
			wizardState: { isActive: true } as any,
		});
		setupSession({ aiTabs: [wizardTab, createMockAITab({ id: 'ai-2' })] });

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabClose('wizard-1');
		});

		await vi.waitFor(() => {
			expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1');
		});
	});

	// "Close all" is scoped to what the strip draws. A hidden consult tab holds a
	// transcript and a resume id the user was never shown a chip for, so closing it
	// here would destroy work silently.
	it('leaves a hidden consult tab alive when closing all tabs', () => {
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' }), consult],
			activeTabId: 'ai-1',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleCloseAllTabs();
		});

		const ids = getSession().aiTabs.map((tab) => tab.id);
		expect(ids).toContain('consult');
		expect(ids).not.toContain('ai-1');
		expect(ids).not.toContain('ai-2');
	});

	// The draft prompt guards tabs the user can still get back to. A draft parked on
	// a chipless consult must not put a confirmation in front of a close-all.
	it('does not prompt about drafts that live only on hidden consult tabs', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'consult', hidden: true })],
			activeTabId: 'ai-1',
		});
		setLiveDraft('consult', 'pending consult text');

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleCloseAllTabs();
		});

		expect(useModalStore.getState().modals.get('confirm')).toBeUndefined();
		expect(getSession().aiTabs.map((tab) => tab.id)).toContain('consult');
	});

	it('persists star changes through the provider-specific API', () => {
		const tab = createMockAITab({ id: 'ai-1', agentSessionId: 'agent-1' });
		setupSession({
			aiTabs: [tab],
			toolType: 'codex' as any,
			projectRoot: '/repo',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabStar('ai-1', true);
		});

		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'agent-1',
			true
		);
		expect(getSession().aiTabs[0].starred).toBe(true);
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useScrollLogHandlers.test.ts =====
describe('useScrollLogHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('updates active AI tab scroll and at-bottom unread state', () => {
		const tab = createMockAITab({ id: 'ai-1', hasUnread: true });
		setupSession({ aiTabs: [tab] });
		const { result } = renderHook(() => useScrollLogHandlers());

		act(() => {
			result.current.handleScrollPositionChange(123);
			result.current.handleAtBottomChange(true);
		});

		expect(getSession().aiTabs[0]).toMatchObject({
			scrollTop: 123,
			isAtBottom: true,
			hasUnread: false,
		});
	});

	it('updates terminal scroll when terminal mode is active', () => {
		setupSession({ inputMode: 'terminal' });
		const { result } = renderHook(() => useScrollLogHandlers());

		act(() => {
			result.current.handleScrollPositionChange(456);
		});

		expect(getSession().terminalScrollTop).toBe(456);
	});

	it('deletes an AI user message pair and command history entry', async () => {
		const tab = createMockAITab({
			id: 'ai-1',
			agentSessionId: 'agent-1',
			logs: [
				{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
				{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
				{ id: 'u2', source: 'user', text: 'next', timestamp: Date.now() },
			] as any,
		});
		setupSession({
			aiTabs: [tab],
			cwd: '/repo',
			aiCommandHistory: ['run tests', 'next'],
		});
		vi.mocked(window.maestro.claude.deleteMessagePair).mockResolvedValue({ success: true });
		const { result } = renderHook(() => useScrollLogHandlers());

		let nextIndex: number | null = null;
		act(() => {
			nextIndex = result.current.handleDeleteLog('u1');
		});

		expect(nextIndex).toBe(0);
		expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2']);
		expect(getSession().aiCommandHistory).toEqual(['next']);
		await vi.waitFor(() => {
			expect(window.maestro.claude.deleteMessagePair).toHaveBeenCalledWith(
				'/repo',
				'agent-1',
				'u1',
				'run tests'
			);
		});
	});

	describe('deleting a command-mode card', () => {
		function cardLog(id: string, command: string) {
			return {
				id,
				source: 'stdout',
				text: 'output',
				timestamp: Date.now(),
				shellCommand: { command, cwd: '/repo', status: 'finished', exitCode: 0 },
			};
		}

		it('removes just that card and prunes its bang-prefixed recall entry', () => {
			const tab = createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [
					{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
					cardLog('c1', 'npm test'),
					{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
				] as any,
			});
			setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test', 'run tests'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			let nextIndex: number | null = 0;
			act(() => {
				nextIndex = result.current.handleDeleteLog('c1');
			});

			// Only the card goes; the surrounding conversation is untouched.
			expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u1', 'a1']);
			expect(getSession().aiCommandHistory).toEqual(['run tests']);
			// No scroll target - removing a card should not move the reader.
			expect(nextIndex).toBeNull();
		});

		it('never asks the provider to delete a message pair for it', () => {
			// The agent was bypassed entirely, so there is no pair in its session.
			const tab = createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [cardLog('c1', 'npm test')] as any,
			});
			setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});

			expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
		});

		it('keeps the recall entry while another card still shows that command', () => {
			// aiCommandHistory is per agent and deduplicated, so pruning on the
			// first delete would contradict the cards still on screen.
			const tab = createMockAITab({
				id: 'ai-1',
				logs: [cardLog('c1', 'ls'), cardLog('c2', 'ls')] as any,
			});
			setupSession({ aiTabs: [tab], aiCommandHistory: ['!ls'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});
			expect(getSession().aiCommandHistory).toEqual(['!ls']);

			act(() => {
				result.current.handleDeleteLog('c2');
			});
			expect(getSession().aiCommandHistory).toEqual([]);
		});

		it('counts survivors across every tab, not just the active one', () => {
			const active = createMockAITab({ id: 'ai-1', logs: [cardLog('c1', 'ls')] as any });
			const other = createMockAITab({ id: 'ai-2', logs: [cardLog('c2', 'ls')] as any });
			setupSession({ aiTabs: [active, other], aiCommandHistory: ['!ls'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});

			// Guard against a silent no-op passing this assertion: the card really
			// went, and the recall entry really survived because ai-2 still has one.
			expect(getSession().aiTabs[0].logs).toEqual([]);
			expect(getSession().aiCommandHistory).toEqual(['!ls']);
		});
	});

	it('deletes shell logs and returns null for non-user logs', () => {
		setupSession({
			inputMode: 'terminal',
			shellLogs: [
				{ id: 's1', source: 'system', text: 'boot', timestamp: Date.now() },
				{ id: 'u1', source: 'user', text: 'pwd', timestamp: Date.now() },
				{ id: 'o1', source: 'stdout', text: '/repo', timestamp: Date.now() },
			] as any,
			shellCommandHistory: ['pwd'],
		});
		const { result } = renderHook(() => useScrollLogHandlers());

		expect(result.current.handleDeleteLog('s1')).toBeNull();
		act(() => {
			expect(result.current.handleDeleteLog('u1')).toBeNull();
		});

		expect(getSession().shellLogs.map((log) => log.id)).toEqual(['s1']);
		expect(getSession().shellCommandHistory).toEqual([]);
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useTabDerivedState.test.ts =====
describe('getTabDerivedState', () => {
	it('returns empty derived state for null session', () => {
		const result = getTabDerivedState(null);
		expect(result.activeTab).toBeUndefined();
		expect(result.unifiedTabs).toEqual([]);
		expect(result.activeFileTab).toBeNull();
		expect(result.isResumingSession).toBe(false);
	});
});

describe('useTabDerivedState', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('returns empty derived state when no session exists', () => {
		const { result } = renderHook(() => useTabDerivedState());

		expect(result.current.activeTab).toBeUndefined();
		expect(result.current.unifiedTabs).toEqual([]);
		expect(result.current.activeFileTab).toBeNull();
		expect(result.current.activeBrowserTab).toBeNull();
		expect(result.current.fileTabCanGoBack).toBe(false);
		expect(result.current.fileTabCanGoForward).toBe(false);
	});

	it('computes active AI, file, browser, and unified tab order', () => {
		const aiTab = createMockAITab({ id: 'ai-1', agentSessionId: 'agent-session' });
		const fileTab = createMockFileTab({ id: 'file-1', name: 'readme' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		const { result } = renderHook(() => useTabDerivedState());

		act(() => {
			setupSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				browserTabs: [browserTab],
				terminalTabs: [terminalTab],
				activeFileTabId: fileTab.id,
				activeBrowserTabId: browserTab.id,
				unifiedTabOrder: [
					{ type: 'terminal', id: terminalTab.id },
					{ type: 'browser', id: browserTab.id },
					{ type: 'file', id: fileTab.id },
					{ type: 'ai', id: aiTab.id },
				],
			});
		});

		expect(result.current.activeTab?.id).toBe('ai-1');
		expect(result.current.activeFileTab?.id).toBe('file-1');
		expect(result.current.activeBrowserTab?.id).toBe('browser-1');
		expect(result.current.isResumingSession).toBe(true);
		expect(result.current.unifiedTabs.map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			'terminal:term-1',
			'browser:browser-1',
			'file:file-1',
			'ai:ai-1',
		]);
	});

	it('computes file tab back and forward history for the active file tab', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			navigationHistory: [
				{ path: '/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/c.ts', name: 'c', scrollTop: 3 },
			],
			navigationIndex: 1,
		});
		setupSession({
			filePreviewTabs: [fileTab],
			activeFileTabId: fileTab.id,
		});

		const { result } = renderHook(() => useTabDerivedState());

		expect(result.current.activeFileTabNavIndex).toBe(1);
		expect(result.current.fileTabBackHistory).toEqual([{ path: '/a.ts', name: 'a', scrollTop: 1 }]);
		expect(result.current.fileTabForwardHistory).toEqual([
			{ path: '/c.ts', name: 'c', scrollTop: 3 },
		]);
		expect(result.current.fileTabCanGoBack).toBe(true);
		expect(result.current.fileTabCanGoForward).toBe(true);
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useTerminalTabHandlers.test.ts =====
describe('useTerminalTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('opens and selects terminal tabs through tabStore', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useTerminalTabHandlers());

		act(() => {
			result.current.handleOpenTerminalTab({ shell: 'bash', cwd: '/repo', name: 'Local' });
		});

		const terminalTab = getSession().terminalTabs[0];
		expect(terminalTab).toMatchObject({ shellType: 'bash', cwd: '/repo', name: 'Local' });
		expect(getSession().activeTerminalTabId).toBe(terminalTab.id);
	});

	it('closes idle terminal tabs immediately', async () => {
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});
		vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(false);
		const { result } = renderHook(() => useTerminalTabHandlers());

		await act(async () => {
			result.current.handleCloseTerminalTab('term-1');
			await Promise.resolve();
		});

		expect(window.maestro.process.isTerminalBusy).toHaveBeenCalledWith(
			'test-session-terminal-term-1'
		);
		expect(getSession().terminalTabs).toHaveLength(0);
	});

	it('opens a destructive confirmation when the terminal is busy', async () => {
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});
		vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(true);
		const { result } = renderHook(() => useTerminalTabHandlers());

		await act(async () => {
			result.current.handleCloseTerminalTab('term-1');
			await Promise.resolve();
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.destructive).toBe(true);
		expect(getSession().terminalTabs).toHaveLength(1);

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(getSession().terminalTabs).toHaveLength(0);
	});
});
