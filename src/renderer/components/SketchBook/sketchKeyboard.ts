/**
 * Who answers a key pressed on the Sketch Book canvas: Excalidraw or Maestro.
 *
 * On the canvas the sketch wins a clash, with one exception: the keys that
 * move the user around Maestro (switching tabs, Quick Actions, Switch Agent)
 * stay Maestro's, so the keyboard can always leave a sketch. They are matched
 * by shortcut ID against the user's own bindings, so a rebound chord follows
 * the rebinding. Excalidraw's own actions on those chords move to new chords
 * (`sketchKeyRemaps()`), and its Help dialog and menu are relabelled to match
 * (`relabelExcalidrawShortcuts()`).
 *
 * The event order this works with (`useSketchKeyboard.ts` wires it):
 *
 * 1. A capture listener on the canvas runs before Excalidraw's handler, which
 *    is a React `onKeyDown` on its container. A Maestro key is stopped there
 *    and forwarded to the main handler on `window`; a remapped chord is
 *    stopped and Excalidraw's own chord is replayed to the same target.
 * 2. Excalidraw stops propagation of the keys its actions answer, so those
 *    never reach Maestro. Some it only `preventDefault()`s (Export image,
 *    Cmd+Shift+E), so a document listener stops a key the canvas already
 *    claimed before it reaches `window`.
 *
 * Excalidraw decides Cmd vs Ctrl by its own platform test, not Maestro's, so
 * the replayed chords and labels use `excalidrawIsDarwin()`.
 */

import { FIXED_SHORTCUTS } from '../../constants/shortcuts';

/** Maestro shortcuts that stay Maestro's on the canvas (matched with `isShortcut`). */
export const SKETCH_MAESTRO_SHORTCUT_IDS = ['quickAction', 'agentSwitcher'] as const;

/** Maestro tab shortcuts that stay Maestro's on the canvas (matched with `isTabShortcut`). */
export const SKETCH_MAESTRO_TAB_SHORTCUT_IDS = [
	'prevTab',
	'nextTab',
	'tabSwitcher',
	'goToTab1',
	'goToTab2',
	'goToTab3',
	'goToTab4',
	'goToTab5',
	'goToTab6',
	'goToTab7',
	'goToTab8',
	'goToTab9',
] as const;

/** The user's live bindings, as `useKeyboardShortcutHelpers()` matches them. */
export interface SketchMaestroKeyMatchers {
	isShortcut: (e: KeyboardEvent, actionId: string) => boolean;
	isTabShortcut: (e: KeyboardEvent, actionId: string) => boolean;
	/** Cmd+0 is Go to Last Tab only while this setting is on. */
	useCmd0AsLastTab: boolean;
}

/** Whether a canvas key belongs to Maestro rather than Excalidraw. */
export function isMaestroSketchKey(e: KeyboardEvent, matchers: SketchMaestroKeyMatchers): boolean {
	return (
		SKETCH_MAESTRO_SHORTCUT_IDS.some((id) => matchers.isShortcut(e, id)) ||
		SKETCH_MAESTRO_TAB_SHORTCUT_IDS.some((id) => matchers.isTabShortcut(e, id)) ||
		(matchers.useCmd0AsLastTab && matchers.isTabShortcut(e, 'goToLastTab'))
	);
}

/** Excalidraw's own platform test, which picks Cmd or Ctrl for its chords. */
export function excalidrawIsDarwin(platform: string = navigator.platform): boolean {
	return /Mac|iPod|iPhone|iPad/.test(platform);
}

/**
 * Excalidraw's own "the user is typing" test (`isWritableElement`, 0.18): it
 * skips its shortcuts for exactly these targets, so the key already reaches
 * Maestro the normal way. Mirrored rather than `isEditingTextTarget()`, which
 * also counts the radio inputs of the properties panel, where Excalidraw
 * still answers its shortcuts.
 */
export function isExcalidrawWritableTarget(target: EventTarget | null): boolean {
	return (
		(target instanceof HTMLElement && target.dataset.type === 'wysiwyg') ||
		target instanceof HTMLBRElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLInputElement &&
			(target.type === 'text' || target.type === 'number' || target.type === 'password'))
	);
}

/** A chord as Excalidraw tests it: `mod` is Cmd on macOS and Ctrl elsewhere. */
export interface ExcalidrawChord {
	key: string;
	code: string;
	mod?: boolean;
	shift?: boolean;
	alt?: boolean;
}

/** A chord Excalidraw prints that the sketch prints differently. */
export interface SketchKeyRelabel {
	/** Excalidraw's chord as its Help dialog and menu print it, e.g. `Cmd+K`. */
	excalidrawLabel: string;
	/** The chord that does it on the sketch canvas, in the same format. */
	sketchLabel: string;
}

/** An Excalidraw action moved off a chord Maestro keeps. */
export interface SketchKeyRemap extends SketchKeyRelabel {
	/** The keys pressed on the canvas now, in Maestro's binding format. */
	press: string[];
	/** Excalidraw's own chord, replayed to it: it answers nothing else. */
	replay: ExcalidrawChord;
	/** The fixed shortcut `press` comes from, for usage tracking. */
	shortcutId?: string;
}

/**
 * The actions moved off Maestro's chords. Add link (Cmd+K, Quick Actions) and
 * Open (Cmd+O, Switch Agent) move on every platform. Off macOS, Excalidraw's
 * Send to back and Bring to front are Ctrl+Shift+[ and ], which are Previous
 * and Next Tab there, so they move to Ctrl+Alt+[ and ], the chords macOS
 * already uses.
 */
