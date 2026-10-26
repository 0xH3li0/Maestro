/**
 * Coworking bridge - main-process IPC server that the coworking-mcp-server
 * subprocess connects back to.
 *
 * Transport: Unix domain socket (Linux/macOS) or named pipe (Windows). Path
 * comes from `getBridgeSocketPath()` and is stable per-userData. The coworking
 * MCP server learns the path via the `MAESTRO_COWORKING_SOCKET` env var that
 * each per-agent installer writes into the user's MCP config.
 *
 * Wire format: newline-delimited JSON-RPC-shaped requests / responses
 * (`{id, method, params}` / `{id, result}` or `{id, error}`).
 *
 * Session binding: every connection MUST send `{method: "hello", params: {...}}`
 * as its first message. The bridge stores the resolved sessionId per-connection
 * and uses it to scope tool calls. Pre-handshake `listTerminals`/`readTerminal`
 * calls are rejected. This is what stops Agent A from reading Agent B's terminals
 * when the user switches focus mid-call (the privacy bug fixed in PR #948).
 *
 * The hello payload supports two resolution sources, in priority order:
 *   1. `sessionId`: injected via `MAESTRO_COWORKING_SESSION_ID` env at agent-CLI
 *      spawn time and propagated by the agent CLI to its MCP subprocess. Works
 *      for Claude Code and OpenCode.
 *   2. `ppid`: the MCP subprocess's parent PID. Used when the agent CLI does NOT
 *      propagate parent env (e.g. Codex, which only passes the env declared in
 *      its config TOML). The bridge walks the process tree up from `ppid` until
 *      it finds a known agent-CLI PID, then binds to that agent's session.
 *
 * Either source is sufficient. If both are absent, or `ppid` is sent but resolves
 * to no known agent, the bridge rejects the connection - fail closed.
 */

import type * as net from 'net';
import { createNdjsonSocketServer } from '../utils/ndjson-socket-server';
import { COWORKING_SOCKET_ENV_VAR } from './coworking-types';
import { getBridgeSocketPath } from './coworking-socket-path';
import type {
	BrowserOp,
	CoworkingBridgeRequest,
	CoworkingBridgeResponse,
	CoworkingBridgeMethod,
} from './coworking-types';
import { coworkingRegistry } from './coworking-registry';
import { bindHandshakeOwner, type HandshakeBindFailure } from './pid-resolution';
import type { CoworkingBrowserCaller } from '../../shared/coworkingBrowser';
import {
	browserInteract,
	getBrowserUrl,
	listBrowsers,
	listTerminals,
	readBrowser,
	readTerminal,
} from './coworking-tools';
import {
	recordBrowserAudit,
	redactBrowserOpDetail,
	type BrowserAuditEntry,
} from './coworking-audit';

const LOG_CTX = '[Coworking][Bridge]';

/** Run a browser tool call and emit one audit record with its outcome (ok or
 *  error). Denied calls are audited separately by the caller. */
async function auditedBrowserCall<T>(
	base: Omit<BrowserAuditEntry, 'ts' | 'status'>,
	run: () => Promise<T> | T
): Promise<T> {
	try {
		const result = await run();
		recordBrowserAudit({ ...base, ts: Date.now(), status: 'ok' });
		return result;
	} catch (err) {
		recordBrowserAudit({ ...base, ts: Date.now(), status: 'error' });
		throw err;
	}
}

/**
 * Optional fallback resolver: maps a peer-process PID (sent by the MCP
 * subprocess in its handshake as `ppid`) to the owning Maestro session id by
 * walking the process tree until a known agent-CLI PID is found. Wired by the
 * main-process startup so the bridge can support agent CLIs (notably Codex)
 * that do not propagate `MAESTRO_COWORKING_SESSION_ID` env into MCP subprocesses.
 */
export type CoworkingSessionFromPidResolver = (pid: number) => Promise<string | null>;

let resolveSessionFromPid: CoworkingSessionFromPidResolver | null = null;
let resolveCallerFromPid: ((pid: number) => Promise<CoworkingBrowserCaller | null>) | null = null;

/** Per-connection state keyed by socket. The sessionId is set on `hello` and
 *  stays put for the lifetime of the connection. */
