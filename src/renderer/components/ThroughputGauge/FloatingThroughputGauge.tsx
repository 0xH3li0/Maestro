/**
 * FloatingThroughputGauge - the card the Throughput Gauge lives in.
 *
 * Floats over the Main Window like the media player (`FloatingMediaPlayer`),
 * follows the user across agents and tabs, and is dragged by its title strip.
 * It opens parked bottom-left so it never lands on the media player, which
 * opens bottom-right.
 *
 * The card is clamped inside the viewport on every drag step and on window
 * resize, and kept below the custom title strip when one is drawn: that strip
 * is an OS drag region, so a card pushed under it would stop taking clicks.
 *
 * The gear beside close opens the settings popover. The dial shows the chosen
 * metric. Until the other styles and the three-gauge layout exist, every style
 * and layout draws the dial; the choice is still saved.
 */

import { memo, useCallback, useRef, useState, type CSSProperties } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Gauge, GripVertical, Settings, X } from 'lucide-react';

import { throughputGaugeCaption } from '../../../shared/throughputGauge';
import { AnalogDial } from './AnalogDial';
import { ThroughputGaugeSettingsPopover } from './ThroughputGaugeSettingsPopover';
import { GhostIconButton } from '../ui/GhostIconButton';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useMobileLandscape } from '../../hooks/remote/useMobileLandscape';
import { useViewportBreakpoint } from '../../hooks/ui/useViewportBreakpoint';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { APP_TITLE_STRIP_HEIGHT, shouldShowAppTitleStrip } from '../../utils/appTitleStrip';
import type { Theme } from '../../types';

/** Fixed card size for now; the card is not resizable yet. */
export const THROUGHPUT_GAUGE_CARD_WIDTH = 208;
export const THROUGHPUT_GAUGE_CARD_HEIGHT = 212;
/** Gap kept between the card and the window edges. */
export const THROUGHPUT_GAUGE_EDGE_MARGIN = 24;
/** Same layer as the media player: above the panels, below modals and toasts. */
const FLOAT_Z_INDEX = 60;

export interface GaugePosition {
	left: number;
	top: number;
}

interface GaugeViewport {
	width: number;
	height: number;
	/** Height at the top the card must stay below (the custom title strip). */
	top: number;
}

/** Keep the whole card on screen and below the title strip. */
export function clampGaugePosition(
	position: GaugePosition,
	viewport: GaugeViewport
): GaugePosition {
	const maxLeft = Math.max(0, viewport.width - THROUGHPUT_GAUGE_CARD_WIDTH);
	const maxTop = Math.max(viewport.top, viewport.height - THROUGHPUT_GAUGE_CARD_HEIGHT);
	return {
		left: Math.min(Math.max(0, position.left), maxLeft),
		top: Math.min(Math.max(viewport.top, position.top), maxTop),
	};
}

/** Where the card opens: bottom-left, clear of the media player's corner. */
export function initialGaugePosition(viewport: GaugeViewport): GaugePosition {
	return clampGaugePosition(
		{
			left: THROUGHPUT_GAUGE_EDGE_MARGIN,
			top: viewport.height - THROUGHPUT_GAUGE_CARD_HEIGHT - THROUGHPUT_GAUGE_EDGE_MARGIN,
		},
		viewport
	);
}

interface FloatingThroughputGaugeProps {
	theme: Theme;
}

