// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCueSettings } from '../../../../renderer/hooks/cue/useCueSettings';
import { DEFAULT_CUE_SETTINGS } from '../../../../shared/cue';
import type { CueSettings } from '../../../../shared/cue';
import { usePipelineCrud } from '../../../../renderer/hooks/cue/usePipelineCrud';
import type {
	CuePipelineState,
	CuePipeline,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../shared/cue-pipeline-types';
import { usePipelineKeyboard } from '../../../../renderer/hooks/cue/usePipelineKeyboard';
import type { Node, Edge } from 'reactflow';
import { usePipelineMutations } from '../../../../renderer/hooks/cue/usePipelineMutations';
import { usePipelineSelection } from '../../../../renderer/hooks/cue/usePipelineSelection';

// ===== from src/__tests__/renderer/hooks/cue/useCueSettings.test.ts =====
const mockGetSettings = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		getSettings: (...args: unknown[]) => mockGetSettings(...args),
	},
}));

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('useCueSettings', () => {
	beforeEach(() => {
		mockGetSettings.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('initial state: default settings, settingsLoaded=false', () => {
		mockGetSettings.mockReturnValue(new Promise(() => {})); // never resolves
		const { result } = renderHook(() => useCueSettings());
		expect(result.current.cueSettings).toEqual(DEFAULT_CUE_SETTINGS);
		expect(result.current.settingsLoaded).toBe(false);
	});

	it('on mount, cueService.getSettings invoked once and resolved value overwrites state', async () => {
		const fetched: CueSettings = { ...DEFAULT_CUE_SETTINGS, max_concurrent_runs: 7 };
		mockGetSettings.mockResolvedValue(fetched);
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		expect(mockGetSettings).toHaveBeenCalledTimes(1);
		expect(result.current.cueSettings).toEqual(fetched);
	});

	it('IPC rejection: settingsLoaded still flips to true; cueSettings stays at default', async () => {
		mockGetSettings.mockRejectedValue(new Error('IPC down'));
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		expect(result.current.cueSettings).toEqual(DEFAULT_CUE_SETTINGS);
	});

	it('setCueSettings updates settings in place', async () => {
		mockGetSettings.mockResolvedValue({ ...DEFAULT_CUE_SETTINGS });
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		act(() => {
			result.current.setCueSettings((prev) => ({ ...prev, max_concurrent_runs: 99 }));
		});
		expect(result.current.cueSettings.max_concurrent_runs).toBe(99);
	});

	it('settingsLoaded=true persists across subsequent setCueSettings calls', async () => {
		mockGetSettings.mockResolvedValue({ ...DEFAULT_CUE_SETTINGS });
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		act(() => {
			result.current.setCueSettings({ ...DEFAULT_CUE_SETTINGS, max_concurrent_runs: 5 });
		});
		expect(result.current.settingsLoaded).toBe(true);
	});

	it('unmount before fetch resolves does not flip settingsLoaded', async () => {
		let resolveFn!: (v: CueSettings) => void;
		mockGetSettings.mockReturnValue(
			new Promise<CueSettings>((resolve) => {
				resolveFn = resolve;
			})
		);
		const { result, unmount } = renderHook(() => useCueSettings());
		expect(result.current.settingsLoaded).toBe(false);
		unmount();
		resolveFn({ ...DEFAULT_CUE_SETTINGS });
		// No assertion failure = no setState-on-unmounted warning (thanks to cancelled flag).
		await Promise.resolve();
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineCrud.test.ts =====
const mockShowConfirmation = vi.fn();

vi.mock('../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({ showConfirmation: mockShowConfirmation }),
}));

function makePipeline(id: string, name: string, color = '#06b6d4', nodeCount = 0): CuePipeline {
	return {
		id,
		name,
		color,
		nodes: Array.from({ length: nodeCount }, (_, i) => ({
			id: `${id}-n${i}`,
			type: 'trigger',
			position: { x: 0, y: 0 },
			data: { eventType: 'app.startup', label: 'T', config: {} },
		})),
		edges: [],
	};
}

type Hooks = ReturnType<typeof setup>;

function setup(initialState?: Partial<CuePipelineState>) {
	let pipelineState: CuePipelineState = {
		pipelines: initialState?.pipelines ?? [],
		selectedPipelineId: initialState?.selectedPipelineId ?? null,
	};
	const setPipelineState = vi.fn((updater: React.SetStateAction<CuePipelineState>) => {
		pipelineState =
			typeof updater === 'function'
				? (updater as (prev: CuePipelineState) => CuePipelineState)(pipelineState)
				: updater;
	});
	const persistLayout = vi.fn();
	const setTriggerDrawerOpen = vi.fn();
	const setAgentDrawerOpen = vi.fn();

	const { result, rerender } = renderHook(
		({ state }) =>
			usePipelineCrud({
				state: { pipelineState: state },
				setters: { setPipelineState },
				actions: { persistLayout },
				drawers: { setTriggerDrawerOpen, setAgentDrawerOpen },
			}),
		{ initialProps: { state: pipelineState } }
	);

	return {
		result,
		rerender: () => rerender({ state: pipelineState }),
		getState: () => pipelineState,
		setPipelineState,
		persistLayout,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
	};
}

describe('usePipelineCrud', () => {
	beforeEach(() => {
		mockShowConfirmation.mockReset();
	});

	describe('createPipeline', () => {
		it('creates first pipeline with name "Pipeline 1" and first color', () => {
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines).toHaveLength(1);
			expect(state.pipelines[0].name).toBe('Pipeline 1');
			expect(state.selectedPipelineId).toBe(state.pipelines[0].id);
		});

		it('assigns next unused color when existing pipelines use earlier colors', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Pipeline 1', '#06b6d4')],
			});
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines).toHaveLength(2);
			expect(state.pipelines[1].color).not.toBe('#06b6d4');
		});

		it('auto-generates Pipeline N with N = max existing number + 1 (handles deletions)', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p3', 'Pipeline 3'), makePipeline('p1', 'Pipeline 1')],
			});
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines[2].name).toBe('Pipeline 4');
		});

		it('assigns id of the form `pipeline-${name}` (matches yamlToPipeline reload id)', () => {
			// Regression guard for the "snap-back to grid on first save+reopen"
			// bug: if createPipeline used a timestamp id (e.g. pipeline-1741234567890),
			// the first persistLayout would write positions under that timestamp
			// id; the next reopen would regenerate the id as `pipeline-${name}`
			// and the position lookup would miss, snapping all nodes to the
			// auto-layout default. yamlToPipeline uses `pipeline-${baseName}` on
			// reload (see `subscriptionsToPipelines` in yamlToPipeline.ts), so
			// createPipeline must match that form from day one.
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines[0].id).toBe('pipeline-Pipeline 1');
		});

		it('id tracks the auto-incremented name across successive creates', () => {
			const h: Hooks = setup();
			act(() => h.result.current.createPipeline());
			act(() => h.result.current.createPipeline());
			act(() => h.result.current.createPipeline());
			const state = h.getState();
			expect(state.pipelines.map((p) => p.id)).toEqual([
				'pipeline-Pipeline 1',
				'pipeline-Pipeline 2',
				'pipeline-Pipeline 3',
			]);
		});
	});

	describe('deletePipeline', () => {
		it('deletes empty pipeline without confirmation', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha', '#06b6d4', 0)],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p1'));
			expect(mockShowConfirmation).not.toHaveBeenCalled();
			expect(h.getState().pipelines).toHaveLength(0);
			expect(h.getState().selectedPipelineId).toBeNull();
		});

		it('shows confirmation for pipeline with nodes', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha', '#06b6d4', 3)],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p1'));
			expect(mockShowConfirmation).toHaveBeenCalledWith(
				expect.stringContaining('"Alpha"'),
				expect.any(Function)
			);
			// State not yet changed
			expect(h.getState().pipelines).toHaveLength(1);
			// Invoke the confirmation callback
			const callback = mockShowConfirmation.mock.calls[0][1] as () => void;
			act(() => callback());
			expect(h.getState().pipelines).toHaveLength(0);
			expect(h.getState().selectedPipelineId).toBeNull();
		});

		it('preserves selectedPipelineId when deleting a non-selected pipeline', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A'), makePipeline('p2', 'B')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('p2'));
			expect(h.getState().selectedPipelineId).toBe('p1');
		});

		it('is a no-op for unknown id', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Alpha')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.deletePipeline('non-existent'));
			expect(mockShowConfirmation).not.toHaveBeenCalled();
			expect(h.getState().pipelines).toHaveLength(1);
		});
	});

	describe('renamePipeline', () => {
		it('updates name but leaves nodes/edges/color intact', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'Old', '#abc', 2)],
			});
			act(() => h.result.current.renamePipeline('p1', 'New'));
			const p = h.getState().pipelines[0];
			expect(p.name).toBe('New');
			expect(p.color).toBe('#abc');
			expect(p.nodes).toHaveLength(2);
		});
	});

	describe('selectPipeline', () => {
		it('sets selectedPipelineId to given id and calls persistLayout', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A')],
				selectedPipelineId: null,
			});
			act(() => h.result.current.selectPipeline('p1'));
			expect(h.getState().selectedPipelineId).toBe('p1');
			expect(h.persistLayout).toHaveBeenCalledTimes(1);
			// Drawers untouched when selecting non-null
			expect(h.setTriggerDrawerOpen).not.toHaveBeenCalled();
			expect(h.setAgentDrawerOpen).not.toHaveBeenCalled();
		});

		it('selectPipeline(null) closes both drawers and calls persistLayout', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A')],
				selectedPipelineId: 'p1',
			});
			act(() => h.result.current.selectPipeline(null));
			expect(h.getState().selectedPipelineId).toBeNull();
			expect(h.setTriggerDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.setAgentDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.persistLayout).toHaveBeenCalledTimes(1);
		});
	});

	describe('changePipelineColor', () => {
		it('updates color, leaves other fields intact', () => {
			const h: Hooks = setup({
				pipelines: [makePipeline('p1', 'A', '#abc', 2)],
			});
			act(() => h.result.current.changePipelineColor('p1', '#xyz'));
			const p = h.getState().pipelines[0];
			expect(p.color).toBe('#xyz');
			expect(p.name).toBe('A');
			expect(p.nodes).toHaveLength(2);
		});
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineKeyboard.test.ts =====
function rfNode(id: string): Node {
	return { id, position: { x: 0, y: 0 }, data: {} } as unknown as Node;
}

function rfEdge(id: string): Edge {
	return { id, source: 'a', target: 'b' } as Edge;
}

interface SetupOpts {
	isAllPipelinesView?: boolean;
	selectedNode?: Node | null;
	selectedNodePipelineId?: string | null;
	selectedEdge?: Edge | null;
	selectedEdgePipelineId?: string | null;
	selectedNodeId?: string | null;
	selectedEdgeId?: string | null;
	triggerDrawerOpen?: boolean;
	agentDrawerOpen?: boolean;
	/** Mock editor root. Defaults to a fresh div appended to document.body. */
	container?: HTMLElement;
}

function setupUsePipelineKeyboard(opts: SetupOpts = {}) {
	const onDeleteNode = vi.fn();
	const onDeleteEdge = vi.fn();
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();
	const setTriggerDrawerOpen = vi.fn();
	const setAgentDrawerOpen = vi.fn();
	const setInteractionMode = vi.fn();
	const handleSave = vi.fn();
	const zoomIn = vi.fn();
	const zoomOut = vi.fn();
	const fitView = vi.fn();
	const setIsLocked = vi.fn();

	const container =
		opts.container ??
		(() => {
			const el = document.createElement('div');
			document.body.appendChild(el);
			return el;
		})();
	const containerRef = { current: container };

	renderHook(() =>
		usePipelineKeyboard({
			isAllPipelinesView: opts.isAllPipelinesView ?? false,
			selectedNode: opts.selectedNode ?? null,
			selectedNodePipelineId: opts.selectedNodePipelineId ?? null,
			selectedEdge: opts.selectedEdge ?? null,
			selectedEdgePipelineId: opts.selectedEdgePipelineId ?? null,
			selectedNodeId: opts.selectedNodeId ?? null,
			selectedEdgeId: opts.selectedEdgeId ?? null,
			triggerDrawerOpen: opts.triggerDrawerOpen ?? false,
			agentDrawerOpen: opts.agentDrawerOpen ?? false,
			onDeleteNode,
			onDeleteEdge,
			setSelectedNodeId,
			setSelectedEdgeId,
			setTriggerDrawerOpen,
			setAgentDrawerOpen,
			setInteractionMode,
			handleSave,
			zoomIn,
			zoomOut,
			fitView,
			setIsLocked,
			containerRef,
		})
	);

	return {
		onDeleteNode,
		onDeleteEdge,
		setSelectedNodeId,
		setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
		setInteractionMode,
		handleSave,
		zoomIn,
		zoomOut,
		fitView,
		setIsLocked,
		container,
	};
}

function dispatch(
	key: string,
	opts: { metaKey?: boolean; ctrlKey?: boolean; target?: HTMLElement } = {}
) {
	const event = new KeyboardEvent('keydown', {
		key,
		metaKey: opts.metaKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		bubbles: true,
		cancelable: true,
	});
	if (opts.target) {
		Object.defineProperty(event, 'target', { value: opts.target, enumerable: true });
	}
	window.dispatchEvent(event);
	return event;
}

describe('usePipelineKeyboard', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	describe('Delete / Backspace', () => {
		it('deletes selected node when present', () => {
			const h = setupUsePipelineKeyboard({
				selectedNode: rfNode('p1:t1'),
				selectedNodePipelineId: 'p1',
			});
			dispatch('Delete');
			expect(h.onDeleteNode).toHaveBeenCalledWith('p1:t1');
		});

		it('Backspace also triggers node deletion', () => {
			const h = setupUsePipelineKeyboard({
				selectedNode: rfNode('p1:t1'),
				selectedNodePipelineId: 'p1',
			});
			dispatch('Backspace');
			expect(h.onDeleteNode).toHaveBeenCalled();
		});

		it('deletes selected edge when node is not selected', () => {
			const h = setupUsePipelineKeyboard({
				selectedEdge: rfEdge('e1'),
				selectedEdgePipelineId: 'p1',
			});
			dispatch('Delete');
			expect(h.onDeleteEdge).toHaveBeenCalledWith('e1');
		});

		it('no-op when target is text input', () => {
			const input = document.createElement('input');
			document.body.appendChild(input);
			const h = setupUsePipelineKeyboard({
				selectedNode: rfNode('p1:t1'),
				selectedNodePipelineId: 'p1',
			});
			dispatch('Delete', { target: input });
			expect(h.onDeleteNode).not.toHaveBeenCalled();
		});

		it('no-op in All Pipelines view', () => {
			const h = setupUsePipelineKeyboard({
				selectedNode: rfNode('p1:t1'),
				selectedNodePipelineId: 'p1',
				isAllPipelinesView: true,
			});
			dispatch('Delete');
			expect(h.onDeleteNode).not.toHaveBeenCalled();
		});
	});

	describe('Escape', () => {
		it('closes trigger drawer first', () => {
			const h = setupUsePipelineKeyboard({ triggerDrawerOpen: true, selectedNodeId: 'p1:t1' });
			dispatch('Escape');
			expect(h.setTriggerDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});

		it('closes agent drawer when trigger drawer closed', () => {
			const h = setupUsePipelineKeyboard({ agentDrawerOpen: true, selectedNodeId: 'p1:t1' });
			dispatch('Escape');
			expect(h.setAgentDrawerOpen).toHaveBeenCalledWith(false);
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});

		it('clears selection when no drawers open', () => {
			const h = setupUsePipelineKeyboard({ selectedNodeId: 'p1:t1', selectedEdgeId: null });
			dispatch('Escape');
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});

		it('no-op when nothing to close', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('Escape');
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});
	});

	describe('Cmd/Ctrl+S', () => {
		it('Cmd+S triggers handleSave', () => {
			const h = setupUsePipelineKeyboard();
			const ev = dispatch('s', { metaKey: true });
			expect(h.handleSave).toHaveBeenCalled();
			expect(ev.defaultPrevented).toBe(true);
		});

		it('Ctrl+S triggers handleSave', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('s', { ctrlKey: true });
			expect(h.handleSave).toHaveBeenCalled();
		});

		it('plain "s" does NOT trigger save', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('s');
			expect(h.handleSave).not.toHaveBeenCalled();
		});
	});

	describe('cleanup', () => {
		it('removes listener on unmount', () => {
			const onDeleteNode = vi.fn();
			const container = document.createElement('div');
			document.body.appendChild(container);
			const { unmount } = renderHook(() =>
				usePipelineKeyboard({
					isAllPipelinesView: false,
					selectedNode: rfNode('p1:t1'),
					selectedNodePipelineId: 'p1',
					selectedEdge: null,
					selectedEdgePipelineId: null,
					selectedNodeId: 'p1:t1',
					selectedEdgeId: null,
					triggerDrawerOpen: false,
					agentDrawerOpen: false,
					onDeleteNode,
					onDeleteEdge: vi.fn(),
					setSelectedNodeId: vi.fn(),
					setSelectedEdgeId: vi.fn(),
					setTriggerDrawerOpen: vi.fn(),
					setAgentDrawerOpen: vi.fn(),
					setInteractionMode: vi.fn(),
					handleSave: vi.fn(),
					zoomIn: vi.fn(),
					zoomOut: vi.fn(),
					fitView: vi.fn(),
					setIsLocked: vi.fn(),
					containerRef: { current: container },
				})
			);
			unmount();
			dispatch('Delete');
			expect(onDeleteNode).not.toHaveBeenCalled();
		});
	});

	describe('Interaction mode (P / S)', () => {
		// setInteractionMode is now a functional updater (Dispatch<SetStateAction>)
		// to support toggle semantics: pressing P from 'hand' flips to 'pointer'.
		// Helper: invoke the latest captured updater with a given prev state.
		function applyUpdater(
			mock: ReturnType<typeof vi.fn>,
			prev: 'hand' | 'pointer'
		): 'hand' | 'pointer' {
			const updater = mock.mock.calls.at(-1)?.[0] as (p: 'hand' | 'pointer') => 'hand' | 'pointer';
			return updater(prev);
		}

		it('plain "p" switches to hand mode (from pointer)', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('p');
			expect(h.setInteractionMode).toHaveBeenCalled();
			expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
		});

		it('plain "P" (uppercase) switches to hand mode', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('P');
			expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
		});

		it('plain "s" switches to pointer mode (from hand)', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('s');
			expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
		});

		it('plain "S" (uppercase) switches to pointer mode', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('S');
			expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
		});

		it('pressing same mode key twice toggles back', () => {
			// Pressing 'p' while already in 'hand' should flip to 'pointer'.
			const h = setupUsePipelineKeyboard();
			dispatch('p');
			expect(applyUpdater(h.setInteractionMode, 'hand')).toBe('pointer');
		});

		it('does not change mode when typing in an input INSIDE the editor', () => {
			const h = setupUsePipelineKeyboard();
			const input = document.createElement('input');
			h.container.appendChild(input);
			dispatch('p', { target: input });
			dispatch('s', { target: input });
			expect(h.setInteractionMode).not.toHaveBeenCalled();
		});

		it('still switches mode when an input OUTSIDE the editor has focus', () => {
			// Regression: when the Cue modal is open above an AI textarea that
			// retained focus, P/S must claim the keystroke (not let the hidden
			// background input swallow it).
			const h = setupUsePipelineKeyboard();
			const externalInput = document.createElement('textarea');
			document.body.appendChild(externalInput);
			const ev = dispatch('p', { target: externalInput });
			expect(applyUpdater(h.setInteractionMode, 'pointer')).toBe('hand');
			expect(ev.defaultPrevented).toBe(true);
		});

		it('does not change mode when Cmd is held (Cmd+S still saves)', () => {
			const h = setupUsePipelineKeyboard();
			dispatch('s', { metaKey: true });
			expect(h.setInteractionMode).not.toHaveBeenCalled();
			expect(h.handleSave).toHaveBeenCalled();
		});
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineMutations.test.ts =====
function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType: 'app.startup', label: 'Trigger', config: {} },
	};
}

