/**
 * MediaPlayerWidget - the media player in its own desktop-level window.
 *
 * Unlike the gauge, this window is the AUTHORITY: it owns the one media
 * element app-wide, its `useMediaPlaybackStore` is the real store, and it
 * persists the queue. The primary window's store is a replica that mirrors the
 * snapshot published here and forwards every command it is given (see
 * `stores/mediaPlaybackReplica.ts`).
 *
 * The persisted queue hydrates through the window-settings bundle
 * `FloatingWidgetRoot` runs (`loadAllSettings`), exactly as the primary window
 * does in the browser build: back hidden, paused and dormant. The root reports
 * the window ready only after that load, so a command main held for this window
 * (the first `open-file`) lands on the hydrated queue instead of racing it.
 *
 * The window shows while there is a loaded, undismissed item and hides
 * otherwise. The X and Escape dismiss (minimize): the audio keeps going and the
 * primary window's Now Playing pill brings the window back. The stop button is
 * what releases the player.
 */

import { memo, useCallback, useEffect } from 'react';
import { Copy, FileAudio, FileVideo, Square } from 'lucide-react';

import { ActiveMediaPlayer } from '../components/MediaPlayback/ActiveMediaPlayer';
import { copyMediaFileName } from '../components/MediaPlayback/copyMediaFileName';
import { useMediaListControls } from '../components/MediaPlayback/useMediaListControls';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	flushMediaQueuePersist,
	selectActiveMediaItem,
	useMediaPlaybackStore,
} from '../stores/mediaPlaybackStore';
import { installMediaPlaybackAuthority } from '../stores/mediaPlaybackReplica';
import type { Theme } from '../types';
import { FloatingWidgetFrame } from './FloatingWidgetFrame';

const WIDGET_ID = 'media-player';

interface MediaPlayerWidgetProps {
	theme: Theme;
}

export const MediaPlayerWidget = memo(function MediaPlayerWidget({
	theme,
}: MediaPlayerWidgetProps) {
	const active = useMediaPlaybackStore(selectActiveMediaItem);
	const dismissed = useMediaPlaybackStore((s) => s.dismissed);
	const dismiss = useMediaPlaybackStore((s) => s.dismiss);
	const closeItem = useMediaPlaybackStore((s) => s.closeItem);

	useEffect(() => installMediaPlaybackAuthority(), []);

	// Queue writes are debounced, so a window closing mid-debounce would lose the
	// last position (or the last thing queued). Flush before it goes away.
	useEventListener('beforeunload', flushMediaQueuePersist);

	const visible = active !== null && !dismissed;
	useEffect(() => {
		const api = window.maestro?.floatingWidgets;
		if (!api) return;
		void (visible ? api.show(WIDGET_ID) : api.hide(WIDGET_ID));
	}, [visible]);

	const {
		openList,
		closeList,
		buttons: listButtons,
		menus: listMenus,
	} = useMediaListControls({
		theme,
	});

	// Escape (and the X) close the innermost thing first: an open list, then the
	// player, which minimizes rather than stops so a reflexive key never kills
	// playback. A fullscreen video is already using Escape to leave fullscreen.
	const handleClose = useCallback(() => {
		if (document.fullscreenElement) return;
		if (openList) closeList();
		else dismiss();
	}, [openList, closeList, dismiss]);

	if (!active) return null;

	const KindIcon = active.kind === 'video' ? FileVideo : FileAudio;

	return (
		<FloatingWidgetFrame
			theme={theme}
			icon={<KindIcon className="w-3.5 h-3.5" />}
			title={active.name}
			subtitle={active.sessionName}
			onClose={handleClose}
			closeLabel="Minimize player (keeps playing)"
			actions={
				<>
					<GhostIconButton
						onClick={() => void copyMediaFileName(active.name)}
						title="Copy file name"
						ariaLabel="Copy file name"
						color={theme.colors.textDim}
						testId="media-copy-name"
					>
						<Copy className="w-3.5 h-3.5" />
					</GhostIconButton>
					{listButtons}
					<GhostIconButton
						onClick={() => closeItem(active.id)}
						title="Close player (stops playback)"
						ariaLabel="Close player and stop playback"
						color={theme.colors.textDim}
						testId="media-stop"
					>
						<Square className="w-3.5 h-3.5" />
					</GhostIconButton>
				</>
			}
		>
			<div data-testid="media-player-widget" className="flex-1 min-h-0">
				<ActiveMediaPlayer item={active} theme={theme} />
			</div>
			{listMenus}
		</FloatingWidgetFrame>
	);
});
