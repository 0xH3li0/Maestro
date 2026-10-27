/**
 * Maestro's controls inside the Excalidraw canvas, drawn with Excalidraw's own
 * button styles so they read as part of the canvas:
 *
 * - Top right (`renderTopRightUI`): the room's screening badge, the Room
 *   button while the sketch has a room, and Collaborate. Collaborate takes the
 *   corner Excalidraw gives its Library button.
 * - Bottom right (`Footer`): Library, beside Excalidraw's Help button. The
 *   default Library button at the top right is hidden by
 *   `excalidrawOverrides.css`.
 *
 * Excalidraw is lazy, so its components come in as props from the loaded
 * module (`loadExcalidraw()`); a static import would pull Excalidraw into the
 * main bundle.
 */

import type React from 'react';
import { BookOpen, UserPlus, Users } from 'lucide-react';
import type {
	Button as ExcalidrawButton,
	Footer as ExcalidrawFooter,
	Sidebar as ExcalidrawSidebar,
} from '@excalidraw/excalidraw';

/** What the canvas controls show and do. Built by `SketchTabView`. */
export interface SketchCanvasChrome {
	collaborate: {
		/** The Collaborate panel is open. */
		open: boolean;
		/** The room is live: the button turns green, the way Excalidraw marks a live session. */
		live: boolean;
		/** The chord as display text, or '' when unbound. */
		shortcut: string;
		onToggle: () => void;
	};
	/** Null while the sketch has no room. */
	room: { open: boolean; onToggle: () => void } | null;
	/** The room's screening badge, or null. */
	badge: React.ReactNode;
}

/** Lucide's stroke at Excalidraw's icon weight. */
const ICON_STROKE = 1.5;

export interface SketchTopRightUIProps {
	Button: typeof ExcalidrawButton;
	chrome: SketchCanvasChrome;
}

export function SketchTopRightUI({ Button, chrome }: SketchTopRightUIProps) {
	const { collaborate, room, badge } = chrome;
	const collaborateTitle = collaborate.shortcut
		? `Collaborate (${collaborate.shortcut})`
		: 'Collaborate';
	return (
		<>
			{badge && <div className="sketch-chrome-badge">{badge}</div>}
			{room && (
				<Button
					className={`sidebar-trigger sketch-chrome-button${room.open ? ' active' : ''}`}
					onSelect={room.onToggle}
					title="Show the room"
					aria-label="Show the room"
					aria-pressed={room.open}
				>
					<Users strokeWidth={ICON_STROKE} />
					<div className="sidebar-trigger__label">Room</div>
				</Button>
			)}
			<Button
				className={`collab-button sketch-chrome-button${collaborate.live ? ' active' : ''}`}
				onSelect={collaborate.onToggle}
				title={collaborateTitle}
				aria-label="Collaborate on this sketch"
				aria-pressed={collaborate.open}
				data-testid="sketch-collaborate-button"
			>
				<UserPlus strokeWidth={ICON_STROKE} />
				<div className="sidebar-trigger__label">Collaborate</div>
			</Button>
		</>
	);
}

export interface SketchLibraryTriggerProps {
	Footer: typeof ExcalidrawFooter;
	Sidebar: typeof ExcalidrawSidebar;
}

/** Excalidraw's Library button, moved to the footer beside Help. */
export function SketchLibraryTrigger({ Footer, Sidebar }: SketchLibraryTriggerProps) {
	return (
		<Footer>
			<div className="sketch-chrome-footer">
				<Sidebar.Trigger
					name="default"
					tab="library"
					className="sketch-chrome-button"
					icon={<BookOpen strokeWidth={ICON_STROKE} />}
					title="Library"
				>
					Library
				</Sidebar.Trigger>
			</div>
		</Footer>
	);
}
