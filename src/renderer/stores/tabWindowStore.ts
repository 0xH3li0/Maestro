/**
 * tabWindowStore - the renderer's one source of truth for which tabs are
 * popped out into a tab window (Tab Windows, D4).
 *
 * Main holds the real registry (D3). This store mirrors it: it is hydrated
 * from `tabWindows:list()` when the app mounts and re-read on every
 * `tab-window-changed` broadcast. Popped state is deliberately NOT on the
 * `Session`: a tab keeps its place in `aiTabs` / `fileTabs` / ... and its
 * `unifiedTabOrder` ref (TW-8), and the owner only filters it out of its strip
 * and its tab-picking math.
 *
 * Read it through {@link isTabPoppedOut} in event-time code and pure helpers,
 * and through {@link useIsTabPoppedOut} / {@link usePoppedOutTabKeys} in
 * components. A popped-state change does not change `session`, so a memo over
 * `session` that filters popped tabs must also depend on
 * {@link usePoppedOutTabKeys}.
 *
 * Mount {@link useTabWindowStoreSync} once (App.tsx).
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { TabWindowInfo } from '../../shared/tabWindowTypes';
import { tabRefKey, type UnifiedTabRef } from '../../shared/unifiedTabRef';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/** The popped tabs of one agent, as {@link tabRefKey} strings. */
export type PoppedOutTabKeys = ReadonlySet<string>;

const EMPTY_KEYS: PoppedOutTabKeys = new Set<string>();

interface TabWindowStoreState {
	/** Every tab window, as main last reported it. */
	windows: TabWindowInfo[];
	/**
	 * agentId -> its popped tab keys. An agent with no popped tab has no entry.
	 * An agent whose tabs did not change keeps the same Set across updates, so a
	 * per-agent selector re-renders only for that agent.
	 */
	poppedByAgent: Record<string, PoppedOutTabKeys>;
	/** Replace the mirror with a fresh `tabWindows:list()` answer. */
	setWindows: (windows: TabWindowInfo[]) => void;
}

function sameKeys(a: PoppedOutTabKeys, b: PoppedOutTabKeys): boolean {
	if (a.size !== b.size) return false;
	for (const key of a) if (!b.has(key)) return false;
	return true;
}

/** Group the registry's tab windows by agent, reusing unchanged Sets from `prev`. */
function buildPoppedByAgent(
	windows: TabWindowInfo[],
	prev: Record<string, PoppedOutTabKeys>
): Record<string, PoppedOutTabKeys> {
	const grouped = new Map<string, Set<string>>();
	for (const win of windows) {
		if (win.tabRefs.length === 0) continue;
		let keys = grouped.get(win.agentId);
		if (!keys) {
			keys = new Set<string>();
			grouped.set(win.agentId, keys);
		}
		for (const ref of win.tabRefs) keys.add(tabRefKey(ref));
	}
	const next: Record<string, PoppedOutTabKeys> = {};
	for (const [agentId, keys] of grouped) {
		const previous = prev[agentId];
		next[agentId] = previous && sameKeys(previous, keys) ? previous : keys;
	}
	return next;
}

export const useTabWindowStore = create<TabWindowStoreState>()((set) => ({
	windows: [],
	poppedByAgent: {},
	setWindows: (windows) =>
		set((state) => ({
			windows,
			poppedByAgent: buildPoppedByAgent(windows, state.poppedByAgent),
		})),
}));

/** The popped tab keys of one agent; an empty Set when it has none. */
export function getPoppedOutTabKeys(agentId: string): PoppedOutTabKeys {
	return useTabWindowStore.getState().poppedByAgent[agentId] ?? EMPTY_KEYS;
}

/**
 * Whether a tab of `agentId` is popped out into a tab window. Never true for a
 * `'group'` ref: a whole tiled group cannot be popped out (D6).
 */
export function isTabPoppedOut(agentId: string, ref: UnifiedTabRef): boolean {
	if (ref.type === 'group') return false;
	return getPoppedOutTabKeys(agentId).has(tabRefKey(ref));
}

/** Hook form of {@link isTabPoppedOut}. */
export function useIsTabPoppedOut(agentId: string | null | undefined, ref: UnifiedTabRef): boolean {
	const key = ref.type === 'group' ? null : tabRefKey(ref);
	return useTabWindowStore((state) =>
		agentId && key ? (state.poppedByAgent[agentId]?.has(key) ?? false) : false
	);
}

/**
 * The popped tab keys of one agent, stable until that agent's set changes. Use
 * it as a memo dependency beside `session` wherever popped tabs are filtered.
 */
export function usePoppedOutTabKeys(agentId: string | null | undefined): PoppedOutTabKeys {
	return useTabWindowStore((state) =>
		agentId ? (state.poppedByAgent[agentId] ?? EMPTY_KEYS) : EMPTY_KEYS
	);
}

/**
 * Read the registry once and re-read it on every `tab-window-changed`. Returns
 * the unsubscribe function. A no-op where there is no tab windows API (the
 * web-desktop build has no OS windows, TW-13).
 *
 * Only the newest read is applied, so two changes in quick succession cannot
 * land out of order.
 */
export function startTabWindowStoreSync(): () => void {
	const api = window.maestro?.tabWindows;
	const windowsApi = window.maestro?.windows;
	if (!api || !windowsApi?.onSessionMoved) return () => {};

	let latestRead = 0;
	let stopped = false;
	const refresh = () => {
		const read = ++latestRead;
		api
			.list()
			.then((windows) => {
				if (stopped || read !== latestRead) return;
				useTabWindowStore.getState().setWindows(windows ?? []);
			})
			.catch((error: unknown) => {
				logger.error('[TabWindows] Could not read the tab windows', undefined, error);
				captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { operation: 'tabWindows.list' },
				});
			});
	};

	const unsubscribe = windowsApi.onSessionMoved((payload) => {
		if (payload?.type === 'tab-window-changed') refresh();
	});
	refresh();
	return () => {
		stopped = true;
		unsubscribe();
	};
}

/** Mount once in App.tsx: keeps {@link useTabWindowStore} in step with main. */
export function useTabWindowStoreSync(): void {
	useEffect(() => startTabWindowStoreSync(), []);
}
