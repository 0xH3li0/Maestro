// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useBracketTabCycle } from '../../../../renderer/hooks/utils/useBracketTabCycle';
import {
	EDGE_SWIPE_ZONE_PX,
	useEdgeSwipeHandlers,
} from '../../../../renderer/hooks/utils/useEdgeSwipeHandlers';
import type { TouchHandlers } from '../../../../renderer/hooks/utils/useEdgeSwipeHandlers';
import { useEventListener } from '../../../../renderer/hooks/utils/useEventListener';
import { spyOnListeners, expectAllListenersRemoved } from '../../../helpers/listenerLeakAssertions';
import { useLongPress } from '../../../../renderer/hooks/utils/useLongPress';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { usePointerDrag } from '../../../../renderer/hooks/utils/usePointerDrag';
import {
	useProgressiveRenderWindow,
	DEFAULT_INITIAL_RENDER_COUNT,
	DEFAULT_BACKFILL_CHUNK,
} from '../../../../renderer/hooks/utils/useProgressiveRenderWindow';
import { useStableCallback } from '../../../../renderer/hooks/utils/useStableCallback';
import { useSwipeGestures } from '../../../../renderer/hooks/utils/useSwipeGestures';
import type { UseSwipeGesturesReturn } from '../../../../renderer/hooks/utils/useSwipeGestures';

// ===== from src/__tests__/renderer/hooks/utils/useBracketTabCycle.test.ts =====
/**
 * Tests for hooks/utils/useBracketTabCycle - generic Cmd+Shift+[/] tab cycle
 * with wrap behavior, enabled gating, modifier requirements, and cleanup.
 */

function fire(key: '[' | ']', opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) {
	const event = new KeyboardEvent('keydown', {
		key,
		metaKey: opts.meta ?? true,
		ctrlKey: opts.ctrl ?? false,
		shiftKey: opts.shift ?? true,
		cancelable: true,
		bubbles: true,
	});
	window.dispatchEvent(event);
	return event;
}

const MODES: readonly ('spec' | 'goal')[] = ['spec', 'goal'];

describe('useBracketTabCycle', () => {
	it('Cmd+Shift+] cycles forward', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']');
		expect(onChange).toHaveBeenCalledWith('goal');
	});

	it('Cmd+Shift+[ cycles backward', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'goal', onChange })
		);
		fire('[');
		expect(onChange).toHaveBeenCalledWith('spec');
	});

	it('wraps forward from the last value to the first', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'goal', onChange })
		);
		fire(']');
		expect(onChange).toHaveBeenLastCalledWith('spec');
	});

	it('wraps backward from the first value to the last', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire('[');
		expect(onChange).toHaveBeenLastCalledWith('goal');
	});

	it('Ctrl+Shift+] also cycles (non-mac modifier)', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']', { meta: false, ctrl: true, shift: true });
		expect(onChange).toHaveBeenCalledWith('goal');
	});

	it('is a no-op when enabled is false', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: false, values: MODES, active: 'spec', onChange })
		);
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('is a no-op without Cmd/Ctrl + Shift modifiers', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']', { meta: false, shift: true });
		fire(']', { meta: true, shift: false });
		fire(']', { meta: false, shift: false });
		expect(onChange).not.toHaveBeenCalled();
	});

	it('is a no-op when the active value is not in the list', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({
				enabled: true,
				values: ['spec', 'goal'],
				active: 'other',
				onChange,
			})
		);
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('calls preventDefault + stopPropagation', () => {
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange: vi.fn() })
		);
		const event = new KeyboardEvent('keydown', {
			key: ']',
			metaKey: true,
			shiftKey: true,
			cancelable: true,
			bubbles: true,
		});
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(stopPropagationSpy).toHaveBeenCalledTimes(1);
	});

	it('removes the listener on unmount', () => {
		const onChange = vi.fn();
		const { unmount } = renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		unmount();
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useEdgeSwipeHandlers.test.ts =====
/**
 * Tests for useEdgeSwipeHandlers - drawer-opening swipes that only START at a
 * screen edge, composed onto the app shell in place of the invisible fixed
 * strips that used to swallow taps on the tab bar.
 */

function fakeHandlers(): TouchHandlers & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		onTouchStart: () => calls.push('start'),
		onTouchMove: () => calls.push('move'),
		onTouchEnd: () => calls.push('end'),
		onTouchCancel: () => calls.push('cancel'),
	};
}

