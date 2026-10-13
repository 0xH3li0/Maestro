import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	DELEGATION_POSITION_SAVE_DEBOUNCE_MS,
	useDelegationGraphLayout,
} from '../../../../renderer/components/DelegationGraph/useDelegationGraphLayout';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { DelegationGraphLayouts } from '../../../../renderer/stores/settingsDelegationGraphSlice';
import { DELEGATION_GRAPH_LAYOUTS_SETTING } from '../../../../shared/delegationGraphLayout';
import type { DelegationGraphScope } from '../../../../shared/delegationGraph';
import { createMockSession } from '../../../helpers/mockSession';

const ALL: DelegationGraphScope = { kind: 'all' };
const GROUP: DelegationGraphScope = { kind: 'group', groupId: 'g-1' };

/** Props for a hook under test whose scope changes. Typed here so `ALL` is not narrowed to its own kind. */
function scopeProps(scope: DelegationGraphScope): { scope: DelegationGraphScope } {
	return { scope };
}

function layouts(): DelegationGraphLayouts {
	return useSettingsStore.getState().delegationGraphLayouts;
}

/** How many times the record was written to disk. */
function writeCount(): number {
	return vi
		.mocked(window.maestro.settings.set)
		.mock.calls.filter(([key]) => key === DELEGATION_GRAPH_LAYOUTS_SETTING).length;
}

function rest(): void {
	act(() => {
		vi.advanceTimersByTime(DELEGATION_POSITION_SAVE_DEBOUNCE_MS);
	});
}