export function sketchKeyRemaps(isDarwin: boolean): SketchKeyRemap[] {
	const mod = isDarwin ? 'Cmd' : 'Ctrl';
	const alt = isDarwin ? 'Option' : 'Alt';
	const remaps: SketchKeyRemap[] = [
		{
			excalidrawLabel: `${mod}+K`,
			sketchLabel: `${mod}+${alt}+B`,
			press: FIXED_SHORTCUTS.sketchBookAddLink.keys,
			replay: { key: 'k', code: 'KeyK', mod: true },
			shortcutId: 'sketchBookAddLink',
		},
		{
			excalidrawLabel: `${mod}+O`,
			sketchLabel: `${mod}+${alt}+O`,
			press: FIXED_SHORTCUTS.sketchBookOpenFile.keys,
			replay: { key: 'o', code: 'KeyO', mod: true },
			shortcutId: 'sketchBookOpenFile',
		},
	];
	if (!isDarwin) {
		remaps.push(
			{
				excalidrawLabel: 'Ctrl+Shift+[',
				sketchLabel: 'Ctrl+Alt+[',
				press: ['Meta', 'Alt', '['],
				replay: { key: '{', code: 'BracketLeft', mod: true, shift: true },
			},
			{
				excalidrawLabel: 'Ctrl+Shift+]',
				sketchLabel: 'Ctrl+Alt+]',
				press: ['Meta', 'Alt', ']'],
				replay: { key: '}', code: 'BracketRight', mod: true, shift: true },
			}
		);
	}
	return remaps;
}

/**
 * Every chord the sketch prints differently from Excalidraw: the remaps, plus
 * Reset zoom, whose Cmd+0 is Go to Last Tab. Excalidraw already answers
 * Shift+0 for it, so it needs a new label and no replay.
 */
export function sketchKeyRelabels(isDarwin: boolean): SketchKeyRelabel[] {
	return [
		...sketchKeyRemaps(isDarwin),
		{ excalidrawLabel: `${isDarwin ? 'Cmd' : 'Ctrl'}+0`, sketchLabel: 'Shift+0' },
	];
}

/** The keydown that replays `chord` to Excalidraw. */
export function excalidrawChordInit(chord: ExcalidrawChord, isDarwin: boolean): KeyboardEventInit {
	return {
		key: chord.key,
		code: chord.code,
		metaKey: isDarwin && chord.mod === true,
		ctrlKey: !isDarwin && chord.mod === true,
		shiftKey: chord.shift === true,
		altKey: chord.alt === true,
		bubbles: true,
		cancelable: true,
	};
}

/** Set an element's text through its own text node, so React keeps its node. */
function setElementText(element: Element, text: string): void {
	const first = element.firstChild;
	if (first && first.nodeType === Node.TEXT_NODE && element.childNodes.length === 1) {
		first.nodeValue = text;
	} else {
		element.textContent = text;
	}
}

/** The runs of adjacent `<kbd>` keys in a Help dialog row ("or" text splits them). */
function keyRuns(container: Element): HTMLElement[][] {
	const runs: HTMLElement[][] = [];
	let run: HTMLElement[] = [];
	for (const node of Array.from(container.childNodes)) {
		if (node instanceof HTMLElement && node.tagName === 'KBD') {
			run.push(node);
		} else if (run.length > 0) {
			runs.push(run);
			run = [];
		}
	}
	if (run.length > 0) runs.push(run);
	return runs;
}

/**
 * Rewrite one run of keys. React owns the `<kbd>` nodes, so none is removed:
 * an extra key is a clone placed after the last, and a key no longer needed
 * is hidden.
 */
function rewriteKeyRun(run: HTMLElement[], keys: string[]): void {
	const nodes = [...run];
	keys.forEach((key, index) => {
		let node = nodes[index];
		if (!node) {
			node = nodes[index - 1].cloneNode(false) as HTMLElement;
			node.hidden = false;
			nodes[index - 1].after(node);
			nodes.push(node);
		}
		setElementText(node, key);
	});
	for (let index = keys.length; index < nodes.length; index++) nodes[index].hidden = true;
}

/**
 * Print the sketch's chords where Excalidraw prints its own: the Help
 * dialog's key rows and the canvas menu's shortcut column. Excalidraw has no
 * prop for either text, so the DOM under `root` is rewritten in place. Safe to
 * run again: a rewritten chord no longer matches its old label.
 */
export function relabelExcalidrawShortcuts(
	root: ParentNode,
	relabels: readonly SketchKeyRelabel[]
): void {
	const within = <T extends Element>(selector: string): T[] => {
		const found = Array.from(root.querySelectorAll<T>(selector));
		if (root instanceof Element && root.matches(selector)) found.unshift(root as T);
		return found;
	};
	for (const container of within('.HelpDialog__key-container')) {
		for (const run of keyRuns(container)) {
			const printed = run
				.filter((key) => !key.hidden)
				.map((key) => key.textContent ?? '')
				.join('+');
			const relabel = relabels.find((entry) => entry.excalidrawLabel === printed);
			if (relabel) rewriteKeyRun(run, relabel.sketchLabel.split('+'));
		}
	}
	for (const shortcut of within('.dropdown-menu-item__shortcut')) {
		const relabel = relabels.find((entry) => entry.excalidrawLabel === shortcut.textContent);
		if (relabel) setElementText(shortcut, relabel.sketchLabel);
	}
}
