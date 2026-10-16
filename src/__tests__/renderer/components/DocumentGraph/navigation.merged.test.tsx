// Merged suites; test bodies and names preserved, file-level hooks scoped to their original suites.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GraphLegend } from '../../../../renderer/components/DocumentGraph/GraphLegend';
import type { GraphLegendProps } from '../../../../renderer/components/DocumentGraph/GraphLegend';
import type { Theme } from '../../../../renderer/types';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';
import { mockTheme } from '../../../helpers/mockTheme';
import { GraphMiniMap } from '../../../../renderer/components/DocumentGraph/GraphMiniMap';
import type { MindMapNode } from '../../../../renderer/components/DocumentGraph/MindMap';
import { NodeBreadcrumb } from '../../../../renderer/components/DocumentGraph/NodeBreadcrumb';
import type { NodeBreadcrumbProps } from '../../../../renderer/components/DocumentGraph/NodeBreadcrumb';
import type {
	DocumentNodeData,
	ExternalLinkNodeData,
} from '../../../../renderer/components/DocumentGraph/graphDataBuilder';
import {
	clusterColor,
	clusterHullStyle,
} from '../../../../renderer/components/DocumentGraph/clusterColors';
import { openIconRect } from '../../../../renderer/components/DocumentGraph/mindMapCanvas';
import { NODE_HEADER_HEIGHT } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { transformAfterResize } from '../../../../renderer/components/DocumentGraph/viewportResize';

// ===== from src/__tests__/renderer/components/DocumentGraph/GraphLegend.test.tsx =====
/**
 * Tests for the GraphLegend component
 *
 * The GraphLegend displays a sliding panel explaining node types, edge types,
 * keyboard shortcuts, and interaction hints in the Document Graph visualization.
 *
 * The panel is always shown (no collapsed state) and can be closed via onClose callback.
 */

// Mock theme for testing

// Light theme for theme testing
const lightTheme: Theme = {
	...mockTheme,
	id: 'light',
	name: 'Light',
	mode: 'light',
	colors: {
		...mockTheme.colors,
		bgMain: '#ffffff',
		bgSidebar: '#f5f5f5',
		bgActivity: '#fafafa',
		border: '#e5e5e5',
		textMain: '#1a1a1a',
		textDim: '#666666',
		accent: '#6366f1',
	},
};

// Default props for testing
const defaultProps: GraphLegendProps = {
	theme: mockTheme,
	showExternalLinks: true,
	scrollMode: 'zoom',
	onScrollModeChange: vi.fn(),
	onClose: vi.fn(),
};

