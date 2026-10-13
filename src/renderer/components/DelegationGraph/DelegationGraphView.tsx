/**
 * DelegationGraphView - the fleet's peer relationships, drawn.
 *
 * A reactflow canvas of agent nodes and directed delegation edges, under a
 * toolbar (scope, layout, fit, reset, legend), with a legend, a minimap and a
 * panel for the selected agent. The reactflow wiring follows
 * `CuePipelineEditor/PipelineCanvas.tsx`.
 *
 * READ-ONLY. Nothing here edits a roster: an edge cannot be drawn or removed,
 * and the one way to change a relationship is the link to the Peers tab of an
 * agent's settings. Dragging a node changes where it is DRAWN, never whom it
 * can reach.
 *
 * Where the picture comes from:
 *
 *   - The model is `buildDelegationGraph` over the live agents
 *     (`useDelegationGraphModel`), rebuilt only when a field it reads changes.
 *   - The arrangement is `arrangeDelegationGraph`: a saved position wins, and
 *     an agent with none is placed beside its neighbors and then kept there.
 *   - The saved arrangement is per scope (`useDelegationGraphLayout`). A drag
 *     turns the scope `manual` and saves it; a named layout replaces it.
 *
 * Positions on screen are local state, because a drag moves a node many times
 * between two saves. The arrangement is copied into that state whenever it
 * changes, and reactflow's own changes (a drag, a measurement, a selection)
 * are applied to it directly. A save this canvas made comes back as a new
 * arrangement a render later: that echo is recognized and ignored, so a node
 * under the pointer is never pulled back to where it was saved a moment ago.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import ReactFlow, {
	Background,
	Controls,
	MiniMap,
	ReactFlowProvider,
	applyNodeChanges,
	useReactFlow,
	type Edge,
	type Node,
	type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Info, Maximize2, RotateCcw, Unplug, Users, Waypoints } from 'lucide-react';
import type { Theme } from '../../types';
import {
	connectedAgentIds,
	delegationEdgeId,
	delegationGraphStats,
	type DelegationGraphModel,
	type DelegationGraphScope,
} from '../../../shared/delegationGraph';
import {
	parseScopeStorageKey,
	scopeStorageKey,
	type DelegationSavedPositions,
} from '../../../shared/delegationGraphLayout';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { openAgentSettings } from '../../services/agentNavigation';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { ConfirmModal } from '../ConfirmModal';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { DelegationGraphDetail } from './DelegationGraphDetail';
import { DelegationGraphLegend } from './DelegationGraphLegend';
import { arrangeDelegationGraph, computeDelegationLayout } from './delegationLayouts';
import {
	DEFAULT_DELEGATION_LAYOUT,
	DELEGATION_ALGORITHM_LAYOUTS,
	DELEGATION_LAYOUT_LABELS,
	isDelegationAlgorithmLayout,
	type DelegationAlgorithmLayout,
	type DelegationLayoutType,
} from './delegationLayoutTypes';
import {
	delegationEdgeMarker,
	delegationEdgeTypes,
	type DelegationEdgeData,
} from './edges/DelegationEdge';
import {
	AgentDelegationNode,
	agentDelegationNodeState,
	type AgentDelegationNodeData,
} from './nodes/AgentDelegationNode';
import { useDelegationGraphLayout } from './useDelegationGraphLayout';
import { useDelegationGraphModel } from './useDelegationGraphModel';

export interface DelegationGraphViewProps {
	theme: Theme;
	/** The scope the graph opens on. Every agent when absent. */
	initialScope?: DelegationGraphScope;
}

type AgentNode = Node<AgentDelegationNodeData>;

/** A change the user must confirm, because it discards hand placement. */
type PendingChange = { kind: 'layout'; layout: DelegationAlgorithmLayout } | { kind: 'reset' };

/** The agent the user selected, and every agent one edge away from it. */
interface NeighborFocus {
	selectedId: string;
	neighborIds: ReadonlySet<string>;
}

const ALL_SCOPE: DelegationGraphScope = { kind: 'all' };

// Stable module-scope references, so reactflow does not see new props on
// every render of the canvas.
const NODE_TYPES = { agent: AgentDelegationNode };
const PRO_OPTIONS = { hideAttribution: true } as const;
const FIT_VIEW_OPTIONS = { padding: 0.2 } as const;

/** How long after a rearrangement the view is fitted: the nodes must be drawn first. */
const FIT_DELAY_MS = 180;
const FIT_DURATION_MS = 300;
/**
 * How far a node must travel before a press counts as a drag. A click that
 * slips a pixel must not turn the scope `manual`.
 */
