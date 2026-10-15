// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/renderer/components/UsageDashboard/EntityTile.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/UsageDashboardModalHooks.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/DurationTrendsChart.test.tsx
//   - src/__tests__/renderer/components/UsageDashboard/useQuotaRefresh.test.tsx

import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import { EntityTile } from '../../../../renderer/components/UsageDashboard/EntityTile';
import { useQuotaRefresh } from '../../../../renderer/components/UsageDashboard/quota/useQuotaRefresh';
import {
	useQuotaTabDiscovery,
	useUsageDashboardData,
	useUsageDashboardExport,
	useUsageDashboardLayout,
	useUsageDashboardTabs,
} from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/hooks';
import type { StatsAggregation as StatsAggregation_1 } from '../../../../renderer/hooks/stats/useStats';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../../renderer/stores/codexUsageStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';
import { mockTheme } from '../../../helpers/mockTheme';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React, { StrictMode, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => ({}));
const mockNotifyToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast: mockNotifyToast,
}));

// ===== from src/__tests__/renderer/components/UsageDashboard/EntityTile.test.tsx =====

const baseProps = {
	theme: mockTheme,
	testId: 'tile',
	title: 'Alpha',
	stats: [{ label: 'Queries', value: '7', testId: 'tile-queries' }],
	animationIndex: 0,
	ariaLabel: 'Alpha, 7 queries',
};