describe('GraphLegend', () => {
	describe('Rendering', () => {
		it('renders as a sliding panel with Help heading', () => {
			render(<GraphLegend {...defaultProps} />);

			// Should show the Help heading
			expect(screen.getByText('Help')).toBeInTheDocument();

			// Should show all content sections
			expect(screen.getByText('Node Types')).toBeInTheDocument();
			expect(screen.getByText('Connection Types')).toBeInTheDocument();
			expect(screen.getByText('Selection')).toBeInTheDocument();
		});

		it('has correct aria label on the panel', () => {
			render(<GraphLegend {...defaultProps} />);

			const panel = screen.getByRole('region', { name: /help panel/i });
			expect(panel).toBeInTheDocument();
		});

		it('renders all node types when showExternalLinks is true', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks />);

			expect(screen.getByText('Document')).toBeInTheDocument();
			// External Link appears in both Node Types and Connection Types sections
			const externalLinks = screen.getAllByText('External Link');
			expect(externalLinks.length).toBeGreaterThanOrEqual(1);
		});

		it('hides external node type when showExternalLinks is false', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

			expect(screen.getByText('Document')).toBeInTheDocument();
			// External Link should appear once in "Connection Types" section for edges
			// but not in "Node Types" section
			const nodeTypesSection = screen.getByText('Node Types').parentElement;
			expect(within(nodeTypesSection!).queryByText('External Link')).not.toBeInTheDocument();
		});

		it('renders all edge types when showExternalLinks is true', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks />);

			expect(screen.getByText('Internal Link')).toBeInTheDocument();
			// External Link appears in both Node Types and Connection Types sections
			expect(screen.getAllByText('External Link').length).toBe(2);
		});

		it('hides external edge type when showExternalLinks is false', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

			expect(screen.getByText('Internal Link')).toBeInTheDocument();
			// External Link edge type should not be shown
			const connectionTypesSection = screen.getByText('Connection Types').parentElement;
			expect(within(connectionTypesSection!).queryByText('External Link')).not.toBeInTheDocument();
		});
	});

	describe('Close Button', () => {
		it('renders close button with correct title', () => {
			render(<GraphLegend {...defaultProps} />);

			const closeButton = screen.getByTitle('Close (Esc)');
			expect(closeButton).toBeInTheDocument();
		});

		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			render(<GraphLegend {...defaultProps} onClose={onClose} />);

			const closeButton = screen.getByTitle('Close (Esc)');
			fireEvent.click(closeButton);

			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe('Keyboard Shortcuts Section', () => {
		it('shows keyboard shortcuts section', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});

		it('displays navigation shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('↑ ↓ ← →')).toBeInTheDocument();
			expect(screen.getByText('Navigate between nodes')).toBeInTheDocument();
		});

		it('displays space shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Space')).toBeInTheDocument();
			expect(screen.getByText('Focus node in graph')).toBeInTheDocument();
		});

		it('displays enter shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Enter')).toBeInTheDocument();
			expect(screen.getByText('Preview document in-graph')).toBeInTheDocument();
		});

		it('displays open shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('O')).toBeInTheDocument();
			expect(screen.getByText('Open in main preview')).toBeInTheDocument();
		});

		it('displays escape shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Esc')).toBeInTheDocument();
			expect(screen.getByText('Close preview / modal')).toBeInTheDocument();
		});

		it('displays search shortcut', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText(formatShortcutKeys(['Meta', 'f']))).toBeInTheDocument();
			expect(screen.getByText('Focus search')).toBeInTheDocument();
		});

		it('displays the preview-length shortcut', () => {
			// P used to duplicate Enter; the legend is where a user finds out it
			// now cycles preview length instead.
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('P')).toBeInTheDocument();
			expect(screen.getByText('Cycle preview length (ends at Off)')).toBeInTheDocument();
		});
	});

	describe('Mouse Actions Section', () => {
		it('shows mouse actions section', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Mouse Actions')).toBeInTheDocument();
		});

		it('displays click action', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Click')).toBeInTheDocument();
			expect(screen.getByText('Select node')).toBeInTheDocument();
		});

		it('displays double-click action', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Double-click')).toBeInTheDocument();
			expect(screen.getByText('Recenter view')).toBeInTheDocument();
		});

		it('displays right-click action', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Right-click')).toBeInTheDocument();
			expect(screen.getByText('Context menu')).toBeInTheDocument();
		});

		it('displays drag action', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Drag')).toBeInTheDocument();
			expect(screen.getByText('Reposition node')).toBeInTheDocument();
		});

		it('displays scroll action', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Scroll')).toBeInTheDocument();
			expect(screen.getByText('Zoom in/out')).toBeInTheDocument();
		});
	});

	describe('Selection Section', () => {
		it('shows selection section', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Selection')).toBeInTheDocument();
		});

		it('displays selected node info', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Selected Node')).toBeInTheDocument();
			expect(screen.getByText('Click or navigate to select')).toBeInTheDocument();
		});

		it('displays connected edge info', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Connected Edge')).toBeInTheDocument();
			expect(screen.getByText('Edges to/from selected node')).toBeInTheDocument();
		});
	});

	describe('Status Indicators Section', () => {
		it('shows status indicators section', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Status Indicators')).toBeInTheDocument();
		});

		it('displays broken links indicator', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByText('Broken Links')).toBeInTheDocument();
			expect(screen.getByText('Links to non-existent files')).toBeInTheDocument();
		});

		it('has accessible broken links indicator icon', () => {
			render(<GraphLegend {...defaultProps} />);

			const indicator = screen.getByRole('img', { name: /broken links warning indicator/i });
			expect(indicator).toBeInTheDocument();
		});
	});

	describe('Node Preview Icons', () => {
		it('renders document node preview with aria-label', () => {
			render(<GraphLegend {...defaultProps} />);

			const docPreviews = screen.getAllByRole('img', { name: /document node card/i });
			expect(docPreviews.length).toBeGreaterThanOrEqual(1);
		});

		it('renders external link node preview when showExternalLinks is true', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks />);

			const extPreviews = screen.getAllByRole('img', { name: /external link node pill/i });
			expect(extPreviews.length).toBeGreaterThanOrEqual(1);
		});

		it('does not render external link node preview when showExternalLinks is false', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

			expect(
				screen.queryByRole('img', { name: /external link node pill/i })
			).not.toBeInTheDocument();
		});

		it('renders selected document node preview', () => {
			render(<GraphLegend {...defaultProps} />);

			// Selected node preview has (selected) in aria-label
			const selectedPreviews = screen.getAllByRole('img', {
				name: /document node card \(selected\)/i,
			});
			expect(selectedPreviews.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Edge Preview Icons', () => {
		it('renders internal link edge preview', () => {
			render(<GraphLegend {...defaultProps} />);

			const internalEdges = screen.getAllByRole('img', { name: /internal link edge/i });
			expect(internalEdges.length).toBeGreaterThanOrEqual(1);
		});

		it('renders external link edge preview when showExternalLinks is true', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks />);

			const externalEdges = screen.getAllByRole('img', { name: /external link edge/i });
			expect(externalEdges.length).toBeGreaterThanOrEqual(1);
		});

		it('does not render external link edge preview when showExternalLinks is false', () => {
			render(<GraphLegend {...defaultProps} showExternalLinks={false} />);

			expect(screen.queryByRole('img', { name: /external link edge/i })).not.toBeInTheDocument();
		});

		it('renders highlighted edge preview for connected edges', () => {
			render(<GraphLegend {...defaultProps} />);

			// Highlighted edge preview has (highlighted) in aria-label
			const highlightedEdges = screen.getAllByRole('img', { name: /link edge \(highlighted\)/i });
			expect(highlightedEdges.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Theme Integration', () => {
		it('applies theme background color to panel', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});

		it('applies theme border color', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveStyle({ borderRight: `1px solid ${mockTheme.colors.border}` });
		});

		it('applies theme text color to heading', () => {
			render(<GraphLegend {...defaultProps} />);

			const heading = screen.getByText('Help');
			expect(heading).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('applies theme dim text color to section headers', () => {
			render(<GraphLegend {...defaultProps} />);

			const nodeTypesHeader = screen.getByText('Node Types');
			expect(nodeTypesHeader).toHaveStyle({ color: mockTheme.colors.textDim });
		});

		it('works with light theme', () => {
			render(<GraphLegend {...defaultProps} theme={lightTheme} />);

			const heading = screen.getByText('Help');
			expect(heading).toHaveStyle({ color: lightTheme.colors.textMain });
		});
	});

	describe('Dynamic Content', () => {
		it('updates when showExternalLinks prop changes', () => {
			const { rerender } = render(<GraphLegend {...defaultProps} showExternalLinks />);

			// Initially showing external links
			expect(screen.getAllByText('External Link').length).toBe(2);

			// Rerender with external links disabled
			rerender(<GraphLegend {...defaultProps} showExternalLinks={false} />);

			// External Link should no longer appear
			expect(screen.queryByText('External Link')).not.toBeInTheDocument();
		});
	});

	describe('Panel Layout', () => {
		it('has correct width', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveStyle({ width: '280px' });
		});

		it('has correct z-index', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveStyle({ zIndex: 20 });
		});

		it('is positioned at top-left', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveClass('top-0', 'left-0');
		});

		it('has animation class for slide-in effect', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const panel = container.querySelector('.graph-legend');
			expect(panel).toHaveClass('animate-in', 'slide-in-from-left');
		});
	});

	describe('Content Organization', () => {
		it('displays sections in correct order', () => {
			const { container } = render(<GraphLegend {...defaultProps} />);

			const sections = container.querySelectorAll('h4');
			const sectionTexts = Array.from(sections).map((s) => s.textContent);

			expect(sectionTexts).toEqual([
				'Node Types',
				'Connection Types',
				'Selection',
				'Status Indicators',
				'Keyboard Shortcuts',
				'Mouse Actions',
			]);
		});
	});

	describe('Scroll mode toggle', () => {
		it('offers both modes as an inline segmented control', () => {
			render(<GraphLegend {...defaultProps} />);

			expect(screen.getByTestId('graph-legend-scroll-mode-zoom')).toBeInTheDocument();
			expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toBeInTheDocument();
			expect(screen.getByRole('radiogroup', { name: 'Scroll wheel action' })).toBeInTheDocument();
		});

		it('marks the active mode, so the panel says which binding is live', () => {
			const { rerender } = render(<GraphLegend {...defaultProps} scrollMode="zoom" />);
			expect(screen.getByTestId('graph-legend-scroll-mode-zoom')).toHaveAttribute(
				'aria-checked',
				'true'
			);
			expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toHaveAttribute(
				'aria-checked',
				'false'
			);

			rerender(<GraphLegend {...defaultProps} scrollMode="pan" />);
			expect(screen.getByTestId('graph-legend-scroll-mode-pan')).toHaveAttribute(
				'aria-checked',
				'true'
			);
		});

		it('names a destination rather than toggling', () => {
			// Clicking the mode already active must be a no-op, not a flip - a
			// segmented control that toggles undoes itself on a second click.
			const onScrollModeChange = vi.fn();
			render(
				<GraphLegend {...defaultProps} scrollMode="zoom" onScrollModeChange={onScrollModeChange} />
			);

			fireEvent.click(screen.getByTestId('graph-legend-scroll-mode-pan'));
			expect(onScrollModeChange).toHaveBeenCalledWith('pan');

			fireEvent.click(screen.getByTestId('graph-legend-scroll-mode-zoom'));
			expect(onScrollModeChange).toHaveBeenLastCalledWith('zoom');
		});

		it('rewrites the Mouse Actions lines to match the live mode', () => {
			// The panel described Scroll as "Zoom in/out" unconditionally, which
			// is a lie in pan mode - and this is the section the user reads to
			// find out what the wheel does.
			const { rerender } = render(<GraphLegend {...defaultProps} scrollMode="zoom" />);
			expect(screen.getByText('Zoom in/out')).toBeInTheDocument();
			expect(screen.getByText('Pan the canvas')).toBeInTheDocument();

			rerender(<GraphLegend {...defaultProps} scrollMode="pan" />);
			const scrollRow = screen.getByText('Scroll').parentElement!;
			expect(within(scrollRow).getByText('Pan the canvas')).toBeInTheDocument();
			const shiftRow = screen.getByText('Shift+Scroll').parentElement!;
			expect(within(shiftRow).getByText('Zoom in/out')).toBeInTheDocument();
		});

		it('documents the S shortcut alongside the other single-key controls', () => {
			render(<GraphLegend {...defaultProps} />);
			expect(screen.getByText('Switch scroll between zoom and pan')).toBeInTheDocument();
		});
	});
});