const DRAG_THRESHOLD_PX = 3;
/** An agent that is neither selected nor its neighbor, while one is selected. */
const UNFOCUSED_NODE_STYLE = { opacity: 0.35 } as const;

const LAYOUT_OPTIONS: ReadonlyArray<SegmentedOption<DelegationLayoutType>> =
	DELEGATION_ALGORITHM_LAYOUTS.map((value) => ({
		value,
		label: DELEGATION_LAYOUT_LABELS[value].name,
		title: DELEGATION_LAYOUT_LABELS[value].description,
	}));

function positionsOfNodes(nodes: readonly AgentNode[]): DelegationSavedPositions {
	const positions: DelegationSavedPositions = {};
	for (const node of nodes) positions[node.id] = { x: node.position.x, y: node.position.y };
	return positions;
}

/** The one selected agent, or `null` for none and for a multiple selection. */
function soleSelectedId(nodes: readonly AgentNode[]): string | null {
	const selected = nodes.filter((node) => node.selected);
	return selected.length === 1 ? selected[0].id : null;
}

function neighborFocusOf(
	model: DelegationGraphModel,
	selectedId: string | null
): NeighborFocus | null {
	if (selectedId === null) return null;
	const neighborIds = new Set([selectedId]);
	for (const edge of model.edges) {
		if (edge.sourceId === selectedId) neighborIds.add(edge.targetId);
		if (edge.targetId === selectedId) neighborIds.add(edge.sourceId);
	}
	return { selectedId, neighborIds };
}

function openPeersTab(sessionId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (session) openAgentSettings(session, { tab: 'peers' });
}