describe('EntityTile', () => {
	it('renders the title, stats, and accessible label', () => {
		render(<EntityTile {...baseProps} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('aria-label', 'Alpha, 7 queries');
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByTestId('tile-queries')).toHaveTextContent('7');
		expect(screen.getByText('Queries')).toBeInTheDocument();
	});

	it('stays a plain group until a click handler is supplied', () => {
		render(<EntityTile {...baseProps} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('role', 'group');
		expect(tile).not.toHaveAttribute('tabindex');
		expect(tile.dataset.clickable).toBeUndefined();
	});

	it('becomes a focusable button and fires on click, Enter, and Space', () => {
		const onClick = vi.fn();
		render(<EntityTile {...baseProps} onClick={onClick} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('role', 'button');
		expect(tile).toHaveAttribute('tabindex', '0');

		fireEvent.click(tile);
		fireEvent.keyDown(tile, { key: 'Enter' });
		fireEvent.keyDown(tile, { key: ' ' });
		expect(onClick).toHaveBeenCalledTimes(3);

		// A key the tile does not own must not activate it.
		fireEvent.keyDown(tile, { key: 'a' });
		expect(onClick).toHaveBeenCalledTimes(3);
	});

	describe('border states', () => {
		it('uses a plain border by default and dashes when asked', () => {
			const { rerender } = render(<EntityTile {...baseProps} />);
			expect(screen.getByTestId('tile').style.border).toContain('solid');

			rerender(<EntityTile {...baseProps} isDashed />);
			expect(screen.getByTestId('tile').style.border).toContain('dashed');
		});

		it('promotes to a thick accent border when selected, overriding the dash', () => {
			render(<EntityTile {...baseProps} isDashed isSelected />);

			const tile = screen.getByTestId('tile');
			expect(tile.style.border).toContain('2px');
			expect(tile.style.border).not.toContain('dashed');
			expect(tile.dataset.selected).toBe('true');
		});

		it('promotes on hover only while clickable, and never outranks selection', () => {
			const { rerender } = render(<EntityTile {...baseProps} isDashed onClick={vi.fn()} />);
			const tile = screen.getByTestId('tile');

			fireEvent.mouseEnter(tile);
			expect(tile.style.border).toContain('1px');
			expect(tile.style.border).not.toContain('dashed');

			fireEvent.mouseLeave(tile);
			expect(tile.style.border).toContain('dashed');

			rerender(<EntityTile {...baseProps} isDashed isSelected onClick={vi.fn()} />);
			fireEvent.mouseEnter(screen.getByTestId('tile'));
			expect(screen.getByTestId('tile').style.border).toContain('2px');
		});
	});

	describe('status dot', () => {
		it('is omitted when no color is given', () => {
			render(<EntityTile {...baseProps} />);
			expect(screen.queryByTestId('tile-status-dot')).toBeNull();
		});

		it('animates only when explicitly pulsing', () => {
			const { rerender } = render(<EntityTile {...baseProps} statusColor="#00ff00" />);
			expect(screen.getByTestId('tile-status-dot').style.animation).toBe('');

			rerender(<EntityTile {...baseProps} statusColor="#00ff00" statusPulsing />);
			expect(screen.getByTestId('tile-status-dot').style.animation).toContain('status-pulse');
		});
	});

	it('renders badges and the corner age, highlighting the age on request', () => {
		const { rerender } = render(
			<EntityTile
				{...baseProps}
				badges={[{ label: 'WT', testId: 'tile-wt' }]}
				age="3mo"
				ageTitle="Created yesterday"
			/>
		);

		expect(screen.getByTestId('tile-wt')).toHaveTextContent('WT');
		expect(screen.getByTestId('tile-age')).toHaveTextContent('3mo');
		expect(screen.getByTestId('tile-age')).toHaveAttribute('title', 'Created yesterday');
		expect(screen.getByTestId('tile-age').dataset.highlighted).toBeUndefined();

		rerender(<EntityTile {...baseProps} age="3mo" ageHighlighted />);
		expect(screen.getByTestId('tile-age').dataset.highlighted).toBe('true');
	});

	it('renders the subtitle only when provided', () => {
		const { rerender } = render(<EntityTile {...baseProps} subtitleTestId="tile-branch" />);
		expect(screen.queryByTestId('tile-branch')).toBeNull();

		rerender(<EntityTile {...baseProps} subtitle="feat/thing" subtitleTestId="tile-branch" />);
		expect(screen.getByTestId('tile-branch')).toHaveTextContent('feat/thing');
	});

	it('flags the highlighted stat so the sort key is visible on every tile', () => {
		render(
			<EntityTile
				{...baseProps}
				stats={[
					{ label: 'Queries', value: '7', testId: 'tile-queries', highlighted: true },
					{ label: 'Tabs', value: '2', testId: 'tile-tabs' },
					{ label: 'Auto %', value: '—', testId: 'tile-auto', muted: true },
				]}
			/>
		);

		expect(screen.getByTestId('tile-queries').dataset.highlighted).toBe('true');
		expect(screen.getByTestId('tile-tabs').dataset.highlighted).toBeUndefined();
		// A muted stat renders dim rather than in the main text color, so an
		// absent value never reads as a real zero.
		expect(screen.getByTestId('tile-auto').style.color).toBe(hexToRgb(mockTheme.colors.textDim));
		expect(screen.getByTestId('tile-tabs').style.color).toBe(hexToRgb(mockTheme.colors.textMain));
	});

	// A highlighted-but-muted stat must stay dim: accenting an absent value
	// would advertise it as the sort key's winner.
	it('keeps a muted stat dim even when it is the highlighted one', () => {
		render(
			<EntityTile
				{...baseProps}
				stats={[
					{ label: 'Auto %', value: '—', testId: 'tile-auto', highlighted: true, muted: true },
				]}
			/>
		);

		expect(screen.getByTestId('tile-auto').style.color).toBe(hexToRgb(mockTheme.colors.textDim));
	});

	it('staggers the enter animation by 60ms per tile', () => {
		render(<EntityTile {...baseProps} animationIndex={3} />);

		const tile = screen.getByTestId('tile');
		expect(tile.style.animationDelay).toBe('180ms');
		expect(tile.className).toContain('card-enter');
	});

	// Both grids can render far more tiles than the stagger was designed for.
	// Uncapped, the 100th agent card would sit blank for six seconds and a
	// full tab list for far longer, so the ramp plateaus instead.
	it('caps the stagger so a large grid does not leave late tiles blank', () => {
		const { rerender } = render(<EntityTile {...baseProps} animationIndex={12} />);
		expect(screen.getByTestId('tile').style.animationDelay).toBe('720ms');

		rerender(<EntityTile {...baseProps} animationIndex={375} />);
		expect(screen.getByTestId('tile').style.animationDelay).toBe('720ms');
	});

	describe('layout bands', () => {
		// The name is what the tile is for. Badges and the sparkline used to
		// flank it and squeeze it, so "Maestro Docs" truncated to "Ma..." on a
		// tile with room to spare; they now sit in their own band below.
		it('leaves the title row to the title, the status dot, and the age', () => {
			render(
				<EntityTile
					{...baseProps}
					statusColor="#00ff00"
					age="3mo"
					badges={[{ label: 'WT', testId: 'tile-wt' }]}
					sparkline={[1, 2, 3]}
				/>
			);

			const titleRow = screen.getByText('Alpha').parentElement!;
			expect(titleRow).toContainElement(screen.getByTestId('tile-status-dot'));
			expect(titleRow).toContainElement(screen.getByTestId('tile-age'));
			expect(titleRow).not.toContainElement(screen.getByTestId('tile-wt'));
			expect(titleRow.querySelector('[data-testid="sparkline"]')).toBeNull();
		});

		it('puts the sparkline on the badge row, above the stats', () => {
			render(
				<EntityTile
					{...baseProps}
					badges={[{ label: 'WT', testId: 'tile-wt' }]}
					sparkline={[1, 2, 3]}
				/>
			);

			const metaRow = screen.getByTestId('tile-wt').parentElement!;
			expect(metaRow.querySelector('[data-testid="sparkline"]')).not.toBeNull();
			// ...and the stats own the full width underneath rather than sharing
			// the row with the graph.
			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow).not.toContainElement(metaRow);
			expect(statRow.querySelector('[data-testid="sparkline"]')).toBeNull();
		});

		it('skips the badge row entirely when there is neither a badge nor a graph', () => {
			const { container } = render(<EntityTile {...baseProps} />);

			// Title row + stats row inside the bottom stack: no empty band in between.
			expect(container.querySelector('[data-testid="sparkline"]')).toBeNull();
			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.parentElement!.children).toHaveLength(1);
		});
	});

	describe('size variants', () => {
		const LONG_STATS = [
			{ label: 'Queries', value: '848' },
			{ label: 'Time', value: '142h 5m' },
			{ label: 'Tokens', value: '220.7M' },
			{ label: 'Cost', value: '$187.18' },
		];
		const renderLarge = () => render(<EntityTile {...baseProps} size="lg" stats={LONG_STATS} />);

		it('defaults to the standard size', () => {
			render(<EntityTile {...baseProps} />);

			expect(screen.getByTestId('tile')).toHaveAttribute('data-size', 'default');
		});

		it('marks a large tile so the group grid is distinguishable', () => {
			render(<EntityTile {...baseProps} size="lg" />);

			expect(screen.getByTestId('tile')).toHaveAttribute('data-size', 'lg');
		});

		it("lays a large tile's stats out as a grid rather than one flex row", () => {
			// Four stats in a single flex row is what ran a group's tokens and cost
			// together as "79.5M$65.99". The grid wraps instead of overlapping.
			render(
				<EntityTile
					{...baseProps}
					size="lg"
					stats={[
						{ label: 'Queries', value: '848' },
						{ label: 'Time', value: '96h 57m' },
						{ label: 'Tokens', value: '79.5M' },
						{ label: 'Cost', value: '$65.99' },
					]}
				/>
			);

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('grid');
			expect(statRow.className).not.toContain('flex items-end gap-3');
		});

		it('gives large stat columns enough floor width to not clip a value', () => {
			// The column, not the card, is what a stat value has to fit into: a
			// narrower floor clipped "142h 5m" to "142h 5…" inside a roomy tile.
			renderLarge();

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('minmax(104px,1fr)');
		});

		it('gives the default tile a grid too, with a narrower column floor', () => {
			// Three short stats in a flex row ran their labels together as
			// "QUERIESTABS AUTO %". Equal columns keep each stat in its own lane;
			// the floor is lower than the group tile's because the values are
			// counts rather than "142h 5m".
			render(
				<EntityTile
					{...baseProps}
					stats={[
						{ label: 'Queries', value: '5' },
						{ label: 'Tabs', value: '2' },
						{ label: 'Auto %', value: '7%' },
					]}
				/>
			);

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('grid');
			expect(statRow.className).toContain('minmax(72px,1fr)');
		});
	});
});