function agentNode(id: string, sessionName = 'Agent'): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId: `s-${id}`,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: 'p',
		},
	};
}

function pipeline(
	id: string,
	name: string,
	nodes: PipelineNode[],
	edges: PipelineEdge[] = []
): CuePipeline {
	return { id, name, color: '#06b6d4', nodes, edges };
}

function setupUsePipelineMutations(options: {
	pipelines: CuePipeline[];
	selectedNodePipelineId?: string | null;
	selectedEdgePipelineId?: string | null;
}) {
	let state: CuePipelineState = {
		pipelines: options.pipelines,
		selectedPipelineId: options.pipelines[0]?.id ?? null,
	};
	const setPipelineState = vi.fn((updater: React.SetStateAction<CuePipelineState>) => {
		state =
			typeof updater === 'function'
				? (updater as (p: CuePipelineState) => CuePipelineState)(state)
				: updater;
	});
	const setSelectedNodeId = vi.fn();
	const setSelectedEdgeId = vi.fn();

	const { result, rerender } = renderHook(
		({ selectedNode, selectedEdge }) =>
			usePipelineMutations({
				setPipelineState,
				selection: {
					selectedNodePipelineId: selectedNode,
					selectedEdgePipelineId: selectedEdge,
					setSelectedNodeId,
					setSelectedEdgeId,
				},
			}),
		{
			initialProps: {
				selectedNode: options.selectedNodePipelineId ?? null,
				selectedEdge: options.selectedEdgePipelineId ?? null,
			},
		}
	);

	return { result, rerender, getState: () => state, setSelectedNodeId, setSelectedEdgeId };
}

