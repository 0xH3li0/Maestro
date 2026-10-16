// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
	registerPendingEdit,
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../renderer/hooks/cue/pendingEditsRegistry';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCueGraphData } from '../../../../renderer/hooks/cue/useCueGraphData';
import type {
	CueGraphSession,
	CuePipelineState,
	CuePipeline,
	PipelineNode,
} from '../../../../shared/cue-pipeline-types';
import { useCueToggle } from '../../../../renderer/hooks/cue/useCueToggle';
import { useCueVisibilityWiring } from '../../../../renderer/hooks/cue/useCueVisibilityWiring';
import { usePipelineCanvasCallbacks } from '../../../../renderer/hooks/cue/usePipelineCanvasCallbacks';
import type { Node, Edge, ReactFlowInstance } from 'reactflow';
import { usePipelineContextMenu } from '../../../../renderer/hooks/cue/usePipelineContextMenu';

// ===== from src/__tests__/renderer/hooks/cue/pendingEditsRegistry.test.ts =====
describe('pendingEditsRegistry', () => {
	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('flushAllPendingEdits invokes every registered callback', () => {
		const a = vi.fn();
		const b = vi.fn();
		registerPendingEdit(a);
		registerPendingEdit(b);

		flushAllPendingEdits();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('unregister prevents subsequent invocation', () => {
		const cb = vi.fn();
		const unregister = registerPendingEdit(cb);
		unregister();
		flushAllPendingEdits();
		expect(cb).not.toHaveBeenCalled();
	});

	it('registering the same callback twice coalesces via Set semantics', () => {
		const cb = vi.fn();
		registerPendingEdit(cb);
		registerPendingEdit(cb);
		flushAllPendingEdits();
		expect(cb).toHaveBeenCalledTimes(1);
	});
});

// ===== from src/__tests__/renderer/hooks/cue/useCueGraphData.test.ts =====
const mockGetGraphData = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		getGraphData: (...args: unknown[]) => mockGetGraphData(...args),
	},
}));

// Mock pipeline conversion utils to isolate fetch/race semantics
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline', () => ({
	graphSessionsToPipelines: vi.fn((sessions: unknown[]) => {
		if (!Array.isArray(sessions)) return [];
		return sessions.map((_s, i) => ({
			id: `p${i}`,
			name: `p${i}`,
			color: '#abc',
			nodes: [],
			edges: [],
		}));
	}),
}));

vi.mock('../../../../renderer/components/CueModal/cueModalUtils', () => ({
	buildSubscriptionPipelineMap: vi.fn((pipelines: unknown[]) => {
		const map = new Map<string, unknown>();
		if (Array.isArray(pipelines)) {
			pipelines.forEach((p: any) => map.set(p.id, p));
		}
		return map;
	}),
}));

