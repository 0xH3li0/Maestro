// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/components/UsageDashboard/ActivityHeatmap.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/TokenStatsLegend.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/AgentUsageChart.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/SourceDistributionChart.test.tsx

import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { AgentUsageChart } from '../../../../renderer/components/UsageDashboard/AgentUsageChart';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { TokenStats } from '../../../../renderer/components/UsageDashboard/TokenStats';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { useElementWidth } from '../../../../renderer/hooks/ui/useElementWidth';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import type {
	TokenUsageAggregate,
	TokenUsageTimeBucket,
	TokenUsageTotals,
} from '../../../../shared/tokenUsage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../renderer/hooks/ui/useElementWidth', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useElementWidth')>()),
	useElementWidth: vi.fn(() => 0),
}));
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

// ===== from src/__tests__/renderer/components/UsageDashboard/ActivityHeatmap.test.tsx =====

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
		{ date: '2024-12-22', count: 3, duration: 180000 },
		{ date: '2024-12-23', count: 8, duration: 480000 },
		{ date: '2024-12-24', count: 12, duration: 720000 },
		{ date: '2024-12-25', count: 0, duration: 0 },
		{ date: '2024-12-26', count: 7, duration: 420000 },
		{ date: '2024-12-27', count: 5, duration: 300000 },
	],
};

// Empty data for edge case testing
const emptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [],
};

describe('ActivityHeatmap', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders metric toggle buttons', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Count')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders day labels (Mon, Wed, Fri visible)', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			// Mon, Wed, Fri should be visible (idx % 2 === 1)
			expect(screen.getByText('Mon')).toBeInTheDocument();
			expect(screen.getByText('Wed')).toBeInTheDocument();
			expect(screen.getByText('Fri')).toBeInTheDocument();
		});

		it('renders intensity legend', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Less')).toBeInTheDocument();
			expect(screen.getByText('More')).toBeInTheDocument();
		});

		it('renders with empty data without crashing', () => {
			render(<ActivityHeatmap data={emptyData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
	});

	describe('Metric Mode Toggle', () => {
		it('defaults to count mode', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const countButton = screen.getByText('Count');
			// Count button should have accent background when active
			expect(countButton).toHaveStyle({
				backgroundColor: expect.stringContaining('20'),
			});
		});

		it('switches to duration mode when clicked', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const durationButton = screen.getByText('Duration');
			fireEvent.click(durationButton);

			// Duration button should now be active
			expect(durationButton).toHaveStyle({
				color: theme.colors.accent,
			});
		});
	});

	describe('Time Range Handling', () => {
		it('renders for day time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="day" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for week time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for month time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="month" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for year time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="year" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for all time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="all" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const title = screen.getByText('Activity Heatmap');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<ActivityHeatmap data={mockData} timeRange="week" theme={lightTheme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on cell hover', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Find a heatmap cell (the colored divs in the grid)
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				fireEvent.mouseEnter(cells[0]);

				// Tooltip should appear with date and query count
				// Note: Tooltip content depends on the specific day data
				// We just verify a tooltip-like element appears (uses z-[99999] for high stacking)
				const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
				expect(tooltip).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				fireEvent.mouseEnter(cells[0]);
				fireEvent.mouseLeave(cells[0]);

				const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
				expect(tooltip).not.toBeInTheDocument();
			}
		});
	});

	describe('Data Visualization', () => {
		it('creates heatmap cells based on data', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Should have some cells rendered
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);
		});

		it('applies different intensities based on values', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Get all cells and check they have background colors
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				// At least one cell should have a background style
				const hasBackgroundStyles = Array.from(cells).some(
					(cell) => (cell as HTMLElement).style.backgroundColor !== ''
				);
				expect(hasBackgroundStyles).toBe(true);
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to cells for smooth color changes', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('background-color');
			expect(firstCell.style.transition).toContain('0.3s');
		});

		it('uses ease timing function for smooth animation curves', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('ease');
		});

		it('applies outline transition for hover effects', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('outline');
		});
	});
});

function monthData(): StatsAggregation {
	const byDay = Array.from({ length: 30 }, (_, i) => ({
		date: `2024-12-${String(i + 1).padStart(2, '0')}`,
		count: i,
		duration: i * 1000,
	}));
	return { ...mockData, byDay };
}