export const FloatingThroughputGauge = memo(function FloatingThroughputGauge({
	theme,
}: FloatingThroughputGaugeProps) {
	const { metric, scope } = useSettingsStore((s) => s.throughputGaugeSettings);
	const value = useThroughputGaugeStore((s) => s.rates[metric]);
	const peak = useThroughputGaugeStore((s) => s.peak[metric]);
	const hide = useThroughputGaugeStore((s) => s.hide);
	const activeAgentName = useSessionStore((s) =>
		scope === 'active' ? (selectActiveSession(s)?.name ?? null) : null
	);

	const [settingsOpen, setSettingsOpen] = useState(false);
	const gearRef = useRef<HTMLButtonElement>(null);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);

	// Asked through the same predicate AppShell uses to draw the strip, so the
	// two cannot disagree about where the drag region is.
	const useNativeTitleBar = useSettingsStore((s) => s.useNativeTitleBar);
	const isMobileLandscape = useMobileLandscape();
	const { isMdDown: isMdDownViewport } = useViewportBreakpoint();
	const topInset = shouldShowAppTitleStrip({
		isMobileLandscape,
		useNativeTitleBar,
		isMdDownViewport,
	})
		? APP_TITLE_STRIP_HEIGHT
		: 0;
	const topInsetRef = useRef(topInset);
	topInsetRef.current = topInset;
	const viewport = useCallback(
		(): GaugeViewport => ({
			width: window.innerWidth,
			height: window.innerHeight,
			top: topInsetRef.current,
		}),
		[]
	);

	const [position, setPosition] = useState<GaugePosition>(() => initialGaugePosition(viewport()));
	const [dragging, setDragging] = useState(false);
	const startDrag = usePointerDrag();

	const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		const origin = position;
		const endDrag = () => setDragging(false);
		startDrag(
			e,
			(dx, dy) => {
				setDragging(true);
				setPosition(
					clampGaugePosition({ left: origin.left + dx, top: origin.top + dy }, viewport())
				);
			},
			{ ignoreButtons: true, onEnd: endDrag, onCancel: endDrag }
		);
	};

	// A smaller window can leave the card partly off screen; pull it back in.
	useEventListener('resize', () => setPosition((prev) => clampGaugePosition(prev, viewport())));

	return (
		<div
			data-testid="floating-throughput-gauge"
			className="fixed flex flex-col rounded-lg shadow-2xl border overflow-hidden select-none"
			style={
				{
					left: position.left,
					top: Math.max(position.top, topInset),
					width: THROUGHPUT_GAUGE_CARD_WIDTH,
					height: THROUGHPUT_GAUGE_CARD_HEIGHT,
					zIndex: FLOAT_Z_INDEX,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					// The OS would swallow clicks on any part of the card that ever
					// overlapped the title strip's drag region. Opt the card out.
					WebkitAppRegion: 'no-drag',
				} as CSSProperties
			}
		>
			{/* Title strip doubles as the drag handle. */}
			<div
				className="shrink-0 flex items-center gap-1.5 pl-1 pr-1.5 h-8 border-b"
				style={{ borderColor: theme.colors.border, cursor: dragging ? 'grabbing' : 'grab' }}
				onPointerDown={onDragStart}
				title="Drag to move"
			>
				<GripVertical
					className="w-3.5 h-4 shrink-0 opacity-60"
					style={{ color: theme.colors.textDim }}
					aria-hidden
				/>
				<Gauge
					className="w-3.5 h-3.5 shrink-0"
					style={{ color: theme.colors.accent }}
					aria-hidden
				/>
				<span
					className="text-xs font-medium truncate flex-1"
					style={{ color: theme.colors.textMain }}
				>
					Throughput
				</span>
				<GhostIconButton
					ref={gearRef}
					onClick={() => setSettingsOpen((open) => !open)}
					title="Gauge settings"
					ariaLabel="Throughput gauge settings"
					pressed={settingsOpen}
					color={settingsOpen ? theme.colors.accent : theme.colors.textDim}
					testId="throughput-gauge-settings-button"
				>
					<Settings className="w-3.5 h-3.5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={hide}
					title="Close gauge"
					ariaLabel="Close throughput gauge"
					color={theme.colors.textDim}
					testId="throughput-gauge-close"
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>

			<div className="flex-1 min-h-0 flex items-center justify-center px-2 pb-1">
				<AnalogDial
					theme={theme}
					value={value}
					peak={peak}
					label="tok/s"
					caption={throughputGaugeCaption(metric, scope, activeAgentName)}
				/>
			</div>

			{settingsOpen && (
				<ThroughputGaugeSettingsPopover theme={theme} anchorRef={gearRef} onClose={closeSettings} />
			)}
		</div>
	);
});
