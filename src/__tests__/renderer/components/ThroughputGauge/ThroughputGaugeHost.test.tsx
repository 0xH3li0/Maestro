/**
 * Tests for ThroughputGaugeHost: nothing exists while the `throughputGauge`
 * Encore Feature is off, a mid-session flip on subscribes and pops the card up,
 * the close latch survives a remount, live process events move the published
 * needle, the capture loop honors the scope, window, and metric settings, and
 * the card's position and size persist on drag or resize end, come back on
 * remount, and are pulled into a smaller window.
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
	THROUGHPUT_GAUGE_RECTS_KEY,
	THROUGHPUT_GAUGE_VISIBLE_KEY,
	useThroughputGaugeStore,
} from '../../../../renderer/stores/throughputGaugeStore';
import {
	GAUGE_CLAMP_MARGIN,
	GAUGE_DEFAULT_SIZE,
	GAUGE_EDGE_MARGIN,
	GAUGE_INPUT_AREA_CLEARANCE,
} from '../../../../renderer/components/ThroughputGauge/gaugeGeometry';
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
			history: { in: [], out: [], combined: [] },
			rects: {},
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
		// The test setup's ResizeObserver mock reports on a setTimeout; let the
		// card's toast avoid zone take its first report so only the gauge's own
		// timers are left to count.
		act(() => vi.runOnlyPendingTimers());

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
		expect(history.combined[history.combined.length - 1]).toBe(rates.combined);
		expect(screen.getByTestId('throughput-gauge-reading').textContent).not.toBe('0');
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
		expect(screen.getByTestId('throughput-gauge-label').textContent).toBe('Combined');
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('Backend');
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
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('all agents');
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
		expect(history.combined).toEqual([rates.combined]);
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

	it("shows the chosen metric and records every metric's history", () => {
		vi.useFakeTimers();
		setGaugeSettings({ metric: 'out' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		const { rates, history } = useThroughputGaugeStore.getState();
		expect(history).toEqual({ in: [rates.in], out: [rates.out], combined: [rates.combined] });
		expect(screen.getByTestId('throughput-gauge-reading').textContent).toBe('30');
		expect(screen.getByTestId('throughput-gauge-label').textContent).toBe('Out');
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('all agents');
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

	describe('remembered geometry', () => {
		const VIEWPORT = { width: 1024, height: 768 };
		const SIZE = GAUGE_DEFAULT_SIZE.single;
		const INITIAL = {
			left: GAUGE_EDGE_MARGIN,
			top: VIEWPORT.height - SIZE.height - GAUGE_INPUT_AREA_CLEARANCE,
			...SIZE,
		};
		const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
		const originalCapture = {
			set: prototype.setPointerCapture,
			release: prototype.releasePointerCapture,
		};

		/** A pointer event jsdom can dispatch: a MouseEvent carrying a pointer id. */
		function pointer(type: string, clientX: number, clientY: number): MouseEvent {
			const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
			Object.defineProperty(event, 'pointerId', { value: 1 });
			return event;
		}

		function drag(handle: Element, dx: number, dy: number) {
			act(() => {
				handle.dispatchEvent(pointer('pointerdown', 100, 100));
				window.dispatchEvent(pointer('pointermove', 100 + dx / 2, 100 + dy / 2));
				window.dispatchEvent(pointer('pointermove', 100 + dx, 100 + dy));
			});
		}

		function release() {
			act(() => {
				window.dispatchEvent(pointer('pointerup', 0, 0));
			});
		}

		function setViewport(width: number, height: number) {
			Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
			Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
		}

		function cardRect() {
			const card = screen.getByTestId('floating-throughput-gauge');
			return {
				left: parseFloat(card.style.left),
				top: parseFloat(card.style.top),
				width: parseFloat(card.style.width),
				height: parseFloat(card.style.height),
			};
		}

		function storedRects() {
			const raw = storage.get(THROUGHPUT_GAUGE_RECTS_KEY);
			return raw ? JSON.parse(raw) : undefined;
		}

		beforeEach(() => {
			prototype.setPointerCapture = vi.fn();
			prototype.releasePointerCapture = vi.fn();
			setViewport(VIEWPORT.width, VIEWPORT.height);
			// No custom title strip, so the numbers below are the plain viewport's.
			useSettingsStore.setState({ useNativeTitleBar: true });
			setFlag(true);
		});

		afterEach(() => {
			prototype.setPointerCapture = originalCapture.set;
			prototype.releasePointerCapture = originalCapture.release;
		});

		it('opens bottom-left above the composer with nothing stored', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(INITIAL);
		});

		it('persists the rect when a drag ends, not while it moves', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);

			drag(screen.getByTestId('throughput-gauge-drag-handle'), 100, -50);
			const moved = { ...INITIAL, left: INITIAL.left + 100, top: INITIAL.top - 50 };
			expect(cardRect()).toEqual(moved);
			expect(storedRects()).toBeUndefined();

			release();
			expect(storedRects()).toEqual({ single: moved });
			expect(useThroughputGaugeStore.getState().rects.single).toEqual(moved);
		});

		it('persists the size when a resize from the grip ends', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);

			drag(screen.getByTestId('modal-resize-grip'), 60, 30);
			release();

			const resized = { ...INITIAL, width: SIZE.width + 60, height: SIZE.height + 30 };
			expect(cardRect()).toEqual(resized);
			expect(storedRects()).toEqual({ single: resized });
		});

		it('restores the remembered rect on remount', () => {
			const first = render(<ThroughputGaugeHost theme={mockTheme} />);
			drag(screen.getByTestId('throughput-gauge-drag-handle'), 200, -100);
			release();
			const saved = cardRect();
			first.unmount();

			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(saved);
		});

		it('clamps a stored rect from a bigger window back into a smaller one', () => {
			useThroughputGaugeStore.setState({
				rects: { single: { left: 1800, top: 1200, width: 300, height: 260 } },
			});
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(cardRect()).toEqual({
				left: VIEWPORT.width - GAUGE_CLAMP_MARGIN - 300,
				top: VIEWPORT.height - GAUGE_CLAMP_MARGIN - 260,
				width: 300,
				height: 260,
			});
		});

		it('pulls the card back in when the window shrinks, without overwriting the saved rect', () => {
			const saved = { left: 700, top: 400, ...SIZE };
			useThroughputGaugeStore.setState({ rects: { single: saved } });
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(saved);

			act(() => {
				setViewport(600, 500);
				window.dispatchEvent(new Event('resize'));
			});

			expect(cardRect()).toEqual({
				left: 600 - GAUGE_CLAMP_MARGIN - SIZE.width,
				top: 500 - GAUGE_CLAMP_MARGIN - SIZE.height,
				...SIZE,
			});
			expect(useThroughputGaugeStore.getState().rects.single).toEqual(saved);
		});

		it('remembers a separate rect for the all-three layout', () => {
			useThroughputGaugeStore.setState({
				rects: { single: { left: 300, top: 200, ...SIZE } },
			});
			setGaugeSettings({ layout: 'all' });
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(cardRect()).toEqual({
				left: GAUGE_EDGE_MARGIN,
				top: VIEWPORT.height - GAUGE_DEFAULT_SIZE.all.height - GAUGE_INPUT_AREA_CLEARANCE,
				...GAUGE_DEFAULT_SIZE.all,
			});
		});
	});
});
