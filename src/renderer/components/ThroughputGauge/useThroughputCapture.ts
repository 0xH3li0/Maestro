/**
 * useThroughputCapture - feeds the Throughput Gauge from live agent output.
 *
 * Mounted only while the `throughputGauge` Encore Feature is on, so with the
 * feature off no listener and no timer exist. While mounted it routes the raw
 * `process:*` stream into one module-level rate engine
 * (`src/shared/throughputRate.ts`) and publishes its rolling rates to
 * `throughputGaugeStore` on a timer:
 *
 * - `onThinkingChunk` -> `recordStreamedText`: the live signal.
 * - `onData` -> `recordReplyText`, NEVER `recordStreamedText`: for structured
 *   output providers this is the finished reply re-sent at turn end, after the
 *   usage report that already counted it. The engine's reply latch refuses it.
 * - `onUsage` -> `recordUsage` with the agent's `toolType`, which decides
 *   whether cache reads sit inside `inputTokens`.
 * - `onExit` -> `forgetSource`, so per-turn state never accumulates.
 *
 * Every source is keyed by its RAW process session id (a forced-parallel turn
 * runs beside the tab's normal one); the agent id is only the scope key.
 *
 * Only agent turns count: `ai-tab`, `legacy-ai`, `batch` (Auto Run) and
 * `synopsis` are real model throughput. `regular` covers the command terminal
 * (`{id}-terminal`) and bare-id shell output, which are not tokens. Group chat
 * (`group-chat-*`) also parses as `regular` and is left out for now: only its
 * usage reaches the renderer, and it belongs to no single agent to scope on.
 *
 * Publishing runs on a `setInterval`, not `requestAnimationFrame`, for the
 * reason `useThoughtStreamCaptureListener` gives: rAF stops while the window is
 * hidden, and a timer keeps the reading honest for an unattended run.
 */

import { useEffect } from 'react';
import {
	createThroughputTracker,
	DEFAULT_THROUGHPUT_WINDOW_MS,
	type ThroughputRates,
} from '../../../shared/throughputRate';
import { useOwnedSessionGate } from '../../hooks/agent/internal/useOwnedSessionGate';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { parseSessionId } from '../../utils/sessionIdParser';

/** How often the gauge reads the engine and publishes to the store. */
export const THROUGHPUT_PUBLISH_MS = 250;

const ZERO_RATES: ThroughputRates = { in: 0, out: 0, combined: 0 };

/**
 * The one engine instance. Module-level so the hook's effect can re-subscribe
 * without losing the window of samples; cleared when the hook unmounts.
 */
export const throughputTracker = createThroughputTracker();

export function useThroughputCapture(): void {
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const processApi = window.maestro.process;

		/** The agent id a raw process id counts toward, or null when it does not count. */
		const agentTurnOf = (rawSessionId: string): string | null => {
			if (!ownedGate.current?.(rawSessionId)) return null;
			const parsed = parseSessionId(rawSessionId);
			return parsed.type === 'regular' ? null : parsed.baseSessionId;
		};

		const unsubscribers = [
			processApi.onThinkingChunk?.((sessionId: string, content: string) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordStreamedText(sessionId, agentId, content, performance.now());
			}),
			processApi.onData((sessionId: string, data: string) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordReplyText(sessionId, agentId, data, performance.now());
			}),
			processApi.onUsage((sessionId, usageStats) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				const provider = selectSessionById(agentId)(useSessionStore.getState())?.toolType;
				throughputTracker.recordUsage(sessionId, agentId, usageStats, performance.now(), provider);
			}),
			processApi.onExit((sessionId: string) => {
				// Not gated: forgetting a source this window never tracked is a no-op.
				throughputTracker.forgetSource(sessionId);
			}),
		];

		const timer = setInterval(() => {
			const now = performance.now();
			throughputTracker.prune(now);
			useThroughputGaugeStore
				.getState()
				.publish(throughputTracker.rates(now, DEFAULT_THROUGHPUT_WINDOW_MS));
		}, THROUGHPUT_PUBLISH_MS);

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe?.();
			clearInterval(timer);
			throughputTracker.clear();
			// Drop the needle: a gauge switched off mid-stream must not come back
			// showing the rate it had when it left.
			useThroughputGaugeStore.getState().publish(ZERO_RATES);
		};
	}, [ownedGate]);
}
