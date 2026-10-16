/**
 * Tests for ThroughputGaugeHost: nothing exists while the `throughputGauge`
 * Encore Feature is off, a mid-session flip on subscribes and pops the card up,
 * the close latch survives a remount, live process events move the published
 * needle, and the capture loop honors the scope, window, and metric settings.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThroughputGaugeHost } from '../../../../renderer/components/ThroughputGauge';
import {
	THROUGHPUT_PUBLISH_MS,
	throughputTracker,
} from '../../../../renderer/components/ThroughputGauge/useThroughputCapture';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	THROUGHPUT_GAUGE_VISIBLE_KEY,
	useThroughputGaugeStore,
} from '../../../../renderer/stores/throughputGaugeStore';
import { ENCORE_FEATURE_DEFAULTS } from '../../../../shared/encoreFeatureDefaults';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	type ThroughputGaugeSettings,
} from '../../../../shared/throughputGauge';
import type { UsageStats } from '../../../../shared/types';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const ZERO = { in: 0, out: 0, combined: 0 };
const AI_TAB_ID = 'agent-1-ai-tab-1';

type DataHandler = (sessionId: string, data: string) => void;
type UsageHandler = (sessionId: string, usage: UsageStats) => void;
type ExitHandler = (sessionId: string, code: number) => void;

/** The `process.*` subscriptions the host makes, each returning its own unsubscribe spy. */
function makeProcessListeners() {
	const unsubscribes = {
		onData: vi.fn(),
		onThinkingChunk: vi.fn(),
		onUsage: vi.fn(),
		onExit: vi.fn(),
	};
	return {
		unsubscribes,
		onData: vi.fn((_handler: DataHandler) => unsubscribes.onData),
		onThinkingChunk: vi.fn((_handler: DataHandler) => unsubscribes.onThinkingChunk),
		onUsage: vi.fn((_handler: UsageHandler) => unsubscribes.onUsage),
		onExit: vi.fn((_handler: ExitHandler) => unsubscribes.onExit),
	};
}

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	};
}

function setGaugeSettings(patch: Partial<ThroughputGaugeSettings>) {
	useSettingsStore.setState({
		throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, ...patch },
	});
}

function setFlag(enabled: boolean, settingsLoaded = true) {
	useSettingsStore.setState({
		settingsLoaded,
		encoreFeatures: { ...ENCORE_FEATURE_DEFAULTS, throughputGauge: enabled },
	});
}