// ===== from src/__tests__/renderer/components/DocumentGraph/GraphMiniMap.test.tsx =====
// jsdom has no 2D canvas context, so getContext('2d') returns null and the
// component's draw() bails early. That's fine: these tests cover the rendering
// guards and positioning logic, which don't depend on the canvas actually
// painting. The click/drag-to-navigate path needs a live context (geomRef is
// only populated by draw()) and can't be exercised here.

function makeNode(id: string, x: number, y: number): MindMapNode {
	return {
		id,
		x,
		y,
		width: 120,
		height: 60,
		depth: 0,
		side: 'center',
		nodeType: 'document',
		label: id,
	};
}

const baseProps = {
	theme: mockTheme,
	viewWidth: 800,
	viewHeight: 600,
	transform: { zoom: 1, panX: 0, panY: 0 },
	onRecenter: vi.fn(),
	legendExpanded: false,
	selectedNodeId: null,
	focusedNodeId: null,
};

describe('GraphMiniMap', () => {
	it('renders nothing when there are no nodes', () => {
		const { container } = render(<GraphMiniMap {...baseProps} nodes={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing with a single node (nothing worth navigating)', () => {
		const { container } = render(<GraphMiniMap {...baseProps} nodes={[makeNode('a', 0, 0)]} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders the minimap once there are at least two nodes', () => {
		const { container } = render(
			<GraphMiniMap {...baseProps} nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]} />
		);
		const root = container.firstChild as HTMLElement | null;
		expect(root).not.toBeNull();
		expect(root?.querySelector('canvas')).not.toBeNull();
	});

	it('sits at the edge margin when the legend is collapsed', () => {
		const { container } = render(
			<GraphMiniMap
				{...baseProps}
				legendExpanded={false}
				nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]}
			/>
		);
		const root = container.firstChild as HTMLElement;
		// EDGE_MARGIN (12px) with no legend offset.
		expect(root.style.left).toBe('12px');
	});

	it('slides clear of the legend drawer when it is expanded', () => {
		const { container } = render(
			<GraphMiniMap
				{...baseProps}
				legendExpanded={true}
				nodes={[makeNode('a', 0, 0), makeNode('b', 300, 200)]}
			/>
		);
		const root = container.firstChild as HTMLElement;
		// LEGEND_WIDTH (280) + EDGE_MARGIN (12) = 292px when the legend is open.
		expect(root.style.left).toBe('292px');
	});
});

