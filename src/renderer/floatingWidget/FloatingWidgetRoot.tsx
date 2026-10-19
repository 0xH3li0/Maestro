/**
 * FloatingWidgetRoot - render entry for a desktop-level widget window.
 *
 * The main process loads the main renderer bundle into a small frameless,
 * transparent window with `?floatingWidget=<id>`, and main.tsx mounts this
 * instead of the full app. Like CadenzaHudRoot (`../cadenzaHud.tsx`), it boots
 * only what a widget needs: the user's settings (for the theme and fonts) and
 * the one widget body the id names. Each body draws its own
 * `FloatingWidgetFrame`, so it owns its title, actions and close behavior.
 *
 * An id this build does not know renders nothing: the window stays a
 * transparent, empty rectangle rather than a broken widget, and the reason
 * goes to the log.
 */

import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { LayoutPanelTop } from 'lucide-react';
import { isFloatingWidgetId, type FloatingWidgetId } from '../../shared/floatingWidgets';
import { useWindowSettingsSync } from '../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../hooks/ui/useResolvedTheme';
import { logger } from '../utils/logger';
import type { Theme } from '../types';
import { FloatingWidgetFrame } from './FloatingWidgetFrame';
import { ThroughputGaugeWidget } from './ThroughputGaugeWidget';

/** The URL parameter that names the widget a window hosts. */
export const FLOATING_WIDGET_QUERY_PARAM = 'floatingWidget';

export interface FloatingWidgetBodyProps {
	theme: Theme;
}

/**
 * Temporary body until the real widget lands (phase 04 of the
 * floating-widgets plan). Its close hides the window, which main keeps.
 */
function placeholderBody(
	id: FloatingWidgetId,
	title: string
): ComponentType<FloatingWidgetBodyProps> {
	function PlaceholderBody({ theme }: FloatingWidgetBodyProps) {
		return (
			<FloatingWidgetFrame
				theme={theme}
				icon={<LayoutPanelTop className="w-3.5 h-3.5" />}
				title={title}
				onClose={() => void window.maestro?.floatingWidgets?.hide(id)}
				closeLabel={`Hide ${title}`}
			>
				<div
					className="flex-1 flex items-center justify-center text-xs"
					style={{ color: theme.colors.textDim }}
				>
					{title}
				</div>
			</FloatingWidgetFrame>
		);
	}
	PlaceholderBody.displayName = `PlaceholderBody(${id})`;
	return PlaceholderBody;
}

/** The body each widget id renders. */
const WIDGET_BODIES: Record<FloatingWidgetId, ComponentType<FloatingWidgetBodyProps>> = {
	'throughput-gauge': ThroughputGaugeWidget,
	'media-player': placeholderBody('media-player', 'Media Player'),
};

function readWidgetParam(): string | null {
	return new URLSearchParams(window.location.search).get(FLOATING_WIDGET_QUERY_PARAM);
}

export function FloatingWidgetRoot() {
	const param = readWidgetParam();

	useEffect(() => {
		if (!isFloatingWidgetId(param)) {
			logger.warn(`Unknown floating widget id: ${String(param)}`, 'FloatingWidget');
		}
	}, [param]);

	if (!isFloatingWidgetId(param)) return null;
	return <FloatingWidgetHost id={param} />;
}

function FloatingWidgetHost({ id }: { id: FloatingWidgetId }) {
	// Load settings once, reload them when another window or the CLI changes
	// them, and publish the typography: the window-settings bundle every
	// secondary window shares.
	useWindowSettingsSync();
	const theme = useResolvedTheme();

	// Tell main the body mounted (and subscribed), so commands it held for this
	// window can be delivered. The ref keeps StrictMode's remount from sending twice.
	const readySent = useRef(false);
	useEffect(() => {
		if (readySent.current) return;
		readySent.current = true;
		window.maestro?.floatingWidgets?.ready(id);
	}, [id]);

	const Body = WIDGET_BODIES[id];
	return <Body theme={theme} />;
}
