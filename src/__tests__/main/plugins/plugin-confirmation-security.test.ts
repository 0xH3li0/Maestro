import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const { ipc, windows } = vi.hoisted(() => ({
	ipc: new Map<string, Function>(),
	windows: [] as any[],
}));
vi.mock('electron', () => ({
	ipcMain: { handle: (name: string, fn: Function) => ipc.set(name, fn) },
	BrowserWindow: class extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), {
			id: 1,
			mainFrame: { routingId: 42, url: 'file:///fixture/plugin-confirmation.html' },
			setWindowOpenHandler() {},
		});
		destroyed = false;
		focused = true;
		constructor(public options: any) {
			super();
			windows.push(this);
		}
		setMenu() {}
		async loadFile() {}
		show() {}
		isFocused() {
			return this.focused;
		}
		isDestroyed() {
			return this.destroyed;
		}
		close() {
			if (!this.destroyed) {
				this.destroyed = true;
				this.emit('closed');
			}
		}
	},
}));
import { PluginConfirmationWindows } from '../../../main/plugins/plugin-confirmation-window';

beforeEach(() => {
	ipc.clear();
	windows.length = 0;
});
function open() {
	const host = new PluginConfirmationWindows('/fixture'),
		controller = new AbortController();
	const commit = vi.fn(() => ({ revision: 1 }));
	const promise = host.confirm(
		{
			kind: 'record',
			pluginId: 'com.example.fixture',
			key: 'policy',
			summary: 'Opaque grant',
			value: { disabled: true },
		},
		controller.signal,
		() => {},
		commit
	);
	const window = windows[0],
		wc = window.webContents;
	const encoded = window.options.webPreferences.additionalArguments[0].split('=')[1];
	const offer = JSON.parse(Buffer.from(encoded, 'base64').toString());
	const event = { sender: wc, senderFrame: wc.mainFrame };
	const activate = () => wc.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
	const call = (request = { nonce: offer.nonce, approved: true }, e = event) =>
		ipc.get('plugin-confirmation:call')!(e, request);
	return { promise, commit, window, wc, event, offer, activate, call, controller };
}
describe('trusted generic confirmation surface', () => {
	it('accepts only exact-frame nonce plus a fresh main-observed activation and captures original payload', async () => {
		const s = open();
		await Promise.resolve();
		expect(s.window.options.webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		});
		expect(s.call()).toEqual({ ok: false, error: 'PLUGIN_DENIED' });
		expect(s.commit).not.toHaveBeenCalled();
		s.activate();
		expect(s.call()).toEqual({ ok: true });
		expect(await s.promise).toEqual({ revision: 1 });
		expect(s.call()).toEqual({ ok: false, error: 'PLUGIN_DENIED' });
		expect(s.commit).toHaveBeenCalledTimes(1);
	});
	it('rejects a foreign sender, child frame, payload replacement and a forged nonce', async () => {
		const s = open();
		await Promise.resolve();
		s.activate();
		expect(s.call(undefined, { ...s.event, sender: {} })).toMatchObject({ ok: false });
		expect(s.call(undefined, { ...s.event, senderFrame: { ...s.wc.mainFrame } })).toMatchObject({
			ok: false,
		});
		expect(s.call({ nonce: 'invented', approved: true })).toMatchObject({ ok: false });
		expect(
			s.call({ nonce: s.offer.nonce, approved: true, value: { widened: true } } as any)
		).toMatchObject({ ok: false });
		expect(s.commit).not.toHaveBeenCalled();
		const denied = expect(s.promise).rejects.toMatchObject({ code: 'PLUGIN_CANCELED' });
		s.controller.abort();
		await denied;
	});
	it('cancels on plugin lifetime revocation and never accepts renderer claimed activation', async () => {
		const s = open();
		await Promise.resolve();
		expect(
			s.call({ nonce: s.offer.nonce, approved: true, userActivation: true } as any)
		).toMatchObject({ ok: false });
		const denied = expect(s.promise).rejects.toThrow();
		s.controller.abort();
		await denied;
		s.activate();
		expect(s.call()).toMatchObject({ ok: false });
		expect(s.commit).not.toHaveBeenCalled();
	});
});