/** Day numbers actually printed above the 4-hour-block grid. */
function printedDayLabels(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('div[title]'))
		.filter((el) => /^[A-Z][a-z]+day, /.test(el.getAttribute('title') ?? ''))
		.map((el) => el.textContent ?? '')
		.filter((text) => text.length > 0);
}

describe('ActivityHeatmap day labels', () => {
	afterEach(() => {
		vi.mocked(useElementWidth).mockReturnValue(0);
	});

	it('labels every column when each one has room', () => {
		vi.mocked(useElementWidth).mockReturnValue(900);
		const { container } = render(
			<ActivityHeatmap data={monthData()} timeRange="month" theme={theme} />
		);

		expect(printedDayLabels(container).length).toBe(30);
	});

	it('thins the labels when the columns are too narrow to print into', () => {
		vi.mocked(useElementWidth).mockReturnValue(270);
		const { container } = render(
			<ActivityHeatmap data={monthData()} timeRange="month" theme={theme} />
		);

		const labels = printedDayLabels(container);
		expect(labels.length).toBeGreaterThan(1);
		expect(labels.length).toBeLessThan(30);
		// The month boundary is the one label kept off-stride. The grid is built
		// from today rather than from the data, so assert on its SHAPE (a month
		// abbreviation among day numbers) instead of naming a month.
		expect(labels.filter((text) => !/^\d+$/.test(text)).length).toBeGreaterThanOrEqual(1);
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/TokenStatsLegend.test.tsx =====

// In-memory stand-in for localStorage: the local jsdom build ships without a
// Storage implementation, so asserting persistence against the real one only
// ever passes on CI. Mocking the accessor tests the wiring everywhere.
const storage = new Map<string, string>();

const theme_1 = THEMES['dracula'];

function makeTotals(over: Partial<TokenUsageTotals> = {}): TokenUsageTotals {
	return {
		inputTokens: 1_000,
		outputTokens: 2_000,
		cacheReadTokens: 900_000,
		cacheCreationTokens: 0,
		costUsd: 12,
		costEstimated: true,
		sessionCount: 3,
		...over,
	};
}

function bucket(startMs: number, over: Partial<TokenUsageTimeBucket> = {}): TokenUsageTimeBucket {
	return { startMs, ...makeTotals(), ...over };
}

const aggregate: TokenUsageAggregate = {
	totals: makeTotals(),
	byAgent: [],
	byModel: [],
	byProject: [],
	byAccount: [],
	// Two buckets whose cache reads differ by 10x, so a rescale after hiding
	// cache reads is visible in the bar heights.
	timeline: [
		bucket(1_700_000_000_000, {
			cacheReadTokens: 100_000,
			inputTokens: 1_000,
			outputTokens: 1_000,
		}),
		bucket(1_700_086_400_000, {
			cacheReadTokens: 1_000_000,
			inputTokens: 1_000,
			outputTokens: 1_000,
		}),
	],
	series: {
		byDay: {},
		byHour: {},
		byAgentByDay: {},
		bySessionByDay: {},
	} as TokenUsageAggregate['series'],
	coverageByAgent: {},
	generatedAtMs: 1_700_086_400_000,
};

function mountTokens() {
	return render(<TokenStats timeRange="month" theme={theme_1} />);
}

/** Bar heights in the timeline, in render order. */
function barHeights(): string[] {
	const timeline = screen.getByTestId('token-timeline');
	return Array.from(timeline.querySelectorAll<HTMLElement>('.rounded-t-sm')).map(
		(el) => el.style.height
	);
}

describe('TokenStats timeline legend', () => {
	beforeEach(() => {
		storage.clear();
		(window as unknown as { maestro: unknown }).maestro = {
			stats: { getTokenUsage: vi.fn().mockResolvedValue(aggregate) },
		};
	});

	it('shows every series by default', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
			expect(screen.getByTestId(`token-timeline-legend-${key}`).getAttribute('aria-pressed')).toBe(
				'true'
			);
		}
	});

	it('hides a series and rescales the chart when its legend entry is clicked', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		// With cache reads in play the small bucket is a tenth of the tall one.
		expect(barHeights()).toEqual(['10.179640718562874%', '100%']);

		fireEvent.click(screen.getByTestId('token-timeline-legend-cacheReadTokens'));

		expect(
			screen.getByTestId('token-timeline-legend-cacheReadTokens').getAttribute('aria-pressed')
		).toBe('false');
		// Input + output are identical across both buckets, so dropping cache reads
		// makes them equal rather than leaving one invisible.
		expect(barHeights()).toEqual(['100%', '100%']);
	});

	it('remembers each series choice across a remount', async () => {
		const first = mountTokens();
		await screen.findByTestId('token-timeline');

		fireEvent.click(screen.getByTestId('token-timeline-legend-outputTokens'));
		expect(storage.get('usageDashboard.tokens.timelineSeries.outputTokens')).toBe('false');

		first.unmount();

		mountTokens();
		await screen.findByTestId('token-timeline');
		expect(
			screen.getByTestId('token-timeline-legend-outputTokens').getAttribute('aria-pressed')
		).toBe('false');
		expect(
			screen.getByTestId('token-timeline-legend-inputTokens').getAttribute('aria-pressed')
		).toBe('true');
	});

	it('refuses to hide the last visible series', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		fireEvent.click(screen.getByTestId('token-timeline-legend-inputTokens'));
		fireEvent.click(screen.getByTestId('token-timeline-legend-outputTokens'));

		const last = screen.getByTestId('token-timeline-legend-cacheReadTokens');
		await waitFor(() => expect((last as HTMLButtonElement).disabled).toBe(true));

		fireEvent.click(last);
		expect(last.getAttribute('aria-pressed')).toBe('true');
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/AgentUsageChart.test.tsx =====

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

const theme_2 = THEMES['dracula'];

const baseEmptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byLocation: { local: 0, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 0,
	sessionsByAgent: {},
	sessionsByDay: [],
	avgSessionDuration: 0,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
};

function dataForSessions(
	sessionDays: Record<string, Array<{ date: string; count: number; duration: number }>>
): StatsAggregation {
	return { ...baseEmptyData, bySessionByDay: sessionDays };
}

describe('AgentUsageChart', () => {
	describe('Rendering', () => {
		it('renders the title', () => {
			render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme_2} />);
			expect(screen.getByText('Agent Usage Over Time')).toBeInTheDocument();
		});

		it('renders the empty-state message when no session data is present', () => {
			render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme_2} />);
			expect(screen.getByText('No usage data available')).toBeInTheDocument();
		});
	});

	describe('Session Name Resolution', () => {
		it('uses the user-assigned session name when the stat key matches a session', () => {
			const session = makeSession({ id: 'sess-aaa', name: 'Backend API' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme_2} sessions={[session]} />);

			expect(screen.getByText('Backend API')).toBeInTheDocument();
		});

		it('matches stat keys with tab-id suffixes back to the underlying session', () => {
			const session = makeSession({ id: 'sess-bbb', name: 'Frontend' });
			const data = dataForSessions({
				'sess-bbb-ai-tab1': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme_2} sessions={[session]} />);

			expect(screen.getByText('Frontend')).toBeInTheDocument();
		});

		it('disambiguates colliding session names with " (2)" suffixes', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'Worker' });
			const b = makeSession({ id: 'sess-bbb', name: 'Worker' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme_2} sessions={[a, b]} />);

			expect(screen.getByText('Worker')).toBeInTheDocument();
			expect(screen.getByText('Worker (2)')).toBeInTheDocument();
		});

		it('appends " (WT)" suffix to worktree-child session names', () => {
			const parent = makeSession({ id: 'parent', name: 'Main App' });
			const worktree = makeSession({
				id: 'wt-1',
				name: 'Feature Branch',
				parentSessionId: 'parent',
			});
			const data = dataForSessions({
				parent: [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'wt-1': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={[parent, worktree]}
				/>
			);

			expect(screen.getByText('Main App')).toBeInTheDocument();
			expect(screen.getByText('Feature Branch (WT)')).toBeInTheDocument();
		});

		it('falls back to a prettified key when no matching session exists', () => {
			// "claude-code" is the canonical agent id, so prettifyAgentType returns
			// "Claude Code" - used as the legend label when no session is registered
			// for this stat key.
			const data = dataForSessions({
				'claude-code': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme_2} sessions={[]} />);

			expect(screen.getByText('Claude Code')).toBeInTheDocument();
		});
	});

	describe('Drill-down filter', () => {
		// Two-session fixture used across the drill-down tests below.
		function buildTwoSessionFixture() {
			const sessionA = makeSession({ id: 'sess-aaa', name: 'Backend' });
			const sessionB = makeSession({ id: 'sess-bbb', name: 'Frontend' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});
			return { sessions: [sessionA, sessionB], data };
		}

		it('renders legend items as non-interactive when onAgentClick is not provided', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart data={data} timeRange="week" theme={theme_2} sessions={sessions} />
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			expect(legendButtons.length).toBe(0);
		});

		it('renders legend items as buttons with tabIndex when onAgentClick is provided', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={vi.fn()}
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			// Sorted by total queries desc → Backend (5), Frontend (3).
			expect(legendButtons.length).toBe(2);
			legendButtons.forEach((btn) => {
				expect(btn.getAttribute('tabIndex')).toBe('0');
				expect((btn as HTMLElement).style.cursor).toBe('pointer');
			});
		});

		it('fires onAgentClick with the session key and resolved display name', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={onAgentClick}
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			fireEvent.click(legendButtons[0]); // Backend (sorted first by total)

			expect(onAgentClick).toHaveBeenCalledTimes(1);
			expect(onAgentClick).toHaveBeenCalledWith('sess-aaa', 'Backend');
		});

		it('fires onAgentClick on Enter and Space key activation', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={onAgentClick}
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			fireEvent.keyDown(legendButtons[0], { key: 'Enter' });
			fireEvent.keyDown(legendButtons[0], { key: ' ' });

			expect(onAgentClick).toHaveBeenCalledTimes(2);
		});

		it('highlights the matching legend item with an accent background', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={vi.fn()}
					activeFilterKey="sess-aaa"
				/>
			);

			const legendButtons = container.querySelectorAll(
				'[role="button"]'
			) as NodeListOf<HTMLElement>;
			// Backend (sorted first) is selected; Frontend is not.
			expect(legendButtons[0].style.backgroundColor).not.toBe('');
			expect(legendButtons[1].style.backgroundColor).toBe('');
		});

		it('reflects selection state via aria-pressed', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={vi.fn()}
					activeFilterKey="sess-bbb"
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			// Sorted: Backend (false), Frontend (true).
			expect(legendButtons[0].getAttribute('aria-pressed')).toBe('false');
			expect(legendButtons[1].getAttribute('aria-pressed')).toBe('true');
		});

		it('dims non-selected lines to 0.15 stroke-opacity and thickens the selected line', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={vi.fn()}
					activeFilterKey="sess-aaa"
				/>
			);

			// Two lines, sorted: sess-aaa (selected), sess-bbb (dimmed).
			const lines = container.querySelectorAll('path');
			expect(lines.length).toBe(2);
			expect(lines[0].getAttribute('stroke-opacity')).toBe('1');
			expect(lines[0].getAttribute('stroke-width')).toBe('2.5');
			expect(lines[1].getAttribute('stroke-opacity')).toBe('0.15');
			expect(lines[1].getAttribute('stroke-width')).toBe('2');
		});

		it('renders all lines at full opacity and default width when no filter is active', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme_2}
					sessions={sessions}
					onAgentClick={vi.fn()}
					activeFilterKey={null}
				/>
			);

			const lines = container.querySelectorAll('path');
			lines.forEach((line) => {
				expect(line.getAttribute('stroke-opacity')).toBe('1');
				expect(line.getAttribute('stroke-width')).toBe('2');
			});
		});
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/SourceDistributionChart.test.tsx =====

