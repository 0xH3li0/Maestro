/**
 * Tests for MediaPlayerWidget, the media player's desktop-window body. This
 * window is the authority: it owns the one media element, shows and hides its
 * window from the store, dismisses on its X, applies commands the primary
 * window forwards, and hydrates the persisted queue.
 */
import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaPlayerWidget } from '../../../renderer/floatingWidget/MediaPlayerWidget';
import {
	MEDIA_QUEUE_SETTINGS_KEY,
	setMediaQueuePersistEnabled,
	useMediaPlaybackStore,
} from '../../../renderer/stores/mediaPlaybackStore';
import { loadAllSettings } from '../../../renderer/stores/settingsStore';
import type { MediaItem } from '../../../renderer/utils/mediaItems';
import { mockTheme } from '../../helpers/mockTheme';

/** Counts constructions of the player element; a re-render reuses it. */
const mountCount = vi.fn();

vi.mock('../../../renderer/components/FilePreview/MediaViewer', () => ({
	MediaViewer: () => {
		useEffect(() => {
			mountCount();
		}, []);
		return <div data-testid="media-viewer" />;
	},
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const originalWidgets = maestro.floatingWidgets;

const podcast: MediaItem = {
	id: 's1::/files/podcast.mp3',
	path: '/files/podcast.mp3',
	name: 'podcast.mp3',
	sessionId: 's1',
	sessionName: 'Agent One',
	kind: 'audio',
};

let api: {
	show: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
	publishState: ReturnType<typeof vi.fn>;
	onCommand: ReturnType<typeof vi.fn>;
};
let commandHandler: ((command: unknown) => void) | null;

function resetStore() {
	useMediaPlaybackStore.setState({
		items: [],
		activeItemId: null,
		history: [],
		playing: false,
		dismissed: false,
		dormant: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		focusRequest: 0,
		resumeTimes: {},
		durations: {},
		aspects: {},
	});
}

function load(item: MediaItem, dismissed = false) {
	useMediaPlaybackStore.setState({ items: [item], activeItemId: item.id, dismissed });
}

const renderWidget = () => render(<MediaPlayerWidget theme={mockTheme} />);

beforeEach(() => {
	vi.clearAllMocks();
	commandHandler = null;
	api = {
		show: vi.fn().mockResolvedValue(true),
		hide: vi.fn().mockResolvedValue(false),
		publishState: vi.fn(),
		onCommand: vi.fn((_id: string, handler: (command: unknown) => void) => {
			commandHandler = handler;
			return () => {
				commandHandler = null;
			};
		}),
	};
	maestro.floatingWidgets = api;
	resetStore();
});

afterEach(() => {
	maestro.floatingWidgets = originalWidgets;
	setMediaQueuePersistEnabled(true);
});

describe('MediaPlayerWidget', () => {
	it('renders one player element and keeps it mounted across dismiss and restore', () => {
		load(podcast);
		renderWidget();
		expect(screen.getAllByTestId('media-viewer')).toHaveLength(1);
		expect(mountCount).toHaveBeenCalledTimes(1);

		act(() => useMediaPlaybackStore.getState().dismiss());
		act(() => useMediaPlaybackStore.getState().restore());
		expect(screen.getAllByTestId('media-viewer')).toHaveLength(1);
		expect(mountCount).toHaveBeenCalledTimes(1);
	});

	it('titles the frame with the file name and the agent', () => {
		load(podcast);
		renderWidget();
		const strip = screen.getByTestId('floating-widget-title-strip');
		expect(strip).toHaveTextContent('podcast.mp3');
		expect(strip).toHaveTextContent('Agent One');
	});

	it('renders nothing and hides the window with nothing loaded', () => {
		renderWidget();
		expect(screen.queryByTestId('floating-widget-frame')).toBeNull();
		expect(api.hide).toHaveBeenCalledWith('media-player');
		expect(api.show).not.toHaveBeenCalled();
	});

	it('shows the window for a loaded item and hides it on dismiss', () => {
		load(podcast);
		renderWidget();
		expect(api.show).toHaveBeenLastCalledWith('media-player');

		act(() => useMediaPlaybackStore.getState().dismiss());
		expect(api.hide).toHaveBeenLastCalledWith('media-player');

		act(() => useMediaPlaybackStore.getState().restore());
		expect(api.show).toHaveBeenCalledTimes(2);
	});

	it('hides the window when the last item closes', () => {
		load(podcast);
		renderWidget();
		act(() => useMediaPlaybackStore.getState().closeItem(podcast.id));
		expect(api.hide).toHaveBeenLastCalledWith('media-player');
		expect(screen.queryByTestId('media-viewer')).toBeNull();
	});

	it('dismisses on its close button without stopping playback', () => {
		load(podcast);
		useMediaPlaybackStore.setState({ playing: true });
		renderWidget();

		fireEvent.click(screen.getByTestId('floating-widget-close'));

		const state = useMediaPlaybackStore.getState();
		expect(state.dismissed).toBe(true);
		expect(state.playing).toBe(true);
		expect(state.activeItemId).toBe(podcast.id);
		expect(screen.getByTestId('media-viewer')).toBeInTheDocument();
	});

	it('dismisses on Escape', () => {
		load(podcast);
		renderWidget();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(useMediaPlaybackStore.getState().dismissed).toBe(true);
	});

	it('releases the player on its stop button', () => {
		load(podcast);
		renderWidget();
		fireEvent.click(screen.getByTestId('media-stop'));
		expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
	});

	it('publishes its snapshot and applies forwarded commands as the authority', () => {
		renderWidget();
		expect(api.publishState).toHaveBeenCalledWith(
			'media-player',
			expect.objectContaining({ items: [], activeItemId: null })
		);

		const request = {
			path: podcast.path,
			name: podcast.name,
			sessionId: podcast.sessionId,
			sessionName: podcast.sessionName,
			kind: podcast.kind,
		};
		act(() => commandHandler?.({ type: 'action', action: 'openMedia', args: [request] }));
		expect(useMediaPlaybackStore.getState().activeItemId).toBe(podcast.id);
		expect(api.show).toHaveBeenLastCalledWith('media-player');

		// Anything outside the command union is dropped.
		act(() => commandHandler?.({ type: 'action', action: 'setPlaying', args: [true] }));
		expect(useMediaPlaybackStore.getState().playing).toBe(false);
	});

	describe('persisted queue', () => {
		const settings = () =>
			window.maestro.settings as unknown as { getAll: ReturnType<typeof vi.fn> };

		afterEach(() => {
			settings().getAll.mockImplementation(() => Promise.resolve({}));
		});

		function persist() {
			settings().getAll.mockResolvedValue({
				[MEDIA_QUEUE_SETTINGS_KEY]: {
					items: [podcast],
					activeItemId: podcast.id,
					resumeTimes: { [podcast.id]: 42 },
					durations: {},
				},
			});
		}

		it('loads the persisted queue hidden, paused and dormant', async () => {
			persist();
			renderWidget();
			await act(async () => {
				await loadAllSettings();
			});

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toEqual([podcast]);
			expect(state.activeItemId).toBe(podcast.id);
			expect(state.resumeTimes[podcast.id]).toBe(42);
			expect(state.dismissed).toBe(true);
			expect(state.dormant).toBe(true);
			expect(state.playing).toBe(false);
			// Loaded but dismissed: mounted, with the window still hidden.
			expect(screen.getByTestId('media-viewer')).toBeInTheDocument();
			expect(api.show).not.toHaveBeenCalled();
		});

		it('is not hydrated by a replica window', async () => {
			persist();
			setMediaQueuePersistEnabled(false);
			await loadAllSettings();
			expect(useMediaPlaybackStore.getState().items).toEqual([]);
		});
	});
});
