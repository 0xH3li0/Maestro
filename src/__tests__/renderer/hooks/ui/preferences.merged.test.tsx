// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, render, screen } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { usePersistedChoice } from '../../../../renderer/hooks/ui/usePersistedChoice';
import {
	usePersistedPanelSize,
	usePersistedPanelWidth,
} from '../../../../renderer/hooks/ui/usePersistedPanelWidth';
import { usePersistedToggle } from '../../../../renderer/hooks/ui/usePersistedToggle';
import {
	useFontScale,
	clampFontScale,
	FONT_SCALE_MIN,
	FONT_SCALE_MAX,
} from '../../../../renderer/hooks/ui/useFontScale';
import { usePagination } from '../../../../renderer/hooks/ui/usePagination';
import { useTableSort } from '../../../../renderer/hooks/ui/useTableSort';
import { useScaleShortcuts } from '../../../../renderer/hooks/ui/useScaleShortcuts';
import type { UseScalePreferenceReturn } from '../../../../renderer/hooks/ui/useScalePreference';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../../renderer/hooks/ui/useModalLayer';
import { useIsTopLayer } from '../../../../renderer/hooks/ui/useIsTopLayer';
import { useRestartWhenIdle } from '../../../../renderer/hooks/ui/useRestartWhenIdle';
import {
	useSessionStore,
	selectHasAnyRunnableQueuedWork,
} from '../../../../renderer/stores/sessionStore';
import { useRestartPendingStore } from '../../../../renderer/stores/restartPendingStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { QueuedItem, Session } from '../../../../renderer/types';
import { useIdleNotification } from '../../../../renderer/hooks/ui/useIdleNotification';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';

// ===== from src/__tests__/renderer/hooks/ui/usePersistedChoice.test.tsx =====
/**
 * `usePersistedChoice` - one value out of a fixed option list, remembered under
 * a localStorage key.
 *
 * Two behaviours are worth pinning: a stored value that is no longer an option
 * must fall back to the default (otherwise an old build's mode strands the
 * surface in a state its control cannot express), and a blocked Storage must
 * cost the user persistence rather than the pane.
 */

const KEY = 'test.choice';
const OPTIONS = ['name', 'newest', 'oldest'] as const;
type Option = (typeof OPTIONS)[number];

function mount(defaultValue: Option = 'name') {
	return renderHook(() => usePersistedChoice<Option>(KEY, OPTIONS, defaultValue));
}

describe('usePersistedChoice', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(mount().result.current.value).toBe('name');
		expect(mount('newest').result.current.value).toBe('newest');
	});

	it('reads a stored value in preference to the default', () => {
		window.localStorage.setItem(KEY, 'oldest');
		expect(mount().result.current.value).toBe('oldest');
	});

	it('falls back to the default when the stored value is not an option', () => {
		window.localStorage.setItem(KEY, 'by-vibes');
		expect(mount().result.current.value).toBe('name');
	});

	it('persists a change and hands it to the next mount', () => {
		const { result } = mount();
		act(() => result.current.setValue('newest'));
		expect(result.current.value).toBe('newest');
		expect(window.localStorage.getItem(KEY)).toBe('newest');
		expect(mount().result.current.value).toBe('newest');
	});

	it('keeps separate keys independent', () => {
		const a = renderHook(() => usePersistedChoice<Option>('surface.a', OPTIONS, 'name'));
		act(() => a.result.current.setValue('newest'));
		const b = renderHook(() => usePersistedChoice<Option>('surface.b', OPTIONS, 'name'));
		expect(b.result.current.value).toBe('name');
	});

	it('still works in memory when Storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});
		const { result } = mount();
		expect(result.current.value).toBe('name');
		act(() => result.current.setValue('newest'));
		expect(result.current.value).toBe('newest');
	});
});

// ===== from src/__tests__/renderer/hooks/ui/usePersistedPanelWidth.test.tsx =====
/**
 * `usePersistedPanelWidth` - one panel width remembered under a localStorage key.
 *
 * Two behaviours worth pinning: a stored width is clamped on READ (bounds that
 * tighten in a later build must not restore a pane wider than its container),
 * and a blocked or missing Storage costs the user persistence, not their pane.
 */

const KEYUsePersistedPanelWidth = 'test.panelWidth';
const BOUNDS = { defaultWidth: 560, minWidth: 320, maxWidth: 1400 };