// ===== from src/__tests__/renderer/components/DocumentGraph/NodeBreadcrumb.test.tsx =====
/**
 * Tests for the NodeBreadcrumb component
 *
 * The NodeBreadcrumb displays a path hierarchy for the currently selected node
 * in the Document Graph, showing folder/file structure for documents and
 * domain for external links.
 */

// Mock theme for testing

// Light theme for theme testing
const lightThemeNodeBreadcrumb: Theme = {
	...mockTheme,
	id: 'light',
	name: 'Light',
	mode: 'light',
	colors: {
		...mockTheme.colors,
		bgMain: '#ffffff',
		bgSidebar: '#f5f5f5',
		bgActivity: '#fafafa',
		border: '#e5e5e5',
		textMain: '#1a1a1a',
		textDim: '#666666',
	},
};

// Helper to create document node data
function createDocumentNodeData(filePath: string): DocumentNodeData & { theme: Theme } {
	return {
		nodeType: 'document',
		title: filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled',
		lineCount: 100,
		wordCount: 500,
		size: '1.5 KB',
		filePath,
		theme: mockTheme,
	};
}

// Helper to create external link node data
function createExternalNodeData(
	domain: string,
	urls: string[] = []
): ExternalLinkNodeData & { theme: Theme } {
	return {
		nodeType: 'external',
		domain,
		linkCount: urls.length || 1,
		urls: urls.length > 0 ? urls : [`https://${domain}/page`],
		theme: mockTheme,
	};
}