function touchEvent(clientX: number, count = 1): React.TouchEvent {
	return {
		touches: Array.from({ length: count }, () => ({ clientX })),
	} as unknown as React.TouchEvent;
}

describe('useEdgeSwipeHandlers', () => {
	beforeEach(() => {
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
	});

	it('spreads nothing while disabled', () => {
		const { result } = renderHook(() =>
			useEdgeSwipeHandlers(fakeHandlers(), fakeHandlers(), false)
		);
		expect(result.current).toEqual({});
	});

	it('forwards a touch that starts at the left edge to the left gesture only', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(EDGE_SWIPE_ZONE_PX));
		h.onTouchMove(touchEvent(120));
		h.onTouchEnd(touchEvent(200));

		expect(left.calls).toEqual(['start', 'move', 'end']);
		expect(right.calls).toEqual([]);
	});

	it('forwards a touch that starts at the right edge to the right gesture only', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(390 - EDGE_SWIPE_ZONE_PX));
		h.onTouchMove(touchEvent(250));
		h.onTouchCancel(touchEvent(250));

		expect(right.calls).toEqual(['start', 'move', 'cancel']);
		expect(left.calls).toEqual([]);
	});

	it('never forwards a touch that starts away from the edges (a tap or a scroll)', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(EDGE_SWIPE_ZONE_PX + 1));
		h.onTouchMove(touchEvent(300));
		h.onTouchEnd(touchEvent(300));
		h.onTouchStart(touchEvent(390 - EDGE_SWIPE_ZONE_PX - 1));
		h.onTouchEnd(touchEvent(10));

		expect(left.calls).toEqual([]);
		expect(right.calls).toEqual([]);
	});

	it('ignores multi-finger touches', () => {
		const left = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, fakeHandlers(), true));
		const h = result.current as TouchHandlers;
		h.onTouchStart(touchEvent(4, 2));
		h.onTouchEnd(touchEvent(200));
		expect(left.calls).toEqual([]);
	});

	it('disarms after the gesture ends so a later move is not forwarded', () => {
		const left = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, fakeHandlers(), true));
		const h = result.current as TouchHandlers;
		h.onTouchStart(touchEvent(2));
		h.onTouchEnd(touchEvent(200));
		h.onTouchMove(touchEvent(250));
		expect(left.calls).toEqual(['start', 'end']);
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useEventListener.test.ts =====
/**
 * Tests for useEventListener - generic event-listener hook used across the
 * renderer. Covers the original window-only behaviour plus the
 * `target`, `enabled`, and `capture` options.
 */