describe('useCueGraphData', () => {
	beforeEach(() => {
		mockGetGraphData.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('on mount, invokes getGraphData once and populates graphSessions', async () => {
		const fakeData: CueGraphSession[] = [{ sessionId: 's1' } as unknown as CueGraphSession];
		mockGetGraphData.mockResolvedValue(fakeData);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphSessions).toEqual(fakeData));
		expect(mockGetGraphData).toHaveBeenCalledTimes(1);
		expect(result.current.graphError).toBeNull();
	});

	it('IPC rejection: graphError populated with message', async () => {
		mockGetGraphData.mockRejectedValue(new Error('boom'));
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphError).toBe('boom'));
	});

	it('tab change triggers re-fetch', async () => {
		mockGetGraphData.mockResolvedValue([]);
		const { rerender } = renderHook(
			({ tab }) => useCueGraphData({ activeTab: tab, sessionInfoList: [] }),
			{ initialProps: { tab: 'dashboard' as 'dashboard' | 'pipeline' } }
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(1));
		rerender({ tab: 'pipeline' });
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(2));
	});

	it('race: two synchronous fetches → only latest wins', async () => {
		// First fetch hangs; second resolves to [B]
		let resolveFirst!: (v: CueGraphSession[]) => void;
		const firstPromise = new Promise<CueGraphSession[]>((resolve) => {
			resolveFirst = resolve;
		});
		mockGetGraphData
			.mockReturnValueOnce(firstPromise)
			.mockResolvedValueOnce([{ sessionId: 'B' } as unknown as CueGraphSession]);

		const { result, rerender } = renderHook(
			({ tab }) => useCueGraphData({ activeTab: tab, sessionInfoList: [] }),
			{ initialProps: { tab: 'dashboard' as 'dashboard' | 'pipeline' } }
		);
		// Trigger a second fetch before first resolves
		rerender({ tab: 'pipeline' });
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'B' }]));
		// Now resolve the stale first fetch - should be ignored
		resolveFirst([{ sessionId: 'A' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		expect(result.current.graphSessions).toEqual([{ sessionId: 'B' }]);
	});

	it('unmount mid-fetch: no setState warning', async () => {
		let resolveFn!: (v: CueGraphSession[]) => void;
		mockGetGraphData.mockReturnValue(
			new Promise<CueGraphSession[]>((r) => {
				resolveFn = r;
			})
		);
		const { unmount } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		unmount();
		resolveFn([{ sessionId: 'late' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		// No assertion needed - absence of act() warning is the signal
	});

	it('refreshGraphData triggers a fresh fetch', async () => {
		mockGetGraphData
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ sessionId: 'fresh' } as unknown as CueGraphSession]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalledTimes(1));
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'fresh' }]));
	});

	it('refreshGraphData during in-flight mount fetch → cancellation protects', async () => {
		let resolveMount!: (v: CueGraphSession[]) => void;
		mockGetGraphData
			.mockReturnValueOnce(
				new Promise<CueGraphSession[]>((r) => {
					resolveMount = r;
				})
			)
			.mockResolvedValueOnce([{ sessionId: 'refresh-won' } as unknown as CueGraphSession]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() =>
			expect(result.current.graphSessions).toEqual([{ sessionId: 'refresh-won' }])
		);
		// Mount fetch resolves late - must be ignored
		resolveMount([{ sessionId: 'mount-lost' } as unknown as CueGraphSession]);
		await new Promise((r) => setTimeout(r, 20));
		expect(result.current.graphSessions).toEqual([{ sessionId: 'refresh-won' }]);
	});

	it('refreshGraphData rejection: graphError set, previous graphSessions untouched', async () => {
		mockGetGraphData.mockResolvedValueOnce([
			{ sessionId: 'initial' } as unknown as CueGraphSession,
		]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.graphSessions).toEqual([{ sessionId: 'initial' }]));
		mockGetGraphData.mockRejectedValueOnce(new Error('refresh failed'));
		act(() => {
			result.current.refreshGraphData();
		});
		await waitFor(() => expect(result.current.graphError).toBe('refresh failed'));
		// Previous graphSessions untouched
		expect(result.current.graphSessions).toEqual([{ sessionId: 'initial' }]);
	});

	it('initialLoading: true on mount, false after first fetch resolves', async () => {
		let resolveFn!: (v: CueGraphSession[]) => void;
		mockGetGraphData.mockReturnValue(
			new Promise<CueGraphSession[]>((r) => {
				resolveFn = r;
			})
		);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		expect(result.current.initialLoading).toBe(true);
		resolveFn([]);
		await waitFor(() => expect(result.current.initialLoading).toBe(false));
	});

	it('initialLoading: flips to false after first fetch rejects', async () => {
		mockGetGraphData.mockRejectedValue(new Error('boom'));
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		expect(result.current.initialLoading).toBe(true);
		await waitFor(() => expect(result.current.initialLoading).toBe(false));
	});

	it('initialLoading: stays false on subsequent refetches (does not flicker back)', async () => {
		mockGetGraphData.mockResolvedValue([]);
		const { result } = renderHook(() =>
			useCueGraphData({ activeTab: 'dashboard', sessionInfoList: [] })
		);
		await waitFor(() => expect(result.current.initialLoading).toBe(false));
		act(() => {
			result.current.refreshGraphData();
		});
		// Should remain false even while a refetch is in flight.
		expect(result.current.initialLoading).toBe(false);
	});

	it('dashboardPipelines memo recomputes only when graphSessions or sessionInfoList change', async () => {
		const { graphSessionsToPipelines } =
			await import('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline');
		mockGetGraphData.mockResolvedValue([]);
		const infoA = [{ id: 's1', name: 's1', toolType: 'x' }];
		const { result, rerender } = renderHook(
			({ info }) => useCueGraphData({ activeTab: 'dashboard', sessionInfoList: info }),
			{ initialProps: { info: infoA } }
		);
		await waitFor(() => expect(mockGetGraphData).toHaveBeenCalled());
		const callCountAfterMount = (graphSessionsToPipelines as any).mock.calls.length;
		// Rerender with same ref → no re-memoize
		rerender({ info: infoA });
		expect((graphSessionsToPipelines as any).mock.calls.length).toBe(callCountAfterMount);
	});
});