describe('NodeBreadcrumb', () => {
	describe('Rendering', () => {
		it('renders nothing when no node is selected', () => {
			const { container } = render(
				<NodeBreadcrumb selectedNodeData={null} theme={mockTheme} rootPath="/project" />
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders breadcrumb for a document node in root directory', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('README.md')}
					theme={mockTheme}
					rootPath="/Users/test/project"
				/>
			);

			// Should show project (root) and the file name
			expect(screen.getByText('project')).toBeInTheDocument();
			expect(screen.getByText('README')).toBeInTheDocument();
		});

		it('renders breadcrumb with nested path for document node', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('docs/guides/getting-started.md')}
					theme={mockTheme}
					rootPath="/Users/test/my-project"
				/>
			);

			// Should show root, folders, and file
			expect(screen.getByText('my-project')).toBeInTheDocument();
			expect(screen.getByText('docs')).toBeInTheDocument();
			expect(screen.getByText('guides')).toBeInTheDocument();
			expect(screen.getByText('getting-started')).toBeInTheDocument();
		});

		it('renders breadcrumb for external link node', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('github.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('External Links')).toBeInTheDocument();
			expect(screen.getByText('github.com')).toBeInTheDocument();
		});

		it('strips .md extension from file name', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('api/endpoints.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('endpoints')).toBeInTheDocument();
			expect(screen.queryByText('endpoints.md')).not.toBeInTheDocument();
		});

		it('handles deep nesting correctly', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('src/components/ui/buttons/primary-button.md')}
					theme={mockTheme}
					rootPath="/app"
				/>
			);

			expect(screen.getByText('app')).toBeInTheDocument();
			expect(screen.getByText('src')).toBeInTheDocument();
			expect(screen.getByText('components')).toBeInTheDocument();
			expect(screen.getByText('ui')).toBeInTheDocument();
			expect(screen.getByText('buttons')).toBeInTheDocument();
			expect(screen.getByText('primary-button')).toBeInTheDocument();
		});
	});

	describe('Chevron separators', () => {
		it('renders chevron separators between segments', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/subfolder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Should have 3 chevrons (root > folder > subfolder > file)
			// There are 4 segments total, so 3 chevrons between them
			// Count ChevronRight icons - they are rendered directly (not inside buttons)
			const breadcrumb = container.querySelector('.node-breadcrumb');
			const buttons = breadcrumb?.querySelectorAll('button');
			// 4 segments = 4 buttons, and 3 chevrons between them
			expect(buttons?.length).toBe(4);

			// Chevrons are siblings between buttons, so we should have 4 buttons
			// and the SVG chevrons are outside of buttons
			const allSvgs = breadcrumb?.querySelectorAll('svg');
			// Total SVGs: 4 segments (some have icons) + 3 chevrons
			// Root has Home icon, file has FileText icon = 2 icons in buttons
			// Plus 3 chevron icons = 5 total SVGs
			expect(allSvgs?.length).toBeGreaterThanOrEqual(3);
		});

		it('does not render chevron before first segment', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// First element should be the root button, not a chevron
			const navigation = screen.getByRole('navigation');
			const firstChild = navigation.firstChild;
			expect(firstChild?.nodeName.toLowerCase()).toBe('button');
		});
	});

	describe('Segment interaction', () => {
		it('calls onSegmentClick when non-final segment is clicked', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on folder segment
			fireEvent.click(screen.getByText('folder'));
			expect(onSegmentClick).toHaveBeenCalledWith('folder');
		});

		it('does not call onSegmentClick when final segment is clicked', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on file segment (final)
			fireEvent.click(screen.getByText('file'));
			expect(onSegmentClick).not.toHaveBeenCalled();
		});

		it('root segment click passes empty path', () => {
			const onSegmentClick = vi.fn();

			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
					onSegmentClick={onSegmentClick}
				/>
			);

			// Click on root segment
			fireEvent.click(screen.getByText('project'));
			expect(onSegmentClick).toHaveBeenCalledWith('');
		});

		it('final segment button is disabled', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toBeDisabled();
		});

		it('non-final segments are not disabled', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/subfolder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			const subfolderButton = screen.getByText('subfolder').closest('button');

			expect(folderButton).not.toBeDisabled();
			expect(subfolderButton).not.toBeDisabled();
		});
	});

	describe('Accessibility', () => {
		it('has navigation role', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByRole('navigation')).toBeInTheDocument();
		});

		it('has aria-label for navigation', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByRole('navigation')).toHaveAttribute('aria-label', 'Selected node path');
		});

		it('final segment has aria-current="page"', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveAttribute('aria-current', 'page');
		});

		it('non-final segments do not have aria-current', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).not.toHaveAttribute('aria-current');
		});

		it('segments have title attributes', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			const fileButton = screen.getByText('file').closest('button');

			expect(folderButton).toHaveAttribute('title', 'Go to folder');
			expect(fileButton).toHaveAttribute('title', 'file');
		});
	});

	describe('Theme styling', () => {
		it('applies theme colors to container', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({ borderBottom: `1px solid ${mockTheme.colors.border}` });
		});

		it('applies light theme colors correctly', () => {
			const lightNodeData = {
				...createDocumentNodeData('file.md'),
				theme: lightThemeNodeBreadcrumb,
			};

			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={lightNodeData}
					theme={lightThemeNodeBreadcrumb}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({
				borderBottom: `1px solid ${lightThemeNodeBreadcrumb.colors.border}`,
			});
		});

		it('final segment has main text color', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('non-final segments have dim text color', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Icons', () => {
		it('renders Home icon for root segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Check for Home icon (lucide-react renders as SVG with specific class)
			const rootButton = screen.getByText('project').closest('button');
			const icon = rootButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
		});

		it('renders FileText icon for document final segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// File button should have FileText icon with accent color
			const fileButton = screen.getByText('file').closest('button');
			const icon = fileButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('renders Globe icon for external link final segment', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('github.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// External link button should have Globe icon
			const externalButton = screen.getByText('github.com').closest('button');
			const icon = externalButton?.querySelector('svg');
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('does not render icon for folder segments', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			// Folder button should not have an icon
			const folderButton = screen.getByText('folder').closest('button');
			const icon = folderButton?.querySelector('svg');
			expect(icon).toBeNull();
		});
	});

	describe('Edge cases', () => {
		it('handles file in root with no parent folders', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('CHANGELOG.md')}
					theme={mockTheme}
					rootPath="/my-app"
				/>
			);

			expect(screen.getByText('my-app')).toBeInTheDocument();
			expect(screen.getByText('CHANGELOG')).toBeInTheDocument();
		});

		it('handles rootPath with trailing slash', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project/"
				/>
			);

			expect(screen.getByText('project')).toBeInTheDocument();
		});

		it('handles complex domain names', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createExternalNodeData('docs.anthropic.com')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('docs.anthropic.com')).toBeInTheDocument();
		});

		it('handles file names with special characters (excluding path)', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('docs/[id]-guide.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(screen.getByText('docs')).toBeInTheDocument();
			expect(screen.getByText('[id]-guide')).toBeInTheDocument();
		});

		it('handles uppercase .MD extension', () => {
			// Create a custom node data with uppercase extension in title
			const nodeData = {
				...createDocumentNodeData('docs/README.MD'),
				title: 'README.MD', // Override title to test .MD stripping
			};
			// The breadcrumb strips .md case-insensitively based on filePath
			render(<NodeBreadcrumb selectedNodeData={nodeData} theme={mockTheme} rootPath="/project" />);

			// Should strip .MD extension
			expect(screen.getByText('README')).toBeInTheDocument();
		});
	});

	describe('Container styling', () => {
		it('has correct CSS class for styling', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			expect(container.querySelector('.node-breadcrumb')).toBeInTheDocument();
		});

		it('has minimum height for consistent layout', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveStyle({ minHeight: '36px' });
		});

		it('has overflow-x auto for long paths', () => {
			const { container } = render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('a/b/c/d/e/f/g/h/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const breadcrumb = container.querySelector('.node-breadcrumb');
			expect(breadcrumb).toHaveClass('overflow-x-auto');
		});
	});

	describe('Hover states', () => {
		it('non-final segment has pointer cursor', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const folderButton = screen.getByText('folder').closest('button');
			expect(folderButton).toHaveStyle({ cursor: 'pointer' });
		});

		it('final segment has default cursor', () => {
			render(
				<NodeBreadcrumb
					selectedNodeData={createDocumentNodeData('folder/file.md')}
					theme={mockTheme}
					rootPath="/project"
				/>
			);

			const fileButton = screen.getByText('file').closest('button');
			expect(fileButton).toHaveStyle({ cursor: 'default' });
		});
	});
});

