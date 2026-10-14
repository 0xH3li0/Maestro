/**
 * QuickChatRoot - render entry for the Quick Chat window.
 *
 * The main process loads the main renderer bundle into a small frameless
 * window with `?quickChat`, and main.tsx mounts this instead of the full app.
 * It is a thin view: every action is a command to the engine running in the
 * app window (see src/shared/quickChat.ts), and everything shown comes from the
 * snapshots that engine streams back.
 *
 * Two shapes, like the ChatGPT companion window it is modeled on: just the
 * composer before the first message, then the conversation above it. In the
 * first shape the window is exactly the composer, so it grows with the draft.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ArrowUp,
	Bookmark,
	BookmarkCheck,
	Brain,
	ChevronDown,
	ExternalLink,
	PenSquare,
	Pin,
	PinOff,
	Square,
	X,
} from 'lucide-react';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_COMPACT_HEIGHT,
	type QuickChatCommand,
	type QuickChatMessage,
	type QuickChatRoute,
	type QuickChatSnapshot,
} from '../../shared/quickChat';
import { useWindowSettingsSync } from '../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../hooks/ui/useResolvedTheme';
import { useStickToBottom } from '../hooks/ui/useStickToBottom';
import { useAutosizeTextarea } from '../hooks/ui/useAutosizeTextarea';
import { useElementHeight } from '../hooks/ui/useElementWidth';
import { FontScaleControl } from '../components/ui/FontScaleControl';
import type { UseFontScaleReturn } from '../hooks/ui/useFontScale';
import { FONT_SCALE_DEFAULT, FONT_SCALE_MAX, FONT_SCALE_MIN } from '../../shared/scaleRange';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { safeClipboardWrite } from '../utils/clipboard';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { HoverTooltip } from '../components/ui/HoverTooltip';
import { ZOOM_VIEWER_ATTR, ZoomViewerHost, useZoomViewerStore } from '../components/ZoomViewer';
import { LayerStackProvider } from '../contexts/LayerStackContext';
import type { Theme } from '../types';
import { QuickChatAgentPicker } from './QuickChatAgentPicker';
import { QuickChatTabPicker, tabChoiceFromPickerId } from './QuickChatTabPicker';
import { QuickChatRouteLine, QuickChatWorkingLine } from './QuickChatRouteLine';

/** The reply box under a conversation: the conversation keeps the room. */
const COMPOSER_MAX_HEIGHT = 120;
/**
 * The draft before the first message, where the composer is the whole window.
 * With the header and buttons it stays inside QUICK_CHAT_MAX_COMPACT_HEIGHT.
 */
const COMPACT_COMPOSER_MAX_HEIGHT = 360;
/** `-webkit-app-region` lets the frameless window be dragged by its header. */
const DRAG_REGION = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

/** The window's in-window chords: Cmd (Ctrl off macOS) plus this letter. */
const QUICK_CHAT_KEYS = {
	newChat: 'n',
	picker: 'o',
	tabPicker: 'j',
	keep: 's',
	pin: 'p',
	openTab: 't',
	close: 'w',
} as const;

/**
 * Chords that take Shift too. Only the thinking toggle, on the same chord the
 * main window's composer uses for its thinking chip.
 */
const QUICK_CHAT_SHIFT_KEYS = {
	thinking: 'k',
} as const;

/** What the thinking button says in each mode, and what a click does next. */
const THINKING_LABELS = {
	off: {
		label: 'Thinking hidden',
		hint: "Click to show the agent's reasoning while it works on a reply.",
	},
	on: {
		label: 'Showing thinking',
		hint: 'The reasoning goes away once the answer arrives. Click to keep it.',
	},
	sticky: {
		label: 'Keeping thinking',
		hint: 'The reasoning stays above each answer. Click to hide it.',
	},
} as const;

/**
 * Text zoom for the conversation, like a browser: Cmd+= / Cmd+- step it and
 * Cmd+0 resets. `+` and `_` are the same keys with Shift, so either hand works.
 */
