/**
 * The Sketch Book canvas key routing (useSketchKeyboard) against a stand-in
 * for Excalidraw's React key handler: Maestro's navigation keys go to
 * `window`, Excalidraw never sees them, a moved action is replayed under
 * Excalidraw's chord, a key the canvas claimed stays off `window`, typing is
 * left alone, and a Help dialog portal is relabelled.
 *
 * jsdom reports no platform, so Excalidraw's chords here are the Ctrl ones;
 * Maestro's matcher treats Ctrl and Cmd as one modifier.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackShortcutUsage = vi.fn();
vi.mock('../../../../renderer/utils/shortcutTracking', () => ({
	trackShortcutUsage: (id: string) => trackShortcutUsage(id),
}));

import { useSketchKeyboard } from '../../../../renderer/components/SketchBook/useSketchKeyboard';

/** Excalidraw's handler, reduced: it claims Ctrl+K and Ctrl+O, and only prevents Export image. */
function Harness({ onCanvasKey }: { onCanvasKey: (event: KeyboardEvent) => void }) {
	const [canvas, setCanvas] = React.useState<HTMLDivElement | null>(null);
	useSketchKeyboard(canvas);
	return (
		<div ref={setCanvas}>
			<div
				data-testid="excalidraw"
				tabIndex={0}
				onKeyDown={(event) => {
					onCanvasKey(event.nativeEvent);
					if (event.ctrlKey && (event.key === 'k' || event.key === 'o')) {
						event.preventDefault();
						event.stopPropagation();
					} else if (event.ctrlKey && event.shiftKey && event.key === 'E') {
						event.preventDefault();
					}
				}}
			>
				<textarea data-testid="wysiwyg" />
			</div>
		</div>
	);
}

describe('useSketchKeyboard', () => {
	const windowKeys = vi.fn();
	const canvasKeys = vi.fn();

	beforeEach(() => {
		windowKeys.mockClear();
		canvasKeys.mockClear();
		trackShortcutUsage.mockClear();
		window.addEventListener('keydown', windowKeys);
	});

	afterEach(() => {
		window.removeEventListener('keydown', windowKeys);
		document.querySelectorAll('[data-test-portal]').forEach((node) => node.remove());
	});

	it('forwards Quick Actions to the main handler and keeps it from Excalidraw', () => {
		render(<Harness onCanvasKey={canvasKeys} />);

		fireEvent.keyDown(screen.getByTestId('excalidraw'), { key: 'k', code: 'KeyK', ctrlKey: true });

		expect(canvasKeys).not.toHaveBeenCalled();
		expect(windowKeys).toHaveBeenCalledTimes(1);
		const forwarded = windowKeys.mock.calls[0][0] as KeyboardEvent;
		expect((forwarded.target as Window).document).toBe(document);
		expect(forwarded).toMatchObject({ key: 'k', code: 'KeyK', ctrlKey: true });
	});

	it('forwards a tab shortcut (Previous Tab) the same way', () => {
		render(<Harness onCanvasKey={canvasKeys} />);

		fireEvent.keyDown(screen.getByTestId('excalidraw'), {
			key: '{',
			code: 'BracketLeft',
			ctrlKey: true,
			shiftKey: true,
		});

		expect(canvasKeys).not.toHaveBeenCalled();
		expect(((windowKeys.mock.calls[0][0] as KeyboardEvent).target as Window).document).toBe(
			document
		);
	});

	it("replays Add link's new chord as Excalidraw's own, and keeps both off window", () => {
		render(<Harness onCanvasKey={canvasKeys} />);

		fireEvent.keyDown(screen.getByTestId('excalidraw'), {
			key: '∫',
			code: 'KeyB',
			ctrlKey: true,
			altKey: true,
		});

		expect(canvasKeys).toHaveBeenCalledTimes(1);
		expect(canvasKeys.mock.calls[0][0]).toMatchObject({ key: 'k', ctrlKey: true, altKey: false });
		expect(windowKeys).not.toHaveBeenCalled();
		expect(trackShortcutUsage).toHaveBeenCalledWith('sketchBookAddLink');
	});

	it('keeps a key the canvas only prevented (Export image) from also firing in Maestro', () => {
		render(<Harness onCanvasKey={canvasKeys} />);

		fireEvent.keyDown(screen.getByTestId('excalidraw'), {
			key: 'E',
			code: 'KeyE',
			ctrlKey: true,
			shiftKey: true,
		});

		expect(canvasKeys).toHaveBeenCalledTimes(1);
		expect(windowKeys).not.toHaveBeenCalled();
	});

	it('lets a key the canvas does not claim reach Maestro unchanged', () => {
		render(<Harness onCanvasKey={canvasKeys} />);
		const canvas = screen.getByTestId('excalidraw');

		fireEvent.keyDown(canvas, { key: 'w', code: 'KeyW', ctrlKey: true });

		expect(canvasKeys).toHaveBeenCalledTimes(1);
		expect(windowKeys).toHaveBeenCalledTimes(1);
		expect((windowKeys.mock.calls[0][0] as KeyboardEvent).target).toBe(canvas);
	});

	it('leaves keys typed into a text element alone', () => {
		render(<Harness onCanvasKey={canvasKeys} />);
		const field = screen.getByTestId('wysiwyg');

		fireEvent.keyDown(field, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });

		expect(canvasKeys).toHaveBeenCalledTimes(1);
		expect(canvasKeys.mock.calls[0][0]).toMatchObject({ key: 'b', altKey: true, ctrlKey: true });
		expect((windowKeys.mock.calls[0][0] as KeyboardEvent).target).toBe(field);
		expect(trackShortcutUsage).not.toHaveBeenCalled();
	});

	it("relabels the Help dialog's moved chords when its portal opens", async () => {
		render(<Harness onCanvasKey={canvasKeys} />);

		const portal = document.createElement('div');
		portal.dataset.testPortal = '';
		document.body.append(portal);
		const row = document.createElement('div');
		row.className = 'HelpDialog__key-container';
		for (const text of ['Ctrl', 'K']) {
			const kbd = document.createElement('kbd');
			kbd.textContent = text;
			row.append(kbd);
		}
		portal.append(row);

		await waitFor(() =>
			expect(
				Array.from(row.querySelectorAll('kbd'))
					.filter((kbd) => !kbd.hidden)
					.map((kbd) => kbd.textContent)
			).toEqual(['Ctrl', 'Alt', 'B'])
		);
	});

	it('stops routing once unmounted', () => {
		const { unmount } = render(<Harness onCanvasKey={canvasKeys} />);
		const canvas = screen.getByTestId('excalidraw');
		unmount();

		document.body.append(canvas);
		fireEvent.keyDown(canvas, { key: 'k', code: 'KeyK', ctrlKey: true });
		canvas.remove();

		expect((windowKeys.mock.calls[0][0] as KeyboardEvent).target).toBe(canvas);
	});
});