// ===== from src/__tests__/renderer/components/DocumentGraph/clusterColors.test.ts =====
/**
 * Tests for the Lobes layout's cluster colours (clusterColors.ts).
 *
 * The colours are derived from the active theme's accent by hue rotation
 * rather than taken from a fixed palette, so the properties worth pinning are
 * about the derivation: that the first cluster is the theme's own colour, that
 * successive clusters are actually distinguishable, and that a near-grey
 * accent does not collapse every lobe into the same grey.
 */

/** Parse an `rgb(r, g, b)` string back into channels. */
function channels(color: string): { r: number; g: number; b: number } {
	const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (!match) throw new Error(`not an rgb colour: ${color}`);
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function distance(a: string, b: string): number {
	const ca = channels(a);
	const cb = channels(b);
	return Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b);
}

const ACCENT = '#9146FF';

describe('clusterColors', () => {
	describe('clusterColor', () => {
		it('gives the first cluster the theme accent itself', () => {
			// The dominant lobe holds the center document. Painting it the
			// theme's own colour is what stops the graph looking like it picked
			// an arbitrary palette out of nowhere.
			const accentChannels = channels('rgb(145, 70, 255)');
			const first = channels(clusterColor(ACCENT, 0));
			expect(Math.abs(first.r - accentChannels.r)).toBeLessThanOrEqual(2);
			expect(Math.abs(first.g - accentChannels.g)).toBeLessThanOrEqual(2);
			expect(Math.abs(first.b - accentChannels.b)).toBeLessThanOrEqual(2);
		});

		it('separates the first several clusters clearly', () => {
			// These are the lobes with enough nodes to matter. An even 360/n
			// split cannot guarantee this without knowing n up front, which is
			// why the rotation is a golden-angle walk.
			const colors = [0, 1, 2, 3, 4].map((i) => clusterColor(ACCENT, i));
			for (let i = 0; i < colors.length; i++) {
				for (let j = i + 1; j < colors.length; j++) {
					expect(distance(colors[i], colors[j])).toBeGreaterThan(40);
				}
			}
		});

		it('is deterministic', () => {
			expect(clusterColor(ACCENT, 3)).toBe(clusterColor(ACCENT, 3));
		});

		it('still separates lobes on a near-grey accent', () => {
			// Rotating the hue of a grey produces another grey, so the
			// saturation is floored. Without that, a monochrome theme paints
			// every lobe the same colour and the grouping disappears.
			const grey = '#808080';
			const a = clusterColor(grey, 0);
			const b = clusterColor(grey, 1);
			expect(distance(a, b)).toBeGreaterThan(40);
		});

		it('returns the input unchanged when the accent is not parseable', () => {
			expect(clusterColor('not-a-colour', 2)).toBe('not-a-colour');
		});

		it('produces channels in range for a long walk around the wheel', () => {
			for (let i = 0; i < 30; i++) {
				const { r, g, b } = channels(clusterColor(ACCENT, i));
				[r, g, b].forEach((channel) => {
					expect(channel).toBeGreaterThanOrEqual(0);
					expect(channel).toBeLessThanOrEqual(255);
				});
			}
		});
	});

	describe('clusterHullStyle', () => {
		it('draws the hull as a background wash, not a solid', () => {
			// The nodes are the content; a hull opaque enough to compete with
			// them makes the graph harder to read, not easier.
			const { fill, stroke } = clusterHullStyle(ACCENT, 0, false);
			const fillAlpha = Number(fill.match(/,\s*([\d.]+)\)$/)![1]);
			const strokeAlpha = Number(stroke.match(/,\s*([\d.]+)\)$/)![1]);
			expect(fillAlpha).toBeLessThan(0.2);
			expect(strokeAlpha).toBeGreaterThan(fillAlpha);
			expect(strokeAlpha).toBeLessThan(1);
		});

		it('mutes the ungrouped pile below every real cluster', () => {
			const real = clusterHullStyle(ACCENT, 1, false);
			const ungrouped = clusterHullStyle(ACCENT, 1, true);
			const alpha = (color: string) => Number(color.match(/,\s*([\d.]+)\)$/)![1]);
			expect(alpha(ungrouped.fill)).toBeLessThan(alpha(real.fill));
			expect(alpha(ungrouped.stroke)).toBeLessThan(alpha(real.stroke));
		});

		it('denies the ungrouped pile a hue of its own', () => {
			// It is the leftovers, not a finding. Giving it a colour would
			// present "these belong to nothing" as just another group.
			const ungrouped = clusterHullStyle(ACCENT, 3, true);
			const accentish = clusterHullStyle(ACCENT, 0, true);
			expect(channels(ungrouped.fill)).toEqual(channels(accentish.fill));
		});
	});
});

