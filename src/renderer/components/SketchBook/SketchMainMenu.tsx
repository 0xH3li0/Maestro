/**
 * The Sketch Book canvas menu: Excalidraw's default main menu without its
 * "Excalidraw links" group (GitHub, X, Discord), plus Maestro's Collaborate
 * item. A sketch is Maestro's surface, so its menu does not send the user to
 * Excalidraw's channels.
 *
 * Excalidraw is lazy, so the caller passes its `MainMenu` in from the loaded
 * module (`loadExcalidraw()`); a static import here would pull Excalidraw
 * into the main bundle.
 */

import { UserPlus } from 'lucide-react';
import type { MainMenu as ExcalidrawMainMenu } from '@excalidraw/excalidraw';

export interface SketchMainMenuProps {
	MainMenu: typeof ExcalidrawMainMenu;
	/** Opens the Collaborate panel, same as the button at the top right. */
	onCollaborate: () => void;
	/** The Collaborate chord as display text, or '' when unbound. */
	collaborateShortcut: string;
}

export function SketchMainMenu({
	MainMenu,
	onCollaborate,
	collaborateShortcut,
}: SketchMainMenuProps) {
	const { DefaultItems } = MainMenu;
	return (
		<MainMenu>
			<DefaultItems.LoadScene />
			<DefaultItems.SaveToActiveFile />
			<DefaultItems.Export />
			<DefaultItems.SaveAsImage />
			<MainMenu.Item
				icon={<UserPlus strokeWidth={1.5} />}
				onSelect={onCollaborate}
				shortcut={collaborateShortcut || undefined}
				data-testid="sketch-menu-collaborate"
			>
				Collaborate...
			</MainMenu.Item>
			<DefaultItems.SearchMenu />
			<DefaultItems.Help />
			<DefaultItems.ClearCanvas />
			<MainMenu.Separator />
			<DefaultItems.ToggleTheme />
			<DefaultItems.ChangeCanvasBackground />
		</MainMenu>
	);
}