describe('useDelegationGraphLayout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSettingsStore.setState({ delegationGraphLayouts: {} });
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
			],
		});
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('reading', () => {
		it('reads a scope with nothing saved as the default layout and no positions', () => {
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			expect(result.current.layout).toBe('hierarchical');
			expect(result.current.positions).toEqual({});
		});

		it('reads what was saved for the scope', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: { all: { layout: 'radial', positions: { a: { x: 1, y: 2 } } } },
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			expect(result.current.layout).toBe('radial');
			expect(result.current.positions).toEqual({ a: { x: 1, y: 2 } });
		});

		// One agent, two graphs, two places. A scope must never show the other's.
		it("loads the scope's own positions when the scope changes, never the other's", () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } },
					'group:g-1': { layout: 'force', positions: { a: { x: 900, y: 900 } } },
				},
			});
			const { result, rerender } = renderHook(({ scope }) => useDelegationGraphLayout(scope), {
				initialProps: scopeProps(ALL),
			});
			expect(result.current.positions).toEqual({ a: { x: 1, y: 1 } });

			rerender({ scope: GROUP });
			expect(result.current.layout).toBe('force');
			expect(result.current.positions).toEqual({ a: { x: 900, y: 900 } });

			rerender({ scope: { kind: 'group', groupId: 'g-2' } });
			expect(result.current.layout).toBe('hierarchical');
			expect(result.current.positions).toEqual({});
		});

		// The canvas memoizes on `positions`. A fresh `{}` per render would rebuild
		// it on every render of a scope with nothing saved.
		it('hands back the same empty positions object across renders', () => {
			const { result, rerender } = renderHook(() => useDelegationGraphLayout(ALL));
			const first = result.current.positions;
			rerender();
			expect(result.current.positions).toBe(first);
		});

		it('keeps its three actions identity-stable across renders and scope changes', () => {
			const { result, rerender } = renderHook(({ scope }) => useDelegationGraphLayout(scope), {
				initialProps: scopeProps(ALL),
			});
			const { saveDraggedPositions, saveAlgorithmLayout, resetLayout } = result.current;

			rerender({ scope: GROUP });

			expect(result.current.saveDraggedPositions).toBe(saveDraggedPositions);
			expect(result.current.saveAlgorithmLayout).toBe(saveAlgorithmLayout);
			expect(result.current.resetLayout).toBe(resetLayout);
		});
	});

	describe('saveDraggedPositions', () => {
		// The first move is what turns the scope manual, so it is written at once
		// and the toolbar reads Manual while the node is still being dragged.
		it('switches the scope to manual on the first move, without waiting', () => {
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 10, y: 10 }, b: { x: 20, y: 20 } });
			});

			expect(result.current.layout).toBe('manual');
			expect(layouts().all).toEqual({
				layout: 'manual',
				positions: { a: { x: 10, y: 10 }, b: { x: 20, y: 20 } },
			});
			expect(writeCount()).toBe(1);
		});

		// A drag fires on every mouse move. One write per event would send the
		// whole record through IPC dozens of times a second.
		it('debounces the moves after the first into one write', () => {
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));
			act(() => {
				result.current.saveDraggedPositions({ a: { x: 0, y: 0 } });
			});
			expect(writeCount()).toBe(1);

			act(() => {
				for (let step = 1; step <= 40; step++) {
					result.current.saveDraggedPositions({ a: { x: step, y: step } });
					vi.advanceTimersByTime(16);
				}
			});
			expect(writeCount()).toBe(1);
			expect(layouts().all.positions.a).toEqual({ x: 0, y: 0 });

			rest();
			expect(writeCount()).toBe(2);
			expect(layouts().all.positions.a).toEqual({ x: 40, y: 40 });
		});

		it('folds a move into what the scope already has, keeping the nodes that did not move', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					all: { layout: 'manual', positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } },
				},
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ b: { x: 50, y: 60 } });
			});
			rest();

			expect(layouts().all.positions).toEqual({ a: { x: 1, y: 1 }, b: { x: 50, y: 60 } });
		});

		it('writes only to the scope it was called in', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					'group:g-1': { layout: 'force', positions: { a: { x: 900, y: 900 } } },
				},
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 5, y: 5 } });
			});

			expect(layouts()['group:g-1']).toEqual({
				layout: 'force',
				positions: { a: { x: 900, y: 900 } },
			});
			expect(layouts().all.positions).toEqual({ a: { x: 5, y: 5 } });
		});

		it('drops the coordinates of a deleted agent when it writes', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					all: {
						layout: 'manual',
						positions: { a: { x: 1, y: 1 }, deleted: { x: 7, y: 7 } },
					},
				},
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 3, y: 3 } });
			});
			rest();

			expect(layouts().all.positions).toEqual({ a: { x: 3, y: 3 } });
		});

		// A drag, then a scope switch inside the debounce window. The pending write
		// belongs to the scope the drag happened in, and must not be lost or land
		// in the scope now on screen.
		it('flushes a waiting write into its own scope when the scope changes', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: { all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } } },
			});
			const { result, rerender } = renderHook(({ scope }) => useDelegationGraphLayout(scope), {
				initialProps: scopeProps(ALL),
			});

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 77, y: 88 } });
			});
			expect(layouts().all.positions.a).toEqual({ x: 1, y: 1 });

			rerender({ scope: GROUP });

			expect(layouts().all.positions.a).toEqual({ x: 77, y: 88 });
			expect(layouts()['group:g-1']).toBeUndefined();

			// Nothing is left waiting to fire a second time.
			const writes = writeCount();
			rest();
			expect(writeCount()).toBe(writes);
		});

		// Closing the graph inside the debounce window must not lose the last move.
		it('flushes a waiting write when the canvas unmounts', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: { all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } } },
			});
			const { result, unmount } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 42, y: 24 } });
			});
			unmount();

			expect(layouts().all.positions.a).toEqual({ x: 42, y: 24 });
		});
	});

	describe('saveAlgorithmLayout', () => {
		it('writes at once and replaces every saved position', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					all: { layout: 'manual', positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } },
				},
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveAlgorithmLayout('radial', { a: { x: 300, y: 0 } });
			});

			expect(result.current.layout).toBe('radial');
			expect(layouts().all).toEqual({ layout: 'radial', positions: { a: { x: 300, y: 0 } } });
			expect(writeCount()).toBe(1);
		});

		// Without the cancel, the drag write lands after the algorithm's and puts
		// the scope back on manual with the positions the user just replaced.
		it('cancels a drag write that is still waiting', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: { all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } } },
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 9, y: 9 } });
				result.current.saveAlgorithmLayout('force', { a: { x: 500, y: 500 } });
			});
			rest();

			expect(layouts().all).toEqual({ layout: 'force', positions: { a: { x: 500, y: 500 } } });
		});
	});

	describe('resetLayout', () => {
		it('forgets the scope, which reads as the default layout again', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: {
					all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } },
					'group:g-1': { layout: 'force', positions: { a: { x: 2, y: 2 } } },
				},
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.resetLayout();
			});

			expect(result.current.layout).toBe('hierarchical');
			expect(result.current.positions).toEqual({});
			expect(layouts()).toEqual({
				'group:g-1': { layout: 'force', positions: { a: { x: 2, y: 2 } } },
			});
		});

		it('cancels a drag write that is still waiting, so the reset is not undone', () => {
			useSettingsStore.setState({
				delegationGraphLayouts: { all: { layout: 'manual', positions: { a: { x: 1, y: 1 } } } },
			});
			const { result } = renderHook(() => useDelegationGraphLayout(ALL));

			act(() => {
				result.current.saveDraggedPositions({ a: { x: 9, y: 9 } });
				result.current.resetLayout();
			});
			rest();

			expect(layouts()).toEqual({});
		});
	});
});
