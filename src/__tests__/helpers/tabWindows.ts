/**
 * Shared Tab Windows test helpers: put tabs into `tabWindowStore` as popped
 * out, and install a fake `window.maestro.tabWindows` (the global setup mock
 * has none, which is also what the web-desktop build looks like, TW-13).
 */

import { vi } from 'vitest';
import { useTabWindowStore } from '../../renderer/stores/tabWindowStore';
import type {
	TabWindowDockResult,
	TabWindowFocusResult,
	TabWindowTabRef,
} from '../../shared/tabWindowTypes';

/** Mark `tabRefs` of `agentId` as popped out into one tab window. */
export function popOutTabsInStore(agentId: string, tabRefs: TabWindowTabRef[]): void {
	useTabWindowStore
		.getState()
		.setWindows([
			{ windowId: `tw-${agentId}`, agentId, tabRefs, activeTabRef: tabRefs[0] ?? null },
		]);
}

/** Dock every tab: the store reports no tab window. */
export function clearTabWindowStore(): void {
	useTabWindowStore.getState().setWindows([]);
}

/**
 * Install a fake `window.maestro.tabWindows` whose `focus` answers `result` and
 * whose `dock` answers `dockResult`. Returns both mocks and a restore function.
 */
export function installTabWindowsApi(
	result: TabWindowFocusResult = { focused: true, windowId: 'tw-1' },
	dockResult: TabWindowDockResult = { docked: true, windowId: 'tw-1' }
): {
	focus: ReturnType<typeof vi.fn>;
	dock: ReturnType<typeof vi.fn>;
	restore: () => void;
} {
	const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
	const previous = maestro.tabWindows;
	const focus = vi.fn().mockResolvedValue(result);
	const dock = vi.fn().mockResolvedValue(dockResult);
	maestro.tabWindows = { focus, dock };
	return {
		focus,
		dock,
		restore: () => {
			if (previous === undefined) delete maestro.tabWindows;
			else maestro.tabWindows = previous;
		},
	};
}