const connections = new WeakMap<
	net.Socket,
	{ sessionId: string | null; caller?: CoworkingBrowserCaller }
>();

/** The bridge socket. Stopping it drops live connections as well. */
const bridgeServer = createNdjsonSocketServer({
	socketPath: getBridgeSocketPath,
	logContext: LOG_CTX,
	logCategory: 'Coworking',
	onConnect: (conn) => connections.set(conn, { sessionId: null }),
	onClose: (conn) => connections.delete(conn),
	onRequest: (conn, request) => dispatch(conn, request as CoworkingBridgeRequest),
});

/** What a failed `hello` tells the MCP subprocess, per binding failure. */
const HELLO_FAILURE_MESSAGES: Record<HandshakeBindFailure, string> = {
	missing: '`sessionId` or `ppid` is required for hello',
	mismatch: 'session id does not match caller process',
	'no-resolver': 'coworking bridge: ppid resolver not configured',
	unresolved: 'coworking bridge: could not resolve session from peer PID',
};

/** Env-var pair to embed in each agent's MCP-server config entry. */
export function getBridgeEnvVar(): { name: string; value: string } {
	return { name: COWORKING_SOCKET_ENV_VAR, value: getBridgeSocketPath() };
}

/** Start the bridge. Idempotent. Must be called inside `app.whenReady`. */
export async function startCoworkingBridge(options?: {
	resolveSessionFromPid?: CoworkingSessionFromPidResolver;
	resolveCallerFromPid?: (pid: number) => Promise<CoworkingBrowserCaller | null>;
}): Promise<void> {
	if (options?.resolveSessionFromPid !== undefined) {
		resolveSessionFromPid = options.resolveSessionFromPid;
	}
	if (options?.resolveCallerFromPid !== undefined)
		resolveCallerFromPid = options.resolveCallerFromPid;
	await bridgeServer.start();
}

/**
 * Stop the bridge. Idempotent. Called on app quit and when the coworking Encore
 * flag turns off: live MCP-server connections are dropped as well, so an agent
 * that connected while the feature was on cannot keep calling tools after it.
 */
export async function stopCoworkingBridge(): Promise<void> {
	await bridgeServer.stop();
}

/** Guard for the URL/search input an agent may navigate a browser tab to. The
 *  renderer treats this field as "URL or search query" and safely resolves bare
 *  hosts and free text to https, so those are allowed. When the input DOES parse
 *  as a URL we enforce a scheme allowlist: only http/https (plus about:blank)
 *  pass. Any other scheme is rejected - file: (local-file exfiltration via a
 *  follow-up read_browser), javascript: and data: (a second eval path that would
 *  bypass the eval approval gate), and privileged schemes like chrome:. */
function isAllowedNavigateUrl(url: string): boolean {
	const trimmed = url.trim();
	if (trimmed.toLowerCase() === 'about:blank') return true;
	let scheme: string;
	try {
		scheme = new URL(trimmed).protocol.toLowerCase();
	} catch {
		// Does not parse as a URL: a bare host ('example.com') or a search
		// query. The renderer's resolveBrowserTabNavigationTarget resolves these
		// to https, so allow them - matching the documented behavior.
		return true;
	}
	// Parsed as a URL: enforce the scheme allowlist.
	return scheme === 'http:' || scheme === 'https:';
}

/** Validate an untyped interaction op from the MCP JSON into a BrowserOp. Returns
 *  null for unknown kinds or missing required fields (caller maps to -32602).
 *  `read` is intentionally rejected here - reads go through `readBrowser`. */