/** jsdom reports colors as `rgb(r, g, b)`; convert a theme hex for comparison. */
function hexToRgb(hex: string): string {
	const v = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
	return `rgb(${r}, ${g}, ${b})`;
}

// ===== from src/__tests__/renderer/components/UsageDashboard/UsageDashboardModalHooks.test.tsx =====

const sampleAggregation: StatsAggregation = {
	totalQueries: 2,
	totalDuration: 1000,
	avgDuration: 500,
	queryDurationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
	queryDurationPercentilesByAgent: {},
	autoRunTaskDurationPercentiles: {
		count: 0,
		min: 0,
		p50: 0,
		p75: 0,
		p90: 0,
		p95: 0,
		p99: 0,
		max: 0,
	},
	byAgent: { codex: { count: 2, duration: 1000 } },
	bySource: { user: 1, auto: 1 },
	byLocation: { local: 2, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 1,
	sessionsByAgent: { codex: 1 },
	sessionsByDay: [],
	avgSessionDuration: 1000,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	worktreeQueries: 0,
	parentQueries: 2,
	byWorktreeStatus: {
		worktree: { count: 0, duration: 0 },
		parent: { count: 2, duration: 1000 },
	},
	imageAnnotations: 0,
};

const mockGetAggregation = vi.fn();

const mockGetDelegationTotals = vi.fn().mockResolvedValue({
	interactive: { count: 0, durationMs: 0 },
	autoRun: { count: 0, durationMs: 0 },
	cue: { count: 0, durationMs: 0 },
});

const mockGetDelegationByDay = vi.fn().mockResolvedValue([]);

const mockGetDatabaseSize = vi.fn();

const mockOnStatsUpdate = vi.fn();

const mockCueAggregation = vi.fn();

const mockSaveFile = vi.fn();

const mockExportUsage = vi.fn();

const mockWriteFile = vi.fn();

const mockRefreshClaudeUsageSnapshots = vi.fn();

const mockRefreshCodexUsageSnapshots = vi.fn();

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function installMaestroMock() {
	let statsUpdateHandler: (() => void) | undefined;
	mockOnStatsUpdate.mockImplementation((handler: () => void) => {
		statsUpdateHandler = handler;
		return vi.fn();
	});

	Object.defineProperty(window, 'maestro', {
		value: {
			stats: {
				getAggregation: mockGetAggregation,
				getDelegationTotals: mockGetDelegationTotals,
				getDelegationByDay: mockGetDelegationByDay,
				getDatabaseSize: mockGetDatabaseSize,
				onStatsUpdate: mockOnStatsUpdate,
				exportUsage: mockExportUsage,
			},
			cueStats: {
				getAggregation: mockCueAggregation,
			},
			dialog: {
				saveFile: mockSaveFile,
			},
			fs: {
				writeFile: mockWriteFile,
			},
			agents: {
				refreshClaudeUsageSnapshots: mockRefreshClaudeUsageSnapshots,
				refreshCodexUsageSnapshots: mockRefreshCodexUsageSnapshots,
			},
		},
		writable: true,
	});

	return {
		emitStatsUpdate: () => statsUpdateHandler?.(),
	};
}

describe('UsageDashboardModal hooks', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		useUIStore.setState({ usageDashboardViewMode: 'overview' });
		useClaudeUsageStore.getState().__resetForTests();
		useCodexUsageStore.getState().__resetForTests();
		mockGetAggregation.mockResolvedValue(sampleAggregation);
		mockGetDelegationTotals.mockResolvedValue({
			interactive: { count: 4, durationMs: 40000 },
			autoRun: { count: 2, durationMs: 30000 },
			cue: { count: 1, durationMs: 30000 },
		});
		mockGetDelegationByDay.mockResolvedValue([]);
		mockGetDatabaseSize.mockResolvedValue(4096);
		mockCueAggregation.mockResolvedValue({
			totals: { occurrences: 3, totalDurationMs: 1200 },
		});
		mockSaveFile.mockResolvedValue('/tmp/usage.json');
		mockExportUsage.mockResolvedValue({
			path: '/tmp/usage.json',
			format: 'json',
			rowCounts: { 'query-events': 2, 'wizard-runs': 1 },
			notes: [],
		});
		mockWriteFile.mockResolvedValue(undefined);
		mockRefreshClaudeUsageSnapshots.mockResolvedValue({ refreshed: 1 });
		mockRefreshCodexUsageSnapshots.mockResolvedValue({ refreshed: 1 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('loads usage data, Cue totals, and debounces realtime refresh indicators', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		const { result } = renderHook(() =>
			useUsageDashboardData({
				isOpen: true,
				timeRange: 'week',
				cueTabEnabled: true,
			})
		);

		await flushPromises();
		expect(result.current.loading).toBe(false);
		expect(result.current.data).toBe(sampleAggregation);
		expect(result.current.databaseSize).toBe(4096);
		expect(result.current.cueSourceTotals).toEqual({
			occurrences: 3,
			totalDurationMs: 1200,
			// Cue token totals feed the Source Distribution chart's Tokens mode; this
			// fixture's Cue aggregate reports none.
			tokens: 0,
		});

		mockGetAggregation.mockClear();
		act(() => controls.emitStatsUpdate());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(999);
		});
		expect(mockGetAggregation).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		await flushPromises();
		expect(mockGetAggregation).toHaveBeenCalledTimes(1);
		expect(result.current.showNewDataIndicator).toBe(true);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(result.current.showNewDataIndicator).toBe(false);
	});

	it('clears realtime indicator timers on unmount', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		const { unmount } = renderHook(() =>
			useUsageDashboardData({
				isOpen: true,
				timeRange: 'week',
				cueTabEnabled: true,
			})
		);

		await flushPromises();
		act(() => controls.emitStatsUpdate());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await flushPromises();
		expect(vi.getTimerCount()).toBe(1);

		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('persists tabs, appends dynamic tabs, and falls back from disabled tabs', async () => {
		installMaestroMock();
		useUIStore.setState({ usageDashboardViewMode: 'cue' });
		const content = document.createElement('div');
		content.scrollTop = 24;
		const onViewModeChanged = vi.fn();

		const { result } = renderHook(() =>
			useUsageDashboardTabs({
				cueTabEnabled: false,
				hasAnthropicUsageDetails: true,
				hasCodexUsageDetails: true,
				contentRef: { current: content },
				onViewModeChanged,
			})
		);

		await waitFor(() => expect(result.current.viewMode).toBe('overview'));
		expect(result.current.viewModeTabs.map((tab) => tab.value)).toEqual([
			'overview',
			'agent-overview',
			'agents',
			'groups',
			'tokens',
			'activity',
			'autorun',
			'shortcuts',
			'anthropic-usage',
			'codex-usage',
		]);

		act(() => result.current.switchViewMode('activity'));
		expect(useUIStore.getState().usageDashboardViewMode).toBe('activity');
		expect(content.scrollTop).toBe(0);
		expect(onViewModeChanged).toHaveBeenCalled();
	});

	it('derives responsive layout columns from ResizeObserver width', async () => {
		installMaestroMock();
		let observerCallback: ResizeObserverCallback | undefined;
		const disconnect = vi.fn();
		const observe = vi.fn();
		const originalResizeObserver = globalThis.ResizeObserver;
		class MockResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				observerCallback = callback;
			}

			observe = observe;
			disconnect = disconnect;
		}
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

		const content = document.createElement('div');
		Object.defineProperty(content, 'offsetWidth', { value: 580, configurable: true });

		const { result, unmount } = renderHook(() =>
			useUsageDashboardLayout(true, { current: content })
		);

		await waitFor(() => expect(result.current.chartGridCols).toBe(1));
		expect(result.current.summaryCardsCols).toBe(2);
		expect(result.current.isTiny).toBe(false);

		// Phone width: a rung below `isNarrow`. Two metric cards in a ~340px
		// column leave each about 90px of text, and the Auto Run tiles TRUNCATE
		// their value rather than wrapping it ("4h 3…").
		Object.defineProperty(content, 'offsetWidth', { value: 340, configurable: true });
		act(() => observerCallback?.([], {} as ResizeObserver));
		await waitFor(() => expect(result.current.isTiny).toBe(true));
		expect(result.current.summaryCardsCols).toBe(1);
		expect(result.current.autoRunStatsCols).toBe(1);

		Object.defineProperty(content, 'offsetWidth', { value: 920, configurable: true });
		act(() => observerCallback?.([], {} as ResizeObserver));
		await waitFor(() => expect(result.current.autoRunStatsCols).toBe(6));

		unmount();
		expect(disconnect).toHaveBeenCalled();
		globalThis.ResizeObserver = originalResizeObserver;
	});

	it('exports through the save dialog and reports where the file went', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 6, 1, 12, 0, 0));
		installMaestroMock();
		const { result } = renderHook(() => useUsageDashboardExport('month'));

		await act(async () => {
			await result.current.handleExport('json');
		});

		expect(mockSaveFile).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultPath: 'maestro-usage-month-20260701-120000.json',
				filters: [{ name: 'JSON', extensions: ['json'] }],
			})
		);
		expect(mockExportUsage).toHaveBeenCalledWith('month', 'json', '/tmp/usage.json');
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'green', message: '3 rows saved to /tmp/usage.json.' })
		);
		expect(result.current.isExporting).toBe(false);

		mockSaveFile.mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.handleExport('csv');
		});
		expect(mockSaveFile).toHaveBeenLastCalledWith(
			expect.objectContaining({ filters: [{ name: 'Zip of CSV files', extensions: ['zip'] }] })
		);
		expect(mockExportUsage).toHaveBeenCalledTimes(1);
	});

	it('reports a failed export instead of failing silently', async () => {
		installMaestroMock();
		mockExportUsage.mockRejectedValueOnce(new Error('disk full'));
		const { result } = renderHook(() => useUsageDashboardExport('week'));

		await act(async () => {
			await result.current.handleExport('csv');
		});

		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'disk full' })
		);
		expect(result.current.isExporting).toBe(false);
	});

	it('samples quota tabs once per open and skips when disabled', async () => {
		installMaestroMock();
		const { rerender } = renderHook(
			({ isOpen, enabled }) => useQuotaTabDiscovery(isOpen, enabled),
			{ initialProps: { isOpen: true, enabled: true } }
		);

		await waitFor(() => expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1));
		expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1);

		rerender({ isOpen: true, enabled: true });
		expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1);

		rerender({ isOpen: false, enabled: true });
		rerender({ isOpen: true, enabled: false });
		expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1);
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/DurationTrendsChart.test.tsx =====

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation_1 = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 }, // avg: 60s
		{ date: '2024-12-21', count: 10, duration: 600000 }, // avg: 60s
		{ date: '2024-12-22', count: 3, duration: 180000 }, // avg: 60s
		{ date: '2024-12-23', count: 8, duration: 480000 }, // avg: 60s
		{ date: '2024-12-24', count: 12, duration: 960000 }, // avg: 80s
		{ date: '2024-12-25', count: 4, duration: 120000 }, // avg: 30s
		{ date: '2024-12-26', count: 7, duration: 420000 }, // avg: 60s
		{ date: '2024-12-27', count: 5, duration: 300000 }, // avg: 60s
	],
};