describe('usePersistedPanelWidth', () => {
	beforeEach(() => {
		// jsdom here ships no working Storage - install the shared in-memory
		// stand-in, which also resets the store between tests.
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(560);
	});

	it('reads a stored width in preference to the default', () => {
		window.localStorage.setItem(KEYUsePersistedPanelWidth, '820');
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(820);
	});

	it('clamps a stored width that falls outside the current bounds', () => {
		window.localStorage.setItem(KEYUsePersistedPanelWidth, '4000');
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(1400);

		window.localStorage.setItem(KEYUsePersistedPanelWidth, '10');
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(320);
	});

	it('falls back to the default for junk in storage', () => {
		window.localStorage.setItem(KEYUsePersistedPanelWidth, 'not-a-number');
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(560);

		window.localStorage.setItem(KEYUsePersistedPanelWidth, '0');
		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(560);
	});

	it('clamps, rounds, and stores on setWidth', () => {
		const { result } = renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS));

		act(() => result.current.setWidth(700.6));
		expect(result.current.width).toBe(701);
		expect(window.localStorage.getItem(KEYUsePersistedPanelWidth)).toBe('701');

		act(() => result.current.setWidth(9000));
		expect(result.current.width).toBe(1400);
		expect(window.localStorage.getItem(KEYUsePersistedPanelWidth)).toBe('1400');
	});

	it('survives a remount under the same key', () => {
		const first = renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS));
		act(() => first.result.current.setWidth(900));
		first.unmount();

		expect(
			renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS)).result.current
				.width
		).toBe(900);
	});

	it('forgets the stored width on reset', () => {
		const { result } = renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS));
		act(() => result.current.setWidth(900));
		act(() => result.current.reset());

		expect(result.current.width).toBe(560);
		expect(window.localStorage.getItem(KEYUsePersistedPanelWidth)).toBeNull();
	});

	it('keeps keys separate', () => {
		const a = renderHook(() => usePersistedPanelWidth('surface.a', BOUNDS));
		act(() => a.result.current.setWidth(900));
		expect(renderHook(() => usePersistedPanelWidth('surface.b', BOUNDS)).result.current.width).toBe(
			560
		);
	});

	it('still resizes in memory when storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		const { result } = renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS));
		expect(result.current.width).toBe(560);
		act(() => result.current.setWidth(700));
		expect(result.current.width).toBe(700);
	});

	it('still resizes when there is no Storage at all', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		const { result } = renderHook(() => usePersistedPanelWidth(KEYUsePersistedPanelWidth, BOUNDS));
		act(() => result.current.setWidth(700));
		expect(result.current.width).toBe(700);
	});
});

describe('usePersistedPanelSize', () => {
	const SIZE_BOUNDS = { defaultSize: 400, minSize: 100, maxSize: 900 };

	beforeEach(() => {
		installLocalStorageMock();
	});

	it('reports isCustomized only while a picked size is stored', () => {
		const { result } = renderHook(() =>
			usePersistedPanelSize(KEYUsePersistedPanelWidth, SIZE_BOUNDS)
		);
		expect(result.current).toMatchObject({ size: 400, isCustomized: false });

		act(() => result.current.setSize(650));
		expect(result.current).toMatchObject({ size: 650, isCustomized: true });

		act(() => result.current.reset());
		expect(result.current).toMatchObject({ size: 400, isCustomized: false });
		expect(window.localStorage.getItem(KEYUsePersistedPanelWidth)).toBeNull();
	});

	it('re-clamps the stored size when the bounds change after mount', () => {
		window.localStorage.setItem(KEYUsePersistedPanelWidth, '800');
		const { result, rerender } = renderHook(
			({ maxSize }) =>
				usePersistedPanelSize(KEYUsePersistedPanelWidth, { ...SIZE_BOUNDS, maxSize }),
			{ initialProps: { maxSize: 900 } }
		);
		expect(result.current.size).toBe(800);

		rerender({ maxSize: 500 });
		expect(result.current.size).toBe(500);
		// The stored preference is untouched, so widening the bounds restores it.
		rerender({ maxSize: 900 });
		expect(result.current.size).toBe(800);
	});
});

// ===== from src/__tests__/renderer/hooks/ui/usePersistedToggle.test.tsx =====
/**
 * `usePersistedToggle` - one boolean remembered under a localStorage key.
 *
 * The behaviour worth pinning is the degradation: a renderer with storage
 * blocked (private mode, a hostile Storage, jsdom) must still get a working
 * in-memory toggle rather than an exception on the way to painting a pane.
 */

const KEYUsePersistedToggle = 'test.toggle';