// Test theme
const theme_3 = THEMES['dracula'];

// Sample data for testing
const mockData_1: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
	],
};

// Data with only interactive (user) queries
const interactiveOnlyData: StatsAggregation = {
	totalQueries: 30,
	totalDuration: 1800000, // 30 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 30, duration: 1800000 },
	},
	bySource: { user: 30, auto: 0 },
	byDay: [],
};

// Data with only auto queries
const autoOnlyData: StatsAggregation = {
	totalQueries: 20,
	totalDuration: 1200000, // 20 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 20, duration: 1200000 },
	},
	bySource: { user: 0, auto: 20 },
	byDay: [],
};

// Empty data for edge case testing
const emptyData_1: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [],
};

// Data with equal distribution
const equalDistributionData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 6000000, // 100 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 100, duration: 6000000 },
	},
	bySource: { user: 50, auto: 50 },
	byDay: [],
};

describe('SourceDistributionChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			expect(screen.getByText('Session Type')).toBeInTheDocument();
		});

		it('renders metric toggle buttons', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			expect(screen.getByText('Count')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders SVG donut chart', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders chart segments as paths', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBe(2); // Interactive and Auto
		});

		it('renders with empty data showing message', () => {
			render(<SourceDistributionChart data={emptyData_1} theme={theme_3} />);

			expect(screen.getByText('No source data available')).toBeInTheDocument();
		});

		it('renders single source (interactive only) correctly', () => {
			render(<SourceDistributionChart data={interactiveOnlyData} theme={theme_3} />);

			expect(screen.getByText('Interactive')).toBeInTheDocument();
			// With only interactive, should show 100%
			expect(screen.getByText(/100\.0%/)).toBeInTheDocument();
		});

		it('renders single source (auto only) correctly', () => {
			render(<SourceDistributionChart data={autoOnlyData} theme={theme_3} />);

			expect(screen.getByText('Auto Run')).toBeInTheDocument();
			// With only auto, should show 100%
			expect(screen.getByText(/100\.0%/)).toBeInTheDocument();
		});
	});

	describe('Center Label', () => {
		it('shows total count in count mode', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Total is 35 + 15 = 50
			expect(screen.getByText('50')).toBeInTheDocument();
			expect(screen.getByText('total')).toBeInTheDocument();
		});

		it('shows total duration in duration mode', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Switch to duration mode
			fireEvent.click(screen.getByText('Duration'));

			// Should show formatted duration
			expect(screen.getByText('time')).toBeInTheDocument();
		});

		it('formats large numbers with K suffix', () => {
			const largeData: StatsAggregation = {
				...mockData_1,
				bySource: { user: 1500, auto: 500 },
			};

			render(<SourceDistributionChart data={largeData} theme={theme_3} />);

			// Total is 2000, should show as 2K (with decimal)
			expect(screen.getByText('2.0K')).toBeInTheDocument();
		});
	});

	describe('Legend', () => {
		it('renders legend with source labels', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			expect(screen.getByText('Interactive')).toBeInTheDocument();
			expect(screen.getByText('Auto Run')).toBeInTheDocument();
		});

		it('shows percentages in legend', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Interactive is 35/50 = 70%, Auto is 15/50 = 30%
			expect(screen.getByText(/70\.0%/)).toBeInTheDocument();
			expect(screen.getByText(/30\.0%/)).toBeInTheDocument();
		});

		it('shows color indicators for each source', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Legend color indicators
			const colorIndicators = container.querySelectorAll('.w-3.h-3.rounded-sm');
			expect(colorIndicators.length).toBe(2);
		});

		it('highlights legend item on hover', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Find legend item container
			const legendItems = container.querySelectorAll('.flex.items-center.gap-3.cursor-default');

			if (legendItems.length > 0) {
				const labelBefore = legendItems[0].querySelector('.text-sm.font-medium');
				expect(labelBefore).toHaveStyle({ color: theme_3.colors.textDim });

				fireEvent.mouseEnter(legendItems[0]);

				const labelAfter = legendItems[0].querySelector('.text-sm.font-medium');
				expect(labelAfter).toHaveStyle({ color: theme_3.colors.textMain });
			}
		});
	});

	describe('Metric Mode Toggle', () => {
		it('defaults to count mode', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const countButton = screen.getByText('Count');
			expect(countButton).toHaveStyle({
				color: theme_3.colors.accent,
			});
		});

		it('switches to duration mode when clicked', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const durationButton = screen.getByText('Duration');
			fireEvent.click(durationButton);

			expect(durationButton).toHaveStyle({
				color: theme_3.colors.accent,
			});
		});

		it('updates legend values when switching modes', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// In count mode, should show count values
			expect(screen.getByText(/35$/)).toBeInTheDocument(); // Interactive: 35

			// Switch to duration mode
			fireEvent.click(screen.getByText('Duration'));

			// Should now show duration-based values
			// Legend text should update to show time values
			const legendTexts = screen.getAllByText(/•/);
			expect(legendTexts.length).toBeGreaterThan(0);
		});
	});

	describe('Chart Segments', () => {
		it('uses accent color for interactive segment', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			const fills = Array.from(paths).map((p) => (p as SVGPathElement).getAttribute('fill'));

			// Interactive segment should use accent color
			expect(fills).toContain(theme_3.colors.accent);
		});

		it('uses different color for auto segment', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			const fills = Array.from(paths)
				.map((p) => (p as SVGPathElement).getAttribute('fill'))
				.filter((f) => f !== null);

			// Should have 2 different colors
			expect(new Set(fills).size).toBe(2);
		});

		it('renders full donut for single source', () => {
			const { container } = render(
				<SourceDistributionChart data={interactiveOnlyData} theme={theme_3} />
			);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBe(1);
		});

		it('shows equal segments for 50/50 distribution', () => {
			render(<SourceDistributionChart data={equalDistributionData} theme={theme_3} />);

			// Both should show 50%
			const percentages = screen.getAllByText(/50\.0%/);
			expect(percentages.length).toBe(2);
		});
	});

	// Note: Tooltip functionality was removed in commit 287821dd
	// "Source distribution chart simplified by removing floating tooltip overlay"
	// The chart now uses legend highlighting on hover instead of a floating tooltip

	describe('Hover Effects', () => {
		it('expands segment on hover', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 0) {
				// Before hover, segment should have normal opacity
				expect(paths[0]).toHaveAttribute('opacity', '1');

				fireEvent.mouseEnter(paths[0]);

				// Hovered segment stays at opacity 1
				expect(paths[0]).toHaveAttribute('opacity', '1');

				// Other segment should dim
				if (paths.length > 1) {
					expect(paths[1]).toHaveAttribute('opacity', '0.5');
				}
			}
		});

		it('dims other segments when one is hovered', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 1) {
				fireEvent.mouseEnter(paths[0]);

				expect(paths[1]).toHaveAttribute('opacity', '0.5');
			}
		});

		it('restores opacity on mouse leave', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 1) {
				fireEvent.mouseEnter(paths[0]);
				fireEvent.mouseLeave(paths[0]);

				expect(paths[1]).toHaveAttribute('opacity', '1');
			}
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme_3.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const title = screen.getByText('Session Type');
			expect(title).toHaveStyle({
				color: theme_3.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<SourceDistributionChart data={mockData_1} theme={lightTheme} />);

			expect(screen.getByText('Session Type')).toBeInTheDocument();
		});

		it('applies border colors from theme', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Toggle buttons should have border
			const toggleContainer = container.querySelector('.flex.rounded.overflow-hidden.border');
			expect(toggleContainer).toHaveStyle({
				borderColor: theme_3.colors.border,
			});
		});

		it('center label uses theme text colors', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			// Find the center label container
			const centerLabel = container.querySelector('.absolute.inset-0');
			const mainText = centerLabel?.querySelector('.text-lg.font-semibold');
			const subText = centerLabel?.querySelector('.text-xs');

			expect(mainText).toHaveStyle({ color: theme_3.colors.textMain });
			expect(subText).toHaveStyle({ color: theme_3.colors.textDim });
		});
	});

	describe('Value Formatting', () => {
		it('formats large numbers with K suffix in center', () => {
			const largeData: StatsAggregation = {
				...mockData_1,
				bySource: { user: 5000, auto: 3000 },
			};

			render(<SourceDistributionChart data={largeData} theme={theme_3} />);

			expect(screen.getByText('8.0K')).toBeInTheDocument();
		});

		it('formats millions with M suffix', () => {
			const hugeData: StatsAggregation = {
				...mockData_1,
				bySource: { user: 1500000, auto: 500000 },
			};

			render(<SourceDistributionChart data={hugeData} theme={theme_3} />);

			expect(screen.getByText('2.0M')).toBeInTheDocument();
		});

		it('formats duration correctly in duration mode', () => {
			const durationData: StatsAggregation = {
				...mockData_1,
				totalDuration: 7200000, // 2 hours
				bySource: { user: 40, auto: 10 },
			};

			render(<SourceDistributionChart data={durationData} theme={theme_3} />);

			fireEvent.click(screen.getByText('Duration'));

			// Should show hours/minutes format
			expect(screen.getByText('time')).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles zero total gracefully', () => {
			render(<SourceDistributionChart data={emptyData_1} theme={theme_3} />);

			expect(screen.getByText('No source data available')).toBeInTheDocument();
		});

		it('handles very small percentages', () => {
			const skewedData: StatsAggregation = {
				...mockData_1,
				bySource: { user: 999, auto: 1 },
			};

			render(<SourceDistributionChart data={skewedData} theme={theme_3} />);

			// Should show 0.1% for auto
			expect(screen.getByText(/0\.1%/)).toBeInTheDocument();
		});

		it('handles very large percentages', () => {
			const skewedData: StatsAggregation = {
				...mockData_1,
				bySource: { user: 999, auto: 1 },
			};

			render(<SourceDistributionChart data={skewedData} theme={theme_3} />);

			// Should show 99.9% for interactive
			expect(screen.getByText(/99\.9%/)).toBeInTheDocument();
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to arc paths for smooth updates', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			// All arc paths should have transition styles
			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('d');
			expect(firstPath.style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('cubic-bezier');
		});

		it('applies opacity transition for hover effects', () => {
			const { container } = render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('opacity');
		});
	});

	describe('Cue slice (3-way breakdown)', () => {
		it('renders only Interactive and Auto Run when cueTotals is omitted', () => {
			render(<SourceDistributionChart data={mockData_1} theme={theme_3} />);

			expect(screen.getByText('Session Type')).toBeInTheDocument();
			expect(screen.getByText('Interactive')).toBeInTheDocument();
			expect(screen.getByText('Auto Run')).toBeInTheDocument();
			expect(screen.queryByText('Cue')).not.toBeInTheDocument();
		});

		it('adds a Cue slice and relabels the chart when cueTotals is provided', () => {
			render(
				<SourceDistributionChart
					data={mockData_1}
					theme={theme_3}
					cueTotals={{ occurrences: 15, totalDurationMs: 600000 }}
				/>
			);

			// Title switches from "Session Type" to the broader "Activity Source"
			expect(screen.getByText('Activity Source')).toBeInTheDocument();
			expect(screen.queryByText('Session Type')).not.toBeInTheDocument();
			expect(screen.getByText('Cue')).toBeInTheDocument();
		});

		it('hides the Cue slice (and keeps the Session Type title) when Cue is idle in range', () => {
			render(
				<SourceDistributionChart
					data={mockData_1}
					theme={theme_3}
					cueTotals={{ occurrences: 0, totalDurationMs: 0 }}
				/>
			);

			// Cue enabled but zero usage: zero-value slices are hidden, matching
			// the original two-way donut, so the chart looks unchanged.
			expect(screen.getByText('Session Type')).toBeInTheDocument();
			expect(screen.queryByText('Cue')).not.toBeInTheDocument();
		});

		it('includes Cue occurrences in the count total and percentages', () => {
			// user 35 + auto 15 + cue 50 = 100 total; Cue should read 50.0%
			render(
				<SourceDistributionChart
					data={mockData_1}
					theme={theme_3}
					cueTotals={{ occurrences: 50, totalDurationMs: 600000 }}
				/>
			);

			expect(screen.getByText('100')).toBeInTheDocument();
			expect(screen.getByText(/50\.0%/)).toBeInTheDocument();
		});

		it('treats an all-zero range with Cue enabled as having data', () => {
			render(
				<SourceDistributionChart
					data={emptyData_1}
					theme={theme_3}
					cueTotals={{ occurrences: 4, totalDurationMs: 120000 }}
				/>
			);

			// With Cue occurrences present, the empty-state message must not show.
			expect(screen.queryByText('No source data available')).not.toBeInTheDocument();
			expect(screen.getByText('Cue')).toBeInTheDocument();
		});
	});
});