function validateInteractionOp(raw: unknown): BrowserOp | null {
	if (typeof raw !== 'object' || raw === null) return null;
	if (!('kind' in raw) || typeof raw.kind !== 'string') return null;
	switch (raw.kind) {
		case 'back':
			return { kind: 'back' };
		case 'forward':
			return { kind: 'forward' };
		case 'reload':
			return { kind: 'reload' };
		case 'stop':
			return { kind: 'stop' };
		case 'screenshot':
			return { kind: 'screenshot' };
		case 'navigate':
			return 'url' in raw && typeof raw.url === 'string' && isAllowedNavigateUrl(raw.url)
				? { kind: 'navigate', url: raw.url }
				: null;
		case 'click':
			return 'selector' in raw && typeof raw.selector === 'string'
				? { kind: 'click', selector: raw.selector }
				: null;
		case 'type':
			return 'selector' in raw &&
				'text' in raw &&
				typeof raw.selector === 'string' &&
				typeof raw.text === 'string'
				? { kind: 'type', selector: raw.selector, text: raw.text }
				: null;
		case 'eval':
			return 'code' in raw && typeof raw.code === 'string'
				? { kind: 'eval', code: raw.code }
				: null;
		case 'waitFor': {
			if (!('selector' in raw) || typeof raw.selector !== 'string') return null;
			const timeoutMs = 'timeoutMs' in raw ? raw.timeoutMs : undefined;
			if (
				timeoutMs !== undefined &&
				(typeof timeoutMs !== 'number' ||
					!Number.isInteger(timeoutMs) ||
					timeoutMs <= 0 ||
					timeoutMs > 30000)
			) {
				return null;
			}
			return { kind: 'waitFor', selector: raw.selector, timeoutMs };
		}
		case 'newTab': {
			const url = 'url' in raw ? raw.url : undefined;
			// A provided url must clear the same scheme allowlist as navigate:
			// newTab mounts a real webview, and window-manager permits file: for
			// local HTML, so an unguarded newTab({url:'file:///…'}) + read_browser
			// is a local-file exfiltration path. Omitting url opens the home page.
			if (url !== undefined && (typeof url !== 'string' || !isAllowedNavigateUrl(url))) return null;
			const ephemeral = 'ephemeral' in raw ? raw.ephemeral : undefined;
			if (ephemeral !== undefined && typeof ephemeral !== 'boolean') return null;
			return { kind: 'newTab', url, ephemeral };
		}
		case 'closeTab':
			return { kind: 'closeTab' };
		default:
			return null;
	}
}