describe('usePipelineMutations', () => {
	describe('onUpdateNode', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setupUsePipelineMutations({
				pipelines: [pipeline('p1', 'A', [agentNode('n1')])],
				selectedNodePipelineId: null,
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('Agent');
		});

		it('mutates only the node in selected pipeline', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline('p1', 'A', [agentNode('n1', 'Alpha')]),
					pipeline('p2', 'B', [agentNode('n1', 'Bravo')]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'Updated' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe(
				'Updated'
			);
			expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe('Bravo');
		});

		it('merges data partial into node data', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline('p1', 'A', [
						{
							id: 't1',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: {
								eventType: 'time.heartbeat',
								label: 'T',
								config: { interval_minutes: 5 },
							} as TriggerNodeData,
						},
					]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('t1', {
					customLabel: 'Morning',
				} as Partial<TriggerNodeData>)
			);
			const updated = h.getState().pipelines[0].nodes[0].data as TriggerNodeData;
			expect(updated.customLabel).toBe('Morning');
			expect(updated.config.interval_minutes).toBe(5);
		});
	});

	describe('onUpdateEdgePrompt', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'old' }]
					),
				],
				selectedNodePipelineId: null,
			});
			act(() => h.result.current.onUpdateEdgePrompt('e1', 'new'));
			expect(h.getState().pipelines[0].edges[0].prompt).toBe('old');
		});

		it('updates only the target edge', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1'), agentNode('a2')],
						[
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'old1' },
							{ id: 'e2', source: 't1', target: 'a2', mode: 'pass', prompt: 'old2' },
						]
					),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() => h.result.current.onUpdateEdgePrompt('e1', 'new1'));
			expect(h.getState().pipelines[0].edges[0].prompt).toBe('new1');
			expect(h.getState().pipelines[0].edges[1].prompt).toBe('old2');
		});
	});

	describe('onDeleteNode', () => {
		it('no-op when selectedNodePipelineId is null', () => {
			const h = setupUsePipelineMutations({
				pipelines: [pipeline('p1', 'A', [triggerNode('t1')])],
				selectedNodePipelineId: null,
			});
			act(() => h.result.current.onDeleteNode('t1'));
			expect(h.getState().pipelines[0].nodes).toHaveLength(1);
			expect(h.setSelectedNodeId).not.toHaveBeenCalled();
		});

		it('removes node and all adjacent edges (source and target)', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1'), agentNode('a2')],
						[
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
							{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
						]
					),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() => h.result.current.onDeleteNode('a1'));
			expect(h.getState().pipelines[0].nodes.map((n) => n.id)).toEqual(['t1', 'a2']);
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
			expect(h.setSelectedNodeId).toHaveBeenCalledWith(null);
		});
	});

	describe('onUpdateEdge', () => {
		it('no-op when selectedEdgePipelineId is null', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: null,
			});
			act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
			expect(h.getState().pipelines[0].edges[0].mode).toBe('pass');
		});

		it('merges updates, preserving other fields', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'hi' }]
					),
				],
				selectedEdgePipelineId: 'p1',
			});
			act(() => h.result.current.onUpdateEdge('e1', { mode: 'debate' }));
			const edge = h.getState().pipelines[0].edges[0];
			expect(edge.mode).toBe('debate');
			expect(edge.prompt).toBe('hi');
			expect(edge.source).toBe('t1');
		});
	});

	describe('onDeleteEdge', () => {
		it('no-op when selectedEdgePipelineId is null', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: null,
			});
			act(() => h.result.current.onDeleteEdge('e1'));
			expect(h.getState().pipelines[0].edges).toHaveLength(1);
			expect(h.setSelectedEdgeId).not.toHaveBeenCalled();
		});

		it('removes edge and clears selection', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline(
						'p1',
						'A',
						[triggerNode('t1'), agentNode('a1')],
						[{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }]
					),
				],
				selectedEdgePipelineId: 'p1',
			});
			act(() => h.result.current.onDeleteEdge('e1'));
			expect(h.getState().pipelines[0].edges).toHaveLength(0);
			expect(h.setSelectedEdgeId).toHaveBeenCalledWith(null);
		});
	});

	describe('selection change across renders', () => {
		it('callbacks pick up new selection ID after rerender', () => {
			const h = setupUsePipelineMutations({
				pipelines: [
					pipeline('p1', 'A', [agentNode('n1', 'Alpha')]),
					pipeline('p2', 'B', [agentNode('n1', 'Bravo')]),
				],
				selectedNodePipelineId: 'p1',
			});
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'X' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');

			// Rerender with different selection
			h.rerender({ selectedNode: 'p2', selectedEdge: null } as unknown as never);
			act(() =>
				h.result.current.onUpdateNode('n1', { sessionName: 'Y' } as Partial<AgentNodeData>)
			);
			expect((h.getState().pipelines[1].nodes[0].data as AgentNodeData).sessionName).toBe('Y');
			expect((h.getState().pipelines[0].nodes[0].data as AgentNodeData).sessionName).toBe('X');
		});
	});
});