// ===== from src/__tests__/renderer/components/DocumentGraph/openIconRect.test.ts =====
/**
 * Where the open-file icon sits inside a document node.
 *
 * The renderer and the click hit test both call `openIconRect`, and that is the
 * whole point of the helper: when the two computed the rectangle separately the
 * clickable box sat a pixel above the drawn glyph, and turning previews off
 * would have moved the drawn icon to the middle of the pill while leaving the
 * hit box pinned to where a header band used to be. These tests pin the
 * geometry both callers share.
 */

/** A node is positioned by its CENTER, so the box runs from x - w/2 to x + w/2. */
const card = { x: 200, y: 300, width: 240, height: 120 };
const pill = { x: 200, y: 300, width: 240, height: NODE_HEADER_HEIGHT };

describe('openIconRect', () => {
	it('sits inside the node, hard against its right edge', () => {
		const rect = openIconRect(card, 100);
		const right = card.x + card.width / 2;

		expect(rect.x).toBeGreaterThan(card.x);
		expect(rect.x + rect.size).toBeLessThan(right);
	});

	it('centres the icon in the header band on a full card', () => {
		const rect = openIconRect(card, 100);
		const top = card.y - card.height / 2;

		// Equal gap above and below within the header strip - not the whole node,
		// which would drop the icon into the preview text.
		const gapAbove = rect.y - top;
		const gapBelow = top + NODE_HEADER_HEIGHT - (rect.y + rect.size);
		expect(gapAbove).toBeCloseTo(gapBelow);
		expect(rect.y + rect.size).toBeLessThanOrEqual(top + NODE_HEADER_HEIGHT);
	});

	it('centres the icon in the whole node once previews are off', () => {
		// The pill has no header strip to sit in: the title band IS the node.
		const rect = openIconRect(pill, 0);
		const top = pill.y - pill.height / 2;

		const gapAbove = rect.y - top;
		const gapBelow = top + pill.height - (rect.y + rect.size);
		expect(gapAbove).toBeCloseTo(gapBelow);
	});

	it('never runs past the bottom of a node shorter than a header band', () => {
		// Defensive: a layout that produced a stubby node must not draw the icon
		// outside it, which would leave a hit box floating over the canvas.
		const stub = { x: 0, y: 0, width: 200, height: 20 };
		const rect = openIconRect(stub, 100);

		expect(rect.y).toBeGreaterThanOrEqual(stub.y - stub.height / 2);
		expect(rect.y + rect.size).toBeLessThanOrEqual(stub.y + stub.height / 2);
	});

	it('gives the same rectangle for every "off" spelling', () => {
		// `isPreviewOff` treats anything at or below 0 as off, so the hit test and
		// the renderer must agree on a stored value of -1 as much as on 0.
		expect(openIconRect(pill, 0)).toEqual(openIconRect(pill, -1));
	});
});

