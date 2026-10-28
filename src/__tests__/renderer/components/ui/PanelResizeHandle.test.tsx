/**
 * PanelResizeHandle: the drag strip on a side panel's edge. It hands the
 * pointer-down to `useResizablePanel()`, resets on double-click when asked,
 * and keeps the `.resize-handle` class the stylesheet (touch-action, the
 * coarse-pointer hit area, the phone drawer rule) keys on.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PanelResizeHandle } from '../../../../renderer/components/ui/PanelResizeHandle';

describe('PanelResizeHandle', () => {
	it('starts a resize on pointer down and sits on the left edge by default', () => {
		const onResizeStart = vi.fn();
		render(<PanelResizeHandle onResizeStart={onResizeStart} label="Resize the panel" />);
		const handle = screen.getByRole('separator', { name: 'Resize the panel' });
		expect(handle).toHaveClass('resize-handle', 'cursor-col-resize', 'left-0', 'border-l-4');
		expect(handle).toHaveAttribute('aria-orientation', 'vertical');
		expect(handle).toHaveAttribute('title', 'Drag to resize');

		fireEvent.pointerDown(handle);
		expect(onResizeStart).toHaveBeenCalledTimes(1);
	});

	it('resets on double-click when given onReset, and says so', () => {
		const onReset = vi.fn();
		render(<PanelResizeHandle onResizeStart={vi.fn()} onReset={onReset} edge="right" />);
		const handle = screen.getByRole('separator');
		expect(handle).toHaveClass('right-0', 'border-r-4');
		expect(handle).toHaveAttribute('title', 'Drag to resize (double-click to reset)');

		fireEvent.doubleClick(handle);
		expect(onReset).toHaveBeenCalledTimes(1);
	});
});
