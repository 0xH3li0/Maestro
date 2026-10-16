// Merged suites; original names and test bodies preserved; source-level hooks scoped to their suites:
//   - src/__tests__/main/app-menu.test.ts
//   - src/__tests__/main/checkin.test.ts
//   - src/__tests__/main/concerto-html.test.ts
//   - src/__tests__/main/constants.test.ts
//   - src/__tests__/main/themes.test.ts

import {
	installApplicationMenu,
	resetMenuShortcutKeysForTesting,
	setMenuShortcutKeys,
} from '../../main/app-menu';
import {
	CONCERTO_HTML_CSP,
	MAX_CONCERTO_HTML_BYTES,
	MAX_CONCERTO_HTML_DOCUMENTS,
	applyCadenzaHtmlPayload,
	applyMovementHtmlPayload,
	attachConcertoHtmlNavigationGuard,
	clearConcertoHtmlDocumentsForTests,
	createConcertoHtmlResponse,
	getConcertoHtmlDocumentRevision,
	injectConcertoDesignerBootstrap,
	releaseConcertoHtmlDocument,
	restoreConcertoHtmlDocument,
} from '../../main/concerto-html';
import {
	MAX_GROUP_CHAT_BUFFER_SIZE,
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	REGEX_MODERATOR_SESSION,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	REGEX_PARTICIPANT_FALLBACK,
	REGEX_PARTICIPANT_TIMESTAMP,
	REGEX_PARTICIPANT_UUID,
	debugLog,
} from '../../main/constants';
import { THEMES, getThemeById } from '../../main/themes';
import { CONCERTO_DESIGNER_CHANNEL, buildConcertoHtmlUrl } from '../../shared/concerto-html';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApplicationMenu, buildFromTemplate, send, getFocusedWindow, FakeBrowserWindow } =
	vi.hoisted(() => {
		const send = vi.fn();
		return {
			setApplicationMenu: vi.fn(),
			buildFromTemplate: vi.fn((template: unknown) => ({ template })),
			send,
			getFocusedWindow: vi.fn(),
			FakeBrowserWindow: class {
				isDestroyed = () => false;
				webContents = { isDestroyed: () => false, send };
			},
		};
	});
vi.mock('electron', () => ({
	app: { quit: vi.fn() },
	Menu: {
		setApplicationMenu: (...args: unknown[]) => setApplicationMenu(...args),
		buildFromTemplate: (...args: unknown[]) => buildFromTemplate(args[0]),
	},
	BrowserWindow: Object.assign(FakeBrowserWindow, {
		getFocusedWindow: () => getFocusedWindow(),
	}),
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/platformDetection', () => ({
	isMacOS: () => isMac,
}));

// ===== from src/__tests__/main/app-menu.test.ts =====

let isMac = true;

interface TemplateItem {
	label?: string;
	role?: string;
	type?: string;
	accelerator?: string;
	registerAccelerator?: boolean;
	submenu?: TemplateItem[];
	click?: (item: unknown, window: unknown, event?: unknown) => void;
}

/** Last template handed to Menu.buildFromTemplate. */
function lastTemplate(): TemplateItem[] {
	return buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[];
}

function menuNamed(label: string): TemplateItem {
	const found = lastTemplate().find((item) => item.label === label);
	if (!found) throw new Error(`no "${label}" menu in template`);
	return found;
}

/**
 * Find an item by its command name. Labels carry the keystroke appended after a
 * run of en-spaces (see `labelWithShortcut`), so match on the name portion.
 */
function itemNamed(menu: TemplateItem, label: string): TemplateItem {
	const found = menu.submenu?.find((item) => nameOf(item) === label);
	if (!found) throw new Error(`no "${label}" item in "${menu.label}" menu`);
	return found;
}

/** The command name half of a menu label, with any keystroke stripped. */
function nameOf(item: TemplateItem): string {
	return (item.label ?? '').split('\u2002')[0];
}

/** The keystroke half of a menu label, or undefined when none is shown. */
function shortcutOf(item: TemplateItem): string | undefined {
	const parts = (item.label ?? '').split(/\u2002+/);
	return parts.length > 1 ? parts[1] : undefined;
}

