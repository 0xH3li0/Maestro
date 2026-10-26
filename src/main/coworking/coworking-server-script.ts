/**
 * Source for the bundled coworking MCP server script.
 *
 * The agent's MCP client spawns this script as a stdio subprocess (per the user-level
 * MCP config we install via `coworking-installer`). The subprocess speaks the MCP wire
 * protocol on stdin/stdout, and connects back to Maestro main via the Unix-domain
 * socket / named pipe whose path is in `MAESTRO_COWORKING_SOCKET`.
 *
 * We write the script as a self-contained CommonJS file to `<userData>/coworking-mcp-server.js`
 * on every app `ready`. That gives us:
 *   - a stable absolute path users can reference in their MCP config (survives upgrades)
 *   - no dependency on the Maestro app bundle being on disk at a known path
 *   - no bundler step in PR #1 (script is plain Node - only built-ins)
 *
 * The bridge client and the MCP stdio loop are shared with Sketch Book's server
 * (`buildMcpStdioServerScript()` in utils/mcp-stdio-server-script.ts). This file
 * supplies the coworking tool suite: terminal reads (`list_terminals`, `read_terminal`),
 * browser reads (`list_browsers`, `get_browser_url`, `read_browser`) and the
 * permission-gated browser interaction tools (`browser_navigate` ... `browser_close_tab`).
 */

import {
	buildMcpStdioServerScript,
	type McpToolDefinition,
} from '../utils/mcp-stdio-server-script';
import {
	COWORKING_MCP_SERVER_NAME,
	COWORKING_SESSION_ID_ENV_VAR,
	COWORKING_SOCKET_ENV_VAR,
	COWORKING_SOCKET_OVERRIDE_ENV_VAR,
} from './coworking-types';

const COWORKING_TOOLS: ReadonlyArray<McpToolDefinition> = [
	{
		name: 'list_terminals',
		description:
			'List terminal tabs in your own Maestro session (the agent that spawned this MCP server). ' +
			'Returns an array of { id, cwd, title } where id is a stable readable handle like "term:3". ' +
			'You will never see terminals belonging to other Maestro sessions, regardless of which tab the user has focused.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'read_terminal',
		description:
			'Read the scrollback contents of a terminal tab by id, scoped to your own Maestro session. ' +
			'Optionally tail-truncate to the last N lines.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Terminal id, e.g. "term:3" (from list_terminals).' },
				lines: {
					type: 'integer',
					minimum: 1,
					description: 'If set, return only the last N lines.',
				},
			},
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_browsers',
		description:
			'List the in-app browser tabs in your own Maestro session (the agent that spawned this MCP server). ' +
			'Returns an array of { id, url, title, canGoBack, canGoForward, isLoading } where id is a stable handle like "browser:2". ' +
			'You only ever see browser tabs in your own session, regardless of which tab the user has focused.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'get_browser_url',
		description:
			'Get the current URL, title, and loading state of a browser tab by id, scoped to your own Maestro session. ' +
			'Returns { id, url, title, isLoading }; poll isLoading (or list_browsers) to confirm a page finished loading before reading it.',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: 'Browser tab id, e.g. "browser:2" (from list_browsers).',
				},
			},
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_browser',
		description:
			'Read the rendered text (or HTML) of a browser tab by id, scoped to your own Maestro session. ' +
			'Waits for the page to finish loading before reading, so a read right after browser_navigate returns the loaded page (bounded; a still-loading page is read best-effort). ' +
			'Use format "text" or "innerText" for the visible page text, or "html" for the page markup. ' +
			'Optionally scope the read to the first element matching a CSS selector, and/or cap the output with maxChars (head-truncated).',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				format: {
					type: 'string',
					enum: ['text', 'innerText', 'html'],
					description: 'Output format (default "text").',
				},
				selector: {
					type: 'string',
					description: 'If set, read only the first element matching this CSS selector.',
				},
				maxChars: {
					type: 'integer',
					minimum: 1,
					description: 'If set, return only the first N characters.',
				},
			},
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_navigate',
		description:
			'Navigate a browser tab to a URL (or search query), scoped to your own Maestro session. ' +
			'Requires browser interaction to be enabled for this agent.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				url: { type: 'string', description: 'URL or search text to load.' },
			},
			required: ['id', 'url'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_back',
		description:
			'Navigate a browser tab back in history (scoped to your own session; requires browser interaction enabled).',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_forward',
		description:
			'Navigate a browser tab forward in history (requires browser interaction enabled).',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_reload',
		description: 'Reload a browser tab (requires browser interaction enabled).',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_stop',
		description: 'Stop loading a browser tab (requires browser interaction enabled).',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_click',
		description:
			'Click the first element matching a CSS selector in a browser tab (requires browser interaction enabled).',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				selector: { type: 'string', description: 'CSS selector of the element to click.' },
			},
			required: ['id', 'selector'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_type',
		description:
			'Type text into the first element matching a CSS selector (sets value, fires input/change events). Requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				selector: { type: 'string', description: 'CSS selector of the input/textarea.' },
				text: { type: 'string', description: 'Text to set as the value.' },
			},
			required: ['id', 'selector', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_eval',
		description:
			'Evaluate JavaScript in a browser tab and return the result. Powerful; requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				code: {
					type: 'string',
					description: 'JavaScript expression or statements to run in the page.',
				},
			},
			required: ['id', 'code'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_screenshot',
		description:
			'Capture a PNG screenshot of a browser tab (returned as an image). Most reliable on the visible tab. Requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_wait_for',
		description:
			'Wait until an element matching a CSS selector appears in a browser tab (or the timeout elapses). ' +
			'Useful after navigate/click to let dynamic pages settle. Requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' },
				selector: { type: 'string', description: 'CSS selector to wait for.' },
				timeoutMs: {
					type: 'integer',
					minimum: 1,
					maximum: 30000,
					description: 'Max wait in milliseconds (default 10000, capped at 30000).',
				},
			},
			required: ['id', 'selector'],
			additionalProperties: false,
		},
	},
	{
		name: 'browser_new_tab',
		description:
			'Open a new in-app browser tab in your own Maestro session, optionally at a URL. ' +
			'Set ephemeral=true for an incognito-style tab: its session is isolated and kept in memory only (no cookies/logins are ever written to disk). ' +
			'The new tab does not have an id yet: call list_browsers afterwards to address it. ' +
			'Requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to load (defaults to the browser home page).' },
				ephemeral: {
					type: 'boolean',
					description: 'If true, use an in-memory session (no persisted cookies/logins).',
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: 'browser_close_tab',
		description:
			'Close a browser tab by id, scoped to your own Maestro session. Requires browser interaction enabled.',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Browser tab id, e.g. "browser:2".' } },
			required: ['id'],
			additionalProperties: false,
		},
	},
];