describe('usePersistedToggle', () => {
	beforeEach(() => {
		// jsdom here ships no working Storage - install the shared in-memory
		// stand-in, which also resets the store between tests.
		installLocalStorageMock();
	});

	it('starts at the default with nothing persisted', () => {
		expect(renderHook(() => usePersistedToggle(KEYUsePersistedToggle)).result.current.value).toBe(
			false
		);
		expect(
			renderHook(() => usePersistedToggle(KEYUsePersistedToggle, true)).result.current.value
		).toBe(true);
	});

	it('reads a stored value in preference to the default', () => {
		window.localStorage.setItem(KEYUsePersistedToggle, 'false');
		expect(
			renderHook(() => usePersistedToggle(KEYUsePersistedToggle, true)).result.current.value
		).toBe(false);
	});

	it('writes the new value on toggle', () => {
		const { result } = renderHook(() => usePersistedToggle(KEYUsePersistedToggle));
		act(() => result.current.toggle());
		expect(result.current.value).toBe(true);
		expect(window.localStorage.getItem(KEYUsePersistedToggle)).toBe('true');
	});

	it('writes the new value on setValue', () => {
		const { result } = renderHook(() => usePersistedToggle(KEYUsePersistedToggle, true));
		act(() => result.current.setValue(false));
		expect(result.current.value).toBe(false);
		expect(window.localStorage.getItem(KEYUsePersistedToggle)).toBe('false');
	});

	it('survives a remount under the same key', () => {
		const first = renderHook(() => usePersistedToggle(KEYUsePersistedToggle));
		act(() => first.result.current.toggle());
		first.unmount();

		expect(renderHook(() => usePersistedToggle(KEYUsePersistedToggle)).result.current.value).toBe(
			true
		);
	});

	it('keeps keys separate', () => {
		const a = renderHook(() => usePersistedToggle('surface.a'));
		act(() => a.result.current.toggle());
		expect(renderHook(() => usePersistedToggle('surface.b')).result.current.value).toBe(false);
	});

	it('still toggles in memory when storage throws', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage blocked');
			},
		});

		const { result } = renderHook(() => usePersistedToggle(KEYUsePersistedToggle, false));
		expect(result.current.value).toBe(false);
		act(() => result.current.toggle());
		expect(result.current.value).toBe(true);
	});

	it('still toggles in memory when setItem throws QuotaExceededError', () => {
		// The accessor-only guard misses this: Storage is reachable, then the
		// write refuses. A persist that called setItem directly would throw
		// out of the toggle and take the pane down.
		vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});

		const { result } = renderHook(() => usePersistedToggle(KEYUsePersistedToggle, false));
		expect(result.current.value).toBe(false);
		act(() => result.current.toggle());
		expect(result.current.value).toBe(true);
	});

	it('still toggles when there is no Storage at all', () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});

		const { result } = renderHook(() => usePersistedToggle(KEYUsePersistedToggle, true));
		expect(result.current.value).toBe(true);
		act(() => result.current.setValue(false));
		expect(result.current.value).toBe(false);
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useFontScale.test.tsx =====
/**
 * Tests for useFontScale - the shared, persisted font-zoom state behind the
 * Director's Notes and file-preview zoom controls.
 *
 * The rounding assertions are not cosmetic: the value is interpolated straight
 * into a `calc()` and written to localStorage, so a raw float sum would ship
 * `calc(0.875rem * 1.0000000000000002)` to the DOM.
 */

const KEYUseFontScale = 'test.fontScale';

describe('clampFontScale', () => {
	it('holds the supported range', () => {
		expect(clampFontScale(5)).toBe(FONT_SCALE_MAX);
		expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN);
	});

	it('falls back to 1 for junk', () => {
		expect(clampFontScale(Number.NaN)).toBe(1);
	});

	it('rounds float drift away', () => {
		expect(clampFontScale(1.0000000000000002)).toBe(1);
		expect(clampFontScale(1.2000000000000002)).toBe(1.2);
	});
});

