/**
 * Quick Chat window reveal tests.
 *
 * Contract: the first show creates the window hidden and reveals it on the
 * FIRST of `ready-to-show` or a short delay after the page finishes loading.
 * `ready-to-show` alone left the first hotkey press after launch doing nothing,
 * because the transparent panel never emitted it. A hide that lands while the
 * reveal is pending cancels it, and status reports a pending show as visible.
 *
 * The window lives in module state, so each test imports a fresh module.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { created } = vi.hoisted(() => ({ created: [] as unknown[] }));

vi.mock('electron', async () => {
	// vi.mock is hoisted above the file's imports, so the factory imports its own.
	const { EventEmitter } = await import('events');
	class MockBrowserWindow extends EventEmitter {
		visible = false;
		destroyed = false;
		bounds = { x: 0, y: 0, width: 560, height: 148 };
		webContents = Object.assign(new EventEmitter(), {
			send: vi.fn(),
			setWindowOpenHandler: vi.fn(),
		});
		show = vi.fn(() => {
			this.visible = true;
		});
		hide = vi.fn(() => {
			this.visible = false;
		});
		focus = vi.fn();
		loadURL = vi.fn();
		setAlwaysOnTop = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		setBounds = vi.fn((b) => {
			this.bounds = b;
		});
		getBounds = () => this.bounds;
		isVisible = () => this.visible;
		isFocused = () => this.visible;
		isDestroyed = () => this.destroyed;
		close = () => {
			this.destroyed = true;
			this.emit('closed');
		};
		constructor() {
			super();
			created.push(this);
		}
	}
	return {
		BrowserWindow: MockBrowserWindow,
		screen: {
			getCursorScreenPoint: () => ({ x: 0, y: 0 }),
			getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
		},
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../shared/platformDetection', () => ({
	isMacOS: () => true,
	isWindows: () => false,
	isLinux: () => false,
}));

type WindowModule = typeof import('../../../main/quick-chat/quick-chat-window');
type MockWindow = EventEmitter & {
	show: ReturnType<typeof vi.fn>;
	webContents: EventEmitter;
	isVisible: () => boolean;
};

const deps = {
	isDevelopment: true,
	preloadPath: '/preload.js',
	rendererProductionUrl: 'app://renderer/index.html',
	devServerUrl: 'http://localhost:5173/',
	windowRegistry: { create: vi.fn(() => 'quick-window'), remove: vi.fn() },
} as unknown as Parameters<WindowModule['showQuickChatWindow']>[0];

async function freshModule(): Promise<WindowModule> {
	vi.resetModules();
	return import('../../../main/quick-chat/quick-chat-window');
}

function lastWindow(): MockWindow {
	return created[created.length - 1] as MockWindow;
}

describe('Quick Chat window reveal', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reveals a fresh window after the page loads even when ready-to-show never fires', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		expect(win.show).not.toHaveBeenCalled();
		// A status read right after the show reports the show it asked for.
		expect(mod.isQuickChatWindowVisible()).toBe(true);

		win.webContents.emit('did-finish-load');
		vi.runAllTimers();

		expect(win.show).toHaveBeenCalledTimes(1);
		expect(win.isVisible()).toBe(true);
	});

	it('reveals on ready-to-show without waiting, and only once', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		win.emit('ready-to-show');
		expect(win.show).toHaveBeenCalledTimes(1);

		win.webContents.emit('did-finish-load');
		vi.runAllTimers();
		expect(win.show).toHaveBeenCalledTimes(1);
	});

	it('does not reveal a fresh window hidden before it painted', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		mod.hideQuickChatWindow();
		expect(mod.isQuickChatWindowVisible()).toBe(false);

		win.emit('ready-to-show');
		win.webContents.emit('did-finish-load');
		vi.runAllTimers();
		expect(win.show).not.toHaveBeenCalled();
	});

	it('shows an existing window immediately', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();
		win.emit('ready-to-show');
		mod.hideQuickChatWindow();

		mod.showQuickChatWindow(deps);
		expect(created).toHaveLength(1);
		expect(win.show).toHaveBeenCalledTimes(2);
		expect(mod.isQuickChatWindowVisible()).toBe(true);
	});
});