// ===== from src/__tests__/renderer/hooks/cue/useCueToggle.test.ts =====
const mockNotifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

describe('useCueToggle', () => {
	beforeEach(() => {
		mockNotifyToast.mockReset();
	});

	it('click when disabled → enable called, toggling flips true then false', async () => {
		let resolveEnable!: () => void;
		const enable = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolveEnable = r;
				})
		);
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		let pending: Promise<void>;
		act(() => {
			pending = result.current.handleToggle();
		});
		expect(result.current.toggling).toBe(true);
		expect(enable).toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
		await act(async () => {
			resolveEnable();
			await pending;
		});
		expect(result.current.toggling).toBe(false);
	});

	it('click when enabled → disable called', async () => {
		const enable = vi.fn();
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useCueToggle({ isEnabled: true, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(disable).toHaveBeenCalled();
		expect(enable).not.toHaveBeenCalled();
	});

	it('double-click while toggling → second call ignored', async () => {
		let resolveEnable!: () => void;
		const enable = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolveEnable = r;
				})
		);
		const disable = vi.fn();
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		let first: Promise<void>;
		act(() => {
			first = result.current.handleToggle();
		});
		// Second call while first pending
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(enable).toHaveBeenCalledTimes(1);
		await act(async () => {
			resolveEnable();
			await first;
		});
	});

	it('enable throws → toast invoked; toggling restored to false', async () => {
		const enable = vi.fn().mockRejectedValue(new Error('nope'));
		const disable = vi.fn();
		const { result } = renderHook(() => useCueToggle({ isEnabled: false, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', message: 'nope' })
		);
		expect(result.current.toggling).toBe(false);
	});

	it('disable throws with non-Error value → default message used', async () => {
		const enable = vi.fn();
		const disable = vi.fn().mockRejectedValue('string error');
		const { result } = renderHook(() => useCueToggle({ isEnabled: true, enable, disable }));
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Failed to disable') })
		);
	});

	it('reads fresh isEnabled between calls', async () => {
		const enable = vi.fn().mockResolvedValue(undefined);
		const disable = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ enabled }) => useCueToggle({ isEnabled: enabled, enable, disable }),
			{ initialProps: { enabled: false } }
		);
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(enable).toHaveBeenCalledTimes(1);
		rerender({ enabled: true });
		await act(async () => {
			await result.current.handleToggle();
		});
		expect(disable).toHaveBeenCalledTimes(1);
	});
});

// ===== from src/__tests__/renderer/hooks/cue/useCueVisibilityWiring.test.ts =====
/**
 * Tests for useCueVisibilityWiring - forwards renderer visibility
 * changes to the main-process Cue scanner subsystem.
 */

