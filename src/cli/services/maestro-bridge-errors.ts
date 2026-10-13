// The failures a call to the running app can end in, kept free of imports so
// `exitCodeForError()` can recognise them without loading the WebSocket client
// (which tests replace wholesale). `maestro-client.ts` re-exports all three.

/**
 * Thrown when no running app can be reached: no discovery file, a stale one
 * left by a crash, or a socket that would not open. Carrying a distinct type
 * lets every verb map it to the `NotRunning` exit code without parsing text.
 */
export class MaestroNotRunningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MaestroNotRunningError';
	}
}

/**
 * Thrown when the running app echoes a command back unhandled - i.e. it does
 * not recognize the message type. This almost always means the desktop app is
 * an older build than this CLI (a new command was added since the app was last
 * built/restarted). Carrying a distinct type lets callers map it to the
 * `Unsupported` exit code and print a "rebuild/restart the app" hint instead of
 * a generic timeout.
 */
export class UnsupportedCommandError extends Error {
	readonly commandType: string;
	constructor(commandType: string) {
		super(
			`The running Maestro app does not support the '${commandType}' command. ` +
				'It is likely an older build - rebuild and restart the desktop app, then retry.'
		);
		this.name = 'UnsupportedCommandError';
		this.commandType = commandType;
	}
}

/** Thrown when the app was reachable but did not answer a command in time. */
export class CommandTimeoutError extends Error {
	readonly responseType: string;
	constructor(responseType: string) {
		super(
			`Timed out waiting for the Maestro app to respond (expected '${responseType}'). ` +
				'The app is reachable but its renderer did not reply - it may be busy or unresponsive.'
		);
		this.name = 'CommandTimeoutError';
		this.responseType = responseType;
	}
}