describe('app menu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMenuShortcutKeysForTesting();
		isMac = true;
	});

	it('installs File, Edit, View and Window menus on macOS', () => {
		installApplicationMenu();

		const labels = lastTemplate().map((item) => item.label ?? item.role);
		expect(labels).toEqual(['appMenu', 'File', 'Edit', 'View', 'Window']);
	});

	it('removes the menu bar entirely off macOS', () => {
		isMac = false;
		installApplicationMenu();

		expect(setApplicationMenu).toHaveBeenCalledWith(null);
		expect(buildFromTemplate).not.toHaveBeenCalled();
	});

	// The whole design rests on the renderer keeping ownership of every
	// keystroke. An `accelerator` on a command item hands it to NSMenu instead,
	// which swallows the keydown before the web contents ever sees it -
	// including Option+N, which macOS users press to type an 'n'.
	//
	// `registerAccelerator: false` does NOT prevent that here: Electron marks it
	// `@platform linux,win32` and macOS ignores it, so the only safe answer is
	// to not set an accelerator at all. Quit is the single exception, and it is
	// deliberate: Cmd+Q is a real OS-level action and its handler reads the
	// click event's modifier flags to swallow Opt+Cmd+Q.
	it('never sets an accelerator on a command item', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'], closeTab: ['Meta', 'w'] });

		const commands = lastTemplate()
			.flatMap((menu) => menu.submenu ?? [])
			.filter((item) => item.click && item.label !== 'Quit Maestro');

		expect(commands.length).toBeGreaterThan(0);
		for (const item of commands) {
			expect(item.accelerator).toBeUndefined();
		}
	});

	it('still shows the keystroke, as label text rather than an accelerator', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		const item = itemNamed(menuNamed('View'), 'Switch AI / Shell Mode');
		expect(item.label).toContain('⌘J');
		expect(item.accelerator).toBeUndefined();
	});

	it('keeps Cmd+W and Cmd+Z out of the natively-registered roles', () => {
		installApplicationMenu();

		const windowRoles = menuNamed('Window').submenu?.map((item) => item.role);
		expect(windowRoles).not.toContain('close');

		const editRoles = menuNamed('Edit').submenu?.map((item) => item.role);
		expect(editRoles).not.toContain('undo');
		expect(editRoles).not.toContain('redo');
	});

	it('renders the keystroke the renderer reported, in macOS symbols', () => {
		setMenuShortcutKeys({
			toggleMode: ['Meta', 'j'],
			toggleSidebar: ['Alt', 'Meta', 'ArrowLeft'],
			goToAutoRun: ['Meta', 'Shift', '1'],
			killInstance: ['Meta', 'Shift', 'Backspace'],
		});

		const view = menuNamed('View');
		expect(shortcutOf(itemNamed(view, 'Switch AI / Shell Mode'))).toBe('⌘J');
		expect(shortcutOf(itemNamed(view, 'Toggle Left Panel'))).toBe('⌥⌘←');
		expect(shortcutOf(itemNamed(view, 'Auto Run'))).toBe('⌘⇧1');
		expect(shortcutOf(itemNamed(menuNamed('File'), 'Remove Agent'))).toBe('⌘⇧⌫');
	});

	it('follows a user remap instead of showing the bundled default', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });
		expect(shortcutOf(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode'))).toBe('⌘J');

		setMenuShortcutKeys({ toggleMode: ['Alt', 'Meta', 't'] });
		expect(shortcutOf(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode'))).toBe('⌥⌘T');
	});

	it('shows a bare name for shortcuts the renderer has not reported', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		const item = itemNamed(menuNamed('File'), 'New Agent');
		expect(item.label).toBe('New Agent');
		expect(shortcutOf(item)).toBeUndefined();
	});

	it('ignores a repeated push of identical bindings', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		expect(buildFromTemplate).toHaveBeenCalledTimes(1);
	});

	it('sends the clicked item shortcut id to the window it was invoked from', () => {
		installApplicationMenu();
		const window = new FakeBrowserWindow();

		itemNamed(menuNamed('View'), 'Switch AI / Shell Mode').click?.({}, window);

		expect(send).toHaveBeenCalledWith('menu:command', 'toggleMode');
		expect(getFocusedWindow).not.toHaveBeenCalled();
	});

	it('falls back to the focused window for app-menu items', () => {
		installApplicationMenu();
		const focused = new FakeBrowserWindow();
		getFocusedWindow.mockReturnValue(focused);

		const appMenu = lastTemplate().find((item) => item.role === 'appMenu')!;
		itemNamed(appMenu, 'Settings...').click?.({}, undefined);

		expect(send).toHaveBeenCalledWith('menu:command', 'settings');
	});

	it('does not send to a destroyed window', () => {
		installApplicationMenu();
		getFocusedWindow.mockReturnValue(null);

		itemNamed(menuNamed('File'), 'New Agent').click?.({}, undefined);

		expect(send).not.toHaveBeenCalled();
	});
});

