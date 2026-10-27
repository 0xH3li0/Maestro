import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildSketchBookCommandsArgs {
	/** `canUseSketchBook()`: the Encore flag is on and this is the desktop app. */
	sketchBookAvailable: boolean;
	activeSession: Session | undefined;
	/** Create a sketch owned by this agent and open it in a tab. */
	newSketchBook: (sessionId: string) => void;
	/** Open the Sketch Books list (every sketch, every agent). */
	showSketchBooks: () => void;
	setQuickActionOpen: (open: boolean) => void;
	newSketchBookShortcut?: QuickAction['shortcut'];
	showSketchBooksShortcut?: QuickAction['shortcut'];
}

/**
 * Palette entries for Sketch Book. New Sketch Book needs an agent on screen,
 * since a sketch belongs to one; the Sketch Books list spans every agent and
 * needs none. With the Encore Feature off neither exists.
 */
export function buildSketchBookCommands({
	sketchBookAvailable,
	activeSession,
	newSketchBook,
	showSketchBooks,
	setQuickActionOpen,
	newSketchBookShortcut,
	showSketchBooksShortcut,
}: BuildSketchBookCommandsArgs): QuickAction[] {
	if (!sketchBookAvailable) return [];
	const list: QuickAction = {
		id: 'showSketchBooks',
		label: 'Sketch Books',
		subtext: 'Search, reopen, rename, or delete every sketch',
		shortcut: showSketchBooksShortcut,
		action: () => {
			showSketchBooks();
			setQuickActionOpen(false);
		},
	};
	if (!activeSession) return [list];
	return [
		{
			id: 'newSketchBook',
			label: 'New Sketch Book',
			subtext: `Open a new Excalidraw sketch owned by ${activeSession.name}`,
			shortcut: newSketchBookShortcut,
			action: () => {
				newSketchBook(activeSession.id);
				setQuickActionOpen(false);
			},
		},
		list,
	];
}
