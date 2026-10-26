/**
 * A host-owned local socket that speaks newline-delimited JSON, shared by the
 * MCP bridges whose stdio subprocesses dial back into the main process
 * (Coworking's `maestro-coworking`, Sketch Book's `maestro-sketch`).
 *
 * Transport: a Unix domain socket on POSIX, chmod 0600 so only this OS user can
 * connect, or a per-user named pipe on Windows. Each line is one JSON request;
 * the bridge's `onRequest` answers it and the reply goes back as one line. A
 * line that is not JSON closes the connection (the MCP subprocess logs and
 * exits).
 *
 * Lifecycle: `start()` is idempotent and single-flight, `stop()` closes the
 * server AND drops every live connection, so a feature switched off cannot keep
 * serving an agent that connected while it was on.
 */

import * as fs from 'fs';
import * as net from 'net';
import { logger } from './logger';

export interface NdjsonSocketServerOptions {
	/** The socket path, resolved on every start. */
	socketPath: () => string;
	/** Log line prefix, e.g. `[Coworking][Bridge]`. */
	logContext: string;
	/** Logger category, e.g. `Coworking`. */
	logCategory: string;
	/** Called for each accepted connection, before its first request. */
	onConnect?: (conn: net.Socket) => void;
	/** Called once when a connection closes. */
	onClose?: (conn: net.Socket) => void;
	/** Answer one parsed request. The returned value is written back as one line. */
	onRequest: (conn: net.Socket, request: unknown) => Promise<unknown>;
}

export interface NdjsonSocketServer {
	/** Listen on the socket. Idempotent; overlapping calls share one start. */
	start(): Promise<void>;
	/** Close the socket and drop live connections. Idempotent. */
	stop(): Promise<void>;
	/** True once the socket listens, until `stop()`. */
	isListening(): boolean;
}

export function createNdjsonSocketServer(options: NdjsonSocketServerOptions): NdjsonSocketServer {
	const { logContext, logCategory } = options;
	let server: net.Server | null = null;
	/**
	 * The start in progress, or null. `server` is only set once the socket
	 * listens, several awaits in, so two overlapping starts (a feature toggle
	 * reconciles once directly and once through the flag listener) would both
	 * pass the `server` check: the second would unlink the first one's live
	 * socket and leave its server open with nothing able to close it.
	 */
	let starting: Promise<void> | null = null;
	/** Every open connection, so stopping can drop them too. */
	const openSockets = new Set<net.Socket>();

	async function handleLine(conn: net.Socket, line: string): Promise<void> {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			conn.end();
			return;
		}
		const response = await options.onRequest(conn, request);
		conn.write(JSON.stringify(response) + '\n');
	}

	function handleConnection(conn: net.Socket): void {
		options.onConnect?.(conn);
		openSockets.add(conn);
		conn.setEncoding('utf8');
		let buffer = '';
		conn.on('data', (chunk) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				handleLine(conn, line).catch((err) => {
					logger.error(`${logContext} dispatch failed: ${String(err)}`, logCategory);
				});
			}
		});
		conn.on('error', (err) => {
			logger.warn(`${logContext} connection error: ${err.message}`, logCategory);
		});
		conn.on('close', () => {
			options.onClose?.(conn);
			openSockets.delete(conn);
		});
	}

	async function listen(): Promise<void> {
		const socketPath = options.socketPath();

		// Clean up a stale socket file from a prior crashed run (POSIX only).
		if (process.platform !== 'win32') {
			try {
				await fs.promises.unlink(socketPath);
			} catch (e) {
				const code = (e as NodeJS.ErrnoException)?.code;
				if (code && code !== 'ENOENT') {
					logger.warn(`${logContext} Could not clean stale socket: ${String(e)}`, logCategory);
				}
			}
		}

		const srv = net.createServer((conn) => handleConnection(conn));
		srv.on('error', (err) => {
			logger.error(`${logContext} server error: ${err.message}`, logCategory);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				srv.removeListener('listening', onListening);
				reject(err);
			};
			const onListening = () => {
				srv.removeListener('error', onError);
				resolve();
			};
			srv.once('error', onError);
			srv.once('listening', onListening);
			srv.listen(socketPath);
		});

		// Restrict the socket to the owner (POSIX). Node creates Unix sockets with
		// the process umask, which can leave them group/other-connectable, and the
		// bridges expose agent-scoped tools. (Windows named pipes are per-user via
		// the userData-slug name.)
		if (process.platform !== 'win32') {
			try {
				await fs.promises.chmod(socketPath, 0o600);
			} catch (e) {
				logger.warn(`${logContext} Could not chmod socket to 0600: ${String(e)}`, logCategory);
			}
		}

		server = srv;
		logger.info(`${logContext} listening on ${socketPath}`, logCategory);
	}

	return {
		async start() {
			if (server) return;
			if (!starting) {
				starting = listen().finally(() => {
					starting = null;
				});
			}
			await starting;
		},

		async stop() {
			// A stop that lands mid-start waits for the socket, then closes it.
			if (starting) await starting.catch(() => undefined);
			if (!server) return;
			const srv = server;
			server = null;
			const closed = new Promise<void>((resolve) => {
				srv.close(() => resolve());
			});
			for (const socket of openSockets) socket.destroy();
			openSockets.clear();
			await closed;
		},

		isListening() {
			return server !== null;
		},
	};
}