// ===== from src/__tests__/main/checkin.test.ts =====

const CHECKIN_ENDPOINT = 'https://runmaestro.ai/api/telemetry/checkin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mockFetch = vi.fn();

global.fetch = mockFetch as unknown as typeof fetch;

let userDataDir: string;

// Minimal Electron `app` stand-in - checkin.ts only ever reads isPackaged and
// calls getPath + getVersion, and imports the App type only (no runtime electron
// dependency). Defaults to packaged: unpackaged runs never ping, so every test
// that expects a request needs a packaged app.
function makeApp(version = '9.9.9', isPackaged = true) {
	return {
		isPackaged,
		getPath: (name: string) => {
			expect(name).toBe('userData');
			return userDataDir;
		},
		getVersion: () => version,
	} as unknown as import('electron').App;
}

// Fresh module instance per test so the module-level install-id cache is reset.
async function loadModule() {
	vi.resetModules();
	return import('../../main/checkin');
}

describe('checkin', () => {
	beforeEach(() => {
		userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-checkin-'));
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
	});

	afterEach(() => {
		fs.rmSync(userDataDir, { recursive: true, force: true });
	});

	it('generates and persists a UUID, then POSTs guid + version', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp('1.2.3'));

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, opts] = mockFetch.mock.calls[0];
		expect(url).toBe(CHECKIN_ENDPOINT);
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body as string);
		expect(body.guid).toMatch(UUID_RE);
		expect(body.version).toBe('1.2.3');
		// platform/arch come straight from process and are always present.
		expect(body.platform).toBe(process.platform);
		expect(body.arch).toBe(process.arch);

		// Persisted to userData/checkin-id.json with the same id.
		const raw = await fsp.readFile(path.join(userDataDir, 'checkin-id.json'), 'utf-8');
		expect(JSON.parse(raw).installId).toBe(body.guid);
	});

	it('includes theme when a non-empty id is passed', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp(), 'monokai');

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.theme).toBe('monokai');
	});

	it('omits theme when unresolved (undefined/null/empty)', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp(), null);
		await sendCheckin(makeApp(), '');
		await sendCheckin(makeApp());

		for (const call of mockFetch.mock.calls) {
			const body = JSON.parse(call[1].body);
			expect('theme' in body).toBe(false);
			// guid/version/platform/arch still present on every ping.
			expect(body.guid).toMatch(UUID_RE);
			expect(body.platform).toBe(process.platform);
			expect(body.arch).toBe(process.arch);
		}
	});

	it('reuses the persisted UUID across process restarts', async () => {
		// First "process" mints and persists an id.
		const first = await loadModule();
		await first.sendCheckin(makeApp());
		const firstGuid = JSON.parse(mockFetch.mock.calls[0][1].body).guid;

		// Second "process" (fresh module, same userData) reuses it.
		const second = await loadModule();
		await second.sendCheckin(makeApp());
		const secondGuid = JSON.parse(mockFetch.mock.calls[1][1].body).guid;

		expect(secondGuid).toBe(firstGuid);
	});

	it('mints a fresh id when the stored file is corrupt', async () => {
		fs.writeFileSync(path.join(userDataDir, 'checkin-id.json'), '{ not valid json');
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp());

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.guid).toMatch(UUID_RE);
	});

	it('swallows network failures without throwing', async () => {
		mockFetch.mockRejectedValue(new Error('offline'));
		const { sendCheckin } = await loadModule();
		await expect(sendCheckin(makeApp())).resolves.toBeUndefined();
	});

	it('never pings from an unpackaged build', async () => {
		// Dev runs and the e2e suite are not part of the install base. An
		// unpackaged launch can also report the Electron binary version rather
		// than Maestro's, which is what put phantom installs in the analytics.
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp('1.2.3', false));

		expect(mockFetch).not.toHaveBeenCalled();
		// It must not even mint an install id - that file is what makes a
		// machine countable, and a throwaway CI profile would create a new one
		// on every run.
		expect(fs.existsSync(path.join(userDataDir, 'checkin-id.json'))).toBe(false);
	});

	it('warns when the endpoint rejects the ping', async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
		const { logger } = await import('../../main/utils/logger');
		const { sendCheckin } = await loadModule();
		await expect(sendCheckin(makeApp())).resolves.toBeUndefined();

		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'), 'Checkin');
	});
});