describe('useFontScale', () => {
	beforeEach(() => {
		// jsdom in this environment ships no working Storage, so install the same
		// in-memory stand-in the other localStorage-backed tests use.
		installLocalStorageMock();
	});

	it('starts at 100% with nothing persisted', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));
		expect(result.current.fontScale).toBe(1);
		expect(result.current.canDecrease).toBe(true);
		expect(result.current.canIncrease).toBe(true);
	});

	it('loads and clamps the persisted value', () => {
		window.localStorage.setItem(KEYUseFontScale, '9');
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));
		expect(result.current.fontScale).toBe(FONT_SCALE_MAX);
		expect(result.current.canIncrease).toBe(false);
		expect(result.current.canDecrease).toBe(true);
	});

	it('steps up and persists a clean number', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));

		act(() => result.current.adjustFontScale(1));

		expect(result.current.fontScale).toBe(1.1);
		expect(window.localStorage.getItem(KEYUseFontScale)).toBe('1.1');
	});

	it('steps down and persists', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));

		act(() => result.current.adjustFontScale(-1));

		expect(result.current.fontScale).toBe(0.9);
		expect(window.localStorage.getItem(KEYUseFontScale)).toBe('0.9');
	});

	it('does not drift past the bounds on repeated steps', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));

		act(() => {
			for (let i = 0; i < 40; i++) result.current.adjustFontScale(1);
		});
		expect(result.current.fontScale).toBe(FONT_SCALE_MAX);

		act(() => {
			for (let i = 0; i < 40; i++) result.current.adjustFontScale(-1);
		});
		expect(result.current.fontScale).toBe(FONT_SCALE_MIN);
	});

	it('resets back to 100% and persists that', () => {
		window.localStorage.setItem(KEYUseFontScale, '1.5');
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));

		act(() => result.current.resetFontScale());

		expect(result.current.fontScale).toBe(1);
		expect(window.localStorage.getItem(KEYUseFontScale)).toBe('1');
	});

	it('keys surfaces independently', () => {
		const a = renderHook(() => useFontScale('surface.a'));
		const b = renderHook(() => useFontScale('surface.b'));

		act(() => a.result.current.adjustFontScale(1));

		expect(window.localStorage.getItem('surface.a')).toBe('1.1');
		expect(window.localStorage.getItem('surface.b')).toBeNull();
		expect(b.result.current.fontScale).toBe(1);
	});
});

/**
 * The hook runs during render of panes as large as the whole file preview, so a
 * Storage that is missing or refuses access has to cost the user their
 * persistence and nothing else. Mounting FilePreview in a jsdom without Storage
 * is exactly how this surfaced.
 */
describe('useFontScale without a working Storage', () => {
	let descriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: undefined,
		});
	});

	afterEach(() => {
		if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
	});

	it('starts at 100% instead of throwing', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));
		expect(result.current.fontScale).toBe(1);
	});

	it('still zooms, it just cannot remember', () => {
		const { result } = renderHook(() => useFontScale(KEYUseFontScale));

		act(() => result.current.adjustFontScale(1));

		expect(result.current.fontScale).toBe(1.1);
	});
});

