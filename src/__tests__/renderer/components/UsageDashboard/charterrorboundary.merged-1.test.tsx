// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/components/UsageDashboard/ChartErrorBoundary.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/ChartSkeletons.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/AgentEfficiencyChart.test.tsx

import { AgentEfficiencyChart } from '../../../../renderer/components/UsageDashboard/AgentEfficiencyChart';
import { ChartErrorBoundary } from '../../../../renderer/components/UsageDashboard/ChartErrorBoundary';
import {
	ActivityHeatmapSkeleton,
	AgentComparisonChartSkeleton,
	AutoRunStatsSkeleton,
	DashboardSkeleton,
	DurationTrendsChartSkeleton,
	SourceDistributionChartSkeleton,
	SummaryCardsSkeleton,
} from '../../../../renderer/components/UsageDashboard/ChartSkeletons';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session, Theme } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => ({
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="alert-triangle-icon" className={className} style={style}>
			⚠️
		</span>
	),
	RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="refresh-icon" className={className} style={style}>
			🔄
		</span>
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-down-icon" className={className} style={style}>
			▼
		</span>
	),
	ChevronUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-up-icon" className={className} style={style}>
			▲
		</span>
	),
}));
vi.mock('../../../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// ===== from src/__tests__/renderer/components/UsageDashboard/ChartErrorBoundary.test.tsx =====

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Component that throws an error
const BrokenComponent = ({ shouldError = true }: { shouldError?: boolean }) => {
	if (shouldError) {
		throw new Error('Test error from BrokenComponent');
	}
	return <div data-testid="working-child">Working component</div>;
};

// Component that works
const WorkingComponent = () => <div data-testid="working-child">Working component</div>;

describe('ChartErrorBoundary', () => {
	const theme = createTheme();
	const originalConsoleError = console.error;

	beforeEach(() => {
		vi.clearAllMocks();
		// Suppress React error boundary console output during tests
		console.error = vi.fn();
	});

	afterEach(() => {
		console.error = originalConsoleError;
	});

	describe('Normal Rendering', () => {
		it('renders children when no error occurs', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<WorkingComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('working-child')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});

		it('does not show error UI when children render successfully', () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Test Chart">
					<div>Normal content</div>
				</ChartErrorBoundary>
			);

			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(screen.queryByTestId('chart-retry-button')).not.toBeInTheDocument();
		});
	});

	describe('Error Catching', () => {
		it('catches and displays error when child component throws', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();
			expect(screen.getByText(/Chart failed to render/i)).toBeInTheDocument();
		});

		it('displays chart name in error message when provided', () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Agent Comparison">
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/Failed to render Agent Comparison/i)).toBeInTheDocument();
		});

		it('shows generic message when chartName is not provided', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/Chart failed to render/i)).toBeInTheDocument();
		});

		it('displays unexpected error message', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByText(/An unexpected error occurred/i)).toBeInTheDocument();
		});
	});

	describe('Retry Functionality', () => {
		it('renders retry button when error occurs', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton).toBeInTheDocument();
			expect(retryButton).toHaveTextContent('Retry');
		});

		it('re-renders children when retry is clicked', () => {
			let shouldError = true;

			const ConditionalBrokenComponent = () => {
				if (shouldError) {
					throw new Error('Conditional error');
				}
				return <div data-testid="recovered-child">Recovered!</div>;
			};

			render(
				<ChartErrorBoundary theme={theme}>
					<ConditionalBrokenComponent />
				</ChartErrorBoundary>
			);

			// Initially shows error UI
			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();

			// Fix the error and click retry
			shouldError = false;
			const retryButton = screen.getByTestId('chart-retry-button');
			fireEvent.click(retryButton);

			// Should now show recovered component
			expect(screen.getByTestId('recovered-child')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});

		it('calls onRetry callback when retry is clicked', () => {
			const onRetry = vi.fn();

			render(
				<ChartErrorBoundary theme={theme} onRetry={onRetry}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			fireEvent.click(retryButton);

			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('increments and displays retry count after multiple retries', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// First retry - need to re-query button after each click since component is re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 1');

			// Second retry - re-query the button as it was re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 2');

			// Third retry - re-query the button as it was re-rendered
			fireEvent.click(screen.getByTestId('chart-retry-button'));
			expect(screen.getByTestId('retry-count')).toHaveTextContent('Retry attempts: 3');
		});

		it('does not show retry count on initial error (before any retries)', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.queryByTestId('retry-count')).not.toBeInTheDocument();
		});
	});

	describe('Error Details', () => {
		it('shows toggle details button when error has message', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			expect(toggleButton).toBeInTheDocument();
			expect(toggleButton).toHaveTextContent('Show details');
		});

		it('shows error details when toggle is clicked', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('error-details')).toBeInTheDocument();
			expect(screen.getByText(/Test error from BrokenComponent/i)).toBeInTheDocument();
		});

		it('hides error details when toggle is clicked again', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');

			// Show details
			fireEvent.click(toggleButton);
			expect(screen.getByTestId('error-details')).toBeInTheDocument();

			// Hide details
			fireEvent.click(toggleButton);
			expect(screen.queryByTestId('error-details')).not.toBeInTheDocument();
		});

		it('toggles chevron icon when showing/hiding details', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// Initially shows down chevron
			expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument();
			expect(screen.queryByTestId('chevron-up-icon')).not.toBeInTheDocument();

			// After clicking, shows up chevron
			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('chevron-up-icon')).toBeInTheDocument();
			expect(screen.queryByTestId('chevron-down-icon')).not.toBeInTheDocument();
		});
	});

	describe('Theme Integration', () => {
		it('applies theme background color to error container', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('applies theme accent color to retry button', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});

		it('applies theme text colors to error messages', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const heading = screen.getByText(/Chart failed to render/i);
			expect(heading).toHaveStyle({ color: theme.colors.textMain });

			const subtext = screen.getByText(/An unexpected error occurred/i);
			expect(subtext).toHaveStyle({ color: theme.colors.textDim });
		});

		it('works with light theme', () => {
			const lightTheme: Theme = {
				...theme,
				id: 'test-light',
				name: 'Test Light',
				mode: 'light',
				colors: {
					...theme.colors,
					bgMain: '#ffffff',
					textMain: '#1a1a2e',
					textDim: '#666666',
				},
			};

			render(
				<ChartErrorBoundary theme={lightTheme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ backgroundColor: lightTheme.colors.bgMain });
		});
	});

	describe('Accessibility', () => {
		it('sets role="alert" on error container', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('sets aria-live="polite" for screen readers', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveAttribute('aria-live', 'polite');
		});

		it('icons have aria-hidden for assistive technologies', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// The icons should be present (mocked)
			expect(screen.getByTestId('alert-triangle-icon')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
		});

		it('retry button is keyboard focusable', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const retryButton = screen.getByTestId('chart-retry-button');
			expect(retryButton.tagName).toBe('BUTTON');
		});
	});

	describe('Error Logging', () => {
		it('logs error to console when component catches error', async () => {
			render(
				<ChartErrorBoundary theme={theme} chartName="Test Chart">
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			// Console.error is called by React's error boundary and our own logging
			expect(console.error).toHaveBeenCalled();
		});
	});

	describe('Edge Cases', () => {
		it('handles multiple children', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<div>Child 1</div>
					<div>Child 2</div>
					<div>Child 3</div>
				</ChartErrorBoundary>
			);

			expect(screen.getByText('Child 1')).toBeInTheDocument();
			expect(screen.getByText('Child 2')).toBeInTheDocument();
			expect(screen.getByText('Child 3')).toBeInTheDocument();
		});

		it('handles deeply nested children', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<div>
						<div>
							<div>
								<BrokenComponent />
							</div>
						</div>
					</div>
				</ChartErrorBoundary>
			);

			expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();
		});

		it('handles errors with no stack trace', () => {
			const ErrorWithoutStack = () => {
				const error = new Error('Error without stack');
				error.stack = undefined;
				throw error;
			};

			render(
				<ChartErrorBoundary theme={theme}>
					<ErrorWithoutStack />
				</ChartErrorBoundary>
			);

			const toggleButton = screen.getByTestId('toggle-error-details');
			fireEvent.click(toggleButton);

			expect(screen.getByTestId('error-details')).toBeInTheDocument();
			expect(screen.getByText(/Error without stack/i)).toBeInTheDocument();
		});

		it('handles errors thrown during event handlers (does not catch)', () => {
			// Error boundaries don't catch errors in event handlers
			// This test documents that behavior
			const ComponentWithEventError = () => (
				<button
					onClick={() => {
						throw new Error('Event handler error');
					}}
					data-testid="error-button"
				>
					Click me
				</button>
			);

			render(
				<ChartErrorBoundary theme={theme}>
					<ComponentWithEventError />
				</ChartErrorBoundary>
			);

			// Component renders normally (error boundaries don't catch event errors)
			expect(screen.getByTestId('error-button')).toBeInTheDocument();
			expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
		});
	});

	describe('Integration with UsageDashboard Charts', () => {
		it('provides minimum height container for chart errors', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveStyle({ minHeight: '200px' });
		});

		it('uses rounded corners matching dashboard style', () => {
			render(
				<ChartErrorBoundary theme={theme}>
					<BrokenComponent />
				</ChartErrorBoundary>
			);

			const container = screen.getByTestId('chart-error-boundary');
			expect(container).toHaveClass('rounded-lg');
		});
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/ChartSkeletons.test.tsx =====

// Create test theme
const createTheme_1 = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

describe('ChartSkeletons', () => {
	const theme = createTheme_1();

	describe('SummaryCardsSkeleton', () => {
		it('renders 5 skeleton cards by default', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			expect(skeleton).toBeInTheDocument();

			// Each card has 3 skeleton boxes (icon, label, value)
			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			expect(skeletonBoxes.length).toBe(15); // 5 cards × 3 boxes
		});

		it('respects custom column count', () => {
			render(<SummaryCardsSkeleton theme={theme} columns={3} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			expect(skeleton).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('uses theme background color for cards', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			const cards = skeleton.querySelectorAll('.rounded-lg');
			cards.forEach((card) => {
				expect(card).toHaveStyle({ backgroundColor: theme.colors.bgMain });
			});
		});

		it('skeleton boxes have shimmer animation', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
		});
	});

	describe('AgentComparisonChartSkeleton', () => {
		it('renders with proper structure', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');
			expect(skeleton).toBeInTheDocument();
			expect(skeleton).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('renders header, bars, and legend sections', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');

			// Header section
			const header = skeleton.querySelector('.flex.items-center.justify-between.mb-4');
			expect(header).toBeInTheDocument();

			// Bar section (4 bars)
			const bars = skeleton.querySelectorAll('.space-y-2 > div');
			expect(bars.length).toBe(4);

			// Legend section with border-t
			const legend = skeleton.querySelector('.border-t');
			expect(legend).toBeInTheDocument();
		});

		it('renders skeleton boxes for bar chart elements', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			// Header: 2 (title + toggle) + Bars: 4×3=12 (name + bar + value) + Legend: 4×2=8
			expect(skeletonBoxes.length).toBeGreaterThanOrEqual(14);
		});
	});

	describe('SourceDistributionChartSkeleton', () => {
		it('renders with circular placeholder for pie chart', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('source-distribution-skeleton');
			expect(skeleton).toBeInTheDocument();

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toBeInTheDocument();
			expect(circle).toHaveClass('rounded-full');
		});

		it('circle has shimmer animation', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toHaveStyle({
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
			});
		});

		it('renders legend items', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('source-distribution-skeleton');
			const legendSection = skeleton.querySelector('.flex.justify-center.gap-6');
			expect(legendSection).toBeInTheDocument();
		});
	});

	describe('ActivityHeatmapSkeleton', () => {
		it('renders with proper grid structure', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			expect(skeleton).toBeInTheDocument();
		});

		it('renders day labels (7 rows)', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			// Day labels column exists
			const dayLabelsColumn = skeleton.querySelector('.flex-col.justify-between');
			expect(dayLabelsColumn).toBeInTheDocument();
		});

		it('renders week columns (multiple)', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			const gridColumns = skeleton.querySelectorAll('.flex.flex-col');
			// Should have multiple columns for weeks
			expect(gridColumns.length).toBeGreaterThan(5);
		});

		it('renders legend with intensity levels', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			const legendSection = skeleton.querySelector('.flex.items-center.justify-end.gap-2');
			expect(legendSection).toBeInTheDocument();
		});
	});

	describe('DurationTrendsChartSkeleton', () => {
		it('renders with SVG wave placeholder', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			expect(skeleton).toBeInTheDocument();

			// SVG element should exist
			const svg = skeleton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders Y-axis label placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			// 5 Y-axis labels
			const yAxisContainer = skeleton.querySelector('.flex.flex-col.justify-between');
			const yLabels = yAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
			expect(yLabels?.length).toBe(5);
		});

		it('renders X-axis label placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			const xAxisContainer = skeleton.querySelector('.flex.justify-between.mt-2');
			const xLabels = xAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
			expect(xLabels?.length).toBe(6);
		});

		it('renders gridlines placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			const gridlines = skeleton.querySelectorAll('.absolute.w-full');
			expect(gridlines.length).toBe(4);
		});
	});

	describe('AutoRunStatsSkeleton', () => {
		it('renders 6 skeleton cards by default', () => {
			render(<AutoRunStatsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('autorun-stats-skeleton');
			expect(skeleton).toBeInTheDocument();

			const cards = skeleton.querySelectorAll('.rounded-lg');
			expect(cards.length).toBe(6);
		});

		it('respects custom column count', () => {
			render(<AutoRunStatsSkeleton theme={theme} columns={3} />);

			const skeleton = screen.getByTestId('autorun-stats-skeleton');
			expect(skeleton).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('each card has icon, label, and value placeholders', () => {
			render(<AutoRunStatsSkeleton theme={theme} />);

			// 6 cards × 3 elements = 18 skeleton boxes
			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			expect(skeletonBoxes.length).toBe(18);
		});
	});

	describe('DashboardSkeleton', () => {
		it('renders overview mode skeleton by default', () => {
			render(<DashboardSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();

			// Should contain all overview components
			expect(screen.getByTestId('summary-cards-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('source-distribution-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
		});

		it('renders agents mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="agents" />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();

			expect(screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('renders activity mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="activity" />);

			expect(screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('renders autorun mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="autorun" />);

			expect(screen.getByTestId('autorun-stats-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('respects chartGridCols prop', () => {
			render(<DashboardSkeleton theme={theme} chartGridCols={1} />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			const chartGrid = skeleton.querySelector('.grid.gap-6');
			expect(chartGrid).toHaveStyle({
				gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
			});
		});

		it('respects summaryCardsCols prop', () => {
			render(<DashboardSkeleton theme={theme} summaryCardsCols={3} />);

			const summaryCards = screen.getByTestId('summary-cards-skeleton');
			expect(summaryCards).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('respects autoRunStatsCols prop', () => {
			render(<DashboardSkeleton theme={theme} viewMode="autorun" autoRunStatsCols={4} />);

			const autoRunStats = screen.getByTestId('autorun-stats-skeleton');
			expect(autoRunStats).toHaveStyle({
				gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
			});
		});
	});

	describe('Theme Integration', () => {
		it('uses theme border color for skeleton boxes', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ backgroundColor: theme.colors.border });
			});
		});

		it('uses theme bgMain for card backgrounds', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');
			expect(skeleton).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('works with light theme', () => {
			const lightTheme: Theme = {
				...theme,
				mode: 'light',
				colors: {
					...theme.colors,
					bgMain: '#ffffff',
					border: '#e5e5e5',
				},
			};

			render(<SummaryCardsSkeleton theme={lightTheme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ backgroundColor: lightTheme.colors.border });
			});
		});
	});

	describe('Animation', () => {
		it('all skeleton boxes have consistent animation timing', () => {
			render(<DashboardSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
		});

		it('skeleton circle has animation', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toHaveStyle({
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
			});
		});
	});

	describe('Accessibility', () => {
		it('skeleton elements use opacity for visibility', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ opacity: '0.3' });
			});
		});

		it('renders with appropriate structure for screen readers', () => {
			render(<DashboardSkeleton theme={theme} />);

			// Dashboard skeleton should be recognizable as a loading state
			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();
		});
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/AgentEfficiencyChart.test.tsx =====

let _sessionIdCounter = 0;

function makeSession(overrides: Partial<Session> = {}): Session {
	_sessionIdCounter++;
	return {
		id: `s${_sessionIdCounter}`,
		name: `Session ${_sessionIdCounter}`,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		createdAt: 0,
		...overrides,
	} as Session;
}

const theme = THEMES['dracula'];

const baseData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000,
	avgDuration: 72000,
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		'factory-droid': { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [],
};

describe('AgentEfficiencyChart', () => {
	describe('Rendering', () => {
		it('renders the title', () => {
			render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			expect(screen.getByText('Agent Efficiency')).toBeInTheDocument();
		});

		it('renders the empty-state message when no agent data is present', () => {
			const emptyData: StatsAggregation = {
				totalQueries: 0,
				totalDuration: 0,
				avgDuration: 0,
				byAgent: {},
				bySource: { user: 0, auto: 0 },
				byDay: [],
			};
			render(<AgentEfficiencyChart data={emptyData} theme={theme} />);
			expect(screen.getByText('No agent query data available')).toBeInTheDocument();
		});
	});

	describe('Session Name Resolution', () => {
		it('uses the user-assigned session name when a single session matches the provider', () => {
			const session = makeSession({
				id: 'backend-api',
				name: 'Backend API',
				toolType: 'claude-code',
			});
			const data: StatsAggregation = {
				...baseData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />);

			expect(screen.getAllByText('Backend API').length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
		});

		it('falls back to prettified type when multiple sessions share the same provider', () => {
			const a = makeSession({ id: 'a', name: 'Frontend', toolType: 'claude-code' });
			const b = makeSession({ id: 'b', name: 'Backend', toolType: 'claude-code' });
			const data: StatsAggregation = {
				...baseData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
		});

		it('disambiguates colliding display names with " (2)" suffixes', () => {
			const a = makeSession({ id: 'a', name: 'Worker', toolType: 'claude-code' });
			const b = makeSession({ id: 'b', name: 'Worker', toolType: 'opencode' });
			const data: StatsAggregation = {
				...baseData,
				byAgent: {
					'claude-code': { count: 30, duration: 2000000 },
					opencode: { count: 20, duration: 1000000 },
				},
			};

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Worker').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Worker (2)').length).toBeGreaterThanOrEqual(1);
		});

		it('prettifies raw agent type keys when no sessions are provided', () => {
			render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			// "claude-code" → "Claude Code", "factory-droid" → "Factory Droid"
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
		});

		it('shows resolved name in row title attribute (used as tooltip on truncation)', () => {
			const session = makeSession({
				id: 'backend-api',
				name: 'Backend API',
				toolType: 'claude-code',
			});
			const data: StatsAggregation = {
				...baseData,
				byAgent: {
					'claude-code': { count: 20, duration: 1000000 },
				},
			};

			const { container } = render(
				<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />
			);

			const labelEl = container.querySelector(
				'[data-testid="bar-chart-label"]'
			) as HTMLElement | null;
			expect(labelEl).not.toBeNull();
			expect(labelEl?.title).toBe('Backend API');
		});
	});

	describe('Drill-down filter', () => {
		it('renders all entries at full opacity when no activeFilterKey is provided', () => {
			const { container } = render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			// Row containers live at the top of the .space-y-3 wrapper as
			// `.flex.items-center.gap-3` divs. With no filter, neither row should
			// have the dim opacity applied.
			const rows = container.querySelectorAll('.space-y-3 > div.flex.items-center.gap-3');
			expect(rows.length).toBe(2);
			rows.forEach((row) => {
				expect((row as HTMLElement).style.opacity).not.toBe('0.3');
			});
		});

		it('dims rows that do not match activeFilterKey to 0.3 opacity', () => {
			const { container } = render(
				<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="claude-code" />
			);
			const rows = container.querySelectorAll(
				'.space-y-3 > div.flex.items-center.gap-3'
			) as NodeListOf<HTMLElement>;
			expect(rows.length).toBe(2);

			// Two providers: claude-code (matches) and factory-droid (dimmed).
			// Sort by efficiency: data has claude-code at 2000000/30 ≈ 66667ms,
			// factory-droid at 1600000/20 = 80000ms - claude-code is faster, so
			// it renders first. We don't depend on order; instead, find the row
			// whose label is "Claude Code" vs "Factory Droid".
			const claudeRow = Array.from(rows).find((r) => r.textContent?.includes('Claude Code'));
			const factoryRow = Array.from(rows).find((r) => r.textContent?.includes('Factory Droid'));

			expect(claudeRow).toBeDefined();
			expect(factoryRow).toBeDefined();
			expect(claudeRow?.style.opacity).not.toBe('0.3');
			expect(factoryRow?.style.opacity).toBe('0.3');
		});

		it('dims all rows when activeFilterKey matches no entry', () => {
			const { container } = render(
				<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="nonexistent" />
			);
			const rows = container.querySelectorAll(
				'.space-y-3 > div.flex.items-center.gap-3'
			) as NodeListOf<HTMLElement>;
			expect(rows.length).toBe(2);
			rows.forEach((row) => {
				expect(row.style.opacity).toBe('0.3');
			});
		});
	});

	describe('Worktree Differentiation', () => {
		it('splits worktree agents into separate rows tagged with "(Worktree)"', () => {
			const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'wt-1',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});

			const dataWithSessions: StatsAggregation = {
				...baseData,
				bySessionByDay: {
					parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
				},
			};

			render(
				<AgentEfficiencyChart data={dataWithSessions} theme={theme} sessions={[parent, worktree]} />
			);

			// Two sessions share toolType "claude-code" so the name resolves to
			// the prettified type for the regular row plus a "(Worktree)" suffix.
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Claude Code (Worktree)').length).toBeGreaterThanOrEqual(1);
		});

		it('widens the label column so "(Worktree)" labels are not clipped', () => {
			const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'wt-1',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});

			const dataWithSessions: StatsAggregation = {
				...baseData,
				bySessionByDay: {
					parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
				},
			};

			const { container } = render(
				<AgentEfficiencyChart data={dataWithSessions} theme={theme} sessions={[parent, worktree]} />
			);

			const labels = Array.from(
				container.querySelectorAll<HTMLElement>('[data-testid="bar-chart-label"]')
			);
			expect(labels.length).toBeGreaterThanOrEqual(2);
			// Every row shares one column width, wider than the old fixed 112px.
			const widths = new Set(labels.map((el) => el.style.width));
			expect(widths.size).toBe(1);
			expect(parseInt(labels[0].style.width, 10)).toBeGreaterThan(112);
		});
	});
});