// ===== from src/__tests__/main/concerto-html.test.ts =====

describe('Concerto HTML document protocol', () => {
	beforeEach(clearConcertoHtmlDocumentsForTests);

	it('serves inline CSS and JavaScript with a restrictive response policy', async () => {
		const html =
			'<style>button{color:red}</style><button>Buy</button><script>window.ready=true</script>';
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: html,
		});

		const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1));
		expect(response.status).toBe(200);
		const served = await response.text();
		expect(served).toContain(html);
		expect(served).toContain(CONCERTO_DESIGNER_CHANNEL);
		expect(served).toContain("data.action === 'click'");
		expect(served.indexOf("'RTCPeerConnection'")).toBeLessThan(served.indexOf('window.ready=true'));
		expect(response.headers.get('content-security-policy')).toBe(CONCERTO_HTML_CSP);
		expect(CONCERTO_HTML_CSP).toContain("script-src 'unsafe-inline' blob:");
		expect(CONCERTO_HTML_CSP).toContain("connect-src 'none'");
		expect(CONCERTO_HTML_CSP).toContain("webrtc 'block'");
		expect(CONCERTO_HTML_CSP).toContain("frame-src 'none'");
		expect(CONCERTO_HTML_CSP).toContain('sandbox allow-scripts');
		expect(response.headers.get('x-dns-prefetch-control')).toBe('off');
	});

	it('updates an existing HTML document without requiring viewType again', async () => {
		applyCadenzaHtmlPayload({
			op: 'open',
			id: 'mini',
			viewType: 'html',
			body: '<button>First</button>',
		});
		applyCadenzaHtmlPayload({ op: 'update', id: 'mini', body: '<button>Second</button>' });

		const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('cadenza', 'mini', 2));
		expect(await response.text()).toContain('<button>Second</button>');
	});

	it('injects the designer harness at the start of head', () => {
		const result = injectConcertoDesignerBootstrap(
			'<!doctype html><html><head><title>Mockup</title></head><body></body></html>'
		);
		expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeGreaterThan(result.indexOf('<head>'));
		expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeLessThan(result.indexOf('<title>'));
	});

	it('removes documents and rejects oversized payloads', () => {
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>ok</p>',
		});
		applyMovementHtmlPayload({ op: 'remove', id: 'mockup' });
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1)).status).toBe(
			404
		);

		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'too-large',
				viewType: 'html',
				body: 'x'.repeat(MAX_CONCERTO_HTML_BYTES + 1),
			})
		).toThrow(/size limit/);
	});

	it('assigns a new revision whenever HTML content changes', () => {
		const first = applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>first</p>',
		});
		const second = applyMovementHtmlPayload({
			op: 'update',
			id: 'mockup',
			body: '<p>second</p>',
		});

		expect(first.revision).toBe(1);
		expect(second.revision).toBe(2);
		expect(getConcertoHtmlDocumentRevision('movement', 'mockup')).toBe(2);
	});

	it('restores a released document with a fresh revision', async () => {
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>original</p>',
		});
		releaseConcertoHtmlDocument('movement', 'mockup');

		const revision = restoreConcertoHtmlDocument('movement', 'mockup', '<p>fresh</p>');

		expect(revision).toBe(2);
		const response = createConcertoHtmlResponse(
			buildConcertoHtmlUrl('movement', 'mockup', revision)
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<p>fresh</p>');
	});

	it('rejects capacity instead of evicting a live document and accepts explicit release', () => {
		for (let index = 0; index < MAX_CONCERTO_HTML_DOCUMENTS; index += 1) {
			applyMovementHtmlPayload({
				op: 'add',
				id: `mockup-${index}`,
				viewType: 'html',
				body: `<p>${index}</p>`,
			});
		}

		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'overflow',
				viewType: 'html',
				body: '<p>overflow</p>',
			})
		).toThrow(/document limit reached/);
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status).toBe(
			200
		);

		releaseConcertoHtmlDocument('movement', 'mockup-0');
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status).toBe(
			404
		);
		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'replacement',
				viewType: 'html',
				body: '<p>replacement</p>',
			})
		).not.toThrow();
	});

	it('blocks an HTML frame from navigating away from the local protocol', () => {
		let guard:
			| ((details: {
					preventDefault: () => void;
					isMainFrame: boolean;
					url: string;
					frame: { url: string } | null;
					initiator: { url: string } | null;
			  }) => void)
			| undefined;
		const webContents = {
			on: vi.fn((name: string, listener: typeof guard) => {
				if (name === 'will-frame-navigate') guard = listener;
			}),
		};
		attachConcertoHtmlNavigationGuard(webContents as never);
		const preventDefault = vi.fn();
		guard?.({
			preventDefault,
			isMainFrame: false,
			url: 'https://example.com/exfiltrate',
			frame: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
			initiator: null,
		});
		expect(preventDefault).toHaveBeenCalledOnce();

		guard?.({
			preventDefault,
			isMainFrame: true,
			url: 'https://example.com/top-navigation',
			frame: { url: 'file:///maestro/index.html' },
			initiator: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
		});
		expect(preventDefault).toHaveBeenCalledTimes(2);
	});
});

