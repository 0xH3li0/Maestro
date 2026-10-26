import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildSketchBookCommandsArgs {
	/** `canUseSketchBook()`: the Encore flag is on and this is the desktop app. */
	sketchBookAvailable: boolean;
	activeSession: Session | undefined;
	/** Create a sketch owned by this agent and open it in a tab. */
	newSketchBook: (sessionId: string) => void;
	setQuickActionOpen: (open: boolean) => void;
	newSketchBookShortcut?: QuickAction['shortcut'];
}

/**
 * Palette entry for Sketch Book. A sketch belongs to an agent, so the entry
 * needs one on screen; with the Encore Feature off it does not exist.
 */
export function buildSketchBookCommands({
	sketchBookAvailable,
	activeSession,
	newSketchBook,
	setQuickActionOpen,
	newSketchBookShortcut,
}: BuildSketchBookCommandsArgs): QuickAction[] {
	if (!sketchBookAvailable || !activeSession) return [];
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
	];
}