describe('useCueVisibilityWiring', () => {
	let setActive: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setActive = vi.fn().mockResolvedValue(undefined);
		// The cue mock is provided by setup.ts but reset call counts here.
		(window.maestro.cue as unknown as { setActive: typeof setActive }).setActive = setActive;
		// Reset visibility to "visible" between tests.
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('seeds main process with current visibility state on mount', () => {
		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledTimes(1);
		expect(setActive).toHaveBeenCalledWith(false);
	});

	it('seeds with active=true when document is visible at mount', () => {
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledTimes(1);
		expect(setActive).toHaveBeenCalledWith(true);
	});

	it('forwards visibilitychange events as setActive(!hidden)', () => {
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledWith(true); // mount seed

		// Hide the document and dispatch the event
		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).toHaveBeenLastCalledWith(false);

		// Show the document again
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).toHaveBeenLastCalledWith(true);
	});

	it('removes its visibilitychange listener on unmount', () => {
		const { unmount } = renderHook(() => useCueVisibilityWiring());
		setActive.mockClear();
		unmount();

		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).not.toHaveBeenCalled();
	});

	it('does not throw when window.maestro.cue is missing', () => {
		const original = window.maestro.cue;
		(window.maestro as unknown as { cue: unknown }).cue = undefined;
		try {
			expect(() => renderHook(() => useCueVisibilityWiring())).not.toThrow();
		} finally {
			(window.maestro as unknown as { cue: unknown }).cue = original;
		}
	});

	it('swallows IPC rejection without throwing', async () => {
		setActive.mockRejectedValue(new Error('IPC error'));
		expect(() => renderHook(() => useCueVisibilityWiring())).not.toThrow();
		// Wait a microtask for the catch handler.
		await Promise.resolve();
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineCanvasCallbacks.test.ts =====
function rfNode(id: string, type: 'trigger' | 'agent'): Node {
	return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as Node;
}

function rfEdge(id: string, source: string, target: string): Edge {
	return { id, source, target } as Edge;
}

function pipeline(
	id: string,
	nodes: CuePipeline['nodes'],
	edges: CuePipeline['edges'] = []
): CuePipeline {
	return { id, name: id, color: '#abc', nodes, edges };
}

interface SetupOpts {
	pipelines?: CuePipeline[];
	selectedPipelineId?: string | null;
	isAllPipelinesView?: boolean;
	nodes?: Node[];
	edges?: Edge[];
	stableYOffsets?: Map<string, number>;
}

function setup(opts: SetupOpts = {}) {
	const initialPipelines = opts.pipelines ?? [pipeline('p1', [])];
	// Use "in" check so callers can explicitly pass null
	const initialSelected = 'selectedPipelineId' in opts ? (opts.selectedPipelineId ?? null) : 'p1';
	let state: CuePipelineState = {
		pipelines: initialPipelines,
		selectedPipelineId: initialSelected,
	};
	const setPipelineState = vi.fn((u: React.SetStateAction<CuePipelineState>) => {
		state = typeof u === 'function' ? (u as (p: CuePipelineState) => CuePipelineState)(state) : u;
	});
	let displayNodes: Node[] = opts.nodes ?? [];
	const setDisplayNodes = vi.fn((u: React.SetStateAction<Node[]>) => {
		displayNodes = typeof u === 'function' ? (u as (n: Node[]) => Node[])(displayNodes) : u;
	});
	const persistLayout = vi.fn();
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();
	const stableYOffsetsRef = { current: opts.stableYOffsets ?? new Map<string, number>() };

	const reactFlowInstance = {
		screenToFlowPosition: vi.fn(({ x, y }) => ({ x, y })),
	} as unknown as ReactFlowInstance;

	const { result, rerender } = renderHook(
		({ view }) =>
			usePipelineCanvasCallbacks({
				state: { pipelineState: state, isAllPipelinesView: view },
				refs: { stableYOffsetsRef },
				display: { nodes: displayNodes, edges: opts.edges ?? [], setDisplayNodes },
				actions: { setPipelineState, persistLayout },
				selection: { setSelectedNodeId, setSelectedEdgeId },
				reactFlowInstance,
			}),
		{ initialProps: { view: opts.isAllPipelinesView ?? false } }
	);

	return {
		result,
		rerender,
		getState: () => state,
		getDisplayNodes: () => displayNodes,
		setPipelineState,
		setDisplayNodes,
		persistLayout,
		setSelectedNodeId,
		setSelectedEdgeId,
		reactFlowInstance,
	};
}

describe('usePipelineCanvasCallbacks', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('onNodesChange', () => {
		it('updates displayNodes only for non-remove changes, does not touch pipelineState', () => {
			const h = setup({ nodes: [rfNode('p1:t1', 'trigger')] });
			act(() => {
				h.result.current.onNodesChange([
					{ id: 'p1:t1', type: 'position', position: { x: 99, y: 99 } },
				]);
			});
			expect(h.setDisplayNodes).toHaveBeenCalled();
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('commits remove changes (box-select delete) to pipelineState and prunes connected edges', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const a1 = {
				id: 'a1',
				type: 'agent' as const,
				position: { x: 0, y: 0 },
				data: { sessionId: 's1', sessionName: 'A', toolType: 'x' },
			};
			const h = setup({
				pipelines: [
					pipeline('p1', [t1, a1], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]),
				],
			});
			act(() => {
				h.result.current.onNodesChange([
					{ id: 'p1:t1', type: 'remove' },
					{ id: 'p1:a1', type: 'remove' },
				]);
			});
			expect(h.getState().pipelines[0].nodes).toHaveLength(0);
			// Edge connected to the removed nodes is pruned too.
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
			// Selection cleared so a stale composite id can't linger.
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});

		it('does not commit remove changes in All Pipelines view (read-only)', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const h = setup({ pipelines: [pipeline('p1', [t1])], isAllPipelinesView: true });
			act(() => {
				h.result.current.onNodesChange([{ id: 'p1:t1', type: 'remove' }]);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
		});
	});

	describe('onEdgesChange', () => {
		it('commits edge remove changes to pipelineState', () => {
			const h = setup({
				pipelines: [
					pipeline(
						'p1',
						[],
						[
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
							{ id: 'e2', source: 't1', target: 'a2', mode: 'pass' },
						]
					),
				],
			});
			act(() => {
				h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'remove' }]);
			});
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
			expect(h.getState().pipelines[0].edges[0].id).toBe('e2');
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});

		it('no-op for non-remove edge changes', () => {
			const h = setup({
				pipelines: [pipeline('p1', [], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }])],
			});
			act(() => {
				h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'select', selected: true }]);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
		});

		it('no-op in All Pipelines view (read-only)', () => {
			const h = setup({
				pipelines: [pipeline('p1', [], [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }])],
				isAllPipelinesView: true,
			});
			act(() => {
				h.result.current.onEdgesChange([{ id: 'p1:e1', type: 'remove' }]);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
		});
	});

	describe('onNodeDrag (pipeline-group child translation)', () => {
		// Regression: ReactFlow fires onNodesChange (which moves the group node)
		// BEFORE onNodeDrag. An incremental per-frame delta read the group's
		// already-updated position and computed zero, stranding the child nodes
		// outside the dragged card. The absolute delta (start + total) must keep
		// children locked to the group regardless of that ordering.
		it('translates children by the full delta even when the group moved first', () => {
			const groupId = 'pipeline-group:p1';
			const group = {
				id: groupId,
				type: 'pipeline-group',
				position: { x: 10, y: 10 },
				data: {},
			} as unknown as Node;
			const child1 = {
				id: 'p1:t1',
				type: 'trigger',
				position: { x: 20, y: 30 },
				data: {},
			} as unknown as Node;
			const child2 = {
				id: 'p1:a1',
				type: 'agent',
				position: { x: 60, y: 80 },
				data: {},
			} as unknown as Node;
			const h = setup({
				pipelines: [pipeline('p1', [])],
				selectedPipelineId: null,
				isAllPipelinesView: true,
				nodes: [group, child1, child2],
			});

			// 1) Drag start snapshots child start positions.
			act(() => {
				h.result.current.onNodeDragStart({} as React.MouseEvent, group, [group]);
			});
			// 2) ReactFlow moves the GROUP node first (the bug trigger).
			act(() => {
				h.result.current.onNodesChange([
					{ id: groupId, type: 'position', position: { x: 50, y: 70 }, dragging: true },
				]);
			});
			// 3) onNodeDrag fires with the group already at its new position.
			const movedGroup = { ...group, position: { x: 50, y: 70 } } as Node;
			act(() => {
				h.result.current.onNodeDrag({} as React.MouseEvent, movedGroup, [movedGroup]);
			});

			// Delta = (40, 60); children must track it exactly.
			const dn = h.getDisplayNodes();
			expect(dn.find((n) => n.id === 'p1:t1')!.position).toEqual({ x: 60, y: 90 });
			expect(dn.find((n) => n.id === 'p1:a1')!.position).toEqual({ x: 100, y: 140 });
			// The group node itself is moved by ReactFlow, not this handler.
			expect(dn.find((n) => n.id === groupId)!.position).toEqual({ x: 50, y: 70 });
		});

		it('ignores drags that did not originate on a pipeline-group node', () => {
			const child = {
				id: 'p1:t1',
				type: 'trigger',
				position: { x: 20, y: 30 },
				data: {},
			} as unknown as Node;
			const h = setup({
				pipelines: [pipeline('p1', [])],
				selectedPipelineId: null,
				isAllPipelinesView: true,
				nodes: [child],
			});
			// No dragStart for a group → ref is null → onNodeDrag is a no-op.
			act(() => {
				h.result.current.onNodeDrag({} as React.MouseEvent, child, [child]);
			});
			expect(h.getDisplayNodes().find((n) => n.id === 'p1:t1')!.position).toEqual({
				x: 20,
				y: 30,
			});
		});
	});

	describe('onNodeDragStop', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 5, y: 5 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.persistLayout).not.toHaveBeenCalled();
		});

		it('commits position and calls persistLayout in single-pipeline view', () => {
			const n1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const h = setup({ pipelines: [pipeline('p1', [n1])] });
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 200, y: 100 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.getState().pipelines[0].nodes[0].position).toEqual({ x: 200, y: 100 });
			expect(h.persistLayout).toHaveBeenCalled();
		});

		it('subtracts stableYOffsets in All-Pipelines view', () => {
			const n1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const h = setup({
				pipelines: [pipeline('p1', [n1])],
				selectedPipelineId: null,
				stableYOffsets: new Map([['p1', 500]]),
			});
			const dragged: Node[] = [{ id: 'p1:t1', position: { x: 200, y: 700 }, data: {} } as Node];
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, dragged[0], dragged);
			});
			expect(h.getState().pipelines[0].nodes[0].position).toEqual({ x: 200, y: 200 });
		});

		it('no-op with empty draggedNodes array', () => {
			const h = setup({ pipelines: [pipeline('p1', [])] });
			act(() => {
				h.result.current.onNodeDragStop({} as React.MouseEvent, {} as Node, []);
			});
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});
	});

	describe('onConnect', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			act(() =>
				h.result.current.onConnect({ source: 'p1:t1', target: 'p1:a1' } as Parameters<
					typeof h.result.current.onConnect
				>[0])
			);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('rejects connection when pipelines differ', () => {
			const h = setup();
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p2:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			// Still calls setPipelineState but with prev unchanged - verify via getState
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
		});

		it('rejects when target node is a trigger', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const t2 = { ...t1, id: 't2' };
			const h = setup({ pipelines: [pipeline('p1', [t1, t2])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:t2',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
		});

		it('creates edge when valid', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'app.startup' as const, label: 'T', config: {} },
			};
			const a1 = {
				id: 'a1',
				type: 'agent' as const,
				position: { x: 0, y: 0 },
				data: { sessionId: 's1', sessionName: 'A', toolType: 'x', inputPrompt: 'p' },
			};
			const h = setup({ pipelines: [pipeline('p1', [t1, a1])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
			expect(h.getState().pipelines[0].edges[0]).toMatchObject({
				source: 't1',
				target: 'a1',
				mode: 'pass',
			});
		});

		it('auto-populates default prompt when connecting GitHub trigger to prompt-less agent', () => {
			const t1 = {
				id: 't1',
				type: 'trigger' as const,
				position: { x: 0, y: 0 },
				data: { eventType: 'github.pull_request' as const, label: 'PR', config: {} },
			};
			const a1 = {
				id: 'a1',
				type: 'agent' as const,
				position: { x: 0, y: 0 },
				data: { sessionId: 's1', sessionName: 'A', toolType: 'x' },
			};
			const h = setup({ pipelines: [pipeline('p1', [t1, a1])] });
			act(() =>
				h.result.current.onConnect({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.onConnect>[0])
			);
			const agent = h.getState().pipelines[0].nodes.find((n) => n.id === 'a1');
			expect((agent?.data as { inputPrompt?: string }).inputPrompt).toBeTruthy();
		});
	});

	describe('isValidConnection', () => {
		it('returns false in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			expect(
				h.result.current.isValidConnection({
					source: 'a',
					target: 'b',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects self-loop', () => {
			const h = setup({ nodes: [rfNode('p1:t1', 'trigger')] });
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:t1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects trigger→trigger', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:t2', 'trigger')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:t2',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects target being a trigger', () => {
			const h = setup({
				nodes: [rfNode('p1:a1', 'agent'), rfNode('p1:t1', 'trigger')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:a1',
					target: 'p1:t1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('rejects duplicate edge', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')],
				edges: [rfEdge('e1', 'p1:t1', 'p1:a1')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('accepts valid new connection', () => {
			const h = setup({
				nodes: [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')],
			});
			expect(
				h.result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof h.result.current.isValidConnection>[0])
			).toBe(true);
		});

		// Phase 14C - callback identity stability via ref pattern.
		it('keeps callback identity stable across nodes/edges changes', () => {
			let nodes: Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
			let edges: Edge[] = [];
			const { result, rerender } = renderHook(
				({ n, e }: { n: Node[]; e: Edge[] }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: false,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { n: nodes, e: edges } }
			);

			const firstIdentity = result.current.isValidConnection;

			// Swap in new nodes/edges arrays - simulating post-drag applyNodeChanges.
			nodes = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent'), rfNode('p1:a2', 'agent')];
			edges = [rfEdge('e1', 'p1:t1', 'p1:a1')];
			rerender({ n: nodes, e: edges });

			expect(result.current.isValidConnection).toBe(firstIdentity);
		});

		it('callback reads latest nodes/edges via refs (functional correctness preserved)', () => {
			let nodes: Node[] = [rfNode('p1:t1', 'trigger'), rfNode('p1:a1', 'agent')];
			let edges: Edge[] = [];
			const { result, rerender } = renderHook(
				({ n, e }: { n: Node[]; e: Edge[] }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: false,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: { nodes: n, edges: e, setDisplayNodes: vi.fn() },
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { n: nodes, e: edges } }
			);

			// First: no edge → valid.
			expect(
				result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof result.current.isValidConnection>[0])
			).toBe(true);

			// Add the edge, rerender. Same callback identity, but now sees the edge.
			edges = [rfEdge('e1', 'p1:t1', 'p1:a1')];
			rerender({ n: nodes, e: edges });
			expect(
				result.current.isValidConnection({
					source: 'p1:t1',
					target: 'p1:a1',
				} as Parameters<typeof result.current.isValidConnection>[0])
			).toBe(false);
		});

		it('callback identity changes when isAllPipelinesView flips', () => {
			const { result, rerender } = renderHook(
				({ view }: { view: boolean }) =>
					usePipelineCanvasCallbacks({
						state: {
							pipelineState: { pipelines: [pipeline('p1', [])], selectedPipelineId: 'p1' },
							isAllPipelinesView: view,
						},
						refs: { stableYOffsetsRef: { current: new Map() } },
						display: {
							nodes: [rfNode('p1:t1', 'trigger')],
							edges: [],
							setDisplayNodes: vi.fn(),
						},
						actions: { setPipelineState: vi.fn(), persistLayout: vi.fn() },
						selection: { setSelectedNodeId: vi.fn(), setSelectedEdgeId: vi.fn() },
						reactFlowInstance: { screenToFlowPosition: vi.fn() } as unknown as ReactFlowInstance,
					}),
				{ initialProps: { view: false } }
			);

			const firstIdentity = result.current.isValidConnection;
			rerender({ view: true });
			expect(result.current.isValidConnection).not.toBe(firstIdentity);
		});
	});

	describe('onDragOver', () => {
		it('calls preventDefault and sets move dropEffect', () => {
			const h = setup();
			const preventDefault = vi.fn();
			const stopPropagation = vi.fn();
			const event = {
				preventDefault,
				stopPropagation,
				dataTransfer: { dropEffect: '' },
			} as unknown as React.DragEvent;
			h.result.current.onDragOver(event);
			expect(preventDefault).toHaveBeenCalled();
			expect(event.dataTransfer.dropEffect).toBe('move');
		});
	});

	describe('onDrop', () => {
		it('no-op in All Pipelines view', () => {
			const h = setup({ isAllPipelinesView: true });
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: { getData: vi.fn(() => JSON.stringify({ type: 'trigger' })) },
				clientX: 10,
				clientY: 20,
			} as unknown as React.DragEvent;
			h.result.current.onDrop(event);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('ignores drop without cue-pipeline payload', () => {
			const h = setup();
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: { getData: vi.fn(() => '') },
				clientX: 10,
				clientY: 20,
			} as unknown as React.DragEvent;
			h.result.current.onDrop(event);
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('creates trigger node and defers selection by 50ms', () => {
			const h = setup();
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: {
					getData: vi.fn(() =>
						JSON.stringify({ type: 'trigger', eventType: 'app.startup', label: 'Start' })
					),
				},
				clientX: 100,
				clientY: 200,
			} as unknown as React.DragEvent;
			act(() => {
				h.result.current.onDrop(event);
			});
			// Node created in state
			const newNodes = h.getState().pipelines[0].nodes;
			expect(newNodes).toHaveLength(1);
			expect(newNodes[0].type).toBe('trigger');
			// Selection NOT yet fired
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			// After 50ms, selection fires
			act(() => vi.advanceTimersByTime(50));
			expect(h.setSelectedNodeId).toHaveBeenCalled();
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});

		it('auto-creates pipeline when none exists', () => {
			const h = setup({ pipelines: [], selectedPipelineId: null });
			const event = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
				dataTransfer: {
					getData: vi.fn(() => JSON.stringify({ type: 'trigger', eventType: 'app.startup' })),
				},
				clientX: 100,
				clientY: 200,
			} as unknown as React.DragEvent;
			act(() => {
				h.result.current.onDrop(event);
			});
			expect(h.getState().pipelines).toHaveLength(1);
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			expect(h.getState().selectedPipelineId).toBe(h.getState().pipelines[0].id);
		});
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineContextMenu.test.ts =====
function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 10, y: 20 },
		data: { eventType: 'app.startup', label: 'T', config: {}, customLabel: 'MyTrigger' },
	};
}

function rfNodeUsePipelineContextMenu(id: string, type: 'trigger' | 'agent'): Node {
	return { id, position: { x: 0, y: 0 }, data: {}, type } as unknown as Node;
}

function stubEvent(x = 10, y = 20): React.MouseEvent {
	return {
		preventDefault: vi.fn(),
		clientX: x,
		clientY: y,
	} as unknown as React.MouseEvent;
}

function setupUsePipelineContextMenu(
	options: { isAllPipelinesView?: boolean; pipelines?: PipelineNode[] } = {}
) {
	let pipelineState: CuePipelineState = {
		pipelines: [
			{
				id: 'p1',
				name: 'Pipeline 1',
				color: '#abc',
				nodes: options.pipelines ?? [triggerNode('t1')],
				edges: [],
			},
		],
		selectedPipelineId: 'p1',
	};
	const setPipelineState = vi.fn((u: React.SetStateAction<CuePipelineState>) => {
		pipelineState =
			typeof u === 'function' ? (u as (p: CuePipelineState) => CuePipelineState)(pipelineState) : u;
	});
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();

	const { result, rerender } = renderHook(
		({ isAllPipelinesView }) =>
			usePipelineContextMenu({
				isAllPipelinesView,
				setPipelineState,
				setSelectedNodeId,
				setSelectedEdgeId,
			}),
		{ initialProps: { isAllPipelinesView: options.isAllPipelinesView ?? false } }
	);

	return {
		result,
		rerender,
		getState: () => pipelineState,
		setPipelineState,
		setSelectedNodeId,
		setSelectedEdgeId,
	};
}

describe('usePipelineContextMenu', () => {
	describe('onNodeContextMenu', () => {
		it('opens menu with coordinates + parsed node info', () => {
			const h = setupUsePipelineContextMenu();
			const ev = stubEvent(120, 340);
			act(() =>
				h.result.current.onNodeContextMenu(ev, rfNodeUsePipelineContextMenu('p1:t1', 'trigger'))
			);
			expect(h.result.current.contextMenu).toEqual({
				x: 120,
				y: 340,
				nodeId: 't1',
				pipelineId: 'p1',
				nodeType: 'trigger',
			});
			expect(ev.preventDefault).toHaveBeenCalled();
		});

		it('is a no-op in All Pipelines view', () => {
			const h = setupUsePipelineContextMenu({ isAllPipelinesView: true });
			const ev = stubEvent();
			act(() =>
				h.result.current.onNodeContextMenu(ev, rfNodeUsePipelineContextMenu('p1:t1', 'trigger'))
			);
			expect(h.result.current.contextMenu).toBeNull();
			expect(ev.preventDefault).toHaveBeenCalled();
		});

		it('rejects malformed node ids (no colon separator)', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('malformed', 'trigger')
				)
			);
			expect(h.result.current.contextMenu).toBeNull();
		});
	});

	describe('handleContextMenuConfigure', () => {
		it('selects node + closes menu', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).toHaveBeenCalledWith('p1:t1');
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('view switch between open and action → closes menu without mutation', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('no-op when menu is already null', () => {
			const h = setupUsePipelineContextMenu();
			act(() => h.result.current.handleContextMenuConfigure());
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});
	});

	describe('handleContextMenuDelete', () => {
		it('removes node + adjacent edges, clears selection + menu', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			act(() => h.result.current.handleContextMenuDelete());
			expect(h.getState().pipelines[0].nodes.map((n) => n.id)).not.toContain('t1');
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
			expect(h.result.current.contextMenu).toBeNull();
		});

		it('view switch → closes menu without state change', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuDelete());
			expect(h.setPipelineState).not.toHaveBeenCalled();
			expect(h.result.current.contextMenu).toBeNull();
		});
	});

	describe('handleContextMenuDuplicate', () => {
		it('duplicates trigger with +50px offset', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			act(() => h.result.current.handleContextMenuDuplicate());
			const newNodes = h.getState().pipelines[0].nodes;
			expect(newNodes).toHaveLength(2);
			const newNode = newNodes[1];
			expect(newNode.position).toEqual({ x: 60, y: 70 });
			expect(newNode.type).toBe('trigger');
		});

		it('no-op for agent nodes', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'agent')
				)
			);
			act(() => h.result.current.handleContextMenuDuplicate());
			expect(h.setPipelineState).not.toHaveBeenCalled();
		});

		it('view switch → closes menu without duplicate', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			h.rerender({ isAllPipelinesView: true });
			act(() => h.result.current.handleContextMenuDuplicate());
			// Note: setPipelineState may be called initially by onNodeContextMenu - but it isn't, so
			// only check no state change after duplicate attempt
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
		});
	});

	describe('handleContextMenuDismiss', () => {
		it('sets context menu to null', () => {
			const h = setupUsePipelineContextMenu();
			act(() =>
				h.result.current.onNodeContextMenu(
					stubEvent(),
					rfNodeUsePipelineContextMenu('p1:t1', 'trigger')
				)
			);
			act(() => h.result.current.handleContextMenuDismiss());
			expect(h.result.current.contextMenu).toBeNull();
		});
	});
});
