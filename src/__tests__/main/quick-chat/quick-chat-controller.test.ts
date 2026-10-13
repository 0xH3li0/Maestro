/**
 * Quick Chat controller - the part a voice session bound to Quick Chat uses.
 *
 * `showForVoice` puts the window on screen and names it as the session's owner.
 * It refuses (null) when Quick Chat is turned off, so the caller refuses the
 * session instead of opening a microphone with nothing to show it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const windowState = vi.hoisted(() => ({ visible: false, id: null as string | null }));

vi.mock('electron', () => ({
	app: { focus: vi.fn() },
	ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/global-hotkey-manager', () => ({
	setNamedGlobalHotkey: vi.fn(() => true),
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => !!win,
}));
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn(
		async (_win: unknown, _channel: string, options: { fallback: unknown }) => options.fallback
	),
}));
vi.mock('../../../main/quick-chat/quick-chat-window', () => ({
	closeQuickChatWindow: vi.fn(),
	getQuickChatWindow: vi.fn(() => null),
	getQuickChatWindowBounds: vi.fn(() => null),
	getQuickChatWindowId: vi.fn(() => windowState.id),
	hideQuickChatWindow: vi.fn(() => {
		windowState.visible = false;
	}),
	isQuickChatWindowPinned: vi.fn(() => true),
	isQuickChatWindowVisible: vi.fn(() => windowState.visible),
	setQuickChatLayout: vi.fn(),
	setQuickChatWindowPinned: vi.fn(),
	setQuickChatWindowBounds: vi.fn(),
	// Creating the window is what gives it an id.
	showQuickChatWindow: vi.fn(() => {
		windowState.visible = true;
		windowState.id = 'quick-window';
	}),
	toggleQuickChatWindow: vi.fn(),
}));

import { createQuickChatController } from '../../../main/quick-chat/quick-chat-controller';
import { showQuickChatWindow } from '../../../main/quick-chat/quick-chat-window';

function makeController(quickChatEnabled: boolean) {
	return createQuickChatController({
		settingsStore: {
			get: (key: string) =>
				key === 'encoreFeatures' ? { quickChat: quickChatEnabled } : undefined,
			onDidChange: vi.fn(),
		},
		windowDeps: {} as never,
		getMainWindow: () => ({ webContents: { send: vi.fn() } }) as never,
		getWindowForSession: () => null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	windowState.visible = false;
	windowState.id = null;
});

describe('QuickChatController.showForVoice', () => {
	it('shows the window and names it as the owner of the session', () => {
		const controller = makeController(true);

		expect(controller.showForVoice()).toBe('quick-window');
		expect(showQuickChatWindow).toHaveBeenCalledTimes(1);
	});

	it('does not show a window that is already on screen: the press came from it', () => {
		// Showing again refocuses the composer, in the middle of a press.
		const controller = makeController(true);
		windowState.visible = true;
		windowState.id = 'quick-window';

		expect(controller.showForVoice()).toBe('quick-window');
		expect(showQuickChatWindow).not.toHaveBeenCalled();
	});

	it('refuses when Quick Chat is turned off, and opens no window', () => {
		const controller = makeController(false);

		expect(controller.showForVoice()).toBeNull();
		expect(showQuickChatWindow).not.toHaveBeenCalled();
	});
});
