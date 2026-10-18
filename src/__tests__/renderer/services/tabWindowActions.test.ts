/**
 * Tests for services/tabWindowActions - the one renderer path every pop-out and
 * dock entry point calls (Tab Windows, TW-11, TW-12): the web-desktop and tab
 * window refusals (TW-13, D1), the hidden consult tab refusal (TW-14), the
 * group detach before a pop-out (D6), and main's answers passed through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runtime = vi.hoisted(() => ({ webDesktop: false, tabWindow: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => runtime.webDesktop,
	isTabWindow: () => runtime.tabWindow,
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException }));

import {
	canUseTabWindows,
	dockTab,
	popOutRefusal,
	popOutTab,
} from '../../../renderer/services/tabWindowActions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockAITab, createMockSession, installTabWindowsApi } from '../../helpers';
import type { PanelLayoutNode, Session, TabGroup } from '../../../renderer/types';

const AGENT = 'agent-1';

function leaf(id: string, tabId: string): PanelLayoutNode {
	return { kind: 'leaf', id, tab: { type: 'ai', id: tabId } };
}

function group(id: string, tabIds: string[]): TabGroup {
	return {
		id,
		name: 'Group',
		layout: {
			kind: 'split',
			id: `${id}-split`,
			direction: 'row',
			children: tabIds.map((tabId) => leaf(`leaf-${tabId}`, tabId)),
			sizes: tabIds.map(() => 1 / tabIds.length),
		},
		focusedPaneId: `leaf-${tabIds[0]}`,
		createdAt: 0,
	};
}

function seed(overrides: Partial<Session> = {}): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: AGENT,
				aiTabs: [
					createMockAITab({ id: 'a1' }),
					createMockAITab({ id: 'a2' }),
					createMockAITab({ id: 'a3' }),
					createMockAITab({ id: 'consult', hidden: true }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a1' },
					{ type: 'ai', id: 'a2' },
					{ type: 'ai', id: 'a3' },
				],
				tabGroups: [],
				...overrides,
			}),
		],
	});
}

function agent(): Session {
	return useSessionStore.getState().sessions[0];
}

let api: ReturnType<typeof installTabWindowsApi>;

beforeEach(() => {
	runtime.webDesktop = false;
	runtime.tabWindow = false;
	captureException.mockClear();
	api = installTabWindowsApi();
	seed();
});

afterEach(() => api.restore());

describe('canUseTabWindows', () => {
	it('is true in an app window of the desktop build', () => {
		expect(canUseTabWindows()).toBe(true);
	});

	it('is false in the web-desktop build (TW-13)', () => {
		runtime.webDesktop = true;
		expect(canUseTabWindows()).toBe(false);
	});

	it('is false inside a tab window (D1)', () => {
		runtime.tabWindow = true;
		expect(canUseTabWindows()).toBe(false);
	});

	it('is false with no tab windows API', () => {
		api.restore();
		const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
		const previous = maestro.tabWindows;
		delete maestro.tabWindows;
		expect(canUseTabWindows()).toBe(false);
		maestro.tabWindows = previous;
	});
});

describe('popOutRefusal', () => {
	it('allows a visible tab of any kind the agent holds', () => {
		expect(popOutRefusal(agent(), { type: 'ai', id: 'a1' })).toBeNull();
	});

	it('refuses a hidden consult tab (TW-14)', () => {
		expect(popOutRefusal(agent(), { type: 'ai', id: 'consult' })).toMatch(/hidden consult/);
	});

	it('refuses a tab the agent does not hold', () => {
		expect(popOutRefusal(agent(), { type: 'file', id: 'nope' })).toMatch(/no such tab/);
	});
});

describe('popOutTab', () => {
	it('calls the pop-out IPC and passes the answer from main through', async () => {
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: false });
		expect(result).toEqual({ poppedOut: true, windowId: 'tw-1', created: true });
	});

	it('forwards background', async () => {
		await popOutTab(AGENT, { type: 'ai', id: 'a2' }, { background: true });
		expect(api.popOut).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' }, { background: true });
	});

	it('passes a refusal from main through', async () => {
		api.popOut.mockResolvedValue({ poppedOut: false, error: 'nope' });
		expect(await popOutTab(AGENT, { type: 'ai', id: 'a2' })).toEqual({
			poppedOut: false,
			error: 'nope',
		});
	});

	it('does nothing in the web-desktop build (TW-13)', async () => {
		runtime.webDesktop = true;
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('does nothing inside a tab window (D1)', async () => {
		runtime.tabWindow = true;
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('refuses a hidden consult tab without asking main (TW-14)', async () => {
		const result = await popOutTab(AGENT, { type: 'ai', id: 'consult' });
		expect(result).toEqual({
			poppedOut: false,
			error: 'A hidden consult tab cannot be popped out',
		});
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('refuses an unknown agent or tab', async () => {
		expect((await popOutTab('ghost', { type: 'ai', id: 'a1' })).poppedOut).toBe(false);
		expect((await popOutTab(AGENT, { type: 'browser', id: 'b9' })).poppedOut).toBe(false);
		expect(api.popOut).not.toHaveBeenCalled();
	});

	it('leaves the strip of a standalone tab untouched', async () => {
		const before = agent();
		await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(agent()).toBe(before);
	});

	it('detaches a tiled tab first, right after its group, and dissolves a two-pane group (D6)', async () => {
		seed({
			unifiedTabOrder: [
				{ type: 'group', id: 'g1' },
				{ type: 'ai', id: 'a3' },
			],
			tabGroups: [group('g1', ['a1', 'a2'])],
			activeGroupId: 'g1',
		});
		let orderAtCall: Session['unifiedTabOrder'] | undefined;
		api.popOut.mockImplementation(async () => {
			orderAtCall = agent().unifiedTabOrder;
			return { poppedOut: true, windowId: 'tw-1', created: true };
		});

		await popOutTab(AGENT, { type: 'ai', id: 'a1' });

		// The detach is written before main is asked.
		expect(orderAtCall).toEqual(agent().unifiedTabOrder);
		expect(agent().tabGroups).toEqual([]);
		expect(agent().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'a2' },
			{ type: 'ai', id: 'a1' },
			{ type: 'ai', id: 'a3' },
		]);
	});

	it('keeps a group that still has two panes', async () => {
		seed({
			unifiedTabOrder: [{ type: 'group', id: 'g1' }],
			tabGroups: [group('g1', ['a1', 'a2', 'a3'])],
		});

		await popOutTab(AGENT, { type: 'ai', id: 'a2' });

		expect(agent().unifiedTabOrder).toEqual([
			{ type: 'group', id: 'g1' },
			{ type: 'ai', id: 'a2' },
		]);
		expect(agent().tabGroups).toHaveLength(1);
		expect(JSON.stringify(agent().tabGroups[0].layout)).not.toContain('"a2"');
	});

	it('reports a rejected IPC call and answers with its message', async () => {
		api.popOut.mockRejectedValue(
			new Error("Error invoking remote method 'tabWindows:popOut': Error: boom")
		);
		const result = await popOutTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result).toEqual({ poppedOut: false, error: 'boom' });
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});

describe('dockTab', () => {
	it('calls the dock IPC and passes the answer from main through', async () => {
		const result = await dockTab(AGENT, { type: 'ai', id: 'a2' });
		expect(api.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
		expect(result).toEqual({ docked: true, windowId: 'tw-1' });
	});

	it('runs inside a tab window too (its Dock button)', async () => {
		runtime.tabWindow = true;
		expect((await dockTab(AGENT, { type: 'ai', id: 'a2' })).docked).toBe(true);
	});

	it('does nothing in the web-desktop build (TW-13)', async () => {
		runtime.webDesktop = true;
		const result = await dockTab(AGENT, { type: 'ai', id: 'a2' });
		expect(result.docked).toBe(false);
		expect(api.dock).not.toHaveBeenCalled();
	});

	it('reports a rejected IPC call and answers with its message', async () => {
		api.dock.mockRejectedValue(new Error('gone'));
		expect(await dockTab(AGENT, { type: 'ai', id: 'a2' })).toEqual({
			docked: false,
			error: 'gone',
		});
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});
