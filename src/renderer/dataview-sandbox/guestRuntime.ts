/**
 * The DataviewJS guest runtime (D4, M7): the page side of the sandbox bridge. It runs inside the isolated
 * `<webview>` guest, where note scripts run, and nowhere else.
 *
 * - A `run` message renders one block. The runtime builds the run's index from the snapshot
 *   (`PageIndex.fromSnapshot`, the same source resolution `VaultIndex` runs), gives the script a fresh `dv`
 *   object and container, runs it (`./inlineScript`, DEV-6), waits for the views it started, and answers
 *   `render.done` with the block's height, or `render.error` with upstream's `Evaluation Error:` text.
 *   After a run it sends `render.done` again whenever the block's height changes.
 * - `dv.query`, `dv.io.load`, and the calls built on them are requests the host answers by request id.
 * - A link click sends `open.link`; a task checkbox sends `toggle.task`.
 * - Everything the host sends goes through `parseSandboxMessage(raw, 'host')`; anything it refuses is
 *   dropped.
 */

import {
	PageIndex,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	openSandboxEnvelope,
	parseSandboxMessage,
	sandboxEnvelope,
	type DataviewResult,
	type SandboxGuestMessage,
	type SandboxHostMessage,
	type SandboxRunMessage,
} from '../../shared/dataview';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import { createDvApi, obsidianApiUnavailable } from './dvApi';
import { compileInlineScript } from './inlineScript';
import { LINK_PATH_ATTRIBUTE, LINK_URL_ATTRIBUTE, type GuestRenderContext } from './renderDom';

/** The element of `guest.html` that holds the blocks. */
export const GUEST_ROOT_ID = 'dataview-root';

/** Error text longer than this is cut; the bridge refuses a guest message over 1 MB. */
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

/** Upstream's preamble (`ui/views/js-view.ts`): a script's `this` is `dv`, under both of its names. */
const SCRIPT_PREAMBLE = 'const dataview = this;const dv = this;';

/**
 * A block's script as upstream runs it: the preamble, then the source, inside an async arrow when the source
 * mentions `await` (`asyncEvalInContext`), so top-level `await` works. The newline before the closing
 * brace keeps a trailing `//` comment from swallowing it.
 */
export function blockScriptBody(source: string): string {
	const script = SCRIPT_PREAMBLE + source;
	return script.includes('await') ? `return (async () => { ${script}\n})();` : script;
}

/**
 * Lock down the global object note scripts see. `app` (Obsidian's `window.app`) and `DataviewAPI` (the
 * plugin lookup) throw `Obsidian API not available in Maestro` (D5). The WebRTC constructors are removed,
 * because Chromium does not apply `connect-src` to them (as `src/main/concerto-html.ts` does). Safe to call
 * again on the same global.
 */
export function lockDownScriptGlobal(global: object): void {
	for (const name of ['app', 'DataviewAPI']) {
		Object.defineProperty(global, name, {
			get: obsidianApiUnavailable,
			enumerable: false,
			configurable: false,
		});
	}
	for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
		Object.defineProperty(global, name, {
			value: undefined,
			writable: false,
			enumerable: false,
			configurable: false,
		});
	}
}

export interface DataviewGuestOptions {
	document: Document;
	/** Where block output goes. */
	root: HTMLElement;
	/** The global object note scripts run against: `window` in the guest page. */
	scriptGlobal: object;
	/** Send one message to the host. */
	send(message: SandboxGuestMessage): void;
}

export interface DataviewGuest {
	/** Handle one message from the host. Resolves once it is handled; for `run`, once the run has settled. */
	receive(raw: unknown): Promise<void>;
}

interface Block {
	element: HTMLElement;
	/** The run the block shows, or is rendering. */
	runId: string | null;
	/** Whether that run finished, so height changes are reported. */
	done: boolean;
	/** The height last reported. */
	height: number | null;
}

function describeError(error: unknown): string {
	const stack = (error as { stack?: unknown } | null)?.stack;
	return typeof stack === 'string' ? stack : String(error);
}