/**
 * The coworking `callTool(name, args)`, emitted into the script. Interaction ops
 * (browserInteract) can block on a human approval dialog, so they get a much
 * longer cap than reads, kept slightly above the main-process browser-op timeout
 * so the main side fails first with a clean message.
 */
const COWORKING_CALL_TOOL_SOURCE = String.raw`const BRIDGE_INTERACT_TIMEOUT_MS = 330000;

// Browser interaction tools all funnel through the bridge 'browserInteract'
// method (gated by the per-agent permission in main). Each entry maps a tool
// name to the BrowserOp it sends.
const BROWSER_INTERACTION_OPS = {
  browser_navigate: (a) => ({ kind: 'navigate', url: a.url }),
  browser_back: () => ({ kind: 'back' }),
  browser_forward: () => ({ kind: 'forward' }),
  browser_reload: () => ({ kind: 'reload' }),
  browser_stop: () => ({ kind: 'stop' }),
  browser_click: (a) => ({ kind: 'click', selector: a.selector }),
  browser_type: (a) => ({ kind: 'type', selector: a.selector, text: a.text }),
  browser_eval: (a) => ({ kind: 'eval', code: a.code }),
  browser_screenshot: () => ({ kind: 'screenshot' }),
  browser_wait_for: (a) => ({ kind: 'waitFor', selector: a.selector, timeoutMs: a.timeoutMs }),
  browser_new_tab: (a) => ({ kind: 'newTab', url: a.url, ephemeral: a.ephemeral }),
  browser_close_tab: () => ({ kind: 'closeTab' }),
};

async function callTool(name, args) {
  if (name === 'list_terminals') {
    const result = await bridgeCall('listTerminals', {});
    return jsonResult(result);
  }
  if (name === 'read_terminal') {
    const result = await bridgeCall('readTerminal', args);
    const header =
      'terminal=' +
      (result && result.id) +
      ' totalLines=' +
      (result && result.totalLines) +
      (result && result.truncated ? ' (tail-truncated)' : '');
    const text = header + '\n----- BEGIN BUFFER -----\n' + (result && result.content) + '\n----- END BUFFER -----';
    return { content: [{ type: 'text', text }] };
  }
  if (name === 'list_browsers') {
    const result = await bridgeCall('listBrowsers', {});
    return jsonResult(result);
  }
  if (name === 'get_browser_url') {
    const result = await bridgeCall('getBrowserUrl', args);
    return jsonResult(result);
  }
  if (name === 'read_browser') {
    const result = await bridgeCall('readBrowser', args);
    const header =
      'browser=' + (result && result.id) +
      ' url=' + (result && result.url) +
      ' format=' + (result && result.format) +
      ' totalChars=' + (result && result.totalChars) +
      (result && result.truncated ? ' (head-truncated)' : '');
    const text =
      header + '\n----- BEGIN PAGE -----\n' + (result && result.content) + '\n----- END PAGE -----';
    return { content: [{ type: 'text', text }] };
  }
  if (Object.prototype.hasOwnProperty.call(BROWSER_INTERACTION_OPS, name)) {
    const op = BROWSER_INTERACTION_OPS[name](args);
    const result = await bridgeCall('browserInteract', { id: args.id, op: op }, BRIDGE_INTERACT_TIMEOUT_MS);
    if (op.kind === 'screenshot' && result && result.dataUrl) {
      const base64 = String(result.dataUrl).replace(/^data:image\/[^;]+;base64,/, '');
      return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
    }
    return jsonResult(result);
  }
  return null;
}`;

let cachedScript: string | null = null;

/** Returns the contents of the bundled MCP server script. */
export function getCoworkingServerScript(): string {
	cachedScript ??= buildMcpStdioServerScript({
		title: 'Coworking',
		serverName: COWORKING_MCP_SERVER_NAME,
		bridgeLabel: 'coworking bridge',
		socketOverrideEnvVar: COWORKING_SOCKET_OVERRIDE_ENV_VAR,
		socketEnvVar: COWORKING_SOCKET_ENV_VAR,
		identityEnvVar: COWORKING_SESSION_ID_ENV_VAR,
		identityParam: 'sessionId',
		tools: COWORKING_TOOLS,
		callToolSource: COWORKING_CALL_TOOL_SOURCE,
		// 10s comfortably accommodates a renderer round-trip (the main-process side
		// caps the buffer-fetch at 5s) plus jitter.
		rpcTimeoutMs: 10000,
	});
	return cachedScript;
}