// Data with varying durations to test intensity
const varyingData: StatsAggregation_1 = {
	totalQueries: 100,
	totalDuration: 7200000,
	avgDuration: 72000,
	byAgent: {
		'claude-code': { count: 100, duration: 7200000 },
	},
	bySource: { user: 80, auto: 20 },
	byDay: [
		{ date: '2024-12-20', count: 10, duration: 300000 }, // 30s avg
		{ date: '2024-12-21', count: 10, duration: 600000 }, // 60s avg
		{ date: '2024-12-22', count: 10, duration: 1200000 }, // 120s avg
		{ date: '2024-12-23', count: 10, duration: 1800000 }, // 180s avg
		{ date: '2024-12-24', count: 10, duration: 600000 }, // 60s avg
		{ date: '2024-12-25', count: 10, duration: 900000 }, // 90s avg
		{ date: '2024-12-26', count: 10, duration: 300000 }, // 30s avg
	],
};

// Empty data for edge case testing
const emptyData: StatsAggregation_1 = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [],
};

// Data with zero counts (should handle division by zero)
const zeroCountData: StatsAggregation_1 = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [
		{ date: '2024-12-20', count: 0, duration: 0 },
		{ date: '2024-12-21', count: 0, duration: 0 },
		{ date: '2024-12-22', count: 0, duration: 0 },
	],
};