// ===== from src/__tests__/renderer/hooks/cue/usePipelineSelection.multiTrigger.test.ts =====
/**
 * Regression tests for the multi-trigger prompt-leakage bug.
 *
 * Before the fix, `usePipelineSelection` computed per-edge prompts as:
 *   edge.prompt ?? node.data.inputPrompt ?? ''
 *
 * The `inputPrompt` fallback meant that when an agent had multiple incoming
 * trigger edges and only the first had `edge.prompt` set, every other
 * trigger's UI row would render the agent's `inputPrompt` (which was
 * auto-populated from the first trigger's connection). This leaked the first
 * trigger's prompt into every subsequent trigger's textarea.
 *
 * After the fix, the fallback is `defaultPromptFor(eventType)` - each
 * trigger gets its own barebones template for its event type and the
 * agent-level `inputPrompt` is never consulted at per-edge resolution time.
 */

function makeTriggerNode(id: string, eventType: string, label = 'Trigger') {
	return {
		id,
		type: 'trigger' as const,
		position: { x: 0, y: 0 },
		data: { eventType, label, config: {} },
	};
}

function makeAgentNode(id: string, extras: Record<string, unknown> = {}) {
	return {
		id,
		type: 'agent' as const,
		position: { x: 100, y: 0 },
		data: {
			sessionId: `sess-${id}`,
			sessionName: `Agent ${id}`,
			toolType: 'claude-code',
			...extras,
		},
	};
}