describe('useEventListener', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('default target (window)', () => {
		it('invokes the handler when an event fires on window', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler));
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('removes the listener on unmount', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			const { unmount } = renderHook(() => useEventListener('keydown', handler));
			unmount();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});

		it('reads the latest handler closure (ref pattern)', () => {
			let calls = 0;
			const { rerender } = renderHook(
				({ value }: { value: number }) =>
					useEventListener('keydown', () => {
						calls = value;
					}),
				{ initialProps: { value: 1 } }
			);
			rerender({ value: 42 });
			fireEvent.keyDown(window, { key: 'a' });
			expect(calls).toBe(42);
		});
	});

	describe('target option', () => {
		it('attaches to document when target=document', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler, { target: document }));
			fireEvent.keyDown(document, { key: 'a' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('does NOT receive window events when target=document', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler, { target: document }));
			// Dispatch directly on window (skipping body) so it doesn't bubble to document.
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
			expect(handler).not.toHaveBeenCalled();
		});

		it('attaches to a DOM element target and removes the listener on unmount', () => {
			const el = document.createElement('div');
			document.body.appendChild(el);
			try {
				const handler = vi.fn();
				const { unmount } = renderHook(() => useEventListener('click', handler, { target: el }));

				fireEvent.click(el);
				expect(handler).toHaveBeenCalledTimes(1);

				unmount();
				fireEvent.click(el);
				expect(handler).toHaveBeenCalledTimes(1);
			} finally {
				// Always remove the appended element, even if an assertion threw -
				// otherwise an orphan <div> persists in document.body for the next
				// test in this worker.
				document.body.removeChild(el);
			}
		});

		it('does not attach a listener when target is null', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			renderHook(() => useEventListener('keydown', handler, { target: null }));
			expect(spies.addSpy).not.toHaveBeenCalled();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			spies.restore();
		});

		it('removes its document listener on unmount', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(document);
			const { unmount } = renderHook(() =>
				useEventListener('keydown', handler, { target: document })
			);
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});

	describe('capture option', () => {
		it('runs before a bubble-phase handler that stops the event', () => {
			const order: string[] = [];
			const button = document.createElement('button');
			document.body.appendChild(button);
			button.addEventListener('keydown', (e) => {
				order.push('target');
				e.stopPropagation();
			});
			renderHook(() => useEventListener('keydown', () => order.push('window'), { capture: true }));

			fireEvent.keyDown(button, { key: 'a' });

			expect(order).toEqual(['window', 'target']);
			button.remove();
		});

		it('removes the capture-phase listener on unmount', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			const { unmount } = renderHook(() => useEventListener('keydown', handler, { capture: true }));
			unmount();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});

	describe('enabled option', () => {
		it('does not attach when enabled is false', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			renderHook(() => useEventListener('keydown', handler, { enabled: false }));
			expect(spies.addSpy).not.toHaveBeenCalled();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			spies.restore();
		});

		it('attaches/detaches as enabled toggles', () => {
			const handler = vi.fn();
			const { rerender } = renderHook(
				({ on }: { on: boolean }) => useEventListener('keydown', handler, { enabled: on }),
				{ initialProps: { on: false } }
			);

			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();

			act(() => {
				rerender({ on: true });
			});
			fireEvent.keyDown(window, { key: 'b' });
			expect(handler).toHaveBeenCalledTimes(1);

			act(() => {
				rerender({ on: false });
			});
			fireEvent.keyDown(window, { key: 'c' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('cleans up the listener on unmount when enabled was true', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			const { unmount } = renderHook(() => useEventListener('keydown', handler, { enabled: true }));
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useLongPress.test.ts =====
/**
 * Tests for the hoisted `useLongPress` gesture hook
 * (`src/renderer/hooks/utils/useLongPress.ts`). Covers long-press firing,
 * scroll-cancellation, tap passthrough, and right-click passthrough.
 */

/** Build a minimal React.TouchEvent-like object with a single touch point. */
function touchEventUseLongPress(x: number, y: number): React.TouchEvent {
	return {
		touches: [{ clientX: x, clientY: y }],
	} as unknown as React.TouchEvent;
}

/** Assign a stub element to a (readonly-typed) ref for the hook to measure. */
function setRef(ref: React.RefObject<HTMLElement | null>, el: HTMLElement): void {
	(ref as { current: HTMLElement | null }).current = el;
}

describe('useLongPress', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('fires onLongPress with the element rect after the press duration', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		const rect = { x: 5, y: 10, width: 100, height: 20 } as DOMRect;
		const el = { getBoundingClientRect: () => rect } as HTMLElement;
		setRef(result.current.elementRef, el);

		act(() => {
			result.current.handlers.onTouchStart(touchEventUseLongPress(0, 0));
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onLongPress).toHaveBeenCalledWith(rect);
	});

	it('does not fire onLongPress when the touch scrolls past the threshold', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => ({}) as DOMRect,
		} as HTMLElement);

		act(() => {
			result.current.handlers.onTouchStart(touchEventUseLongPress(0, 0));
			// Move well beyond the 10px scroll threshold.
			result.current.handlers.onTouchMove(touchEventUseLongPress(0, 40));
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('fires onTap for a short press without scroll', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(touchEventUseLongPress(0, 0));
		});
		act(() => {
			// Release before the long-press timer elapses.
			vi.advanceTimersByTime(100);
			result.current.handlers.onTouchEnd();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('does not fire onTap after a long-press has triggered', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => ({}) as DOMRect,
		} as HTMLElement);

		act(() => {
			result.current.handlers.onTouchStart(touchEventUseLongPress(0, 0));
		});
		act(() => {
			vi.advanceTimersByTime(500);
			result.current.handlers.onTouchEnd();
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
	});

	it('fires onLongPress immediately on right-click (context menu)', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));
		const rect = { x: 1, y: 2 } as DOMRect;
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => rect,
		} as HTMLElement);

		const preventDefault = vi.fn();
		act(() => {
			result.current.handleContextMenu({ preventDefault } as unknown as React.MouseEvent);
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(onLongPress).toHaveBeenCalledWith(rect);
	});
});

// ===== from src/__tests__/renderer/hooks/utils/usePointerDrag.test.ts =====
/**
 * Tests for the shared Concerto pointer-drag behavior. Covers pointer capture,
 * active-pointer filtering, delta reporting, and listener teardown.
 */

function pointer(type: string, clientX: number, clientY: number, pointerId: number): MouseEvent {
	const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
	Object.defineProperty(event, 'pointerId', { value: pointerId });
	return event;
}

describe('usePointerDrag', () => {
	let handle: HTMLDivElement;
	let setPointerCapture: ReturnType<typeof vi.fn>;
	let releasePointerCapture: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handle = document.createElement('div');
		setPointerCapture = vi.fn();
		releasePointerCapture = vi.fn();
		Object.defineProperties(handle, {
			setPointerCapture: { value: setPointerCapture },
			releasePointerCapture: { value: releasePointerCapture },
		});
		document.body.appendChild(handle);
	});

	afterEach(() => {
		handle.remove();
		vi.restoreAllMocks();
	});

	function dragEvent(pointerId = 7): ReactPointerEvent<HTMLElement> {
		return {
			target: handle,
			currentTarget: handle,
			clientX: 20,
			clientY: 30,
			pointerId,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ReactPointerEvent<HTMLElement>;
	}

	it('captures the active pointer and reports movement across the window', () => {
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));

		expect(setPointerCapture).toHaveBeenCalledWith(7);

		act(() => window.dispatchEvent(pointer('pointermove', 55, 70, 7)));

		expect(onDrag).toHaveBeenCalledWith(35, 40);
	});

	it('continues dragging when pointer capture is no longer available', () => {
		setPointerCapture.mockImplementation(() => {
			throw new DOMException('Pointer is no longer active', 'NotFoundError');
		});
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));
		act(() => window.dispatchEvent(pointer('pointermove', 55, 70, 7)));

		expect(onDrag).toHaveBeenCalledWith(35, 40);
	});

	it('continues when pointer capture was released before cleanup', () => {
		releasePointerCapture.mockImplementation(() => {
			throw new DOMException('Pointer is no longer active', 'NotFoundError');
		});
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		expect(() => act(() => result.current(dragEvent(8), vi.fn()))).not.toThrow();
		expect(setPointerCapture).toHaveBeenLastCalledWith(8);
	});

	it('rethrows unexpected pointer capture errors', () => {
		setPointerCapture.mockImplementation(() => {
			throw new Error('Unexpected capture failure');
		});
		const { result } = renderHook(() => usePointerDrag());

		expect(() => act(() => result.current(dragEvent(), vi.fn()))).toThrow(
			'Unexpected capture failure'
		);
	});

	it('rethrows unexpected pointer release errors', () => {
		releasePointerCapture.mockImplementationOnce(() => {
			throw new Error('Unexpected release failure');
		});
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		expect(() => act(() => result.current(dragEvent(8), vi.fn()))).toThrow(
			'Unexpected release failure'
		);
	});

	it('ignores unrelated pointers and tears down only for the active pointer', () => {
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));
		act(() => window.dispatchEvent(pointer('pointermove', 80, 90, 4)));
		act(() => window.dispatchEvent(pointer('pointerup', 80, 90, 4)));
		act(() => window.dispatchEvent(pointer('pointermove', 40, 50, 7)));

		expect(onDrag).toHaveBeenCalledOnce();
		expect(onDrag).toHaveBeenCalledWith(20, 20);
		expect(releasePointerCapture).not.toHaveBeenCalled();

		act(() => window.dispatchEvent(pointer('pointerup', 40, 50, 7)));

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 60, 70, 7)));
		expect(onDrag).toHaveBeenCalledOnce();
	});

	it('releases pointer capture when the component unmounts mid-drag', () => {
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		unmount();

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
	});

	it('fires onEnd on pointerup, after the listeners are torn down', () => {
		const onDrag = vi.fn();
		const onEnd = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag, { onEnd }));
		act(() => window.dispatchEvent(pointer('pointerup', 40, 50, 7)));

		expect(onEnd).toHaveBeenCalledOnce();
		// Torn down first: capture released and further moves ignored.
		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 90, 90, 7)));
		expect(onDrag).not.toHaveBeenCalled();
	});

	it('fires onEnd on pointercancel so a system-intercepted gesture still releases', () => {
		const onEnd = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn(), { onEnd }));
		act(() => window.dispatchEvent(pointer('pointercancel', 40, 50, 7)));

		expect(onEnd).toHaveBeenCalledOnce();
		expect(releasePointerCapture).toHaveBeenCalledWith(7);
	});

	it('tears the drag down BEFORE running onEnd', () => {
		// The ordering is the fix: a commit that throws must not strand the
		// gesture. Because teardown already ran, the handle stops tracking the
		// pointer no matter what the commit does.
		const onEnd = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn(), { onEnd }));
		act(() => window.dispatchEvent(pointer('pointerup', 40, 50, 7)));

		expect(releasePointerCapture.mock.invocationCallOrder[0]).toBeLessThan(
			onEnd.mock.invocationCallOrder[0]
		);
	});

	it('does not fire onEnd for an abandoned gesture (unmount)', () => {
		const onEnd = vi.fn();
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn(), { onEnd }));
		unmount();

		// Nothing to commit, and the component is gone.
		expect(onEnd).not.toHaveBeenCalled();
	});

	it('cancels the previous pointer before tracking a new drag', () => {
		const firstDrag = vi.fn();
		const secondDrag = vi.fn();
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(7), firstDrag));
		act(() => result.current(dragEvent(8), secondDrag));

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 40, 50, 7)));
		act(() => window.dispatchEvent(pointer('pointermove', 45, 55, 8)));

		expect(firstDrag).not.toHaveBeenCalled();
		expect(secondDrag).toHaveBeenCalledWith(25, 25);

		unmount();
		expect(releasePointerCapture).toHaveBeenCalledWith(8);
	});

	function mouseMove(clientX: number, clientY: number, pointerId: number, buttons: number) {
		const event = pointer('pointermove', clientX, clientY, pointerId);
		Object.defineProperty(event, 'pointerType', { value: 'mouse' });
		Object.defineProperty(event, 'buttons', { value: buttons });
		return event;
	}

	it('cancels on Escape when onCancel is supplied, and claims the key', () => {
		const onDrag = vi.fn();
		const onEnd = vi.fn();
		const onCancel = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag, { onEnd, onCancel }));
		const key = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
		act(() => {
			window.dispatchEvent(key);
		});

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onEnd).not.toHaveBeenCalled();
		expect(key.defaultPrevented).toBe(true);
		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 90, 90, 7)));
		expect(onDrag).not.toHaveBeenCalled();
	});

	it('leaves Escape alone when there is no onCancel', () => {
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		const key = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
		act(() => {
			window.dispatchEvent(key);
		});

		expect(key.defaultPrevented).toBe(false);
		expect(releasePointerCapture).not.toHaveBeenCalled();
	});

	it('settles a lost release (mouse move with no button held) through onEnd', () => {
		const onDrag = vi.fn();
		const onEnd = vi.fn();
		const onCancel = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag, { onEnd, onCancel }));
		act(() => window.dispatchEvent(mouseMove(40, 50, 7, 1)));
		act(() => window.dispatchEvent(mouseMove(60, 70, 7, 0)));

		expect(onDrag).toHaveBeenCalledOnce();
		expect(onEnd).toHaveBeenCalledOnce();
		expect(onCancel).not.toHaveBeenCalled();
		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(mouseMove(80, 90, 7, 1)));
		expect(onDrag).toHaveBeenCalledOnce();
	});

	it('fires onCancel for an abandoned gesture (unmount or a superseding drag)', () => {
		const firstCancel = vi.fn();
		const secondCancel = vi.fn();
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(7), vi.fn(), { onCancel: firstCancel }));
		act(() => result.current(dragEvent(8), vi.fn(), { onCancel: secondCancel }));
		expect(firstCancel).toHaveBeenCalledOnce();

		unmount();
		expect(secondCancel).toHaveBeenCalledOnce();
	});

	it('pulls keyboard focus out of a focused <webview> so Escape reaches the drag', () => {
		const webview = document.createElement('webview');
		webview.tabIndex = 0;
		document.body.appendChild(webview);
		webview.focus();
		expect(document.activeElement).toBe(webview);
		const onCancel = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn(), { onCancel }));

		expect(document.activeElement).not.toBe(webview);
		webview.remove();
	});

	it('leaves focus alone when there is no onCancel to run', () => {
		const webview = document.createElement('webview');
		webview.tabIndex = 0;
		document.body.appendChild(webview);
		webview.focus();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));

		expect(document.activeElement).toBe(webview);
		webview.remove();
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useProgressiveRenderWindow.test.ts =====
/**
 * Tests for useProgressiveRenderWindow - the tail-first render window that keeps
 * agent switching responsive on long transcripts (issue #1342).
 *
 * The hook returns a slice index plus a reveal escape hatch. The behaviours that
 * matter are: the first commit is bounded regardless of transcript size, the
 * index walks to 0 over successive idle ticks, and it never moves backwards
 * while a conversation is live (which would make a rendered entry vanish).
 */