// ===== from src/__tests__/renderer/hooks/ui/usePagination.test.tsx =====
/**
 * Tests for usePagination.
 *
 * The arithmetic is covered in `utils/pagination.test.ts`; what matters here is
 * the state behavior across re-renders - clamping when the list shrinks under
 * the current page, and resetting when the caller's view of the list changes.
 */

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('usePagination', () => {
	it('starts on page 1 and exposes the first window', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(4);
		expect(result.current.pageItems).toHaveLength(32);
		expect(result.current.pageItems[0]).toBe(0);
		expect(result.current.range).toEqual({ from: 1, to: 32 });
		expect(result.current.totalItems).toBe(100);
	});

	it('reports isPaginated only when there is more than one page', () => {
		const { result: small } = renderHook(() => usePagination(range(10), 32));
		expect(small.current.isPaginated).toBe(false);

		const { result: big } = renderHook(() => usePagination(range(33), 32));
		expect(big.current.isPaginated).toBe(true);
	});

	it('steps forward and back, and pins the edges', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		expect(result.current.canGoPrev).toBe(false);
		act(() => result.current.nextPage());
		expect(result.current.page).toBe(2);
		expect(result.current.pageItems[0]).toBe(32);
		expect(result.current.canGoPrev).toBe(true);

		act(() => result.current.prevPage());
		expect(result.current.page).toBe(1);

		// Already at the first page: stepping back is a no-op, not page 0.
		act(() => result.current.prevPage());
		expect(result.current.page).toBe(1);

		act(() => result.current.setPage(4));
		expect(result.current.canGoNext).toBe(false);
		act(() => result.current.nextPage());
		expect(result.current.page).toBe(4);
	});

	it('clamps a setPage beyond the end', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		act(() => result.current.setPage(999));
		expect(result.current.page).toBe(4);
	});

	// The regression this hook exists for: filtering 1236 tabs down to 18 while
	// parked on page 30 must not render an empty grid under "Page 30 of 1".
	it('clamps the current page when the list shrinks beneath it', () => {
		const { result, rerender } = renderHook(({ items }) => usePagination(items, 32), {
			initialProps: { items: range(1000) },
		});

		act(() => result.current.setPage(30));
		expect(result.current.page).toBe(30);

		rerender({ items: range(18) });

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(1);
		expect(result.current.pageItems).toHaveLength(18);
		expect(result.current.isPaginated).toBe(false);
	});

	it('holds the page when the list grows', () => {
		const { result, rerender } = renderHook(({ items }) => usePagination(items, 32), {
			initialProps: { items: range(100) },
		});

		act(() => result.current.setPage(3));
		rerender({ items: range(200) });

		expect(result.current.page).toBe(3);
		expect(result.current.totalPages).toBe(7);
	});

	it('resets to page 1 when the reset key changes', () => {
		const { result, rerender } = renderHook(({ key }) => usePagination(range(100), 32, key), {
			initialProps: { key: 'all:recent' },
		});

		act(() => result.current.setPage(3));
		expect(result.current.page).toBe(3);

		rerender({ key: 'all:queries' });
		expect(result.current.page).toBe(1);
	});

	it('holds the page when the reset key is unchanged', () => {
		const { result, rerender } = renderHook(({ key }) => usePagination(range(100), 32, key), {
			initialProps: { key: 'all:recent' },
		});

		act(() => result.current.setPage(3));
		rerender({ key: 'all:recent' });
		expect(result.current.page).toBe(3);
	});

	it('survives an empty list', () => {
		const { result } = renderHook(() => usePagination<number>([], 32));

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(1);
		expect(result.current.pageItems).toEqual([]);
		expect(result.current.isPaginated).toBe(false);
		expect(result.current.canGoNext).toBe(false);
		expect(result.current.canGoPrev).toBe(false);
		expect(result.current.range).toEqual({ from: 0, to: 0 });
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useTableSort.test.tsx =====
/**
 * Tests for `useTableSort` - the flip-vs-switch rule shared by every sortable
 * table header in the app.
 */

type Key = 'name' | 'count' | 'date';

describe('useTableSort', () => {
	it('starts on the initial column, ascending by default', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		expect(result.current.sortKey).toBe('name');
		expect(result.current.direction).toBe('asc');
		expect(result.current.isDescending).toBe(false);
	});

	it('honors an explicit initial direction', () => {
		const { result } = renderHook(() => useTableSort<Key>('count', { initialDirection: 'desc' }));

		expect(result.current.direction).toBe('desc');
		expect(result.current.isDescending).toBe(true);
	});

	it('falls back to the column default for the initial direction', () => {
		const { result } = renderHook(() =>
			useTableSort<Key>('count', { defaultDirectionFor: () => 'desc' })
		);

		expect(result.current.direction).toBe('desc');
	});

	it('flips direction when the ACTIVE column is clicked again', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		act(() => result.current.toggleSort('name'));
		expect(result.current).toMatchObject({ sortKey: 'name', direction: 'desc' });

		act(() => result.current.toggleSort('name'));
		expect(result.current).toMatchObject({ sortKey: 'name', direction: 'asc' });
	});

	it('jumps a NEW column to its own default rather than inheriting the current direction', () => {
		const { result } = renderHook(() =>
			useTableSort<Key>('name', {
				defaultDirectionFor: (key) => (key === 'count' ? 'desc' : 'asc'),
			})
		);

		// Leave the text column in descending order...
		act(() => result.current.toggleSort('name'));
		expect(result.current.direction).toBe('desc');

		// ...then switch to a magnitude column. Inheriting 'desc' here would be
		// coincidentally right; the point is it comes from the column's default.
		act(() => result.current.toggleSort('count'));
		expect(result.current).toMatchObject({ sortKey: 'count', direction: 'desc' });

		// Switching to a text column must NOT inherit 'desc' - showing Z-A on a
		// freshly-picked name column reads as broken data.
		act(() => result.current.toggleSort('date'));
		expect(result.current).toMatchObject({ sortKey: 'date', direction: 'asc' });
	});

	it('setSort applies a column and direction explicitly', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		act(() => result.current.setSort('date', 'desc'));
		expect(result.current).toMatchObject({ sortKey: 'date', direction: 'desc' });

		// Omitting the direction falls back to the column default.
		act(() => result.current.setSort('count'));
		expect(result.current).toMatchObject({ sortKey: 'count', direction: 'asc' });
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useScaleShortcuts.test.tsx =====
/**
 * `useScaleShortcuts` - bare `+` / `-` / `0` zoom for a scalable surface.
 *
 * What is worth pinning: the keys fire without a modifier, a modified press is
 * left alone (Cmd +/- is the application's own zoom), typing in a text field
 * never zooms, and `enabled: false` unbinds entirely so a surface underneath an
 * open overlay stops answering the same keypress.
 */

function makeControl(): UseScalePreferenceReturn {
	return {
		scale: 1,
		adjustScale: vi.fn(),
		resetScale: vi.fn(),
		canDecrease: true,
		canIncrease: true,
	};
}

function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	(target ?? window).dispatchEvent(event);
	return event;
}

describe('useScaleShortcuts', () => {
	let control: UseScalePreferenceReturn;

	beforeEach(() => {
		control = makeControl();
	});

	it('steps up on + and =', () => {
		renderHook(() => useScaleShortcuts(control));
		press('+');
		press('=');
		expect(control.adjustScale).toHaveBeenCalledTimes(2);
		expect(control.adjustScale).toHaveBeenNthCalledWith(1, 1);
		expect(control.adjustScale).toHaveBeenNthCalledWith(2, 1);
	});

	it('steps down on - and _', () => {
		renderHook(() => useScaleShortcuts(control));
		press('-');
		press('_');
		expect(control.adjustScale).toHaveBeenCalledTimes(2);
		expect(control.adjustScale).toHaveBeenNthCalledWith(1, -1);
		expect(control.adjustScale).toHaveBeenNthCalledWith(2, -1);
	});

	it('resets on 0', () => {
		renderHook(() => useScaleShortcuts(control));
		press('0');
		expect(control.resetScale).toHaveBeenCalledTimes(1);
	});

	it('consumes the event so a global handler cannot also act on it', () => {
		renderHook(() => useScaleShortcuts(control));
		expect(press('+').defaultPrevented).toBe(true);
	});

	it('ignores keys it does not own', () => {
		renderHook(() => useScaleShortcuts(control));
		const event = press('a');
		expect(control.adjustScale).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('leaves modified presses to the application zoom', () => {
		renderHook(() => useScaleShortcuts(control));
		press('+', { metaKey: true });
		press('-', { ctrlKey: true });
		press('=', { altKey: true });
		expect(control.adjustScale).not.toHaveBeenCalled();
	});

	it('does not zoom while typing in a text field', () => {
		renderHook(() => useScaleShortcuts(control));
		const input = document.createElement('input');
		document.body.appendChild(input);
		press('-', {}, input);
		expect(control.adjustScale).not.toHaveBeenCalled();
		input.remove();
	});

	it('stays unbound while disabled, and binds when re-enabled', () => {
		const { rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useScaleShortcuts(control, { enabled }),
			{ initialProps: { enabled: false } }
		);
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();

		rerender({ enabled: true });
		press('+');
		expect(control.adjustScale).toHaveBeenCalledTimes(1);
	});

	it('unbinds on unmount', () => {
		const { unmount } = renderHook(() => useScaleShortcuts(control));
		unmount();
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();
	});

	it('calls the latest control without rebinding', () => {
		const next = makeControl();
		const { rerender } = renderHook(
			({ c }: { c: UseScalePreferenceReturn }) => useScaleShortcuts(c),
			{
				initialProps: { c: control },
			}
		);
		rerender({ c: next });
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();
		expect(next.adjustScale).toHaveBeenCalledWith(1);
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useIsTopLayer.test.tsx =====
/**
 * `useIsTopLayer` - is this surface the topmost layer right now?
 *
 * The behaviour worth pinning is the flip: a surface that answers an
 * unmodified key has to stop the moment something opens above it, and start
 * again when that closes. Matching is by priority, since `useModalLayer` never
 * hands its layer id back.
 */

const LOWER = 100;
const UPPER = 200;

function Probe({ priority, label }: { priority: number; label: string }) {
	useModalLayer(priority, label, () => {});
	const isTop = useIsTopLayer(priority);
	return <div data-testid={label}>{isTop ? 'top' : 'covered'}</div>;
}

function renderStack(upperOpen: boolean) {
	return render(
		<LayerStackProvider>
			<Probe priority={LOWER} label="lower" />
			{upperOpen && <Probe priority={UPPER} label="upper" />}
		</LayerStackProvider>
	);
}

describe('useIsTopLayer', () => {
	it('reports true for the only registered layer', () => {
		renderStack(false);
		expect(screen.getByTestId('lower').textContent).toBe('top');
	});

	it('reports false once a higher layer registers, and true again when it goes', () => {
		const { rerender } = renderStack(true);

		expect(screen.getByTestId('lower').textContent).toBe('covered');
		expect(screen.getByTestId('upper').textContent).toBe('top');

		act(() => {
			rerender(
				<LayerStackProvider>
					<Probe priority={LOWER} label="lower" />
				</LayerStackProvider>
			);
		});

		expect(screen.getByTestId('lower').textContent).toBe('top');
	});

	it('reports false for a priority nothing registered', () => {
		function Bystander() {
			return <div data-testid="bystander">{useIsTopLayer(999) ? 'top' : 'covered'}</div>;
		}
		render(
			<LayerStackProvider>
				<Probe priority={LOWER} label="lower" />
				<Bystander />
			</LayerStackProvider>
		);
		expect(screen.getByTestId('bystander').textContent).toBe('covered');
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useRestartWhenIdle.test.tsx =====
/**
 * This hook shares its activity definition with `useIdleNotification`, but
 * where that one speaks, this one calls `updates.install()` and relaunches the
 * app. So the gap between two queued turns is not a cosmetic problem here: a
 * restart fired in that window takes the app down with queued work still in the
 * queue.
 */

const install = vi.fn().mockResolvedValue(undefined);

function queuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return { id: 'q1', timestamp: 1, tabId: 'tab-1', type: 'message', text: 'go', ...overrides };
}

function setSessions(sessions: Session[]): void {
	useSessionStore.setState({ sessions });
}

describe('useRestartWhenIdle', () => {
	beforeEach(() => {
		install.mockClear();
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			updates: { install },
		};
		useBatchStore.setState({ batchRunStates: {} });
		useRestartPendingStore.setState({ pending: false });
		setSessions([]);
	});

	it('does not restart in the gap between two queued turns', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [queuedItem({ id: 'q2' })] })]);
		useRestartPendingStore.setState({ pending: true });
		const { rerender } = renderHook(() => useRestartWhenIdle());

		// Turn ends, next item still queued. A restart here would kill queued work.
		setSessions([createMockSession({ state: 'idle', executionQueue: [queuedItem({ id: 'q2' })] })]);
		rerender();

		expect(install).not.toHaveBeenCalled();
		expect(useRestartPendingStore.getState().pending).toBe(true);
	});

	it('restarts once the queue is genuinely drained', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [queuedItem({ id: 'q2' })] })]);
		useRestartPendingStore.setState({ pending: true });
		const { rerender } = renderHook(() => useRestartWhenIdle());

		setSessions([createMockSession({ state: 'idle', executionQueue: [queuedItem({ id: 'q2' })] })]);
		rerender();
		expect(install).not.toHaveBeenCalled();

		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(install).toHaveBeenCalledTimes(1);
		expect(useRestartPendingStore.getState().pending).toBe(false);
	});

	it('restarts when the queue holds only paused items', () => {
		setSessions([
			createMockSession({ state: 'idle', executionQueue: [queuedItem({ paused: true })] }),
		]);
		useRestartPendingStore.setState({ pending: true });
		renderHook(() => useRestartWhenIdle());

		expect(install).toHaveBeenCalledTimes(1);
	});

	it('does nothing while no restart is pending', () => {
		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		renderHook(() => useRestartWhenIdle());

		expect(install).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/renderer/hooks/ui/useIdleNotification.test.tsx =====
/**
 * The idle notification must stay quiet while an agent still has work that
 * would actually run. `busy` alone is only true while a turn is in flight, and
 * the dequeue is atomic, so a draining queue leaves the agent genuinely `idle`
 * in the gap between two queued turns - which is where it used to announce
 * "Maestro is idle" once per gap.
 */

const speak = vi.fn().mockResolvedValue(undefined);

function queuedItemUseIdleNotification(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 1,
		tabId: 'tab-1',
		type: 'message',
		text: 'do the thing',
		...overrides,
	};
}

function setSessionsUseIdleNotification(sessions: Session[]): void {
	useSessionStore.setState({ sessions });
}

describe('useIdleNotification', () => {
	beforeEach(() => {
		speak.mockClear();
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			notification: { speak },
		};
		useBatchStore.setState({ batchRunStates: {} });
		useNotificationStore.getState().setIdleNotification(true, 'say Maestro is idle');
		setSessionsUseIdleNotification([]);
	});

	describe('selectHasAnyRunnableQueuedWork', () => {
		it('counts an idle agent with a runnable queued item as having work', () => {
			const state = {
				sessions: [
					createMockSession({ state: 'idle', executionQueue: [queuedItemUseIdleNotification()] }),
				],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(true);
		});

		it('does not count a queue holding only paused items', () => {
			const state = {
				sessions: [
					createMockSession({
						state: 'idle',
						executionQueue: [
							queuedItemUseIdleNotification({ paused: true }),
							queuedItemUseIdleNotification({ id: 'q2', paused: true }),
						],
					}),
				],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(false);
		});

		it('counts a mixed queue, because one item would still run', () => {
			const state = {
				sessions: [
					createMockSession({
						state: 'idle',
						executionQueue: [
							queuedItemUseIdleNotification({ paused: true }),
							queuedItemUseIdleNotification({ id: 'q2' }),
						],
					}),
				],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(true);
		});

		it('tolerates a session with no queue field at all', () => {
			const session = createMockSession({ state: 'idle' });
			delete (session as Partial<Session>).executionQueue;
			expect(selectHasAnyRunnableQueuedWork({ sessions: [session] } as never)).toBe(false);
		});
	});

	it('stays silent in the gap between two queued turns', () => {
		// Turn 1 running, with the next item still queued behind it.
		setSessionsUseIdleNotification([
			createMockSession({
				state: 'busy',
				executionQueue: [queuedItemUseIdleNotification({ id: 'q2' })],
			}),
		]);
		const { rerender } = renderHook(() => useIdleNotification());

		// Turn 1 ends. The session is idle but q2 has not been dispatched yet -
		// this is the window that used to fire.
		setSessionsUseIdleNotification([
			createMockSession({
				state: 'idle',
				executionQueue: [queuedItemUseIdleNotification({ id: 'q2' })],
			}),
		]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('stays silent when a different agent still has queued work', () => {
		// The selector spans every session, so the agent that finishes its turn is
		// not necessarily the one holding work. Idle is a fleet-wide question.
		setSessionsUseIdleNotification([
			createMockSession({ id: 'sess-1', state: 'busy', executionQueue: [] }),
			createMockSession({
				id: 'sess-2',
				state: 'idle',
				executionQueue: [queuedItemUseIdleNotification({ id: 'q2' })],
			}),
		]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessionsUseIdleNotification([
			createMockSession({ id: 'sess-1', state: 'idle', executionQueue: [] }),
			createMockSession({
				id: 'sess-2',
				state: 'idle',
				executionQueue: [queuedItemUseIdleNotification({ id: 'q2' })],
			}),
		]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('fires once when the last queued item finishes and the queue is empty', () => {
		setSessionsUseIdleNotification([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessionsUseIdleNotification([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).toHaveBeenCalledTimes(1);
		expect(speak).toHaveBeenCalledWith('Maestro is idle', 'say Maestro is idle');

		// Still idle on a later render - the edge already fired, so it must not repeat.
		rerender();
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('fires when the only queued items are paused, because they can never start', () => {
		setSessionsUseIdleNotification([
			createMockSession({
				state: 'busy',
				executionQueue: [queuedItemUseIdleNotification({ paused: true })],
			}),
		]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessionsUseIdleNotification([
			createMockSession({
				state: 'idle',
				executionQueue: [queuedItemUseIdleNotification({ paused: true })],
			}),
		]);
		rerender();

		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('speaks only after the whole queue drains, not once per item', () => {
		const drain: Array<{ state: Session['state']; queue: QueuedItem[] }> = [
			{
				state: 'busy',
				queue: [
					queuedItemUseIdleNotification({ id: 'q2' }),
					queuedItemUseIdleNotification({ id: 'q3' }),
				],
			},
			{
				state: 'idle',
				queue: [
					queuedItemUseIdleNotification({ id: 'q2' }),
					queuedItemUseIdleNotification({ id: 'q3' }),
				],
			},
			{ state: 'busy', queue: [queuedItemUseIdleNotification({ id: 'q3' })] },
			{ state: 'idle', queue: [queuedItemUseIdleNotification({ id: 'q3' })] },
			{ state: 'busy', queue: [] },
			{ state: 'idle', queue: [] },
		];

		setSessionsUseIdleNotification([
			createMockSession({ state: 'busy', executionQueue: drain[0].queue }),
		]);
		const { rerender } = renderHook(() => useIdleNotification());

		for (const step of drain) {
			setSessionsUseIdleNotification([
				createMockSession({ state: step.state, executionQueue: step.queue }),
			]);
			rerender();
		}

		// Three turns, two intermediate gaps, exactly one announcement.
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('does not fire while an Auto Run batch is still running', () => {
		setSessionsUseIdleNotification([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		useBatchStore.setState({
			batchRunStates: { 'session-1': { isRunning: true } as never },
		});
		setSessionsUseIdleNotification([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('stays silent when the notification is disabled', () => {
		useNotificationStore.getState().setIdleNotification(false, 'say Maestro is idle');
		setSessionsUseIdleNotification([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessionsUseIdleNotification([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('does not fire on mount when already idle', () => {
		setSessionsUseIdleNotification([createMockSession({ state: 'idle', executionQueue: [] })]);
		renderHook(() => useIdleNotification());

		expect(speak).not.toHaveBeenCalled();
	});
});
