/**
 * PanelResizeHandle - the thin strip on a side panel's edge that the user drags
 * to change the panel's width. Pair it with `useResizablePanel()`: hand it the
 * hook's `onResizeStart`, and put it inside the panel, which must be
 * `position: relative`.
 *
 * The strip is 12px wide for an easy grab and draws a 4px line on its outer
 * edge while hovered. The `.resize-handle` class (index.css) sets
 * `touch-action: none`, so a touch drag is not taken as a scroll, and widens
 * the hit area under a coarse pointer. Pass `onReset` to make a double-click
 * restore the default width.
 */

import type React from 'react';

export interface PanelResizeHandleProps {
	/** `onResizeStart` from `useResizablePanel()`. */
	onResizeStart: (event: React.PointerEvent) => void;
	/** Double-click restores the default width. */
	onReset?: () => void;
	/** The panel edge the handle sits on: 'left' for a panel docked right. */
	edge?: 'left' | 'right';
	/** Accessible name, such as "Resize the Collaborate panel". */
	label?: string;
}

export function PanelResizeHandle({
	onResizeStart,
	onReset,
	edge = 'left',
	label,
}: PanelResizeHandleProps) {
	const placement = edge === 'left' ? 'left-0 border-l-4' : 'right-0 border-r-4';
	return (
		<div
			className={`resize-handle absolute top-0 ${placement} w-3 h-full cursor-col-resize border-transparent hover:border-blue-500 transition-colors z-20`}
			onPointerDown={onResizeStart}
			onDoubleClick={onReset}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			title={onReset ? 'Drag to resize (double-click to reset)' : 'Drag to resize'}
		/>
	);
}