const FONT_ZOOM_KEYS: Record<string, 1 | -1 | 0> = { '=': 1, '+': 1, '-': -1, _: -1, '0': 0 };

/** The conversation's base size (`prose-sm`), which the zoom multiplies. */
const MESSAGES_BASE_REM = 0.875;

/**
 * The grip the whole window is dragged by. The composer-only shape is all
 * input and buttons, so without it there is nothing to grab there.
 */
function DragHandle({ theme }: { theme: Theme }) {
	return (
		<div
			className="h-3 shrink-0 flex items-center justify-center"
			style={DRAG_REGION}
			title="Drag to move"
			data-testid="quick-chat-drag-handle"
		>
			<div
				className="w-10 h-1 rounded-full"
				style={{ backgroundColor: theme.colors.textDim, opacity: 0.45 }}
			/>
		</div>
	);
}

/**
 * Follow a value the main process owns: read it once, then take every change
 * it announces. The read and the announcements are separate IPC messages with
 * no ordering between them, so a change announced while the read is in flight
 * wins: the read's answer may predate it.
 */
function followMainValue<T>(
	read: () => Promise<T>,
	subscribe: (callback: (value: T) => void) => () => void,
	apply: (value: T) => void
): () => void {
	let announced = false;
	const off = subscribe((value) => {
		announced = true;
		apply(value);
	});
	void read().then((value) => {
		if (!announced) apply(value);
	});
	return off;
}

/** Widest a hover overlay gets before its explanation wraps. */
const TOOLTIP_MAX_WIDTH = 260;

/**
 * A hover overlay naming the control and, when it is not obvious, what it does.
 * Not the native `title`: macOS does not show one in this window while another
 * app is active, which is exactly when the window is summoned.
 */
function QuickChatTooltip({
	label,
	hint,
	shortcut,
	theme,
	triggerClassName,
	children,
}: {
	label: string;
	hint?: string;
	shortcut?: string;
	theme: Theme;
	/** Wrapper classes, for a trigger that must keep shrinking in a flex row. */
	triggerClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<HoverTooltip
			theme={theme}
			shortcut={shortcut}
			triggerClassName={triggerClassName}
			maxWidth={hint ? TOOLTIP_MAX_WIDTH : undefined}
			triggerStyle={NO_DRAG_REGION}
			label={
				hint ? (
					<span className="flex flex-col gap-0.5">
						<span className="font-medium">{label}</span>
						<span style={{ color: theme.colors.textDim }}>{hint}</span>
					</span>
				) : (
					label
				)
			}
		>
			{children}
		</HoverTooltip>
	);
}

function IconButton({
	label,
	hint,
	shortcut,
	onClick,
	theme,
	children,
	disabled,
}: {
	label: string;
	hint?: string;
	shortcut?: string;
	onClick: () => void;
	theme: Theme;
	children: React.ReactNode;
	disabled?: boolean;
}) {
	return (
		<QuickChatTooltip label={label} hint={hint} shortcut={shortcut} theme={theme}>
			<button
				type="button"
				aria-label={hint ? `${label}. ${hint}` : label}
				onClick={onClick}
				disabled={disabled}
				className="p-1.5 rounded-md transition-opacity hover:opacity-100 opacity-70 disabled:opacity-30"
				style={{ ...NO_DRAG_REGION, color: theme.colors.textMain }}
			>
				{children}
			</button>
		</QuickChatTooltip>
	);
}

/** The route of the turn a message belongs to: its own, or the user message above it. */
function turnRoute(messages: QuickChatMessage[], index: number): QuickChatRoute | undefined {
	for (let i = index; i >= 0; i--) {
		if (messages[i].role === 'user') return messages[i].route;
	}
	return undefined;
}

