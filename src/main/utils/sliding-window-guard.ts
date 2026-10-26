/**
 * A keyed sliding-window rate limit with a concurrency cap: the one
 * implementation behind the plugin ActionGuard (per plugin and capability)
 * and the Sketch Book write guard (per sketch).
 *
 * `begin(key)` admits an action when the key has made fewer than
 * `maxPerWindow` actions in the last `windowMs` AND has fewer than
 * `maxConcurrent` in flight. An admitted action counts toward the window at
 * once and holds a concurrency slot until its `release()` (idempotent). A
 * refused action counts toward nothing, so a caller that backs off recovers.
 *
 * Pure given the injected clock, so it is unit-testable without timers.
 */

export interface SlidingWindowLimits {
	/** Sliding-window length in ms. */
	windowMs: number;
	/** Most admitted actions per window per key. */
	maxPerWindow: number;
	/** Most in-flight actions per key. */
	maxConcurrent: number;
}

export type SlidingWindowOutcome =
	| { ok: true; release: () => void }
	| { ok: false; limit: 'rate'; count: number }
	| { ok: false; limit: 'concurrency'; count: number };

export interface SlidingWindowGuard {
	begin(key: string, limits: SlidingWindowLimits): SlidingWindowOutcome;
}

export function createSlidingWindowGuard(now: () => number = Date.now): SlidingWindowGuard {
	const hits = new Map<string, number[]>();
	const inflight = new Map<string, number>();

	return {
		begin(key, limits) {
			const t = now();
			const recent = (hits.get(key) ?? []).filter((ts) => t - ts < limits.windowMs);
			if (recent.length >= limits.maxPerWindow) {
				hits.set(key, recent);
				return { ok: false, limit: 'rate', count: recent.length };
			}
			const current = inflight.get(key) ?? 0;
			if (current >= limits.maxConcurrent) {
				hits.set(key, recent);
				return { ok: false, limit: 'concurrency', count: current };
			}

			recent.push(t);
			hits.set(key, recent);
			inflight.set(key, current + 1);

			let released = false;
			return {
				ok: true,
				release: () => {
					if (released) return;
					released = true;
					const remaining = Math.max(0, (inflight.get(key) ?? 1) - 1);
					if (remaining === 0) inflight.delete(key);
					else inflight.set(key, remaining);
				},
			};
		},
	};
}
