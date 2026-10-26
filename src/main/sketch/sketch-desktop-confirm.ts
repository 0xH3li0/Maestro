/**
 * The Sketch Book desktop confirmation (spec section 1, A1): the native
 * Allow / Deny dialog the conductor answers when an agent asks for something
 * only a person may decide, such as sharing a sketch or allowing a cloud
 * screen. Deny is the default and the cancel answer, so closing the dialog or
 * pressing Escape never allows anything.
 *
 * One dialog for every A1 verb: `sketch-cloud-consent.ts` (consent grants)
 * and `sketch-service.ts` (share, unshare, revoke-link, rotate) both call it.
 */

import { BrowserWindow, dialog } from 'electron';

export interface SketchDesktopConfirmPrompt {
	title: string;
	message: string;
	detail: string;
	/** The agent that asked, when an agent caller asked (A1). Named in the dialog. */
	requestedBy?: string;
}

/** The dialog's detail text: the prompt's detail, then who asked. */
export function sketchConfirmDetail(prompt: SketchDesktopConfirmPrompt): string {
	const asker = prompt.requestedBy
		? `\n\nThe agent "${prompt.requestedBy}" asked for this. Allow it only if you meant to.`
		: '';
	return `${prompt.detail}${asker}`;
}

/** Ask on the focused (or first) window. Resolves true only on Allow. */
export async function confirmSketchActionOnDesktop(
	prompt: SketchDesktopConfirmPrompt
): Promise<boolean> {
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: prompt.title,
		message: prompt.message,
		detail: sketchConfirmDetail(prompt),
		buttons: ['Allow', 'Deny'],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
	};
	const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	const answer = parent
		? await dialog.showMessageBox(parent, options)
		: await dialog.showMessageBox(options);
	return answer.response === 0;
}