function makeEdge(
	id: string,
	source: string,
	target: string,
	extras: Record<string, unknown> = {}
) {
	return { id, source, target, mode: 'pass' as const, ...extras };
}

function makePipelineUsePipelineSelectionmultiTrigger(id: string, nodes: any[], edges: any[]) {
	return { id, name: `Pipeline ${id}`, color: '#06b6d4', nodes, edges };
}

function mouseEvent() {
	return { stopPropagation: () => {} } as unknown as React.MouseEvent;
}

describe('usePipelineSelection - multi-trigger prompt isolation', () => {
	it('returns distinct prompts for two triggers when both have edge.prompt set', () => {
		const triggerA = makeTriggerNode('tA', 'github.issue');
		const triggerB = makeTriggerNode('tB', 'github.pull_request');
		const agent = makeAgentNode('a1');
		const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'handle issue' });
		const edgeB = makeEdge('eB', 'tB', 'a1', { prompt: 'handle PR' });
		const pipeline = makePipelineUsePipelineSelectionmultiTrigger(
			'p1',
			[triggerA, triggerB, agent],
			[edgeA, edgeB]
		);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const triggers = result.current.incomingTriggerEdges;
		expect(triggers).toHaveLength(2);
		const promptByEdge = Object.fromEntries(triggers.map((t) => [t.edgeId, t.prompt]));
		expect(promptByEdge.eA).toBe('handle issue');
		expect(promptByEdge.eB).toBe('handle PR');
	});

	it("second trigger without edge.prompt falls back to its own event-type default, not the first trigger's prompt or agent inputPrompt", () => {
		const triggerA = makeTriggerNode('tA', 'github.issue');
		const triggerB = makeTriggerNode('tB', 'file.changed');
		// Simulate the legacy auto-populate that used to set inputPrompt from the first trigger.
		const agent = makeAgentNode('a1', { inputPrompt: 'ISSUE PROMPT TEMPLATE' });
		const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'user-edited issue prompt' });
		const edgeB = makeEdge('eB', 'tB', 'a1'); // no prompt - this is the leakage vector
		const pipeline = makePipelineUsePipelineSelectionmultiTrigger(
			'p1',
			[triggerA, triggerB, agent],
			[edgeA, edgeB]
		);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const promptByEdge = Object.fromEntries(
			result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
		);
		expect(promptByEdge.eA).toBe('user-edited issue prompt');
		// eB must NOT receive the agent inputPrompt (the bug) and must NOT
		// receive eA's prompt (another shape of leak). It must receive the
		// file.changed template.
		expect(promptByEdge.eB).toContain('{{CUE_FILE_PATH}}');
		expect(promptByEdge.eB).not.toBe('ISSUE PROMPT TEMPLATE');
		expect(promptByEdge.eB).not.toBe('user-edited issue prompt');
	});

	it('two triggers, neither with edge.prompt, each gets its own event-type default', () => {
		const triggerA = makeTriggerNode('tA', 'task.pending');
		const triggerB = makeTriggerNode('tB', 'cli.trigger');
		const agent = makeAgentNode('a1');
		const edgeA = makeEdge('eA', 'tA', 'a1');
		const edgeB = makeEdge('eB', 'tB', 'a1');
		const pipeline = makePipelineUsePipelineSelectionmultiTrigger(
			'p1',
			[triggerA, triggerB, agent],
			[edgeA, edgeB]
		);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const promptByEdge = Object.fromEntries(
			result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
		);
		expect(promptByEdge.eA).toContain('{{CUE_TASK_LIST}}');
		expect(promptByEdge.eB).toContain('{{CUE_CLI_PROMPT}}');
	});

	it('agent inputPrompt is never used as the fallback, even when the edge is present and unset', () => {
		const trigger = makeTriggerNode('t1', 'time.heartbeat');
		const agent = makeAgentNode('a1', { inputPrompt: 'do not leak this' });
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipelineUsePipelineSelectionmultiTrigger('p1', [trigger, agent], [edge]);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		expect(result.current.incomingTriggerEdges[0].prompt).toBe(''); // time.heartbeat default
		expect(result.current.incomingTriggerEdges[0].prompt).not.toContain('do not leak this');
	});
});
