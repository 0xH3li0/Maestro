// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useBrowserTabHandlers';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	createMockAITab,
	createMockBrowserTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
	createMockFileTab,
	createMockTerminalTab,
} from './testUtils';
import { updateSessionWith } from '../../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../../renderer/stores/uiStore';
import type { BrowserTab } from '../../../../../shared/browserPage';
import { isWebDesktop } from '../../../../../renderer/utils/runtimeContext';
import { useFilePreviewTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useFilePreviewTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useMediaPlaybackStore } from '../../../../../renderer/stores/mediaPlaybackStore';
import { useUnifiedTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useUnifiedTabHandlers';
import { createGroupFromTabRefs } from '../../../../../renderer/utils/panelLayout';
import type { PanelLayoutNode, TabGroup, UnifiedTabRef } from '../../../../../renderer/types';

// ===== from src/__tests__/renderer/hooks/tabs/internal/useBrowserTabHandlers.test.ts =====
vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

describe('useBrowserTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		vi.mocked(isWebDesktop).mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
	});

	it('creates and activates a browser tab using the configured home URL', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		useSettingsStore.setState({ browserHomeUrl: 'https://home.example/' } as any);
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleNewBrowserTab();
		});

		const browserTab = getSession().browserTabs[0];
		expect(browserTab).toMatchObject({
			url: 'https://home.example/',
			title: 'https://home.example/',
			isLoading: true,
		});
		expect(getSession().activeBrowserTabId).toBe(browserTab.id);
	});

	it('leaves an active tiled group when creating a new browser tab', () => {
		// A new standalone browser tab must take over the panel; if the group stays
		// active it keeps winning the render precedence and focus never shifts.
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleNewBrowserTab();
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeBrowserTabId).toBe(getSession().browserTabs[0].id);
	});

	it('leaves an active tiled group when opening an explicit URL', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleOpenBrowserTabAt('https://example.com/');
		});

		expect(getSession().activeGroupId).toBeNull();
	});

	it('opens an explicit URL and ignores empty URLs', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleOpenBrowserTabAt('');
			result.current.handleOpenBrowserTabAt('file:///tmp/report.html', { title: 'Report' });
		});

		expect(getSession().browserTabs).toHaveLength(1);
		expect(getSession().browserTabs[0]).toMatchObject({
			url: 'file:///tmp/report.html',
			title: 'Report',
			isLoading: true,
		});
	});

	it('selects an existing browser tab and repairs missing unified order', () => {
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			browserTabs: [browserTab],
			unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleSelectBrowserTab('browser-1');
		});

		expect(getSession().activeBrowserTabId).toBe('browser-1');
		expect(getSession().activeFileTabId).toBeNull();
		expect(getSession().unifiedTabOrder).toContainEqual({ type: 'browser', id: 'browser-1' });
	});

	it('closes a browser tab and records it in unified history', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [aiTab],
			browserTabs: [browserTab],
			activeBrowserTabId: browserTab.id,
			unifiedTabOrder: [
				{ type: 'ai', id: aiTab.id },
				{ type: 'browser', id: browserTab.id },
			],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleCloseBrowserTab('browser-1');
		});

		expect(getSession().browserTabs).toHaveLength(0);
		expect(getSession().activeTabId).toBe('ai-1');
		expect(getSession().unifiedClosedTabHistory?.[0]).toMatchObject({
			type: 'browser',
		});
	});

	it('updates a browser tab in the owning session even when it is not active', () => {
		const browserTab = createMockBrowserTab({ id: 'browser-1', title: '' });
		setupSession({
			id: 'owner-session',
			browserTabs: [browserTab],
		});
		const { result } = renderHook(() => useBrowserTabHandlers());

		act(() => {
			result.current.handleUpdateBrowserTab('owner-session', 'browser-1', {
				url: 'example.com/docs',
				title: '',
			});
		});

		expect(getSession().browserTabs[0]).toMatchObject({
			url: 'https://example.com/docs',
			title: 'example.com',
		});
	});
	it('does not create a client tab before host acknowledgement or duplicate a preceding host snapshot', async () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		const sessionId = setupSession({ activeGroupId: 'client-group' });
		const acknowledged = Promise.withResolvers<BrowserTab>();
		const originalApi = window.maestro.browserSession;
		window.maestro.browserSession = { ...originalApi, createTab: () => acknowledged.promise };
		const hostTab = createMockBrowserTab({
			id: 'host-incognito',
			partition: 'maestro-ephemeral-host-12345678',
			ephemeral: true,
		});
		try {
			const { result } = renderHook(() => useBrowserTabHandlers());
			act(() => result.current.handleNewBrowserTab({ ephemeral: true }));
			expect(getSession().browserTabs).toEqual([]);
			expect(getSession().activeGroupId).toBe('client-group');
			act(() =>
				updateSessionWith(sessionId, (session) => ({
					...session,
					browserTabs: [hostTab],
					unifiedTabOrder: [...session.unifiedTabOrder, { type: 'browser', id: hostTab.id }],
				}))
			);
			await act(async () => {
				acknowledged.resolve(hostTab);
				await acknowledged.promise;
			});
			expect(getSession().browserTabs).toEqual([hostTab]);
			expect(getSession().unifiedTabOrder.filter((ref) => ref.type === 'browser')).toEqual([
				{ type: 'browser', id: hostTab.id },
			]);
			expect(getSession().activeBrowserTabId).toBe(hostTab.id);
			expect(getSession().activeGroupId).toBeNull();
			expect(useUIStore.getState().focusRequest).toEqual({
				tab: { type: 'browser', id: hostTab.id },
			});
		} finally {
			window.maestro.browserSession = originalApi;
		}
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.test.ts =====
describe('useFilePreviewTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		useMediaPlaybackStore.setState({
			items: [],
			activeItemId: null,
			history: [],
			playing: false,
			dismissed: false,
			pendingAutoplay: false,
			resumeTimes: {},
		});
	});

	afterEach(() => {
		cleanup();
	});

	// -----------------------------------------------------------------------
	// Narrow-viewport drawer
	// -----------------------------------------------------------------------
	describe('narrow-viewport right drawer', () => {
		// On a phone the Files panel covers the whole screen, so opening a file
		// from it has to dismiss it. The transition-keyed effect in App.tsx cannot
		// do this alone: the two cases below move none of the active-tab ids it
		// watches, so it sees nothing happen and the file opens behind the tree.
		const originalWidth = window.innerWidth;
		const setViewportWidth = (width: number) => {
			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				writable: true,
				value: width,
			});
		};

		afterEach(() => {
			setViewportWidth(originalWidth);
		});

		it('closes the drawer when a file is opened', () => {
			setViewportWidth(390);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			useUIStore.getState().setRightPanelOpen(true);
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({ path: '/p/a.md', name: 'a.md', content: '# a' });
			});

			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('closes the drawer when the file is ALREADY the active tab', () => {
			// The reported bug: long-press a file already open, tap Preview, and
			// nothing moves - so the effect keyed on activeFileTabId never fires
			// and the drawer stays over the preview.
			setViewportWidth(390);
			const existing = createMockFileTab({ id: 'file-1', path: '/p/a.md', name: 'a.md' });
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				filePreviewTabs: [existing],
				activeFileTabId: 'file-1',
			});
			const { result } = renderHook(() => useFilePreviewTabHandlers());
			const before = getSession().activeFileTabId;
			useUIStore.getState().setRightPanelOpen(true);

			act(() => {
				result.current.handleOpenFileTab({ path: '/p/a.md', name: 'a.md', content: '# a' });
			});

			// The active tab genuinely did not move - that is the whole problem.
			expect(getSession().activeFileTabId).toBe(before);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('closes the drawer for media, which never becomes a tab at all', () => {
			setViewportWidth(390);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			useUIStore.getState().setRightPanelOpen(true);
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: 'maestro-media://stream/tok3n/2f66696c65732f612e6d7033',
				});
			});

			expect(getSession().filePreviewTabs).toHaveLength(0);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('leaves the drawer alone for a background open', () => {
			// `activate: false` is the CLI / web `--background` path: it changes
			// nothing on screen by definition, so it must not move the drawer.
			setViewportWidth(390);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			useUIStore.getState().setRightPanelOpen(true);
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/p/a.md', name: 'a.md', content: '# a' },
					{ activate: false }
				);
			});

			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});

		it('leaves the Right Bar open on a wide viewport', () => {
			setViewportWidth(1440);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			useUIStore.getState().setRightPanelOpen(true);
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({ path: '/p/a.md', name: 'a.md', content: '# a' });
			});

			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});
	});

	describe('media diversion', () => {
		// Media is not a document. It never gets a tab, a main panel view, or any
		// other placement: opening an audio or video file hands it to the floating
		// player and nothing else.
		const STREAM = 'maestro-media://stream/tok3n/2f66696c65732f612e6d7033';

		it('opens a media file in the player without creating a tab', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(0);
			expect(session.activeFileTabId).toBeFalsy();
			expect(session.unifiedTabOrder.map((ref) => ref.type)).toEqual(['ai']);

			const media = useMediaPlaybackStore.getState();
			expect(media.items).toHaveLength(1);
			expect(media.items[0]).toMatchObject({
				path: '/files/podcast.mp3',
				name: 'podcast.mp3',
				kind: 'audio',
			});
			expect(media.pendingAutoplay).toBe(true);
		});

		it('queues a second file instead of taking the player over', () => {
			// Queueing an mp4 behind a playing mp3 must leave the mp3 loaded and
			// audible - the whole point of "Add to Play Queue".
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});
			act(() => {
				useMediaPlaybackStore.getState().consumeAutoplay();
				useMediaPlaybackStore.getState().setPlaying(true);
			});
			const playingId = useMediaPlaybackStore.getState().activeItemId;

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/files/clip.mp4', name: 'clip.mp4', content: STREAM },
					{ mediaMode: 'queue' }
				);
			});

			const media = useMediaPlaybackStore.getState();
			expect(media.items).toHaveLength(2);
			expect(media.activeItemId).toBe(playingId);
			expect(media.playing).toBe(true);
			expect(media.pendingAutoplay).toBe(false);
		});

		it('queues without playing even when the loaded track is paused', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});
			act(() => {
				useMediaPlaybackStore.getState().consumeAutoplay();
				useMediaPlaybackStore.getState().setPlaying(false);
			});
			const pausedId = useMediaPlaybackStore.getState().activeItemId;

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/files/clip.mp4', name: 'clip.mp4', content: STREAM },
					{ mediaMode: 'queue' }
				);
			});

			const media = useMediaPlaybackStore.getState();
			expect(media.activeItemId).toBe(pausedId);
			expect(media.pendingAutoplay).toBe(false);
			expect(media.playing).toBe(false);
		});

		it('stamps the owning agent, so the player says where the file came from', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/clip.mp4',
					name: 'clip.mp4',
					content: STREAM,
				});
			});

			const item = useMediaPlaybackStore.getState().items[0];
			expect(item.kind).toBe('video');
			expect(item.sessionId).toBe(getSession().id);
			expect(item.sessionName).toBe(getSession().name);
		});

		it('still opens a tab for remote media, which has no playable stream', () => {
			// Only local files get a maestro-media:// URL, so a remote .mp3 keeps the
			// binary "download and open externally" preview.
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: '<binary>',
					sshRemoteId: 'remote-1',
				});
			});

			expect(getSession().filePreviewTabs).toHaveLength(1);
			expect(useMediaPlaybackStore.getState().items).toHaveLength(0);
		});
	});

	it('opens a new file tab next to the active tab', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'content',
				lastModified: 55,
			});
		});

		const session = getSession();
		expect(session.filePreviewTabs[0]).toMatchObject({
			path: '/repo/src/app.ts',
			name: 'app',
			extension: '.ts',
			content: 'content',
			lastModified: 55,
		});
		expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
		expect(session.unifiedTabOrder.map((ref) => ref.type)).toEqual(['ai', 'file']);
	});

	// Opening a file must take over the panel; a stale activeGroupId would keep the
	// tiled group winning the render precedence so the file never shows / gets focus.
	it('leaves an active tiled group when opening a new file tab (double-click default)', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/b.ts', name: 'b.ts', content: 'b' });
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe(getSession().filePreviewTabs[0].id);
	});

	it('leaves an active tiled group when re-opening an existing file tab by path', () => {
		const existing = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({ filePreviewTabs: [existing], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/a.ts', name: 'a.ts', content: 'a2' });
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe('file-1');
	});

	// A file already open but tiled INSIDE a group has no standalone chip (it lives
	// only as a leaf in the group layout). Re-opening it (e.g. double-clicking it in
	// the file explorer) must activate its group and focus that pane, NOT clear
	// activeGroupId - otherwise focus is stranded and nothing appears to happen.
	it('focuses the group pane when re-opening a file already tiled into a group', () => {
		const tiled = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({
			filePreviewTabs: [tiled],
			activeGroupId: null,
			activeTabId: 'ai-1',
			// The file lives only inside the group; its standalone ref is not in the order.
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'group', id: 'g1' },
			],
			tabGroups: [
				{
					id: 'g1',
					name: 'Group',
					createdAt: 0,
					focusedPaneId: 'leaf-ai',
					layout: {
						kind: 'split',
						id: 'split-1',
						direction: 'row',
						sizes: [0.5, 0.5],
						children: [
							{ kind: 'leaf', id: 'leaf-ai', tab: { type: 'ai', id: 'ai-1' } },
							{ kind: 'leaf', id: 'leaf-file', tab: { type: 'file', id: 'file-1' } },
						],
					},
				},
			] as never,
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/a.ts', name: 'a.ts', content: 'a2' });
		});

		const s = getSession();
		// Group is activated and its focused pane points at the file's leaf.
		expect(s.activeGroupId).toBe('g1');
		expect(s.tabGroups[0].focusedPaneId).toBe('leaf-file');
		expect(s.activeFileTabId).toBe('file-1');
		expect(s.inputMode).toBe('ai');
		// The file must NOT be resurrected as a standalone ref in the strip order.
		expect(s.unifiedTabOrder.some((ref) => ref.type === 'file' && ref.id === 'file-1')).toBe(false);
		// Content is still refreshed on the tiled tab.
		expect(s.filePreviewTabs.find((t) => t.id === 'file-1')?.content).toBe('a2');
	});

	it('leaves an active tiled group when replacing the current file tab in place', () => {
		const existing = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({
			filePreviewTabs: [existing],
			activeFileTabId: 'file-1',
			activeGroupId: 'group-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/c.ts', name: 'c.ts', content: 'c' },
				{ openInNewTab: false }
			);
		});

		expect(getSession().activeGroupId).toBeNull();
	});

	it('leaves an active tiled group when creating a new untitled file tab', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleNewFileTab();
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe(getSession().filePreviewTabs[0].id);
	});

	it('clears the active browser tab when opening a new file tab', () => {
		setupSession({
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'content',
			});
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
		expect(session.inputMode).toBe('ai');
	});

	it('clears the active browser tab when re-opening an existing file tab', () => {
		const fileTab = createMockFileTab({ id: 'file-1', path: '/repo/src/app.ts' });
		setupSession({
			filePreviewTabs: [fileTab],
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'new',
			});
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe('file-1');
		expect(session.inputMode).toBe('ai');
	});

	it('clears the active browser tab when replacing the current file tab in place', () => {
		const fileTab = createMockFileTab({ id: 'file-1', path: '/repo/b.ts', name: 'b' });
		setupSession({
			filePreviewTabs: [fileTab],
			activeFileTabId: 'file-1',
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/d.ts', name: 'd.ts', content: 'd' },
				{ openInNewTab: false }
			);
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe('file-1');
		expect(session.filePreviewTabs[0].path).toBe('/repo/d.ts');
		expect(session.inputMode).toBe('ai');
	});

	it('updates and selects an existing file tab by path', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/src/app.ts',
			content: 'old',
			isLoading: true,
			loadRequestId: 'load-1',
		});
		setupSession({ filePreviewTabs: [fileTab] });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'new',
				lastModified: 99,
			});
		});

		expect(getSession().filePreviewTabs[0]).toMatchObject({
			content: 'new',
			lastModified: 99,
			isLoading: false,
			loadRequestId: undefined,
		});
		expect(getSession().activeFileTabId).toBe('file-1');
	});

	it('replaces the active file tab and truncates forward history', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/b.ts',
			name: 'b',
			navigationHistory: [
				{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/repo/c.ts', name: 'c', scrollTop: 3 },
			],
			navigationIndex: 1,
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/d.ts', name: 'd.ts', content: 'd' },
				{ openInNewTab: false }
			);
		});

		expect(getSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/d.ts',
			name: 'd',
			navigationIndex: 2,
		});
		expect(getSession().filePreviewTabs[0].navigationHistory).toEqual([
			{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
			{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
			{ path: '/repo/d.ts', name: 'd', scrollTop: 0 },
		]);
	});

	it('confirms before closing an edited file tab and cancels a loading read on confirm', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			name: 'app',
			extension: '.ts',
			editContent: 'dirty',
			isLoading: true,
			loadRequestId: 'load-1',
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleCloseFileTab('file-1');
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.message).toContain('has unsaved changes');

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(window.maestro.fs.cancelReadFile).toHaveBeenCalledWith('load-1');
		expect(getSession().filePreviewTabs).toHaveLength(0);
	});

	it('auto-refreshes stale file content on selection when enabled', async () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/app.ts',
			content: 'old',
			lastModified: 1,
		});
		setupSession({ filePreviewTabs: [fileTab] });
		useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			modifiedAt: new Date(5000).toISOString(),
		} as any);
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('fresh');
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		await act(async () => {
			await result.current.handleSelectFileTab('file-1');
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/app.ts', undefined);
		expect(getSession().activeFileTabId).toBe('file-1');
		expect(getSession().filePreviewTabs[0].content).toBe('fresh');
	});

	it('navigates to an arbitrary file history index using the current SSH remote', async () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			sshRemoteId: 'remote-1',
			navigationHistory: [
				{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
			],
			navigationIndex: 0,
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('b-content');
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		await act(async () => {
			await result.current.handleFileTabNavigateToIndex(1);
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/b.ts', 'remote-1');
		expect(getSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/b.ts',
			content: 'b-content',
			scrollTop: 2,
			navigationIndex: 1,
		});
	});

	// A tiled file pane is not the active file tab (focusing a pane does not set
	// activeFileTabId), so back / forward / breadcrumb-jump all take an explicit tab
	// id. Without it a pane would navigate whichever other file tab was active.
	describe('navigation addressed by tab id', () => {
		const withTwoFileTabs = () => {
			const history = [
				{ path: '/repo/a.ts', name: 'a' },
				{ path: '/repo/b.ts', name: 'b' },
				{ path: '/repo/c.ts', name: 'c' },
			];
			setupSession({
				filePreviewTabs: [
					createMockFileTab({ id: 'active-tab', navigationHistory: history, navigationIndex: 0 }),
					createMockFileTab({ id: 'pane-tab', navigationHistory: history, navigationIndex: 1 }),
				],
				activeFileTabId: 'active-tab',
			});
			vi.mocked(window.maestro.fs.readFile).mockResolvedValue('loaded');
		};

		it('navigates back on the addressed tab, leaving the active one alone', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateBack('pane-tab');
			});

			expect(getSession().filePreviewTabs[1]).toMatchObject({
				path: '/repo/a.ts',
				navigationIndex: 0,
			});
			expect(getSession().filePreviewTabs[0].navigationIndex).toBe(0);
		});

		it('navigates forward on the addressed tab', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateForward('pane-tab');
			});

			expect(getSession().filePreviewTabs[1]).toMatchObject({
				path: '/repo/c.ts',
				navigationIndex: 2,
			});
		});

		it('still defaults to the active file tab when no id is given', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateForward();
			});

			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/repo/b.ts',
				navigationIndex: 1,
			});
			expect(getSession().filePreviewTabs[1].navigationIndex).toBe(1);
		});

		it('does nothing at either end of the history', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				// active-tab sits at index 0 (no back), pane-tab walked to the end below.
				await result.current.handleFileTabNavigateBack('active-tab');
				await result.current.handleFileTabNavigateToIndex(2, 'pane-tab');
				await result.current.handleFileTabNavigateForward('pane-tab');
			});

			expect(getSession().filePreviewTabs[0].navigationIndex).toBe(0);
			expect(getSession().filePreviewTabs[1].navigationIndex).toBe(2);
		});
	});
});