// Single data point
const singlePointData: StatsAggregation_1 = {
	totalQueries: 5,
	totalDuration: 300000,
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 5, duration: 300000 },
	},
	bySource: { user: 5, auto: 0 },
	byDay: [{ date: '2024-12-27', count: 5, duration: 300000 }],
};

describe('DurationTrendsChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders smoothing toggle', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Smoothing:')).toBeInTheDocument();
		});

		it('renders SVG chart element', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders data points as circles', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(mockData.byDay.length);
		});

		it('renders line path', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Should have area path and line path
			expect(paths.length).toBeGreaterThanOrEqual(2);
		});

		it('renders Y-axis label', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders legend', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
		});
	});

	describe('Empty State', () => {
		it('renders empty state message when no data', () => {
			render(<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />);

			expect(screen.getByText('No duration data available')).toBeInTheDocument();
		});

		it('does not render SVG when no data', () => {
			const { container } = render(
				<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />
			);

			const svg = container.querySelector('svg');
			expect(svg).not.toBeInTheDocument();
		});
	});

	describe('Smoothing Toggle', () => {
		it('defaults to smoothing off', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			// Legend should show "Avg Duration" not "Moving Average"
			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
			expect(screen.queryByText('Moving Average')).not.toBeInTheDocument();
		});

		it('toggles smoothing on when clicked', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			fireEvent.click(toggleButton);

			// Legend should now show "Moving Average"
			expect(screen.getByText('Moving Average')).toBeInTheDocument();
		});

		it('shows window size when smoothing is on', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			fireEvent.click(toggleButton);

			expect(screen.getByText(/Window: \d+ periods/)).toBeInTheDocument();
		});

		it('toggles smoothing off when clicked again', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });

			// Turn on
			fireEvent.click(toggleButton);
			expect(screen.getByText('Moving Average')).toBeInTheDocument();

			// Turn off
			fireEvent.click(toggleButton);
			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
		});
	});

	describe('Time Range Handling', () => {
		it('renders for day time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="day" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for week time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for month time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="month" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for year time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="year" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for all time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="all" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const title = screen.getByText('Duration Trends');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('uses theme accent color for line', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Find the main line path (has stroke and no fill)
			const paths = container.querySelectorAll('path');
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('fill') === 'none' && p.getAttribute('stroke')
			);

			expect(linePath).toHaveAttribute('stroke', theme.colors.accent);
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<DurationTrendsChart data={mockData} timeRange="week" theme={lightTheme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('applies border color to toggle button', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			expect(toggleButton).toHaveStyle({
				backgroundColor: expect.stringMatching(/^(rgb|#)/),
			});
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on data point hover', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				// Tooltip should appear with date
				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.shadow-lg');
				expect(tooltip).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);
				fireEvent.mouseLeave(circles[0]);

				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.shadow-lg');
				expect(tooltip).not.toBeInTheDocument();
			}
		});

		it('tooltip shows query count', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				expect(screen.getByText('Queries:')).toBeInTheDocument();
			}
		});

		it('tooltip shows avg duration label', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				expect(screen.getByText('Avg Duration:')).toBeInTheDocument();
			}
		});
	});

	describe('Edge Cases', () => {
		it('handles single data point', () => {
			const { container } = render(
				<DurationTrendsChart data={singlePointData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(1);
		});

		it('handles zero count days gracefully', () => {
			const { container } = render(
				<DurationTrendsChart data={zeroCountData} timeRange="week" theme={theme} />
			);

			// Should render without errors
			expect(screen.getByText('Duration Trends')).toBeInTheDocument();

			// Should have 3 data points even with zero counts
			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(3);
		});

		it('handles varying duration data', () => {
			const { container } = render(
				<DurationTrendsChart data={varyingData} timeRange="week" theme={theme} />
			);

			// Should render all data points
			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(varyingData.byDay.length);
		});
	});

	describe('Grid and Axes', () => {
		it('renders horizontal grid lines', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const gridLines = container.querySelectorAll('line');
			expect(gridLines.length).toBeGreaterThan(0);
		});

		it('renders Y-axis tick labels', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Y-axis should have duration labels (0s, etc.)
			const textElements = container.querySelectorAll('text');
			const hasYLabel = Array.from(textElements).some((el) =>
				el.textContent?.match(/^\d+(s|m|h)$/)
			);
			expect(hasYLabel).toBe(true);
		});

		it('renders X-axis date labels', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Should have date labels (day abbreviations for week view)
			const textElements = container.querySelectorAll('text');
			const hasDateLabels = Array.from(textElements).some((el) =>
				el.textContent?.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
			);
			expect(hasDateLabels).toBe(true);
		});
	});

	describe('Area Fill', () => {
		it('renders gradient-filled area under line', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Should have a linearGradient defined
			const gradient = container.querySelector('linearGradient');
			expect(gradient).toBeInTheDocument();

			// Should have a path using the gradient
			const paths = container.querySelectorAll('path');
			const areaPath = Array.from(paths).find((p) =>
				p.getAttribute('fill')?.includes('url(#duration-gradient')
			);
			expect(areaPath).toBeInTheDocument();
		});
	});

	describe('Data Point Interaction', () => {
		it('enlarges data point on hover', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				const initialRadius = circles[0].getAttribute('r');
				fireEvent.mouseEnter(circles[0]);
				const hoveredRadius = circles[0].getAttribute('r');

				expect(parseInt(hoveredRadius || '0')).toBeGreaterThan(parseInt(initialRadius || '0'));
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to line path for smooth updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Find the main line path (has stroke but no fill)
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
			);

			expect(linePath).toBeInTheDocument();
			const style = (linePath as HTMLElement).style;
			expect(style.transition).toContain('d');
			expect(style.transition).toContain('0.5s');
		});

		it('applies CSS transitions to area path for smooth updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Find the area path (has gradient fill)
			const areaPath = Array.from(paths).find((p) =>
				p.getAttribute('fill')?.includes('url(#duration-gradient')
			);

			expect(areaPath).toBeInTheDocument();
			const style = (areaPath as HTMLElement).style;
			expect(style.transition).toContain('d');
			expect(style.transition).toContain('0.5s');
		});

		it('applies CSS transitions to data points for smooth position updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBeGreaterThan(0);

			const style = (circles[0] as unknown as HTMLElement).style;
			expect(style.transition).toContain('cx');
			expect(style.transition).toContain('cy');
			expect(style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
			);

			const style = (linePath as HTMLElement).style;
			expect(style.transition).toContain('cubic-bezier');
		});
	});
});