function MessageView({
	message,
	theme,
	onOpenTab,
	onMoveToNewTab,
}: {
	message: QuickChatMessage;
	theme: Theme;
	onOpenTab: (messageId: string) => void;
	onMoveToNewTab: (messageId: string) => void;
}) {
	if (message.role === 'user') {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex justify-end">
					<div
						className="max-w-[85%] rounded-2xl px-4 py-2 whitespace-pre-wrap break-words select-text"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						{message.text}
					</div>
				</div>
				{message.route && (
					<QuickChatRouteLine
						route={message.route}
						theme={theme}
						onOpenTab={() => onOpenTab(message.id)}
						onMoveToNewTab={() => onMoveToNewTab(message.id)}
					/>
				)}
			</div>
		);
	}
	if (message.role === 'thinking') {
		return (
			<div
				className="whitespace-pre-wrap break-words select-text text-[0.9em] italic pl-3 border-l-2"
				style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
				data-testid="quick-chat-thinking"
			>
				{message.text}
			</div>
		);
	}
	if (message.role === 'error') {
		return (
			<div className="whitespace-pre-wrap select-text" style={{ color: theme.colors.error }}>
				{message.text}
			</div>
		);
	}
	return (
		<div className="select-text" style={{ color: theme.colors.textMain }}>
			<MarkdownRenderer
				content={message.text}
				theme={theme}
				onCopy={(text) => safeClipboardWrite(text)}
				chatLineBreaks
				chatMath
			/>
		</div>
	);
}

/**
 * The window's root. It boots its own renderer, so it brings the layer stack
 * the full-screen diagram viewer registers with (Escape closes the viewer first).
 */
export function QuickChatRoot() {
	return (
		<LayerStackProvider>
			<QuickChatWindow />
		</LayerStackProvider>
	);
}