async function dispatch(
	conn: net.Socket,
	req: CoworkingBridgeRequest
): Promise<CoworkingBridgeResponse> {
	const method = req.method as CoworkingBridgeMethod;
	const state = connections.get(conn);
	try {
		if (method === 'hello') {
			const params = (req.params ?? {}) as { sessionId?: string | null; ppid?: number };
			// Explicit sessionId (env injected at spawn) wins, cross-checked
			// against the process tree; `ppid` alone is the fallback for agents
			// that don't propagate env (e.g. Codex CLI). No match fails closed - a
			// silent default would reintroduce the privacy hole PR #948 closed.
			const binding = await bindHandshakeOwner(
				{ claimedId: params.sessionId, ppid: params.ppid },
				resolveSessionFromPid
			);
			if (!binding.ok) {
				return {
					id: req.id,
					error: { code: -32602, message: HELLO_FAILURE_MESSAGES[binding.reason] },
				};
			}
			const bound = binding.ownerId;

			const caller =
				resolveCallerFromPid &&
				typeof params.ppid === 'number' &&
				Number.isInteger(params.ppid) &&
				params.ppid > 0
					? await resolveCallerFromPid(params.ppid)
					: null;
			if (caller && caller.sessionId !== bound) {
				return {
					id: req.id,
					error: { code: -32602, message: 'session id does not match caller process' },
				};
			}
			if (state) {
				state.sessionId = bound;
				state.caller = caller ?? undefined;
			}
			return { id: req.id, result: { ok: true } };
		}

		// Every other RPC requires a bound session.
		const sessionId = state?.sessionId;
		if (!sessionId) {
			return {
				id: req.id,
				error: {
					code: -32002,
					message:
						'coworking bridge: handshake required (send `hello` with sessionId or ppid first)',
				},
			};
		}

		if (method === 'listTerminals') {
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType: state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId),
					tool: 'list_terminals',
				},
				() => listTerminals(sessionId)
			);
			return { id: req.id, result };
		}
		if (method === 'readTerminal') {
			const params = (req.params ?? {}) as { id?: string; lines?: number };
			if (typeof params.id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType: state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId),
					tool: 'read_terminal',
					detail: `id=${params.id}${typeof params.lines === 'number' ? ` lines=${params.lines}` : ''}`,
				},
				() => readTerminal(sessionId, { id: params.id as string, lines: params.lines })
			);
			return { id: req.id, result };
		}
		if (method === 'listBrowsers') {
			const agentType = state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall({ sessionId, agentType, tool: 'list_browsers' }, () =>
				listBrowsers(sessionId)
			);
			return { id: req.id, result };
		}
		if (method === 'getBrowserUrl') {
			const params: Record<string, unknown> = req.params ?? {};
			const id = params.id;
			if (typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const agentType = state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall(
				{ sessionId, agentType, tool: 'get_browser_url', detail: `id=${id}` },
				() => getBrowserUrl(sessionId, { id })
			);
			return { id: req.id, result };
		}
		if (method === 'readBrowser') {
			const params: Record<string, unknown> = req.params ?? {};
			const id = params.id;
			if (typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const format = params.format;
			if (
				format !== undefined &&
				format !== 'text' &&
				format !== 'innerText' &&
				format !== 'html'
			) {
				return {
					id: req.id,
					error: {
						code: -32602,
						message: "`format` must be one of 'text', 'innerText', 'html'",
					},
				};
			}
			const maxChars = params.maxChars;
			if (
				maxChars !== undefined &&
				(typeof maxChars !== 'number' ||
					!Number.isInteger(maxChars) ||
					maxChars <= 0 ||
					maxChars > 2_000_000)
			) {
				return {
					id: req.id,
					error: {
						code: -32602,
						message: '`maxChars` must be a positive integer <= 2,000,000',
					},
				};
			}
			const selector = params.selector;
			if (selector !== undefined && typeof selector !== 'string') {
				return {
					id: req.id,
					error: { code: -32602, message: '`selector` must be a string' },
				};
			}
			const agentType = state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType,
					tool: 'read_browser',
					detail: `id=${id} format=${format ?? 'text'}${typeof selector === 'string' ? ` selector=${selector.slice(0, 120)}` : ''}`,
				},
				() => readBrowser(sessionId, { id, format, maxChars, selector })
			);
			return { id: req.id, result };
		}
		if (method === 'browserInteract') {
			const agentType = state?.caller?.provider ?? coworkingRegistry.getAgentType(sessionId);
			if (!coworkingRegistry.isBrowserInteractionEnabled(sessionId, state?.caller?.provider)) {
				recordBrowserAudit({
					ts: Date.now(),
					sessionId,
					agentType,
					tool: 'browser_interact',
					status: 'denied',
				});
				return {
					id: req.id,
					error: {
						code: -32002,
						message:
							'coworking bridge: browser interaction is not enabled for this agent (enable it in Settings -> Encore Features -> Coworking)',
					},
				};
			}
			const params: Record<string, unknown> = req.params ?? {};
			const op = validateInteractionOp(params.op);
			if (!op) {
				return { id: req.id, error: { code: -32602, message: 'invalid or missing `op`' } };
			}
			// `newTab` is session-scoped (creates a tab); every other op targets an
			// existing tab and requires its public id.
			const id = params.id;
			if (op.kind !== 'newTab' && typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType,
					tool: 'browser_interact',
					opKind: op.kind,
					detail: redactBrowserOpDetail(op),
				},
				() =>
					state?.caller
						? browserInteract(
								sessionId,
								{ id: typeof id === 'string' ? id : undefined, op },
								{ caller: state.caller }
							)
						: browserInteract(sessionId, { id: typeof id === 'string' ? id : undefined, op })
			);
			return { id: req.id, result };
		}
		return { id: req.id, error: { code: -32601, message: `Unknown method: ${String(method)}` } };
	} catch (err) {
		return {
			id: req.id,
			error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
		};
	}
}

/** Test-only: synthetic dispatch that bypasses the network and exposes per-connection state. */
export const __testing = {
	dispatch,
	connections,
	setResolveSessionFromPid(fn: CoworkingSessionFromPidResolver | null) {
		resolveSessionFromPid = fn;
	},
	setResolveCallerFromPid(fn: typeof resolveCallerFromPid) {
		resolveCallerFromPid = fn;
	},
};