// ===== from src/__tests__/main/constants.test.ts =====

describe('main/constants', () => {
	// groupChatId is ALWAYS a uuidv4() in production (see group-chat-storage.ts).
	// The regexes now anchor on the UUID format to eliminate greedy-backtrack
	// ambiguity when participant names contain sentinel substrings like
	// "-participant-". Fixtures use real UUIDs accordingly.
	const GC_ID = '550e8400-e29b-41d4-a716-446655440000';
	const GC_ID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

	describe('REGEX_MODERATOR_SESSION', () => {
		it('should match moderator session IDs', () => {
			const match = `group-chat-${GC_ID}-moderator-1702934567890`.match(REGEX_MODERATOR_SESSION);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
		});

		it('should match moderator synthesis session IDs', () => {
			const match = `group-chat-${GC_ID}-moderator-synthesis-1702934567890`.match(
				REGEX_MODERATOR_SESSION
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
		});

		it('should not match participant session IDs', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
				REGEX_MODERATOR_SESSION
			);
			expect(match).toBeNull();
		});

		it('should not match regular session IDs', () => {
			const match = 'session-abc123'.match(REGEX_MODERATOR_SESSION);
			expect(match).toBeNull();
		});

		it('should not match non-UUID groupChatId (strict UUID anchor)', () => {
			const match = 'group-chat-abc123-moderator-1702934567890'.match(REGEX_MODERATOR_SESSION);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_MODERATOR_SESSION_TIMESTAMP', () => {
		it('should match moderator session IDs with timestamp suffix', () => {
			const match = `group-chat-${GC_ID}-moderator-1702934567890`.match(
				REGEX_MODERATOR_SESSION_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
		});

		it('should not match moderator synthesis session IDs', () => {
			// This pattern expects only digits after "moderator-"
			const match = `group-chat-${GC_ID}-moderator-synthesis-1702934567890`.match(
				REGEX_MODERATOR_SESSION_TIMESTAMP
			);
			expect(match).toBeNull();
		});

		it('should not match session IDs without timestamp', () => {
			const match = `group-chat-${GC_ID}-moderator-`.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_PARTICIPANT_UUID', () => {
		it('should match participant session IDs with UUID suffix', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-${GC_ID_2}`.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('Claude');
			expect(match![3]).toBe(GC_ID_2);
		});

		it('should match participant with hyphenated name and UUID', () => {
			const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-${GC_ID_2}`.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('OpenCode-Ollama');
		});

		it('should be case-insensitive for UUID', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-${GC_ID_2.toUpperCase()}`.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).not.toBeNull();
		});

		it('should not match timestamp suffix as UUID', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).toBeNull();
		});

		it('should resist name containing "-participant-" sentinel', () => {
			// Adversarial: a participant name that literally contains "-participant-"
			// used to mis-parse under the old greedy (.+) capture. With the UUID
			// anchor on groupChatId the split is unambiguous.
			const match = `group-chat-${GC_ID}-participant-evil-participant-name-${GC_ID_2}`.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('evil-participant-name');
		});
	});

	describe('REGEX_PARTICIPANT_TIMESTAMP', () => {
		it('should match participant session IDs with timestamp suffix', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('Claude');
			expect(match![3]).toBe('1702934567890');
		});

		it('should match participant with hyphenated name and timestamp', () => {
			const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-1702934567890`.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('OpenCode-Ollama');
		});

		it('should require at least 13 digits for timestamp', () => {
			const shortTimestamp = `group-chat-${GC_ID}-participant-Claude-170293456`.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(shortTimestamp).toBeNull();

			const longTimestamp = `group-chat-${GC_ID}-participant-Claude-17029345678901`.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(longTimestamp).not.toBeNull();
		});

		it('should resist name containing "-participant-" sentinel', () => {
			const match = `group-chat-${GC_ID}-participant-evil-participant-name-1702934567890`.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('evil-participant-name');
		});
	});

	describe('REGEX_PARTICIPANT_FALLBACK', () => {
		it('should match basic participant session IDs', () => {
			const match = `group-chat-${GC_ID}-participant-Claude-anything`.match(
				REGEX_PARTICIPANT_FALLBACK
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('Claude');
		});

		it('should only capture first segment for hyphenated names', () => {
			// Fallback is for backwards compatibility with non-hyphenated names
			const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-1702934567890`.match(
				REGEX_PARTICIPANT_FALLBACK
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe(GC_ID);
			expect(match![2]).toBe('OpenCode'); // Only captures up to first hyphen
		});

		it('should not match non-UUID groupChatId', () => {
			const match = 'group-chat-abc123-participant-Claude-anything'.match(
				REGEX_PARTICIPANT_FALLBACK
			);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_AI_SUFFIX', () => {
		it('should match session IDs with -ai- suffix and any tab ID format', () => {
			expect('session-123-ai-tab1'.match(REGEX_AI_SUFFIX)).not.toBeNull();
			expect('session-123-ai-abc123def'.match(REGEX_AI_SUFFIX)).not.toBeNull();
			expect(
				'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(
					REGEX_AI_SUFFIX
				)
			).not.toBeNull();
		});

		it('should not match session IDs without -ai- suffix', () => {
			expect('session-123-terminal'.match(REGEX_AI_SUFFIX)).toBeNull();
			expect('session-123'.match(REGEX_AI_SUFFIX)).toBeNull();
		});

		it('should correctly strip -ai- suffix to extract base session ID', () => {
			const sessionId =
				'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb';
			expect(sessionId.replace(REGEX_AI_SUFFIX, '')).toBe('51cee651-6629-4de8-abdd-1c1540555f2d');
		});
	});

	describe('REGEX_AI_TAB_ID', () => {
		it('should extract simple tab ID from session ID', () => {
			const match = 'session-123-ai-tab1'.match(REGEX_AI_TAB_ID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('tab1');
		});

		it('should extract UUID tab ID from session ID', () => {
			const match =
				'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(
					REGEX_AI_TAB_ID
				);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('73aaeb23-6673-45a4-8fdf-c769802f79bb');
		});
	});

	describe('debugLog', () => {
		let consoleSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
		});

		it('should be a function', () => {
			expect(typeof debugLog).toBe('function');
		});

		it('should accept prefix, message, and additional args', () => {
			// Function should not throw regardless of DEBUG_GROUP_CHAT value
			expect(() => debugLog('TestPrefix', 'Test message', { extra: 'data' })).not.toThrow();
		});

		it('should format message with prefix when called', () => {
			debugLog('TestPrefix', 'Test message');
			// If DEBUG_GROUP_CHAT is true, it will log; if false, it won't
			// We're just testing it doesn't throw
		});
	});

	describe('MAX_GROUP_CHAT_BUFFER_SIZE', () => {
		it('should be defined', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeDefined();
		});

		it('should be 10MB (10 * 1024 * 1024 bytes)', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBe(10 * 1024 * 1024);
		});

		it('should be a positive number', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeGreaterThan(0);
		});
	});
});

// ===== from src/__tests__/main/themes.test.ts =====

describe('themes.ts', () => {
	describe('THEMES constant', () => {
		it('should export themes matching renderer themes', () => {
			expect(Object.keys(THEMES).length).toBeGreaterThan(0);
		});
	});

	describe('getThemeById', () => {
		it('should return a theme for valid theme IDs', () => {
			const theme = getThemeById('dracula');
			expect(theme).not.toBeNull();
			expect(theme?.id).toBe('dracula');
		});

		it('should return null for unknown theme IDs', () => {
			expect(getThemeById('nonexistent-theme')).toBeNull();
			expect(getThemeById('')).toBeNull();
		});

		it('should return the exact same object from THEMES', () => {
			const themeId = 'nord';
			expect(getThemeById(themeId)).toBe(THEMES[themeId]);
		});

		it('should work for all theme IDs', () => {
			for (const themeId of Object.keys(THEMES)) {
				const theme = getThemeById(themeId);
				expect(theme).not.toBeNull();
				expect(theme?.id).toBe(themeId);
			}
		});
	});
});