/**
 * jsdom has no requestIdleCallback, so the hook takes its setTimeout fallback.
 * Fake timers let each test step the backfill deterministically.
 */
function flushIdleTick() {
	act(() => {
		vi.advanceTimersByTime(20);
	});
}

describe('useProgressiveRenderWindow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders only the newest slice on the first commit', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		// 500 entries, 25 rendered => start at 475 rather than 0.
		expect(result.current.startIndex).toBe(500 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('renders everything immediately when the list is already short', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(10, 'a'));
		expect(result.current.startIndex).toBe(0);
	});

	it('backfills older history one chunk per idle tick', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		const start = result.current.startIndex;

		flushIdleTick();
		expect(result.current.startIndex).toBe(start - DEFAULT_BACKFILL_CHUNK);

		flushIdleTick();
		expect(result.current.startIndex).toBe(start - DEFAULT_BACKFILL_CHUNK * 2);
	});

	it('eventually reaches the head and then stops scheduling work', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(60, 'a'));
		expect(result.current.startIndex).toBeGreaterThan(0);

		// 60 - 25 = 35 hidden entries, 8 per tick => 5 ticks. Run extra to be sure
		// it clamps at 0 instead of going negative.
		for (let i = 0; i < 12; i++) flushIdleTick();

		expect(result.current.startIndex).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not re-hide rendered entries when new messages stream in', () => {
		const { result, rerender } = renderHook(({ total }) => useProgressiveRenderWindow(total, 'a'), {
			initialProps: { total: 500 },
		});

		flushIdleTick();
		const afterBackfill = result.current.startIndex;

		// Agent streams 40 more entries. They append at the tail, so they are inside
		// the window already - the start index must not jump forward.
		rerender({ total: 540 });
		expect(result.current.startIndex).toBe(afterBackfill);
	});

	it('reveals more entries when the list shrinks below the window', () => {
		const { result, rerender } = renderHook(({ total }) => useProgressiveRenderWindow(total, 'a'), {
			initialProps: { total: 500 },
		});
		expect(result.current.startIndex).toBe(475);

		// User deletes most of the transcript; the window must not point past the end.
		rerender({ total: 30 });
		expect(result.current.startIndex).toBe(30 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('snaps back to the tail when the conversation identity changes', () => {
		const { result, rerender } = renderHook(
			({ total, key }) => useProgressiveRenderWindow(total, key),
			{ initialProps: { total: 500, key: 'session-a' } }
		);

		for (let i = 0; i < 3; i++) flushIdleTick();
		expect(result.current.startIndex).toBeLessThan(475);

		// Switching to another agent's tab must start from its own tail, not inherit
		// the previous conversation's backfill progress.
		rerender({ total: 300, key: 'session-b' });
		expect(result.current.startIndex).toBe(300 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('notifies the caller before each expansion so scroll can be anchored', () => {
		const onBeforeExpand = vi.fn();
		renderHook(() => useProgressiveRenderWindow(500, 'a', { onBeforeExpand }));

		expect(onBeforeExpand).not.toHaveBeenCalled();

		flushIdleTick();
		expect(onBeforeExpand).toHaveBeenCalledTimes(1);

		flushIdleTick();
		expect(onBeforeExpand).toHaveBeenCalledTimes(2);
	});

	it('cancels pending backfill work on unmount', () => {
		const { unmount } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('honours custom initial and chunk sizes', () => {
		const { result } = renderHook(() =>
			useProgressiveRenderWindow(200, 'a', { initial: 50, chunk: 25 })
		);
		expect(result.current.startIndex).toBe(150);

		flushIdleTick();
		expect(result.current.startIndex).toBe(125);
	});

	describe('revealTo', () => {
		it('pulls a deferred item into the window immediately', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			expect(result.current.startIndex).toBe(475);

			act(() => {
				result.current.revealTo(120);
			});
			expect(result.current.startIndex).toBe(120);
		});

		it('never narrows the window back down', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));

			act(() => {
				result.current.revealTo(100);
			});
			// A later request for a newer item must not re-hide the history already
			// pulled in - that would unmount entries the user can see.
			act(() => {
				result.current.revealTo(400);
			});
			expect(result.current.startIndex).toBe(100);
		});

		it('reveals the whole list when asked for index 0', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));

			act(() => {
				result.current.revealTo(0);
			});
			expect(result.current.startIndex).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('absorbPrepend (scroll-to-top history backfill, issue #1407)', () => {
		it('keeps the visible slice stable when history is prepended', () => {
			// 300 entries, window walked to the head, then 250 older ones arrive.
			const { result, rerender } = renderHook(
				({ total }) => useProgressiveRenderWindow(total, 'a'),
				{ initialProps: { total: 300 } }
			);
			act(() => {
				result.current.revealTo(0);
			});
			expect(result.current.startIndex).toBe(0);

			act(() => {
				result.current.absorbPrepend(250);
			});
			rerender({ total: 550 });

			// The same 300 entries stay rendered - the new history sits above the
			// window rather than mounting in one commit.
			expect(result.current.startIndex).toBe(250);
		});

		it('lets the idle loop walk back through the prepended history', () => {
			const { result, rerender } = renderHook(
				({ total }) => useProgressiveRenderWindow(total, 'a'),
				{ initialProps: { total: 300 } }
			);
			act(() => {
				result.current.revealTo(0);
				result.current.absorbPrepend(250);
			});
			rerender({ total: 550 });

			flushIdleTick();
			expect(result.current.startIndex).toBe(250 - DEFAULT_BACKFILL_CHUNK);
		});

		it('ignores non-positive counts', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			const before = result.current.startIndex;
			act(() => {
				result.current.absorbPrepend(0);
			});
			expect(result.current.startIndex).toBe(before);
		});
	});

	it('uses requestIdleCallback when the platform provides one', () => {
		const scheduled: Array<() => void> = [];
		const ric = vi.fn((cb: () => void) => {
			scheduled.push(cb);
			return 1;
		});
		const cic = vi.fn();
		vi.stubGlobal('requestIdleCallback', ric);
		vi.stubGlobal('cancelIdleCallback', cic);

		try {
			const { result, unmount } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			expect(ric).toHaveBeenCalledTimes(1);

			act(() => {
				scheduled[0]();
			});
			expect(result.current.startIndex).toBe(475 - DEFAULT_BACKFILL_CHUNK);

			unmount();
			expect(cic).toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useStableCallback.test.tsx =====
describe('useStableCallback', () => {
	it('keeps one identity across re-renders', () => {
		const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
			initialProps: { fn: () => 'first' },
		});
		const first = result.current;

		rerender({ fn: () => 'second' });

		expect(result.current).toBe(first);
	});

	// The point of the hook: a stale identity would be worse than an unstable one.
	it('calls the newest implementation', () => {
		const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
			initialProps: { fn: () => 'first' },
		});
		const pinned = result.current;

		rerender({ fn: () => 'second' });

		expect(pinned()).toBe('second');
	});

	it('forwards arguments and the return value', () => {
		const fn = vi.fn((a: number, b: number) => a + b);
		const { result } = renderHook(() => useStableCallback(fn));

		expect(result.current(2, 3)).toBe(5);
		expect(fn).toHaveBeenCalledWith(2, 3);
	});

	it('reads values captured by the newest closure', () => {
		const { result, rerender } = renderHook(({ count }) => useStableCallback(() => count), {
			initialProps: { count: 1 },
		});
		const pinned = result.current;

		rerender({ count: 42 });

		expect(pinned()).toBe(42);
	});

	it('works when the callback is invoked from an effect-driven update', async () => {
		const seen: number[] = [];
		const { result, rerender } = renderHook(
			({ value }) => useStableCallback(() => seen.push(value)),
			{ initialProps: { value: 1 } }
		);

		act(() => {
			result.current();
		});
		rerender({ value: 2 });
		act(() => {
			result.current();
		});

		expect(seen).toEqual([1, 2]);
	});
});

// ===== from src/__tests__/renderer/hooks/utils/useSwipeGestures.test.ts =====
/**
 * Tests for useSwipeGestures.ts (renderer port)
 *
 * The gesture mechanics are covered exhaustively for the legacy hook in
 * src/__tests__/web/hooks/useSwipeGestures.test.ts; this port is behavior-
 * identical (only the GESTURE_THRESHOLDS import moved to renderer touch.ts). So
 * these tests focus on:
 * - the port picking up the shared touch-primitive thresholds (default 50px)
 * - the gesture-to-drawer-state wiring App.tsx builds on top of the hook
 *   (edge swipe opens a drawer, backdrop swipe closes it)
 * - the disabled / below-threshold guards that keep accidental drags inert
 */

function createTouchEvent(
	type: 'touchstart' | 'touchmove' | 'touchend',
	x: number,
	y: number
): React.TouchEvent {
	const touch = { clientX: x, clientY: y } as unknown as React.Touch;
	return {
		type,
		touches: type === 'touchend' ? [] : [touch],
		changedTouches: [touch],
		preventDefault: vi.fn(),
	} as unknown as React.TouchEvent;
}

/** Drive a full start -> move -> end swipe with a controlled duration. */
function simulateSwipe(
	handlers: UseSwipeGesturesReturn['handlers'],
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	duration = 100
) {
	const startTime = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(startTime);
	handlers.onTouchStart(createTouchEvent('touchstart', startX, startY));
	handlers.onTouchMove(createTouchEvent('touchmove', (startX + endX) / 2, (startY + endY) / 2));
	vi.spyOn(Date, 'now').mockReturnValue(startTime + duration);
	handlers.onTouchEnd(createTouchEvent('touchend', endX, endY));
	vi.restoreAllMocks();
}

describe('useSwipeGestures (renderer)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses the shared GESTURE_THRESHOLDS default of 50px', () => {
		const onSwipeLeft = vi.fn();
		const { result } = renderHook(() => useSwipeGestures({ onSwipeLeft }));

		// 40px is below the 50px default: no swipe.
		act(() => {
			simulateSwipe(result.current.handlers, 140, 100, 100, 100, 100);
		});
		expect(onSwipeLeft).not.toHaveBeenCalled();

		// 60px clears the default threshold.
		act(() => {
			simulateSwipe(result.current.handlers, 160, 100, 100, 100, 100);
		});
		expect(onSwipeLeft).toHaveBeenCalled();
	});

	it('preventDefaults a locked horizontal swipe (blocks native scroll in the zone)', () => {
		const { result } = renderHook(() => useSwipeGestures({ onSwipeRight: () => {} }));

		const start = createTouchEvent('touchstart', 5, 100);
		const move = createTouchEvent('touchmove', 60, 100);
		act(() => {
			result.current.handlers.onTouchStart(start);
			result.current.handlers.onTouchMove(move);
		});

		expect(move.preventDefault).toHaveBeenCalled();
	});

	describe('drawer gesture-to-state wiring (mirrors App.tsx)', () => {
		function makeDrawers() {
			const state = { leftOpen: false, rightOpen: false };
			return {
				state,
				setLeftSidebarOpen: (v: boolean) => {
					state.leftOpen = v;
				},
				setRightPanelOpen: (v: boolean) => {
					state.rightOpen = v;
				},
			};
		}

		it('rightward edge swipe opens the left drawer', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true) })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 5, 200, 130, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(true);
			expect(drawers.state.rightOpen).toBe(false);
		});

		it('leftward edge swipe opens the right drawer', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeLeft: () => drawers.setRightPanelOpen(true) })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 380, 200, 250, 200, 100);
			});

			expect(drawers.state.rightOpen).toBe(true);
			expect(drawers.state.leftOpen).toBe(false);
		});

		it('leftward backdrop swipe closes the open left drawer', () => {
			const drawers = makeDrawers();
			drawers.state.leftOpen = true;
			const { result } = renderHook(() =>
				useSwipeGestures({
					onSwipeLeft: () => drawers.setLeftSidebarOpen(false),
					onSwipeRight: () => drawers.setRightPanelOpen(false),
				})
			);

			act(() => {
				simulateSwipe(result.current.handlers, 200, 200, 80, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});

		it('rightward backdrop swipe closes the open right drawer', () => {
			const drawers = makeDrawers();
			drawers.state.rightOpen = true;
			const { result } = renderHook(() =>
				useSwipeGestures({
					onSwipeLeft: () => drawers.setLeftSidebarOpen(false),
					onSwipeRight: () => drawers.setRightPanelOpen(false),
				})
			);

			act(() => {
				simulateSwipe(result.current.handlers, 200, 200, 320, 200, 100);
			});

			expect(drawers.state.rightOpen).toBe(false);
		});

		it('does not open a drawer when disabled (non-narrow / desktop / mouse)', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true), enabled: false })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 5, 200, 130, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});

		it('does not open a drawer on a below-threshold drag', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true) })
			);

			act(() => {
				// 20px < 50px threshold.
				simulateSwipe(result.current.handlers, 5, 200, 25, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});
	});
});
