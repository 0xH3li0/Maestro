/** Loaded solely by the trusted confirmation window, never the SPA or a plugin. */
import { contextBridge, ipcRenderer } from 'electron';
const prefix = '--plugin-confirmation=';
const argument = process.argv.find((value) => value.startsWith(prefix));
let offer: unknown = null;
try {
	offer = JSON.parse(Buffer.from(argument?.slice(prefix.length) ?? '', 'base64').toString('utf8'));
} catch {
	/* closed */
}
contextBridge.exposeInMainWorld(
	'pluginConfirmation',
	Object.freeze({
		offer,
		confirm: (nonce: string, approved: boolean, password?: string) =>
			ipcRenderer.invoke('plugin-confirmation:call', {
				nonce,
				approved,
				...(password === undefined ? {} : { password }),
			}),
	})
);