// ===== from src/__tests__/renderer/components/UsageDashboard/useQuotaRefresh.test.tsx =====

describe('useQuotaRefresh', () => {
	afterEach(() => {
		vi.useRealTimers();
		useUIStore.setState({ usageRefreshIntervals: {} });
	});

	it('settles an in-flight refresh after unmount without a late state update', async () => {
		vi.useFakeTimers();
		const doRefresh = vi.fn().mockResolvedValue(undefined);

		const { result, unmount } = renderHook(() =>
			useQuotaRefresh({
				providerId: 'claude-code',
				refreshing: false,
				autoRefresh: false,
				accountCount: 0,
				snapshotCount: 0,
				doRefresh,
			})
		);

		let refreshPromise!: Promise<void>;
		act(() => {
			refreshPromise = result.current.handleRefresh();
		});
		expect(result.current.isBusy).toBe(true);

		await Promise.resolve();
		unmount();

		await vi.advanceTimersByTimeAsync(900);
		await expect(refreshPromise).resolves.toBeUndefined();
		expect(doRefresh).toHaveBeenCalledTimes(1);
	});

	it('recovers visual busy state after a StrictMode effect remount', async () => {
		vi.useFakeTimers();
		const doRefresh = vi.fn().mockResolvedValue(undefined);
		const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
		let refreshPromise!: Promise<void>;

		const useAutoStartedQuotaRefresh = () => {
			const refresh = useQuotaRefresh({
				providerId: 'claude-code',
				refreshing: false,
				autoRefresh: false,
				accountCount: 0,
				snapshotCount: 0,
				doRefresh,
			});
			const startedRef = useRef(false);

			useEffect(() => {
				if (startedRef.current) return;
				startedRef.current = true;
				refreshPromise = refresh.handleRefresh();
			}, [refresh]);

			return refresh;
		};

		const { result } = renderHook(() => useAutoStartedQuotaRefresh(), { wrapper });
		expect(result.current.isBusy).toBe(true);

		await Promise.resolve();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(900);
			await refreshPromise;
		});

		expect(result.current.isBusy).toBe(false);
		expect(doRefresh).toHaveBeenCalledTimes(1);
	});
});