export function createDataviewGuest(options: DataviewGuestOptions): DataviewGuest {
	const { document: doc, root, send } = options;
	lockDownScriptGlobal(options.scriptGlobal);

	const blocks = new Map<string, Block>();
	const replies = new Map<string, (message: SandboxHostMessage) => void>();
	let requestCount = 0;

	/** Send a request and wait for the host's reply to its id. */
	const ask = (build: (requestId: string) => SandboxGuestMessage): Promise<SandboxHostMessage> => {
		const requestId = `request-${++requestCount}`;
		const reply = new Promise<SandboxHostMessage>((resolve) => replies.set(requestId, resolve));
		send(build(requestId));
		return reply;
	};

	const queryDql = async (source: string, originPath: string): Promise<DataviewResult> => {
		// The host refuses a query that is not text; failing here keeps the run from waiting on it.
		if (typeof source !== 'string') throw new TypeError(`DQL must be text, not ${typeof source}.`);
		const reply = await ask((requestId) => ({ type: 'query.dql', requestId, source, originPath }));
		if (reply.type === 'query.dql.result') return reply.result;
		throw new Error(
			reply.type === 'request.failed' ? reply.message : 'The host sent no query result.'
		);
	};

	const loadText = async (path: string): Promise<string | null> => {
		// The host refuses a path outside the vault root; there is no such file for this page either.
		const normalized = normalizeRootRelativePath(path);
		if (!normalized) return null;
		const reply = await ask((requestId) => ({ type: 'io.load', requestId, path: normalized }));
		if (reply.type === 'io.load.result') return reply.text;
		throw new Error(reply.type === 'request.failed' ? reply.message : 'The host sent no file.');
	};

	const reportHeight = (blockId: string, block: Block, force: boolean): void => {
		if (!block.done || block.runId === null) return;
		const height = Math.max(0, Math.ceil(block.element.getBoundingClientRect().height));
		if (!force && height === block.height) return;
		block.height = height;
		send({ type: 'render.done', blockId, runId: block.runId, height });
	};

	const blockFor = (blockId: string): Block => {
		const existing = blocks.get(blockId);
		if (existing) return existing;
		const element = doc.createElement('div');
		element.className = 'dataview-block';
		element.setAttribute('data-block-id', blockId);
		root.append(element);
		const block: Block = { element, runId: null, done: false, height: null };
		blocks.set(blockId, block);
		const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
		if (typeof ResizeObserverCtor === 'function') {
			new ResizeObserverCtor(() => reportHeight(blockId, block, false)).observe(element);
		}
		return block;
	};

	const renderContext = (index: PageIndex, thisPath: string): GuestRenderContext => ({
		document: doc,
		originPath: thisPath,
		resolveLink: (linkpath, sourcePath) => index.resolveLink(linkpath, sourcePath),
		toggleTask: ({ path, line, text }) => {
			const normalized = normalizeRootRelativePath(path);
			if (!normalized || !Number.isSafeInteger(line) || line < 1) return;
			send({ type: 'toggle.task', path: normalized, line, text });
		},
	});

	/** Run one block's script into `container`. Null when it finished, else the error to show. */
	const execute = async (
		message: SandboxRunMessage,
		container: HTMLElement
	): Promise<string | null> => {
		let index: PageIndex;
		try {
			index = PageIndex.fromSnapshot(message.snapshot, async (path) => {
				const text = await loadText(path);
				if (text === null) throw new Error(`No such file: '${path}'.`);
				return text;
			});
		} catch (error) {
			return `Dataview: the index snapshot could not be read. ${describeError(error)}`;
		}

		// Views and queries the script started without awaiting them still belong to this run.
		const pending = new Set<Promise<unknown>>();
		const dv = createDvApi({
			index,
			thisPath: message.thisPath,
			container,
			render: renderContext(index, message.thisPath),
			queryDql,
			loadText,
			compile: (script) => compileInlineScript(doc, script),
			track: (work) => {
				pending.add(work);
				const forget = () => pending.delete(work);
				work.then(forget, forget);
				return work;
			},
		});

		try {
			const script = compileInlineScript(doc, {
				params: [],
				body: blockScriptBody(message.source),
				strict: true,
			});
			await script.call(dv);
			while (pending.size > 0) await Promise.allSettled([...pending]);
			return null;
		} catch (error) {
			return `Evaluation Error: ${describeError(error)}`;
		}
	};

	const run = async (message: SandboxRunMessage): Promise<void> => {
		const block = blockFor(message.blockId);
		block.runId = message.runId;
		block.done = false;
		block.height = null;
		// A fresh container per run: work a superseded run still has in flight writes into a detached node.
		const container = doc.createElement('div');
		block.element.replaceChildren(container);

		const error = await execute(message, container);
		if (block.runId !== message.runId) return;
		if (error === null) {
			block.done = true;
			reportHeight(message.blockId, block, true);
			return;
		}
		container.replaceChildren();
		send({
			type: 'render.error',
			blockId: message.blockId,
			runId: message.runId,
			message: error.slice(0, MAX_ERROR_MESSAGE_LENGTH),
		});
	};

	// Links never navigate the guest: their targets go to the host, which opens them the way the preview does.
	doc.addEventListener('click', (event) => {
		const anchor = (event.target as Element | null)?.closest?.('a');
		if (!anchor) return;
		const newTab = event.metaKey || event.ctrlKey;
		const path = anchor.getAttribute(LINK_PATH_ATTRIBUTE);
		if (path !== null) {
			event.preventDefault();
			send({ type: 'open.link', kind: 'file', path, newTab });
			return;
		}
		const href = anchor.getAttribute('href') ?? '';
		if (href.startsWith('#')) return;
		event.preventDefault();
		const url = anchor.getAttribute(LINK_URL_ATTRIBUTE) ?? href;
		if (/^https?:\/\//i.test(url)) send({ type: 'open.link', kind: 'url', url, newTab });
	});

	return {
		receive(raw) {
			const parsed = parseSandboxMessage(raw, 'host');
			if (!parsed.ok) {
				console.warn(`Dataview guest dropped a host message: ${parsed.reason}`);
				return Promise.resolve();
			}
			const message = parsed.message;
			if (message.type === 'run') return run(message);
			const settle = replies.get(message.requestId);
			if (settle) {
				replies.delete(message.requestId);
				settle(message);
			}
			return Promise.resolve();
		},
	};
}

/**
 * Start the guest in its page: messages travel as envelopes on the page's own window, which the guest
 * preload relays to and from the host (`ipcRenderer.sendToHost`, `webview.send`).
 */
export function startDataviewGuest(win: Window): DataviewGuest {
	const doc = win.document;
	const guest = createDataviewGuest({
		document: doc,
		root: doc.getElementById(GUEST_ROOT_ID) ?? doc.body,
		scriptGlobal: win,
		send: (message) => win.postMessage(sandboxEnvelope(SANDBOX_TO_HOST_CHANNEL, message), '*'),
	});
	// No `event.source` check: only this page and its preload can post here (the CSP forbids frames and main
	// denies new windows), and a host message forged by a note script misleads only that script's page.
	win.addEventListener('message', (event) => {
		const message = openSandboxEnvelope(event.data, SANDBOX_TO_GUEST_CHANNEL);
		if (message === undefined) return;
		guest.receive(message).catch((error) => {
			console.error(`Dataview guest failed on a host message: ${describeError(error)}`);
		});
	});
	return guest;
}
