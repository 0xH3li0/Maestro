/**
 * throughputGaugeStore - what the Throughput Gauge shows.
 *
 * Written on a timer only: `useThroughputCapture` feeds every stream chunk and
 * usage event to the rate engine (`src/shared/throughputRate.ts`) and calls
 * `publish()` with the rolling rates every `THROUGHPUT_PUBLISH_MS`. Nothing
 * writes here per chunk, so a fast stream costs the gauge four renders a
 * second, not one per token.
 *
 * `peak` and `history` only compare readings taken under one rule. The capture
 * hook calls `restartReadings()` when the scope or the rolling window changes,
 * and `history` restarts by itself when the metric it records changes.
 *
 * `visible` is the user's close/open latch and is remembered across launches.
 * It is separate from the Encore flag: the flag decides whether the gauge
 * exists at all, `visible` whether its card is on screen.
 */

import { create } from 'zustand';
import type { ThroughputMetric, ThroughputRates } from '../../shared/throughputRate';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';

/** localStorage key for the card's open/closed latch. */
export const THROUGHPUT_GAUGE_VISIBLE_KEY = 'throughputGauge.visible';

/** How many published readings `history` keeps (for a sparkline). */
export const THROUGHPUT_HISTORY_LENGTH = 60;

const ZERO_RATES: ThroughputRates = { in: 0, out: 0, combined: 0 };

function loadVisible(): boolean {
	const raw = safeStorageGet(THROUGHPUT_GAUGE_VISIBLE_KEY);
	return raw === null ? true : raw === 'true';
}

function isIdle(rates: ThroughputRates): boolean {
	return rates.in === 0 && rates.out === 0 && rates.combined === 0;
}

export interface ThroughputGaugeState {
	/** Whether the floating card is on screen. Persisted; defaults to true. */
	visible: boolean;
	/** Latest published rates, tokens per second. */
	rates: ThroughputRates;
	/** Highest reading per metric since the last `resetPeak()`. */
	peak: ThroughputRates;
	/** The last {@link THROUGHPUT_HISTORY_LENGTH} readings of `historyMetric`, oldest first. */
	history: number[];
	/** The metric `history` records. */
	historyMetric: ThroughputMetric;
}

export interface ThroughputGaugeActions {
	show: () => void;
	hide: () => void;
	toggle: () => void;
	/** Start the peak again from the current reading (the user's Reset peak). */
	resetPeak: () => void;
	/** Zero `peak` and empty `history`: the reading rule (scope or window) changed. */
	restartReadings: () => void;
	/**
	 * Take one timer reading: set `rates`, raise `peak`, and append
	 * `rates[historyMetric]` to `history`, which starts over when `historyMetric`
	 * differs from the last call's.
	 */
	publish: (rates: ThroughputRates, historyMetric?: ThroughputMetric) => void;
}

export type ThroughputGaugeStore = ThroughputGaugeState & ThroughputGaugeActions;

export const useThroughputGaugeStore = create<ThroughputGaugeStore>()((set, get) => {
	const setVisible = (visible: boolean) => {
		safeStorageSet(THROUGHPUT_GAUGE_VISIBLE_KEY, String(visible));
		set({ visible });
	};

	return {
		visible: loadVisible(),
		rates: ZERO_RATES,
		peak: ZERO_RATES,
		history: [],
		historyMetric: 'combined',

		show: () => setVisible(true),
		hide: () => setVisible(false),
		toggle: () => setVisible(!get().visible),

		resetPeak: () => set({ peak: get().rates }),

		restartReadings: () => set({ peak: ZERO_RATES, history: [] }),

		publish: (rates, historyMetric = 'combined') => {
			const state = get();
			const sameMetric = historyMetric === state.historyMetric;
			// An idle app publishes zeros four times a second. Once the history has
			// drained to zeros too there is nothing left to change, so skip the write
			// and keep an idle gauge at zero renders.
			if (
				sameMetric &&
				isIdle(rates) &&
				isIdle(state.rates) &&
				!state.history.some((value) => value > 0)
			) {
				return;
			}
			// A history of another metric is not this one's past: start it over.
			const previous = sameMetric ? state.history : [];
			const history =
				previous.length >= THROUGHPUT_HISTORY_LENGTH
					? previous.slice(previous.length - THROUGHPUT_HISTORY_LENGTH + 1)
					: previous.slice();
			history.push(rates[historyMetric]);
			set({
				rates,
				peak: {
					in: Math.max(state.peak.in, rates.in),
					out: Math.max(state.peak.out, rates.out),
					combined: Math.max(state.peak.combined, rates.combined),
				},
				history,
				historyMetric,
			});
		},
	};
});