function DelegationGraphCanvas({ theme, initialScope }: DelegationGraphViewProps) {
	const { colors } = theme;
	const reactFlow = useReactFlow();
	const groups = useSessionStore((store) => store.groups);
	const activeSessionId = useSessionStore((store) => store.activeSessionId);

	// A group scope outlives its group only until the next render: the graph
	// then shows every agent, and never an empty picture of a group that is gone.
	const [requestedScope, setRequestedScope] = useState<DelegationGraphScope>(
		initialScope ?? ALL_SCOPE
	);
	const scope = useMemo(
		() =>
			requestedScope.kind === 'group' &&
			!groups.some((group) => group.id === requestedScope.groupId)
				? ALL_SCOPE
				: requestedScope,
		[requestedScope, groups]
	);
	const scopeKey = scopeStorageKey(scope);
	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name)),
		[groups]
	);

	const model = useDelegationGraphModel(scope);
	const stats = useMemo(() => delegationGraphStats(model), [model]);
	const {
		layout,
		hasSavedLayout,
		positions,
		saveDraggedPositions,
		saveAlgorithmLayout,
		savePlacedPositions,
		resetLayout,
	} = useDelegationGraphLayout(scope);

	const arrangement = useMemo(
		() => arrangeDelegationGraph(model, layout, positions),
		[model, layout, positions]
	);
	// A new agent was put beside its neighbors: keep it there, so it is in the
	// same place on the next open. A no-op for a scope with nothing saved.
	useEffect(() => {
		savePlacedPositions(arrangement.newlyPlaced);
	}, [arrangement, savePlacedPositions]);

	const arrangedNodes = useMemo<AgentNode[]>(() => {
		const connectedIds = connectedAgentIds(model);
		return model.nodes.map((node) => ({
			id: node.sessionId,
			type: 'agent',
			position: arrangement.positions[node.sessionId] ?? { x: 0, y: 0 },
			data: {
				sessionId: node.sessionId,
				state: agentDelegationNodeState(node, connectedIds),
				theme,
			},
		}));
	}, [model, arrangement, theme]);

	const [nodes, setNodes] = useState<AgentNode[]>(arrangedNodes);
	// What `nodes` will be after the pending render. reactflow can send several
	// changes before React renders once, and each must build on the one before.
	const nodesRef = useRef(nodes);
	const commitNodes = useCallback((next: AgentNode[]) => {
		nodesRef.current = next;
		setNodes(next);
	}, []);

	// The positions this canvas last sent to be saved, to tell its own save
	// coming back from an arrangement made somewhere else.
	const savedByCanvasRef = useRef<DelegationSavedPositions>({});

	// Copy a new arrangement onto the canvas. Within one scope a node keeps what
	// reactflow knows about it (its measured size, its selection), and a position
	// that is only the echo of this canvas's own save leaves the node where it is
	// now. A change of scope starts clean: the same agent is a different node in
	// another graph.
	const syncedScopeKeyRef = useRef(scopeKey);
	useEffect(() => {
		if (syncedScopeKeyRef.current !== scopeKey) {
			syncedScopeKeyRef.current = scopeKey;
			savedByCanvasRef.current = {};
			commitNodes(arrangedNodes);
			return;
		}
		const current = new Map(nodesRef.current.map((node) => [node.id, node]));
		const savedByCanvas = savedByCanvasRef.current;
		commitNodes(
			arrangedNodes.map((node) => {
				const onCanvas = current.get(node.id);
				if (!onCanvas) return node;
				const sent = savedByCanvas[node.id];
				const isEcho = sent?.x === node.position.x && sent?.y === node.position.y;
				return { ...onCanvas, ...node, position: isEcho ? onCanvas.position : node.position };
			})
		);
	}, [arrangedNodes, scopeKey, commitNodes]);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			const next = applyNodeChanges(changes, nodesRef.current);
			commitNodes(next);
			// A position change that carries a position is the user moving a node,
			// with the pointer or with the arrow keys. Every node is saved, not only
			// the one that moved: the first move is what turns an algorithm's
			// arrangement into a saved one.
			if (changes.some((change) => change.type === 'position' && change.position)) {
				const moved = positionsOfNodes(next);
				savedByCanvasRef.current = moved;
				saveDraggedPositions(moved);
			}
		},
		[commitNodes, saveDraggedPositions]
	);

	const selectedId = soleSelectedId(nodes);
	const focus = useMemo(() => neighborFocusOf(model, selectedId), [model, selectedId]);

	const clearSelection = useCallback(() => {
		commitNodes(
			nodesRef.current.map((node) => (node.selected ? { ...node, selected: false } : node))
		);
	}, [commitNodes]);

	// Dimming is applied at draw time and kept out of `nodes`, so selecting an
	// agent never rewrites a position.
	const displayNodes = useMemo(
		() =>
			focus
				? nodes.map((node) =>
						focus.neighborIds.has(node.id) ? node : { ...node, style: UNFOCUSED_NODE_STYLE }
					)
				: nodes,
		[nodes, focus]
	);

	const edges = useMemo<Edge<DelegationEdgeData>[]>(() => {
		const edgeIds = new Set(model.edges.map((edge) => edge.id));
		const markerEnd = delegationEdgeMarker(theme);
		return model.edges.map((edge) => ({
			id: edge.id,
			source: edge.sourceId,
			target: edge.targetId,
			type: 'delegation',
			markerEnd,
			selectable: false,
			focusable: false,
			data: {
				edge,
				hasReverse: edgeIds.has(delegationEdgeId(edge.targetId, edge.sourceId)),
				...(focus
					? {
							emphasis:
								edge.sourceId === focus.selectedId || edge.targetId === focus.selectedId
									? ('highlighted' as const)
									: ('dimmed' as const),
						}
					: {}),
				theme,
			},
		}));
	}, [model, theme, focus]);

	// Fit after a rearrangement and after a change of scope. The delay lets the
	// moved nodes be drawn and measured, so the fit covers where they ARE.
	const [fitRequest, setFitRequest] = useState(0);
	const requestFit = useCallback(() => setFitRequest((count) => count + 1), []);
	useEffect(() => {
		const timer = setTimeout(
			() => reactFlow.fitView({ ...FIT_VIEW_OPTIONS, duration: FIT_DURATION_MS }),
			FIT_DELAY_MS
		);
		return () => clearTimeout(timer);
	}, [fitRequest, scopeKey, reactFlow]);

	const applyLayout = useCallback(
		(next: DelegationAlgorithmLayout) => {
			saveAlgorithmLayout(
				next,
				computeDelegationLayout(next, model, { centerId: selectedId ?? undefined })
			);
			requestFit();
		},
		[saveAlgorithmLayout, model, selectedId, requestFit]
	);
	const applyReset = useCallback(() => {
		resetLayout();
		requestFit();
	}, [resetLayout, requestFit]);

	// A named layout and a reset both discard hand placement, so both ask first,
	// but only when there IS hand placement. Moving between two algorithms
	// destroys nothing the user made.
	const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
	const handleLayoutChange = useCallback(
		(next: DelegationLayoutType) => {
			if (!isDelegationAlgorithmLayout(next)) return;
			if (layout === 'manual') setPendingChange({ kind: 'layout', layout: next });
			else applyLayout(next);
		},
		[layout, applyLayout]
	);
	const handleReset = useCallback(() => {
		if (layout === 'manual') setPendingChange({ kind: 'reset' });
		else applyReset();
	}, [layout, applyReset]);
	const confirmPendingChange = useCallback(() => {
		if (pendingChange?.kind === 'layout') applyLayout(pendingChange.layout);
		else if (pendingChange?.kind === 'reset') applyReset();
	}, [pendingChange, applyLayout, applyReset]);

	const handleScopeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
		setRequestedScope(parseScopeStorageKey(event.target.value) ?? ALL_SCOPE);
	}, []);

	const legend = usePersistedToggle('delegationGraph.legend.open', true);

	const reactFlowStyle = useMemo(() => ({ backgroundColor: colors.bgMain }), [colors.bgMain]);
	const controlsStyle = useMemo(
		() => ({ backgroundColor: colors.bgActivity, borderColor: colors.border }),
		[colors.bgActivity, colors.border]
	);
	const miniMapStyle = useMemo(
		() => ({ backgroundColor: colors.bgActivity, border: `1px solid ${colors.border}` }),
		[colors.bgActivity, colors.border]
	);
	const miniMapNodeColor = useCallback(
		(node: Node) => {
			const state = (node as AgentNode).data?.state;
			return state === 'isolated'
				? colors.warning
				: state === 'spill'
					? colors.border
					: colors.accent;
		},
		[colors.warning, colors.border, colors.accent]
	);

	const isEmpty = stats.agents === 0;
	const noEdges = !isEmpty && stats.edges === 0;
	// The agent the "nobody is connected" notice sends the user to: the one they
	// selected, else the one they are working in, else the first on the graph.
	const peersTargetId =
		selectedId ??
		(model.nodes.some((node) => node.sessionId === activeSessionId)
			? activeSessionId
			: model.nodes[0]?.sessionId);
	const peersTargetName = model.nodes.find((node) => node.sessionId === peersTargetId)?.name;

	return (
		<div className="flex flex-col h-full w-full min-h-0" data-testid="delegation-graph-view">
			{/* Toolbar */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
				style={{ borderColor: colors.border, backgroundColor: colors.bgSidebar }}
			>
				<select
					value={scopeKey}
					onChange={handleScopeChange}
					aria-label="Scope"
					title="Which agents the graph is about"
					data-testid="delegation-graph-scope"
					className="px-2 py-1 rounded text-xs border cursor-pointer outline-none max-w-[220px]"
					style={{
						backgroundColor: colors.bgMain,
						borderColor: colors.border,
						color: colors.textMain,
					}}
				>
					<option value={scopeStorageKey(ALL_SCOPE)}>All agents</option>
					{sortedGroups.map((group) => {
						const value = scopeStorageKey({ kind: 'group', groupId: group.id });
						return (
							<option key={value} value={value}>
								{group.emoji ? `${group.emoji} ${group.name}` : group.name}
							</option>
						);
					})}
				</select>

				<SegmentedControl
					value={layout}
					onChange={handleLayoutChange}
					options={LAYOUT_OPTIONS}
					theme={theme}
					ariaLabel="Layout"
					testId="delegation-graph-layout"
				/>
				{layout === 'manual' && (
					<MiniBadge
						theme={theme}
						label={DELEGATION_LAYOUT_LABELS.manual.name}
						title={`${DELEGATION_LAYOUT_LABELS.manual.description}. Pick a layout to rearrange.`}
						testId="delegation-graph-layout-manual"
					/>
				)}

				<div className="flex-1" />

				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={requestFit}
					icon={<Maximize2 />}
					title="Fit the whole graph in view"
					disabled={isEmpty}
					testId="delegation-graph-fit"
				>
					Fit
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={handleReset}
					icon={<RotateCcw />}
					title={`Forget where the agents in this scope were placed and go back to the ${DELEGATION_LAYOUT_LABELS[DEFAULT_DELEGATION_LAYOUT].name} layout`}
					disabled={!hasSavedLayout}
					testId="delegation-graph-reset"
				>
					Reset layout
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={legend.toggle}
					icon={<Info />}
					title={legend.value ? 'Hide the legend' : 'Show the legend'}
					testId="delegation-graph-legend-toggle"
				>
					Legend
				</HeaderActionButton>
			</div>

			{/* Canvas */}
			<div className="flex-1 relative overflow-hidden min-h-0">
				{isEmpty ? (
					<EmptyStatePlaceholder
						theme={theme}
						className="h-full"
						icon={<Waypoints className="w-12 h-12" />}
						title={scope.kind === 'group' ? 'No agents in this group' : 'No agents yet'}
						description={
							scope.kind === 'group'
								? 'Pick another scope, or move an agent into this group. Who an agent can consult or delegate to is set on the Peers tab of its settings.'
								: 'This graph draws which agent can consult or delegate to which. Create an agent, then give it peers on the Peers tab of its settings.'
						}
					/>
				) : (
					<ReactFlow
						nodes={displayNodes}
						edges={edges}
						nodeTypes={NODE_TYPES}
						edgeTypes={delegationEdgeTypes}
						onNodesChange={onNodesChange}
						// Read-only: no edge can be drawn, and no key removes a node. The
						// arrangement is the one thing the user changes here.
						nodesConnectable={false}
						deleteKeyCode={null}
						// Dragging rearranges and clicking selects. A drag that also
						// selected would dim the rest of the graph under the pointer.
						selectNodesOnDrag={false}
						nodeDragThreshold={DRAG_THRESHOLD_PX}
						minZoom={0.1}
						maxZoom={2}
						fitView
						fitViewOptions={FIT_VIEW_OPTIONS}
						proOptions={PRO_OPTIONS}
						style={reactFlowStyle}
					>
						<Background color={colors.border} gap={20} />
						<Controls style={controlsStyle} showInteractive={false} />
						<MiniMap
							pannable
							zoomable
							style={miniMapStyle}
							maskColor={`${colors.bgMain}cc`}
							nodeColor={miniMapNodeColor}
						/>
					</ReactFlow>
				)}

				{!isEmpty && legend.value && (
					<DelegationGraphLegend theme={theme} stats={stats} onClose={legend.toggle} />
				)}

				{/* Every agent is isolated: say so, and point at where peers are set. */}
				{noEdges && (
					<div
						data-testid="delegation-graph-no-edges"
						role="status"
						className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-start gap-2 rounded-lg shadow-lg px-3 py-2 text-xs select-text"
						style={{
							maxWidth: 420,
							zIndex: 5,
							backgroundColor: `${colors.bgActivity}f5`,
							border: `1px solid ${colors.warning}`,
							color: colors.textMain,
						}}
					>
						<Unplug className="w-4 h-4 shrink-0 mt-0.5" style={{ color: colors.warning }} />
						<div className="space-y-2">
							<p>
								No agent here can reach another, so there is nothing to draw between them. Who an
								agent can consult or delegate to is set on the Peers tab of its settings.
							</p>
							{peersTargetId && (
								<HeaderActionButton
									theme={theme}
									onClick={() => openPeersTab(peersTargetId)}
									icon={<Users />}
									testId="delegation-graph-no-edges-open-peers"
								>
									{peersTargetName ? `Open Peers tab of ${peersTargetName}` : 'Open Peers tab'}
								</HeaderActionButton>
							)}
						</div>
					</div>
				)}

				{!isEmpty && selectedId && (
					<DelegationGraphDetail
						theme={theme}
						model={model}
						sessionId={selectedId}
						onOpenPeers={openPeersTab}
						onClose={clearSelection}
					/>
				)}
			</div>

			{pendingChange && (
				<ConfirmModal
					theme={theme}
					title={pendingChange.kind === 'layout' ? 'Apply layout' : 'Reset layout'}
					message={
						pendingChange.kind === 'layout'
							? `Arrange this scope with the ${DELEGATION_LAYOUT_LABELS[pendingChange.layout].name} layout? Every agent moves, and the places you dragged them to are lost.`
							: `Forget where you placed the agents in this scope? The graph goes back to the ${DELEGATION_LAYOUT_LABELS[DEFAULT_DELEGATION_LAYOUT].name} layout.`
					}
					headerIcon={<RotateCcw className="w-4 h-4" style={{ color: colors.warning }} />}
					destructive={false}
					confirmLabel={
						pendingChange.kind === 'layout'
							? `Apply ${DELEGATION_LAYOUT_LABELS[pendingChange.layout].name}`
							: 'Reset'
					}
					onConfirm={confirmPendingChange}
					onClose={() => setPendingChange(null)}
					testId="delegation-graph-confirm"
				/>
			)}
		</div>
	);
}

export function DelegationGraphView(props: DelegationGraphViewProps) {
	return (
		<ReactFlowProvider>
			<DelegationGraphCanvas {...props} />
		</ReactFlowProvider>
	);
}
