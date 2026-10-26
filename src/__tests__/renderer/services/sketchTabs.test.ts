/**
 * Tests for "New Sketch Book" (`createSketchInSession`), the one path the
 * hotkey, the command palette, the hamburger menu and the tab bar `+` menu
 * share: main creates the record, the renderer opens it in a tab.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyToast } = vi.hoisted(() => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast,
}));

import {
	createSketchInSession,
	newSketchBookInActiveAgent,
} from '../../../renderer/services/sketchTabs';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { SketchRecord } from '../../../shared/sketch/types';
import { createMockSession } from '../../helpers/mockSession';

const create = vi.fn();

function record(overrides: Partial<SketchRecord> = {}): SketchRecord {
	return {
		sketchId: 'sketch-1',
		ownerAgentId: 'agent-1',
		name: 'Untitled Sketch',
		filePath: '/data/sketches/agent-1/sketch-1.excalidraw',
		createdAt: 1,
		share: null,
		guestEdited: false,
		...overrides,
	} as SketchRecord;
}

/** Stand in for the preload `window.maestro.sketch` the shared setup does not mock. */
function installSketchApi() {
	const host = window as unknown as { maestro: Record<string, unknown> };
	host.maestro = { ...host.maestro, sketch: { create } };
}

const agent = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;

describe('createSketchInSession', () => {
	beforeEach(() => {
		create.mockReset();
		notifyToast.mockReset();
		installSketchApi();
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-1', name: 'Planner' }),
				createMockSession({ id: 'agent-2', name: 'Builder' }),
			],
			activeSessionId: 'agent-1',
		});
	});

	it('creates the sketch for the agent and opens it as the visible tab', async () => {
		create.mockResolvedValue(record());

		const result = await createSketchInSession('agent-1');

		expect(create).toHaveBeenCalledWith({ ownerAgentId: 'agent-1', name: undefined });
		expect(result?.sketchId).toBe('sketch-1');
		const tabs = agent('agent-1').sketchTabs ?? [];
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ sketchId: 'sketch-1', name: 'Untitled Sketch' });
		expect(agent('agent-1').activeSketchTabId).toBe(tabs[0].id);
		expect(agent('agent-1').unifiedTabOrder).toContainEqual({ type: 'sketch', id: tabs[0].id });
	});

	it('adds the tab without moving the view when asked for the background', async () => {
		create.mockResolvedValue(record({ name: 'Plan' }));

		await createSketchInSession('agent-1', { name: 'Plan', background: true });

		expect(create).toHaveBeenCalledWith({ ownerAgentId: 'agent-1', name: 'Plan' });
		expect(agent('agent-1').sketchTabs).toHaveLength(1);
		expect(agent('agent-1').activeSketchTabId ?? null).toBeNull();
	});

	it('shows main refusal as a toast and opens nothing', async () => {
		create.mockRejectedValue(
			new Error(
				"Error invoking remote method 'sketch:create': Error: Sketch Book runs on local agents only."
			)
		);

		const result = await createSketchInSession('agent-1');

		expect(result).toBeNull();
		expect(agent('agent-1').sketchTabs ?? []).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				title: 'Sketch Book',
				message: expect.stringContaining('Sketch Book runs on local agents only.'),
				sessionId: 'agent-1',
			})
		);
	});
});

describe('newSketchBookInActiveAgent', () => {
	beforeEach(() => {
		create.mockReset();
		installSketchApi();
	});

	it('creates the sketch for the active agent', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-1', name: 'Planner' }),
				createMockSession({ id: 'agent-2', name: 'Builder' }),
			],
			activeSessionId: 'agent-2',
		});
		create.mockResolvedValue(record({ ownerAgentId: 'agent-2' }));

		await newSketchBookInActiveAgent();

		expect(create).toHaveBeenCalledWith({ ownerAgentId: 'agent-2', name: undefined });
		expect(agent('agent-2').sketchTabs).toHaveLength(1);
	});

	it('does nothing without an agent', async () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		expect(await newSketchBookInActiveAgent()).toBeNull();
		expect(create).not.toHaveBeenCalled();
	});
});