// ===== from src/__tests__/renderer/hooks/tabs/internal/useUnifiedTabHandlers.test.ts =====
/** Find the leaf id whose tab ref matches, so a test can focus a specific pane. */
function leafIdForTab(group: TabGroup, ref: UnifiedTabRef): string {
	let id: string | null = null;
	const walk = (node: PanelLayoutNode): void => {
		if (id) return;
		if (node.kind === 'leaf') {
			if (node.tab.type === ref.type && node.tab.id === ref.id) id = node.id;
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	if (!id) throw new Error(`No leaf for ${ref.type}:${ref.id}`);
	return id;
}

/** Build a two-pane group and focus the pane holding `focusOn`. */
function groupFocusedOn(members: UnifiedTabRef[], focusOn: UnifiedTabRef): TabGroup {
	const group = createGroupFromTabRefs(members, 'Group');
	return { ...group, focusedPaneId: leafIdForTab(group, focusOn) };
}

const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

describe('useUnifiedTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('reorders the unified tab order by tab id, ignoring ids that are not in it', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
			result.current.handleUnifiedTabReorder('ai-1', 'gone');
		});

		expect(getSession().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-1' },
		]);
	});

	it('reorders the visible chips when hidden tabs sit between them', () => {
		// The strip renders buildUnifiedTabs, which drops hidden consult tabs while
		// their refs stay in the order. Addressing the drop by POSITION moved the
		// hidden ref instead and the strip never changed - the reported bug.
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'consult-1', hidden: true }),
				createMockAITab({ id: 'consult-2', hidden: true }),
				createMockAITab({ id: 'ai-2' }),
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
		});

		expect(getSession().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'consult-1' },
			{ type: 'ai', id: 'consult-2' },
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-1' },
		]);
	});

	it('returns close-current metadata for active AI tabs without closing them', () => {
		const aiTab = createMockAITab({
			id: 'ai-1',
			inputValue: 'draft',
			wizardState: { isActive: true, currentStep: 'intent' } as any,
		});
		setupSession({ aiTabs: [aiTab] });
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'ai',
			tabId: 'ai-1',
			isWizardTab: true,
			hasWizardUserInteraction: true,
			hasDraft: true,
		});
		expect(getSession().aiTabs).toHaveLength(1);
	});

	it('delegates active file close to file preview handlers', () => {
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const handleCloseFileTab = vi.fn();
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab }));

		expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'file', tabId: 'file-1' });
		expect(handleCloseFileTab).toHaveBeenCalledWith('file-1');
	});

	it('closes browser current tab immediately and returns browser result', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [aiTab],
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'browser', id: 'browser-1' },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'browser',
			tabId: 'browser-1',
		});
		expect(getSession().browserTabs).toEqual([]);
	});

	it('closes other mixed tabs, kills terminal processes, and ends closed wizard tabs', async () => {
		const active = createMockAITab({ id: 'ai-active' });
		const wizard = createMockAITab({
			id: 'wizard-1',
			wizardState: { isActive: true } as any,
		});
		const fileTab = createMockFileTab({ id: 'file-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [active, wizard],
			filePreviewTabs: [fileTab],
			browserTabs: [browserTab],
			terminalTabs: [terminalTab],
			activeTabId: active.id,
			unifiedTabOrder: [
				{ type: 'ai', id: active.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'terminal', id: terminalTab.id },
				{ type: 'ai', id: wizard.id },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseOtherTabs();
		});

		expect(getSession().unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-active' }]);
		expect(window.maestro.process.kill).toHaveBeenCalledWith('test-session-terminal-term-1');
		await vi.waitFor(() => {
			expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1');
		});
	});

	describe('Cmd+W with an active tiled group closes only the focused pane', () => {
		it('targets the focused AI pane, not a lingering standalone activeTabId', () => {
			const paneA = createMockAITab({ id: 'ai-A', inputValue: 'draft' });
			const paneB = createMockAITab({ id: 'ai-B' });
			const standalone = createMockAITab({ id: 'ai-standalone' });
			const group = groupFocusedOn(
				[
					{ type: 'ai', id: 'ai-A' },
					{ type: 'ai', id: 'ai-B' },
				],
				{ type: 'ai', id: 'ai-A' }
			);
			setupSession({
				aiTabs: [paneA, paneB, standalone],
				tabGroups: [group],
				activeGroupId: group.id,
				// A stale standalone selection that the old code path would have closed instead.
				activeTabId: 'ai-standalone',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-standalone' },
					{ type: 'group', id: group.id },
				],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({
				type: 'ai',
				tabId: 'ai-A',
				isWizardTab: false,
				hasWizardUserInteraction: false,
				hasDraft: true,
			});
		});

		it('delegates a focused file pane to the file close handler', () => {
			const fileTab = createMockFileTab({ id: 'file-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'file', id: 'file-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				filePreviewTabs: [fileTab],
				tabGroups: [group],
				activeGroupId: group.id,
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const handleCloseFileTab = vi.fn();
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab }));

			expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'file', tabId: 'file-1' });
			expect(handleCloseFileTab).toHaveBeenCalledWith('file-1');
		});

		it('closes a focused browser pane immediately and returns the browser result', () => {
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'browser', id: 'browser-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'browser', id: 'browser-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				browserTabs: [browserTab],
				tabGroups: [group],
				activeGroupId: group.id,
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({
				type: 'browser',
				tabId: 'browser-1',
			});
			expect(getSession().browserTabs).toEqual([]);
		});

		it('returns the terminal result for a focused terminal pane (keyboard handler kills the PTY)', () => {
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'terminal', id: 'term-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'terminal', id: 'term-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				terminalTabs: [terminalTab],
				tabGroups: [group],
				activeGroupId: group.id,
				// Group is active in AI input mode; the standalone terminal-mode guard must not fire.
				inputMode: 'ai',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'terminal', tabId: 'term-1' });
		});
	});

	it('preserves tabs with unsent drafts and closes the rest silently', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
				createMockAITab({ id: 'ai-3' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		// ai-2 (draft) survives; ai-3 closes. No confirmation modal is opened.
		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});

	it('does not close anything when the only tab in the set has a draft', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});
});