function QuickChatWindow() {
	const theme = useResolvedTheme();
	const [snapshot, setSnapshot] = useState<QuickChatSnapshot>({ ...EMPTY_QUICK_CHAT_SNAPSHOT });
	const [draft, setDraft] = useState('');
	const [error, setError] = useState<string | null>(null);
	/** Which picker is open: the agent's (Cmd+O) or the next message's tab (Cmd+J). */
	const [picker, setPicker] = useState<'agent' | 'tab' | null>(null);
	const pickerOpen = picker !== null;
	const [pinned, setPinned] = useState(true);
	const [fontScaleValue, setFontScaleValue] = useState(FONT_SCALE_DEFAULT);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);

	// This window boots its own renderer and never runs useSettings: load the
	// settings, follow changes made in the main window, and apply the typography.
	useWindowSettingsSync();

	useEffect(() => {
		const offSnapshot = window.maestro.quickChat.onSnapshot(setSnapshot);
		const offFocus = window.maestro.quickChat.onFocusInput(() => {
			// Summoned with a diagram still open: the keyboard goes back to the
			// viewer, or arrows and Enter would land in the draft hidden behind it.
			if (useZoomViewerStore.getState().request) {
				document.querySelector<HTMLElement>(`[${ZOOM_VIEWER_ATTR}]`)?.focus();
				return;
			}
			textareaRef.current?.focus();
		});
		const offPinned = followMainValue(
			window.maestro.quickChat.getPinned,
			window.maestro.quickChat.onPinned,
			setPinned
		);
		const offFontScale = followMainValue(
			window.maestro.quickChat.getFontScale,
			window.maestro.quickChat.onFontScale,
			setFontScaleValue
		);
		void window.maestro.quickChat.getSnapshot().then(setSnapshot);
		return () => {
			offSnapshot();
			offFocus();
			offPinned();
			offFontScale();
		};
	}, []);

	const run = useCallback(async (command: QuickChatCommand) => {
		const result = await window.maestro.quickChat.command(command);
		setSnapshot(result.snapshot);
		setError(result.ok ? null : (result.error ?? 'Something went wrong'));
		return result.ok;
	}, []);

	// The picker needs room the composer-only window does not have, so the
	// window grows while it is open and shrinks back when it closes.
	const hasConversation = snapshot.messages.length > 0 || snapshot.busy;
	const expanded = hasConversation || pickerOpen;
	useEffect(() => {
		window.maestro.quickChat.setLayout(expanded ? 'expanded' : 'compact');
	}, [expanded]);

	// Composer only, the window is the composer: report its height as the draft
	// grows and shrinks, or lines past the second are clipped by the window.
	const composerHeight = useElementHeight(composerRef, !expanded);
	useEffect(() => {
		if (!expanded && composerHeight > 0) {
			window.maestro.quickChat.setCompactHeight(composerHeight);
		}
	}, [expanded, composerHeight]);

	// Replies arrive under their own messages, so any message can be the one
	// that grew: the key is the whole thread's length and where each one stands.
	// The text zoom is in it too: growing the text pushes the latest reply down,
	// and a reader at the bottom should stay there.
	const threadSize = snapshot.messages.reduce((n, m) => n + m.text.length, 0);
	const threadStatus = snapshot.messages.map((m) => m.route?.status ?? '').join('');
	const stickRef = useStickToBottom<HTMLDivElement>(
		`${snapshot.messages.length}:${threadSize}:${threadStatus}:${fontScaleValue}`
	);
	useAutosizeTextarea({
		textareaRef,
		value: draft,
		maxHeight: expanded ? COMPOSER_MAX_HEIGHT : COMPACT_COMPOSER_MAX_HEIGHT,
	});

	// Sending does not wait for a reply in progress: each message finds its own
	// tab, so the next one can go out while the last is still being answered.
	const send = useCallback(async () => {
		const text = draft.trim();
		if (!text) return;
		setDraft('');
		const ok = await run({ type: 'send', text });
		if (!ok) setDraft(text);
	}, [draft, run]);
	const openMessageTab = useCallback(
		(messageId: string) => void run({ type: 'reveal', messageId }),
		[run]
	);
	const moveMessageToNewTab = useCallback(
		(messageId: string) => void run({ type: 'moveToNewTab', messageId }),
		[run]
	);

	const hide = useCallback(() => void window.maestro.quickChat.window('hide'), []);
	const togglePinned = useCallback(() => {
		window.maestro.quickChat
			.setPinned(!pinned)
			.then((next) => {
				setPinned(next);
				setError(null);
			})
			.catch((err: unknown) =>
				setError(`Could not change the pin: ${err instanceof Error ? err.message : String(err)}`)
			);
	}, [pinned]);
	const closePicker = useCallback(() => {
		setPicker(null);
		textareaRef.current?.focus();
	}, []);
	const pickAgent = useCallback(
		(agentId: string) => {
			setPicker(null);
			// Picking the agent the chat is already on is not a reason to wipe it.
			const done =
				agentId === snapshot.agentId ? Promise.resolve(true) : run({ type: 'setAgent', agentId });
			void done.then(() => textareaRef.current?.focus());
		},
		[run, snapshot.agentId]
	);
	const pickTab = useCallback(
		(pickerId: string) => {
			setPicker(null);
			void run({ type: 'setTab', choice: tabChoiceFromPickerId(pickerId) }).then(() =>
				textareaRef.current?.focus()
			);
		},
		[run]
	);
	const pickerShortcut = formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.picker]);
	const tabPickerShortcut = formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.tabPicker]);
	const newChat = useCallback(() => {
		setDraft('');
		void run({ type: 'new' }).then(() => textareaRef.current?.focus());
	}, [run]);
	const togglePersistent = useCallback(
		() => void run({ type: 'setPersistent', persistent: !snapshot.persistent }),
		[run, snapshot.persistent]
	);
	// The engine steps from the mode it holds, so a change made elsewhere is not undone.
	const cycleThinking = useCallback(() => void run({ type: 'setThinking', mode: 'cycle' }), [run]);
	const togglePicker = useCallback(() => {
		if (picker === 'agent') closePicker();
		else setPicker('agent');
	}, [picker, closePicker]);
	const toggleTabPicker = useCallback(() => {
		if (picker === 'tab') closePicker();
		else setPicker('tab');
	}, [picker, closePicker]);
	// Nothing to open until the first message creates the tab.
	const openInMaestro = useCallback(() => {
		if (snapshot.tabId) void run({ type: 'reveal' });
	}, [run, snapshot.tabId]);
	const zoomOpen = useZoomViewerStore((s) => s.request !== null);
	// The zoom is owned by the main process (so `maestro-cli quick-chat font`
	// reaches it, and it is saved with the window's other per-device state);
	// this is the control the shared FontScaleControl draws.
	const fontScale = useMemo<UseFontScaleReturn>(() => {
		const change = (request: Parameters<typeof window.maestro.quickChat.setFontScale>[0]) =>
			void window.maestro.quickChat
				.setFontScale(request)
				.then(setFontScaleValue)
				.catch((err: unknown) =>
					setError(
						`Could not change the text size: ${err instanceof Error ? err.message : String(err)}`
					)
				);
		return {
			fontScale: fontScaleValue,
			adjustFontScale: (direction) => change({ step: direction }),
			resetFontScale: () => change({ reset: true }),
			canDecrease: fontScaleValue > FONT_SCALE_MIN,
			canIncrease: fontScaleValue < FONT_SCALE_MAX,
		};
	}, [fontScaleValue]);
	const { adjustFontScale, resetFontScale } = fontScale;

	// A diagram opened full screen needs the whole display, not the chat-sized window.
	useEffect(() => {
		window.maestro.quickChat.setFullView(zoomOpen);
	}, [zoomOpen]);

	useEffect(() => {
		// Cmd (Ctrl off macOS) + letter. Shift is left free for the composer,
		// except for the thinking chord, which matches the main window's.
		const chords: Record<string, () => void> = {
			[QUICK_CHAT_KEYS.newChat]: newChat,
			[QUICK_CHAT_KEYS.picker]: togglePicker,
			[QUICK_CHAT_KEYS.tabPicker]: toggleTabPicker,
			[QUICK_CHAT_KEYS.keep]: togglePersistent,
			[QUICK_CHAT_KEYS.pin]: togglePinned,
			[QUICK_CHAT_KEYS.openTab]: openInMaestro,
			// Closes the window whatever is open in it, unlike Escape.
			[QUICK_CHAT_KEYS.close]: hide,
		};
		const shiftChords: Record<string, () => void> = {
			[QUICK_CHAT_SHIFT_KEYS.thinking]: cycleThinking,
		};
		const onKeyDown = (e: KeyboardEvent) => {
			// The diagram viewer owns the keyboard while it is open: its layer
			// already took Escape (closing the viewer, not the window).
			if (e.defaultPrevented || zoomOpen) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				// Escape backs out of the picker first; only a second press hides.
				if (pickerOpen) closePicker();
				else hide();
				return;
			}
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			// Text zoom first: it takes Shift (`+`), and a held key keeps stepping.
			const zoom = FONT_ZOOM_KEYS[e.key];
			if (zoom !== undefined) {
				e.preventDefault();
				if (zoom === 0) resetFontScale();
				else adjustFontScale(zoom);
				return;
			}
			const action = (e.shiftKey ? shiftChords : chords)[e.key.toLowerCase()];
			if (!action) return;
			e.preventDefault();
			// A held chord auto-repeats; acting on each repeat flips a toggle back.
			if (e.repeat) return;
			action();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [
		hide,
		newChat,
		pickerOpen,
		closePicker,
		togglePicker,
		toggleTabPicker,
		togglePersistent,
		togglePinned,
		cycleThinking,
		openInMaestro,
		zoomOpen,
		adjustFontScale,
		resetFontScale,
	]);

	// The zoom sets the conversation's size once; the bubbles and status lines
	// inherit it, and the markdown (whose own sizes are all em) follows.
	const messagesFontSize = `${Math.round(MESSAGES_BASE_REM * fontScale.fontScale * 1000) / 1000}rem`;
	const proseStyles = useMemo(
		() =>
			`${generateTerminalProseStyles(theme, '.quick-chat-messages')}
.quick-chat-messages .prose { font-size: inherit !important; }`,
		[theme]
	);
	const agentName = snapshot.agentName ?? 'your agent';
	const shownError = error ?? snapshot.error;
	const c = theme.colors;

	// The switcher sits at the TOP in both shapes. The window grows downward
	// from a fixed top edge, so a trigger at the top stays under the cursor
	// while the picker opens just below it.
	const agentButton = (
		<QuickChatTooltip
			theme={theme}
			label="Switch agent"
			hint="Switching starts a new chat."
			shortcut={pickerShortcut}
			triggerClassName="inline-flex min-w-0"
		>
			<button
				type="button"
				onClick={togglePicker}
				aria-label="Switch agent"
				aria-expanded={picker === 'agent'}
				className="flex items-center gap-1 text-sm font-medium max-w-[260px] min-w-0 rounded-md px-1 -mx-1 hover:opacity-100 opacity-90"
				style={{ ...NO_DRAG_REGION, color: c.textMain }}
				data-testid="quick-chat-agent-button"
			>
				<span className="truncate">{snapshot.agentName ?? 'Choose an agent'}</span>
				<ChevronDown
					className={`w-3.5 h-3.5 shrink-0 transition-transform ${picker === 'agent' ? 'rotate-180' : ''}`}
					style={{ color: c.textDim }}
				/>
			</button>
		</QuickChatTooltip>
	);

	// Where the next message goes, beside the agent it goes to. Before the first
	// message Maestro finds the tab; after it, the chat stays in its tab until
	// the user picks another one (or a new one) here.
	const next = snapshot.next;
	const tabLabel = next.kind === 'tab' ? next.name : next.kind === 'new' ? 'New tab' : 'Choose tab';
	const tabHint =
		next.kind === 'tab'
			? next.chosen
				? 'Your next message goes to this tab, and the chat stays there.'
				: 'This chat continues in this tab. Pick another tab, or a new one, to move it.'
			: next.kind === 'new'
				? 'Your next message starts a new tab, and the chat continues there.'
				: 'Maestro finds the tab that fits your message. Pick one to choose it yourself.';
	const tabButton = (
		<QuickChatTooltip
			theme={theme}
			label="Choose the tab"
			hint={tabHint}
			shortcut={tabPickerShortcut}
			triggerClassName="inline-flex min-w-0"
		>
			<button
				type="button"
				onClick={toggleTabPicker}
				aria-label={`Choose the tab: ${tabLabel}`}
				aria-expanded={picker === 'tab'}
				className="flex items-center gap-1 text-sm max-w-[220px] min-w-0 rounded-md px-1 hover:opacity-100 opacity-80"
				style={{ ...NO_DRAG_REGION, color: next.kind === 'auto' ? c.textDim : c.textMain }}
				data-testid="quick-chat-tab-button"
			>
				<span className="truncate">{tabLabel}</span>
				<ChevronDown
					className={`w-3.5 h-3.5 shrink-0 transition-transform ${picker === 'tab' ? 'rotate-180' : ''}`}
					style={{ color: c.textDim }}
				/>
			</button>
		</QuickChatTooltip>
	);
	const headerPickers = (
		<>
			{agentButton}
			<span className="shrink-0" style={{ color: c.textDim }} aria-hidden>
				/
			</span>
			{tabButton}
		</>
	);

	const composer = (
		<div
			ref={composerRef}
			// Composer only, its height is its content's (never stretched to the
			// window): the window follows it, so it must not follow the window.
			className={`rounded-3xl px-4 pb-2 flex flex-col gap-2 ${expanded ? 'pt-3' : 'justify-between'}`}
			style={{
				backgroundColor: expanded ? c.bgActivity : c.bgSidebar,
				border: expanded ? 'none' : `1px solid ${c.border}`,
				...(expanded ? {} : { minHeight: QUICK_CHAT_COMPACT_HEIGHT }),
				...NO_DRAG_REGION,
			}}
			data-testid="quick-chat-composer"
		>
			{!expanded && (
				// Same rows as the conversation header (grip, then a 28px row with
				// the switcher first), so opening the picker leaves it in place.
				<div className="-mx-4 -mb-2 flex flex-col" style={DRAG_REGION}>
					<DragHandle theme={theme} />
					<div className="h-7 px-4 flex items-center gap-1.5 min-w-0">{headerPickers}</div>
				</div>
			)}
			<textarea
				ref={textareaRef}
				autoFocus
				rows={expanded ? 1 : 2}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send();
					}
				}}
				placeholder={expanded ? `Reply to ${agentName}` : `Ask ${agentName} anything`}
				className="w-full resize-none bg-transparent outline-none text-sm leading-6"
				style={{ color: c.textMain }}
			/>
			<div className="flex items-center gap-2">
				{hasConversation && (
					<FontScaleControl
						theme={theme}
						control={fontScale}
						variant="ghost"
						tooltips="overlay"
						target="text"
						shortcutHint={{
							decrease: formatShortcutKeys(['Meta', '-']),
							increase: formatShortcutKeys(['Meta', '=']),
							reset: formatShortcutKeys(['Meta', '0']),
						}}
						testId="quick-chat-font-scale"
					/>
				)}
				<div className="flex-1" />
				<IconButton
					theme={theme}
					label={THINKING_LABELS[snapshot.thinking].label}
					hint={THINKING_LABELS[snapshot.thinking].hint}
					shortcut={formatShortcutKeys(['Meta', 'Shift', QUICK_CHAT_SHIFT_KEYS.thinking])}
					onClick={cycleThinking}
				>
					<span className="relative flex">
						<Brain
							className="w-4 h-4"
							style={
								snapshot.thinking === 'off'
									? undefined
									: { color: snapshot.thinking === 'sticky' ? c.warning : c.accent }
							}
						/>
						{snapshot.thinking === 'sticky' && (
							<Pin
								className="w-2.5 h-2.5 absolute -right-1 -bottom-1"
								style={{ color: c.warning }}
							/>
						)}
					</span>
				</IconButton>
				<IconButton
					theme={theme}
					label={snapshot.persistent ? 'Kept as a tab' : 'Keep as a tab'}
					hint={
						snapshot.persistent
							? `This chat stays as a tab on ${agentName} after you start a new one. Click to make it temporary again.`
							: `Temporary: this chat is deleted when you start a new one. Click to keep it as a tab on ${agentName}.`
					}
					shortcut={formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.keep])}
					onClick={togglePersistent}
				>
					{snapshot.persistent ? (
						<BookmarkCheck className="w-4 h-4" style={{ color: c.accent }} />
					) : (
						<Bookmark className="w-4 h-4" />
					)}
				</IconButton>
				<IconButton
					theme={theme}
					label={pinned ? 'Pinned on top' : 'Not pinned'}
					hint={
						pinned
							? 'Floats above other windows. Click to let it fall behind them.'
							: 'Falls behind other windows when you click away. Click to float it on top.'
					}
					shortcut={formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.pin])}
					onClick={togglePinned}
				>
					{pinned ? (
						<Pin className="w-4 h-4" style={{ color: c.accent }} />
					) : (
						<PinOff className="w-4 h-4" />
					)}
				</IconButton>
				{/* Stop sits BESIDE Send while something is in motion, not in its
				    place: the next message can go out before the last is answered. */}
				{snapshot.busy && (
					<QuickChatTooltip
						label="Stop"
						hint="Stops replies in progress and withdraws messages still waiting."
						theme={theme}
					>
						<button
							type="button"
							aria-label="Stop"
							onClick={() => void run({ type: 'stop' })}
							className="w-9 h-9 rounded-full flex items-center justify-center"
							style={{ backgroundColor: c.textMain, color: c.bgMain }}
						>
							<Square className="w-3.5 h-3.5" fill="currentColor" />
						</button>
					</QuickChatTooltip>
				)}
				<QuickChatTooltip label="Send" shortcut="Enter" theme={theme}>
					<button
						type="button"
						aria-label="Send"
						onClick={() => void send()}
						disabled={!draft.trim()}
						className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40"
						style={{ backgroundColor: c.accent, color: c.accentForeground }}
					>
						<ArrowUp className="w-4 h-4" />
					</button>
				</QuickChatTooltip>
			</div>
		</div>
	);

	return (
		<div
			className="h-screen w-screen flex flex-col overflow-hidden rounded-[28px] select-none"
			style={{
				backgroundColor: expanded ? c.bgMain : 'transparent',
				border: expanded ? `1px solid ${c.border}` : 'none',
				...(expanded ? {} : DRAG_REGION),
			}}
		>
			<style>{proseStyles}</style>
			{/* Expand on a diagram or image opens here, over the whole (grown) window. */}
			<ZoomViewerHost theme={theme} />
			{expanded && <DragHandle theme={theme} />}
			{expanded && (
				<div className="h-7 mb-3 flex items-center gap-2 px-4 shrink-0" style={DRAG_REGION}>
					<div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">{headerPickers}</div>
					<IconButton
						theme={theme}
						label="New chat"
						shortcut={formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.newChat])}
						onClick={newChat}
					>
						<PenSquare className="w-4 h-4" />
					</IconButton>
					<IconButton
						theme={theme}
						label="Open in Maestro"
						hint="Shows this chat as a tab in the main window."
						shortcut={formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.openTab])}
						onClick={openInMaestro}
						disabled={!snapshot.tabId}
					>
						<ExternalLink className="w-4 h-4" />
					</IconButton>
					<IconButton
						theme={theme}
						label="Close"
						hint="The chat is kept. The hotkey brings it back."
						// Escape backs out of the picker first, so it only closes without it;
						// Cmd+W always closes.
						shortcut={
							pickerOpen
								? formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.close])
								: `Esc / ${formatShortcutKeys(['Meta', QUICK_CHAT_KEYS.close])}`
						}
						onClick={hide}
					>
						<X className="w-4 h-4" />
					</IconButton>
				</div>
			)}
			{pickerOpen && (
				<div className="flex-1 min-h-0 flex flex-col" style={NO_DRAG_REGION}>
					{picker === 'agent' ? (
						<QuickChatAgentPicker
							theme={theme}
							agents={snapshot.agents}
							currentAgentId={snapshot.agentId}
							onPick={pickAgent}
							onClose={closePicker}
						/>
					) : (
						<QuickChatTabPicker
							theme={theme}
							tabs={snapshot.tabs}
							next={snapshot.next}
							onPick={pickTab}
							onClose={closePicker}
						/>
					)}
				</div>
			)}
			{expanded && !pickerOpen && (
				<div
					ref={stickRef}
					className="quick-chat-messages flex-1 overflow-y-auto px-5 pb-3 flex flex-col gap-4"
					style={{ ...NO_DRAG_REGION, fontSize: messagesFontSize }}
				>
					{snapshot.messages.map((message, index) => {
						// A reply being written gets its counter at the end of its own
						// turn: after its last message, before the next one the user sent.
						const next = snapshot.messages[index + 1];
						const endsTurn = !next || next.role === 'user';
						const turn = endsTurn ? turnRoute(snapshot.messages, index) : undefined;
						return (
							<Fragment key={message.id}>
								<MessageView
									message={message}
									theme={theme}
									onOpenTab={openMessageTab}
									onMoveToNewTab={moveMessageToNewTab}
								/>
								{turn?.status === 'running' && (
									<QuickChatWorkingLine since={turn.since} theme={theme} />
								)}
							</Fragment>
						);
					})}
				</div>
			)}
			{shownError && (
				<div className="px-5 pb-1 text-xs" style={{ color: c.error, ...NO_DRAG_REGION }}>
					{shownError}
				</div>
			)}
			<div className={expanded ? 'px-3 pb-3 shrink-0' : 'h-full'}>{composer}</div>
		</div>
	);
}
