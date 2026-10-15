// Merged from (playbook doc 02; test code verbatim, mechanical dedup/renames only):
//   - src/__tests__/cli/commands/tab.test.ts
//   - src/__tests__/cli/commands/agent-control.test.ts
//   - src/__tests__/cli/commands/movement.test.ts

import { focusAgent, switchMode } from '../../../cli/commands/agent-control';
import { movementBegin, movementInspect, movementProgress } from '../../../cli/commands/movement';
import {
	tabClose,
	tabEffort,
	tabEnterToSend,
	tabModel,
	tabMove,
	tabNew,
	tabReadOnly,
	tabRename,
	tabSaveToHistory,
	tabShow,
	tabStar,
	tabThinking,
	tabUnread,
} from '../../../cli/commands/tab';
import { formatError } from '../../../cli/output/formatter';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readActiveAgentId, resolveAgentId } from '../../../cli/services/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => null),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
vi.mock('fs', () => ({
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	readFileSync: vi.fn(),
	writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

// ===== from src/__tests__/cli/commands/tab.test.ts =====

// agent-1 owns three tabs in tab-bar order so reordering has something to move
// against; agent-2's single tab guards against cross-agent index leakage.
function entry(tabId: string, agentId: string, over: Record<string, unknown> = {}) {
	return {
		tabId,
		sessionId: tabId,
		agentId,
		agentName: agentId,
		toolType: 'claude-code',
		name: null,
		agentSessionId: null,
		state: 'idle' as const,
		createdAt: 0,
		starred: false,
		active: false,
		hasUnread: false,
		saveToHistory: true,
		readOnly: false,
		thinking: 'off' as const,
		model: null,
		effort: null,
		enterToSend: null,
		...over,
	};
}

const SESSIONS = [
	entry('tab-aaaa', 'agent-1', { active: true, thinking: 'on' }),
	entry('tab-cccc', 'agent-1'),
	entry('tab-dddd', 'agent-1'),
	entry('tab-bbbb', 'agent-2', { active: true, model: 'opus', effort: 'high' }),
];

/**
 * Mock that answers list_desktop_sessions with SESSIONS and captures any other
 * command payload. Works across the two separate connections tab verbs open
 * (resolve owner, then send the command).
 */
function mockTab(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				if (payload.type === 'list_desktop_sessions') {
					return Promise.resolve({ sessions: SESSIONS });
				}
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('tab commands', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.mocked(readActiveAgentId).mockReturnValue(null);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('tab new (no prompt) sends new_tab and prints the tab id', async () => {
		const getPayload = mockTab({ success: true, tabId: 'tab-new' });
		await tabNew({ agent: 'agent-1' });
		const p = getPayload();
		expect(p.type).toBe('new_tab');
		expect(p.sessionId).toBe('agent-1');
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('tab-new'));
	});

	it('tab new --prompt sends new_ai_tab_with_prompt', async () => {
		const getPayload = mockTab({ success: true, tabId: 't' });
		await tabNew({ agent: 'agent-1', prompt: 'hello' });
		const p = getPayload();
		expect(p.type).toBe('new_ai_tab_with_prompt');
		expect(p.prompt).toBe('hello');
	});

	describe('tab new placement', () => {
		// `tab new --prompt` and `dispatch --new-tab` send the SAME
		// new_ai_tab_with_prompt message and disagree about the default: tab new
		// has always focused, dispatch has always been background. That is why the
		// default is keyed by verb rather than by message, and it is what these
		// assertions pin down.
		it('stays foreground by default, on both message shapes', async () => {
			const getNoPrompt = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1' });
			expect(getNoPrompt().background).toBe(false);

			const getWithPrompt = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', prompt: 'hello' });
			expect(getWithPrompt().type).toBe('new_ai_tab_with_prompt');
			expect(getWithPrompt().background).toBe(false);
		});

		it('puts background:true on the wire for --background', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', background: true });
			expect(getPayload().background).toBe(true);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('background'));
		});

		it('lets --focus name the default explicitly', async () => {
			const getPayload = mockTab({ success: true, tabId: 'tab-new' });
			await tabNew({ agent: 'agent-1', background: true, focus: true });
			expect(getPayload().background).toBe(false);
		});
	});

	it('tab close resolves the owning agent from the tab id', async () => {
		const getPayload = mockTab({ success: true });
		await tabClose('tab-bbbb', {});
		const p = getPayload();
		expect(p.type).toBe('close_tab');
		expect(p.sessionId).toBe('agent-2');
		expect(p.tabId).toBe('tab-bbbb');
	});

	it('tab close accepts a unique prefix', async () => {
		const getPayload = mockTab({ success: true });
		await tabClose('tab-aa', {});
		expect(getPayload().tabId).toBe('tab-aaaa');
	});

	it('tab close fails on an unknown tab id', async () => {
		mockTab({ success: true });
		await expect(tabClose('does-not-exist', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('tab rename sends newName', async () => {
		const getPayload = mockTab({ success: true });
		await tabRename('tab-aaaa', 'Docs', {});
		const p = getPayload();
		expect(p.type).toBe('rename_tab');
		expect(p.newName).toBe('Docs');
	});

	it('tab star sends starred:true; unstar sends false', async () => {
		const getStar = mockTab({ success: true });
		await tabStar('tab-aaaa', true, {});
		expect(getStar().starred).toBe(true);

		const getUnstar = mockTab({ success: true });
		await tabStar('tab-aaaa', false, {});
		expect(getUnstar().starred).toBe(false);
	});

	it('tab move derives fromIndex from live tab order, scoped to the owning agent', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-dddd', '0', {});
		const p = getPayload();
		expect(p.type).toBe('reorder_tab');
		expect(p.sessionId).toBe('agent-1');
		// agent-2's tab sits after agent-1's in the flat list; it must not shift
		// the index that agent-1's own tab bar sees.
		expect(p.fromIndex).toBe(2);
		expect(p.toIndex).toBe(0);
	});

	it('tab move accepts "first" and "last"', async () => {
		const getFirst = mockTab({ success: true });
		await tabMove('tab-dddd', 'first', {});
		expect(getFirst().toIndex).toBe(0);

		const getLast = mockTab({ success: true });
		await tabMove('tab-aaaa', 'last', {});
		expect(getLast().toIndex).toBe(2);
	});

	it('tab move clamps an out-of-range index to the last position', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-aaaa', '99', {});
		expect(getPayload().toIndex).toBe(2);
	});

	it('tab move is a no-op when the tab is already at the target position', async () => {
		const getPayload = mockTab({ success: true });
		await tabMove('tab-aaaa', '0', {});
		// No reorder_tab message is sent, so nothing is captured.
		expect(getPayload()).toEqual({});
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already at position 0'));
	});

	it('tab move rejects a non-numeric position', async () => {
		mockTab({ success: true });
		await expect(tabMove('tab-aaaa', 'middle', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid position'));
	});

	it('tab unread/read ride the allowlisted, flushed config path with a tabId', async () => {
		const getUnread = mockTab({ success: true });
		await tabUnread('tab-aaaa', true, {});
		const p = getUnread();
		expect(p.type).toBe('update_session_config');
		expect(p.sessionId).toBe('agent-1');
		expect(p.configPatch).toEqual({ tabId: 'tab-aaaa', hasUnread: true });

		const getRead = mockTab({ success: true });
		await tabUnread('tab-aaaa', false, {});
		expect(getRead().configPatch).toEqual({ tabId: 'tab-aaaa', hasUnread: false });
	});

	it('tab save-to-history sends an explicit boolean', async () => {
		const getOff = mockTab({ success: true });
		await tabSaveToHistory('tab-bbbb', false, {});
		const p = getOff();
		expect(p.sessionId).toBe('agent-2');
		expect(p.configPatch).toEqual({ tabId: 'tab-bbbb', saveToHistory: false });
	});

	it('tab flag verbs fail on an unknown tab id before contacting the desktop', async () => {
		mockTab({ success: true });
		await expect(tabUnread('nope', true, {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
	});

	it('tab thinking sets an explicit mode', async () => {
		const getPayload = mockTab({ success: true });
		await tabThinking('tab-cccc', 'sticky', {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-cccc', showThinking: 'sticky' });
	});

	it("tab thinking cycle advances from the tab's live mode, not from off", async () => {
		// tab-aaaa is already on 'on', so one cycle must land on 'sticky'.
		const getPayload = mockTab({ success: true });
		await tabThinking('tab-aaaa', 'cycle', {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-aaaa', showThinking: 'sticky' });
	});

	it('tab read-only, model, effort and enter-to-send write their own field', async () => {
		const getReadOnly = mockTab({ success: true });
		await tabReadOnly('tab-cccc', true, {});
		expect(getReadOnly().configPatch).toEqual({ tabId: 'tab-cccc', readOnlyMode: true });

		const getModel = mockTab({ success: true });
		await tabModel('tab-cccc', 'opus', {});
		expect(getModel().configPatch).toEqual({ tabId: 'tab-cccc', customModel: 'opus' });

		const getEffort = mockTab({ success: true });
		await tabEffort('tab-cccc', 'high', {});
		expect(getEffort().configPatch).toEqual({ tabId: 'tab-cccc', customEffort: 'high' });

		const getEnter = mockTab({ success: true });
		await tabEnterToSend('tab-cccc', false, {});
		expect(getEnter().configPatch).toEqual({ tabId: 'tab-cccc', enterToSend: false });
	});

	it('clearing an override sends null so the renderer drops the field', async () => {
		const getModel = mockTab({ success: true });
		await tabModel('tab-bbbb', null, {});
		expect(getModel().configPatch).toEqual({ tabId: 'tab-bbbb', customModel: null });

		const getEnter = mockTab({ success: true });
		await tabEnterToSend('tab-bbbb', null, {});
		expect(getEnter().configPatch).toEqual({ tabId: 'tab-bbbb', enterToSend: null });
	});

	it('"active" targets the agent named by --agent', async () => {
		const getPayload = mockTab({ success: true });
		await tabThinking('active', 'off', { agent: 'agent-2' });
		const p = getPayload();
		expect(p.sessionId).toBe('agent-2');
		expect(p.configPatch).toEqual({ tabId: 'tab-bbbb', showThinking: 'off' });
	});

	it('"active" falls back to the desktop\'s focused agent', async () => {
		vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
		const getPayload = mockTab({ success: true });
		await tabReadOnly('active', true, {});
		expect(getPayload().configPatch).toEqual({ tabId: 'tab-aaaa', readOnlyMode: true });
	});

	it('"active" fails loudly when no agent is focused and none was named', async () => {
		mockTab({ success: true });
		await expect(tabShow('active', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('No active agent'));
	});

	it('tab show --json returns the whole entry without writing anything', async () => {
		const getPayload = mockTab({ success: true });
		await tabShow('tab-bbbb', { json: true });
		// No mutation was sent: the list call is the only traffic.
		expect(getPayload()).toEqual({});
		const printed = JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);
		expect(printed.tab.tabId).toBe('tab-bbbb');
		expect(printed.tab.model).toBe('opus');
	});
});

// ===== from src/__tests__/cli/commands/agent-control.test.ts =====

function mockSend(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('focus-agent / switch-mode commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.mocked(readActiveAgentId).mockReturnValue(null);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('focus-agent sends select_session with focus:true', async () => {
		const getPayload = mockSend({ success: true });
		await focusAgent('agent-1', {});
		const p = getPayload();
		expect(p.type).toBe('select_session');
		expect(p.sessionId).toBe('agent-1');
		expect(p.focus).toBe(true);
		expect(p.tabId).toBeUndefined();
	});

	it('focus-agent includes tabId when --tab is given', async () => {
		const getPayload = mockSend({ success: true });
		await focusAgent('agent-1', { tab: 'tab-9' });
		expect(getPayload().tabId).toBe('tab-9');
	});

	it('switch-mode sends mode and uses mode_switch_result', async () => {
		let responseType = '';
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((_payload, rt: string) => {
					responseType = rt;
					return Promise.resolve({ success: true });
				}),
			} as never)
		);
		await switchMode('agent-1', 'terminal', {});
		expect(responseType).toBe('mode_switch_result');
	});

	it('switch-mode normalizes case', async () => {
		const getPayload = mockSend({ success: true });
		await switchMode('agent-1', 'AI', {});
		expect(getPayload().mode).toBe('ai');
	});

	describe('switch-mode --background', () => {
		// switch-mode is the one focus-moving verb that creates nothing, so it has
		// no background surface to fall back on: the mode change IS the view change
		// for whoever is on that agent. `--background` therefore means "skip it
		// rather than move me", and the CLI has to decide because the desktop's
		// switch_mode is fire-and-forget - a renderer-side decline would come back
		// looking exactly like a success.
		it('refuses when the target is the agent currently on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');

			await expect(switchMode('agent-1', 'terminal', { background: true })).rejects.toThrow(
				'__exit__'
			);

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--focus'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('goes through for an agent that is not on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('some-other-agent');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', { background: true });

			// Switching an off-screen agent changes no pixels, so background
			// placement has nothing to object to.
			expect(getPayload().mode).toBe('terminal');
			expect(getPayload().background).toBe(true);
		});

		it('switches the on-screen agent anyway with --focus', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', { focus: true });

			expect(getPayload().background).toBe(false);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('defaults to foreground, so the plain verb still works on screen', async () => {
			vi.mocked(readActiveAgentId).mockReturnValue('agent-1');
			const getPayload = mockSend({ success: true });

			await switchMode('agent-1', 'terminal', {});

			expect(getPayload().background).toBe(false);
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});

	it('switch-mode rejects an invalid mode before connecting', async () => {
		await expect(switchMode('agent-1', 'banana', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid mode'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

// ===== from src/__tests__/cli/commands/movement.test.ts =====

const mockMkdirSync = vi.fn();

const mockWriteFileSync = vi.fn();

function mockInspection(result: Record<string, unknown>): void {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand: vi.fn().mockResolvedValue(result) } as never)
	);
}

describe('movement inspect command', () => {
	let consoleLogSpy: MockInstance;
	let consoleErrorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('prints a JSON error when output is missing', async () => {
		await expect(movementInspect('mockup', { json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'movement inspect requires --output <png>',
		});
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('prints one JSON error when the live frame is unavailable', async () => {
		mockInspection({ success: false, error: 'HTML Movement is not visible' });

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);

		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'HTML Movement is not visible',
		});
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	it('prints a JSON error for an invalid screenshot', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: 'not-a-data-url',
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
	});

	it('prints a JSON error for malformed screenshot base64', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: 'data:image/png;base64,%%%%',
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it('prints a JSON error for non-PNG screenshot data', async () => {
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: `data:image/png;base64,${Buffer.from('not a PNG').toString('base64')}`,
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro returned an invalid designer screenshot',
		});
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it('prints a JSON error when the screenshot cannot be written', async () => {
		mockWriteFileSync.mockImplementation(() => {
			throw new Error('disk full');
		});
		mockInspection({
			success: true,
			inspection: {
				imageDataUrl: `data:image/png;base64,${Buffer.from([
					0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
				]).toString('base64')}`,
				ready: true,
				viewport: { width: 800, height: 600 },
				image: { width: 800, height: 600, scaleFactor: 1 },
				logs: [],
			},
		});

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'disk full',
		});
	});

	it('prints a JSON error when Maestro cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));

		await expect(movementInspect('mockup', { output: 'mockup.png', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'Maestro is not running',
		});
	});
});

describe('movement begin command', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('reserves an HTML shell without authored content', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementBegin('startup', {
			title: 'Loopline startup',
			x: '24',
			y: '36',
			width: '760',
			height: '520',
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'begin',
				id: 'startup',
				viewType: 'html',
				title: 'Loopline startup',
				x: 24,
				y: 36,
				width: 760,
				height: 520,
			},
			'movement_result'
		);
	});

	it('requires a title', async () => {
		await expect(movementBegin('startup', { title: '   ', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('prints a JSON error for a non-numeric position', async () => {
		await expect(
			movementBegin('startup', { title: 'Loopline startup', x: 'left', json: true })
		).rejects.toThrow('__exit__');

		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ success: false, error: '--x must be a number' })
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});

describe('movement progress command', () => {
	let consoleLogSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('reports a phase without creating a Movement window', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementProgress('startup', {
			title: 'Loopline startup',
			phase: 'composing',
			json: true,
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'progress',
				id: 'startup',
				title: 'Loopline startup',
				phase: 'composing',
				step: 1,
				steps: 1,
			},
			'movement_result'
		);
		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: true,
			id: 'startup',
			op: 'progress',
		});
	});

	it('reports progress within a subdivided phase', async () => {
		const sendCommand = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await movementProgress('startup', {
			title: 'Loopline startup',
			phase: 'refining',
			step: '3',
			steps: '6',
			notes: 'sixteenth,sixteenth+dotted,sixteenth+triad,sixteenth+tie,eighth,eighth',
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'progress',
				id: 'startup',
				title: 'Loopline startup',
				phase: 'refining',
				step: 3,
				steps: 6,
				notes: [
					{ value: 'sixteenth' },
					{ value: 'sixteenth', dotted: true },
					{ value: 'sixteenth', triad: true },
					{ value: 'sixteenth', tie: true },
					{ value: 'eighth' },
					{ value: 'eighth' },
				],
			},
			'movement_result'
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"Concerto 'Loopline startup' is refining, step 3 of 6"
		);
	});

	it('rejects malformed musical notation', async () => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'refining',
				notes: 'eighth,eighth+tie',
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: '--notes cannot tie the final note forward',
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('rejects a phase outside the Concerto pipeline', async () => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'sketching',
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: '--phase must be one of: composing, refining, arranging, reviewing, testing',
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it.each([
		{ step: '0', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '5', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '1', steps: '9', error: '--steps must be an integer from 1 through 8' },
		{ step: '1.5', steps: '4', error: '--step must be an integer from 1 through --steps (4)' },
		{ step: '1', steps: 'many', error: '--steps must be a number' },
	])('rejects invalid phase subdivision: $step of $steps', async ({ step, steps, error }) => {
		await expect(
			movementProgress('startup', {
				title: 'Loopline startup',
				phase: 'refining',
				step,
				steps,
				json: true,
			})
		).rejects.toThrow('__exit__');

		expect(JSON.parse(consoleLogSpy.mock.calls[0][0])).toEqual({ success: false, error });
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});
