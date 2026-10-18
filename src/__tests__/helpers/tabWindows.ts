/**
 * Shared Tab Windows test helpers: put tabs into `tabWindowStore` as popped
 * out, install a fake `window.maestro.tabWindows` (the global setup mock has
 * none, which is also what the web-desktop build looks like, TW-13), and play
 * an owner's patch stream into a tab window.
 */

import { vi } from 'vitest';
import { useTabWindowStore } from '../../renderer/stores/tabWindowStore';
import type { Session } from '../../renderer/types';
import { buildTabWindowSnapshot, diffTabWindowSession } from '../../shared/tabWindowPatch';
import type {
	TabWindowDockResult,
	TabWindowFocusResult,
	TabWindowIntent,
	TabWindowSessionPatch,
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
 * Install a fake `window.maestro.tabWindows` whose `focus` answers `result`,
 * whose `dock` answers `dockResult`, and whose `getState` (a tab window's own
 * record) answers null until a test says otherwise. The relay half records
 * what is sent (`sendSessionPatch`, `sendIntent`). As main's relay would,
 * `emitIntent` delivers an intent to every `onIntent` subscriber, and
 * `emitPatch` delivers a patch to every `onSessionPatch` subscriber, cloned
 * the way IPC clones it. Returns the mocks and a restore function.
 */
export function installTabWindowsApi(
	result: TabWindowFocusResult = { focused: true, windowId: 'tw-1' },
	dockResult: TabWindowDockResult = { docked: true, windowId: 'tw-1' }
): {
	focus: ReturnType<typeof vi.fn>;
	dock: ReturnType<typeof vi.fn>;
	getState: ReturnType<typeof vi.fn>;
	sendSessionPatch: ReturnType<typeof vi.fn>;
	sendIntent: ReturnType<typeof vi.fn>;
	onIntent: ReturnType<typeof vi.fn>;
	onSessionPatch: ReturnType<typeof vi.fn>;
	emitIntent: (intent: TabWindowIntent) => void;
	emitPatch: (patch: TabWindowSessionPatch) => void;
	restore: () => void;
} {
	const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
	const previous = maestro.tabWindows;
	const focus = vi.fn().mockResolvedValue(result);
	const dock = vi.fn().mockResolvedValue(dockResult);
	const getState = vi.fn().mockResolvedValue(null);
	const sendSessionPatch = vi.fn();
	const sendIntent = vi.fn();
	const intentListeners = new Set<(intent: TabWindowIntent) => void>();
	const onIntent = vi.fn((callback: (intent: TabWindowIntent) => void) => {
		intentListeners.add(callback);
		return () => intentListeners.delete(callback);
	});
	const patchListeners = new Set<(patch: TabWindowSessionPatch) => void>();
	const onSessionPatch = vi.fn((callback: (patch: TabWindowSessionPatch) => void) => {
		patchListeners.add(callback);
		return () => patchListeners.delete(callback);
	});
	maestro.tabWindows = {
		focus,
		dock,
		getState,
		sendSessionPatch,
		sendIntent,
		onIntent,
		onSessionPatch,
	};
	return {
		focus,
		dock,
		getState,
		sendSessionPatch,
		sendIntent,
		onIntent,
		onSessionPatch,
		emitIntent: (intent) => {
			for (const listener of [...intentListeners]) listener(intent);
		},
		emitPatch: (patch) => {
			// Electron IPC is a structured clone: the receiver never shares an
			// object with the sender, and keys set to `undefined` survive.
			for (const listener of [...patchListeners]) listener(structuredClone(patch));
		},
		restore: () => {
			if (previous === undefined) delete maestro.tabWindows;
			else maestro.tabWindows = previous;
		},
	};
}

/** An owner's patch stream to one tab window. See {@link createOwnerPatchStream}. */
export interface OwnerPatchStream {
	/** Send `session` whole, for `tabRefs` (the stream's refs when omitted). */
	snapshot: (session: Session, tabRefs?: TabWindowTabRef[]) => void;
	/** Send what changed since the last patch; false when nothing did. */
	delta: (next: Session) => boolean;
	/** Number a patch and never deliver it, as a gap in the stream would. */
	lose: () => void;
}

/**
 * The owner window's half of the patch stream in miniature: the real snapshot
 * and diff functions (`src/shared/tabWindowPatch.ts`), numbered the way the
 * publisher numbers them and diffed from the state the last patch was built
 * from, delivered through `emit` (for example `installTabWindowsApi().emitPatch`).
 * No timing: each call is one patch.
 */
export function createOwnerPatchStream(
	emit: (patch: TabWindowSessionPatch) => void,
	agentId: string,
	tabRefs: TabWindowTabRef[]
): OwnerPatchStream {
	let refs = tabRefs;
	let prev: Session | null = null;
	let seq = -1;
	return {
		snapshot: (session, nextRefs = refs) => {
			refs = nextRefs;
			prev = session;
			seq += 1;
			emit({
				form: 'snapshot',
				agentId,
				seq,
				tabRefs: refs,
				session: buildTabWindowSnapshot(session, refs),
			});
		},
		delta: (next) => {
			if (!prev) throw new Error('createOwnerPatchStream: send a snapshot first');
			const changes = diffTabWindowSession(prev, next, refs);
			prev = next;
			if (!changes) return false;
			seq += 1;
			emit({ form: 'delta', agentId, seq, ...changes });
			return true;
		},
		lose: () => {
			seq += 1;
		},
	};
}