describe('ThroughputGaugeHost', () => {
	let storage: Map<string, string>;
	let listeners: ReturnType<typeof makeProcessListeners>;
	const processApi = window.maestro.process as unknown as Record<string, unknown>;
	const originals = {
		onData: processApi.onData,
		onThinkingChunk: processApi.onThinkingChunk,
		onUsage: processApi.onUsage,
		onExit: processApi.onExit,
	};

	beforeEach(() => {
		storage = installLocalStorageMock();
		listeners = makeProcessListeners();
		Object.assign(processApi, {
			onData: listeners.onData,
			onThinkingChunk: listeners.onThinkingChunk,
			onUsage: listeners.onUsage,
			onExit: listeners.onExit,
		});
		throughputTracker.clear();
		useThroughputGaugeStore.setState({
			visible: true,
			rates: ZERO,
			peak: ZERO,
			history: [],
			historyMetric: 'combined',
		});
		setGaugeSettings({});
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-1', name: 'Backend' }),
				createMockSession({ id: 'agent-2', name: 'Frontend' }),
			],
			activeSessionId: 'agent-1',
		});
		setFlag(false);
	});

	afterEach(() => {
		Object.assign(processApi, originals);
		vi.useRealTimers();
	});

	it('renders nothing and subscribes to nothing while the flag is off', () => {
		const { container } = render(<ThroughputGaugeHost theme={mockTheme} />);

		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(listeners.onData).not.toHaveBeenCalled();
		expect(listeners.onThinkingChunk).not.toHaveBeenCalled();
		expect(listeners.onUsage).not.toHaveBeenCalled();
		expect(listeners.onExit).not.toHaveBeenCalled();
	});

	it('flipping the flag on subscribes and pops the gauge up, even after a close', () => {
		useThroughputGaugeStore.setState({ visible: false });
		render(<ThroughputGaugeHost theme={mockTheme} />);

		act(() => setFlag(true));

		expect(listeners.onData).toHaveBeenCalledTimes(1);
		expect(listeners.onThinkingChunk).toHaveBeenCalledTimes(1);
		expect(listeners.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.onExit).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('floating-throughput-gauge')).toBeInTheDocument();
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('the close button hides the card but keeps capturing', () => {
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);

		fireEvent.click(screen.getByTestId('throughput-gauge-close'));

		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('false');
		expect(listeners.unsubscribes.onData).not.toHaveBeenCalled();
	});

	it('honors the persisted close on remount with the flag already on', () => {
		setFlag(true);
		const first = render(<ThroughputGaugeHost theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('throughput-gauge-close'));
		first.unmount();

		render(<ThroughputGaugeHost theme={mockTheme} />);

		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(useThroughputGaugeStore.getState().visible).toBe(false);
	});

	it('treats the first value after settings load as the launch state, not a flip', () => {
		useThroughputGaugeStore.setState({ visible: false });
		setFlag(false, false);
		render(<ThroughputGaugeHost theme={mockTheme} />);

		// Settings arrive with the feature already on: the user's close stands.
		act(() => setFlag(true, true));

		expect(listeners.onData).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
	});

	it('turning the flag off unsubscribes every listener and drops the needle', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		useThroughputGaugeStore.setState({ rates: { in: 5, out: 5, combined: 10 } });

		act(() => setFlag(false));

		expect(listeners.unsubscribes.onData).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onThinkingChunk).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onExit).toHaveBeenCalledTimes(1);
		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('live output and usage move the published rate above zero and record a peak', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onData = listeners.onData.mock.calls[0][0];
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onData(AI_TAB_ID, 'x'.repeat(400));
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		const { rates, peak, history } = useThroughputGaugeStore.getState();
		expect(rates.in).toBeGreaterThan(0);
		expect(rates.out).toBeGreaterThan(0);
		expect(rates.combined).toBeCloseTo(rates.in + rates.out);
		expect(peak.combined).toBe(rates.combined);
		expect(history[history.length - 1]).toBe(rates.combined);
		expect(screen.getByTestId('throughput-dial-reading').textContent).not.toBe('0');
	});

	it('with scope active, output from another agent does not move the rate', () => {
		vi.useFakeTimers();
		setGaugeSettings({ scope: 'active' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		// 1300 tokens from the active agent over the default 10s window.
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
		expect(screen.getByTestId('throughput-dial-caption').textContent).toBe('Combined, Backend');
	});

	it('with scope all, every agent counts', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
		expect(screen.getByTestId('throughput-dial-caption').textContent).toBe('Combined, all agents');
	});

	it('averages over the chosen window and resets the peak when the window changes', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 500 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().peak.combined).toBeCloseTo(150);

		act(() => {
			setGaugeSettings({ windowMs: 30000 });
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		// Same 1500 tokens over 30s; the 10s peak is gone, not carried over.
		const { rates, peak, history } = useThroughputGaugeStore.getState();
		expect(rates.combined).toBeCloseTo(50);
		expect(peak.combined).toBeCloseTo(50);
		expect(history).toEqual([rates.combined]);
	});

	it('changing the scope also resets the peak, keeping the same listeners', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().peak.combined).toBeCloseTo(100);

		act(() => {
			setGaugeSettings({ scope: 'active' });
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().peak).toEqual(ZERO);
		expect(listeners.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onUsage).not.toHaveBeenCalled();
	});

	it('shows the chosen metric and records its history', () => {
		vi.useFakeTimers();
		setGaugeSettings({ metric: 'out' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		const { rates, history, historyMetric } = useThroughputGaugeStore.getState();
		expect(historyMetric).toBe('out');
		expect(history).toEqual([rates.out]);
		expect(screen.getByTestId('throughput-dial-reading').textContent).toBe('30');
		expect(screen.getByTestId('throughput-dial-caption').textContent).toBe('Out, all agents');
	});

	it('ignores command-terminal output', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onData = listeners.onData.mock.calls[0][0];

		act(() => {
			onData('agent-1-terminal', 'x'.repeat(4000));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);
		expect(throughputTracker.sampleCount()).toBe(0);
	});
});