// ===== from src/__tests__/renderer/components/DocumentGraph/viewportResize.test.ts =====
describe('transformAfterResize', () => {
	const size = { width: 1000, height: 800 };

	it('returns the current transform when the size did not change', () => {
		const current = { zoom: 2, panX: 10, panY: 20 };
		expect(transformAfterResize(current, null, size, { ...size })).toBe(current);
	});

	it('re-fits a view the user has not moved since the last fit', () => {
		const fit = { zoom: 0.5, panX: 100, panY: 50 };
		expect(transformAfterResize(fit, fit, size, { width: 1000, height: 764 })).toBe('refit');
	});

	it('keeps the zoom of a view the user moved, and holds the viewport center', () => {
		// Selecting a node shows the info bar, which shrinks the canvas height.
		const fit = { zoom: 0.5, panX: 100, panY: 50 };
		const zoomedIn = { zoom: 2.5, panX: -300, panY: -200 };
		const next = transformAfterResize(zoomedIn, fit, size, { width: 1000, height: 764 });
		expect(next).toEqual({ zoom: 2.5, panX: -300, panY: -218 });
	});

	it('treats an equal-valued but different transform object as moved', () => {
		const fit = { zoom: 1, panX: 0, panY: 0 };
		const next = transformAfterResize({ ...fit }, fit, size, { width: 1200, height: 800 });
		expect(next).toEqual({ zoom: 1, panX: 100, panY: 0 });
	});
});
