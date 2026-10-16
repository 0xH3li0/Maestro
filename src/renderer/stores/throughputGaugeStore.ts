/**
 * throughputGaugeStore - what the Throughput Gauge shows.
 *
 * Written on a timer only: `useThroughputCapture` feeds every stream chunk and
 * usage event to the rate engine (`src/shared/throughputRate.ts`) and calls
 * `publish()` with the rolling rates every `THROUGHPUT_PUBLISH_MS`. Nothing
 * writes here per chunk, so a fast stream costs the gauge four renders a
 * second, not one per token.
 *
 * `visible` is the user's close/open latch and is remembered across launches.
 * It is separate from the Encore flag: the flag decides whether the gauge
 * exists at all, `visible` whether its card is on screen.
 */

import { create } from 'zustand';
import type { ThroughputRates } from '../../shared/throughputRate';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';

/** localStorage key for the card's open/closed latch. */
export const THROUGHPUT_GAUGE_VISIBLE_KEY = 'throughputGauge.visible';

/** How many published combined readings `history` keeps (for a sparkline). */
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
	/** The last {@link THROUGHPUT_HISTORY_LENGTH} combined readings, oldest first. */
	history: number[];
}

export interface ThroughputGaugeActions {
	show: () => void;
	hide: () => void;
	toggle: () => void;
	resetPeak: () => void;
	/** Take one timer reading: set `rates`, raise `peak`, append to `history`. */
	publish: (rates: ThroughputRates) => void;
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

		show: () => setVisible(true),
		hide: () => setVisible(false),
		toggle: () => setVisible(!get().visible),

		resetPeak: () => set({ peak: get().rates }),

		publish: (rates) => {
			const state = get();
			// An idle app publishes zeros four times a second. Once the history has
			// drained to zeros too there is nothing left to change, so skip the write
			// and keep an idle gauge at zero renders.
			if (isIdle(rates) && isIdle(state.rates) && !state.history.some((value) => value > 0)) {
				return;
			}
			const history =
				state.history.length >= THROUGHPUT_HISTORY_LENGTH
					? state.history.slice(state.history.length - THROUGHPUT_HISTORY_LENGTH + 1)
					: state.history.slice();
			history.push(rates.combined);
			set({
				rates,
				peak: {
					in: Math.max(state.peak.in, rates.in),
					out: Math.max(state.peak.out, rates.out),
					combined: Math.max(state.peak.combined, rates.combined),
				},
				history,
			});
		},
	};
});
