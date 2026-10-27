/**
 * Maestro's controls inside the Excalidraw canvas, drawn with the markup and
 * styles of Excalidraw's Library button so they read as part of the canvas:
 *
 * - Top right (`renderTopRightUI`): Collaborate, in the corner Excalidraw
 *   gives its Library button. Its panel holds sharing and the room (members,
 *   links, flagged elements).
 * - Footer (`Footer`): the room's screening badge at the center, and Library
 *   at the right beside Excalidraw's Help button. The default Library button
 *   at the top right is hidden by `excalidrawOverrides.css`.
 *
 * Excalidraw is lazy, so its components come in as props from the loaded
 * module (`loadExcalidraw()`); a static import would pull Excalidraw into the
 * main bundle.
 */

import type React from 'react';
import { BookOpen, UserPlus } from 'lucide-react';
import type {
	Footer as ExcalidrawFooter,
	Sidebar as ExcalidrawSidebar,
} from '@excalidraw/excalidraw';

/** What the canvas controls show and do. Built by `SketchTabView`. */
export interface SketchCanvasChrome {
	collaborate: {
		/** The Collaborate panel is open. */
		open: boolean;
		/** The room is live: the icon and label turn green. */
		live: boolean;
		/** The chord as display text, or '' when unbound. */
		shortcut: string;
		onToggle: () => void;
	};
}

/** Lucide's stroke at Excalidraw's icon weight. */
const ICON_STROKE = 1.5;

export interface SketchTopRightUIProps {
	chrome: SketchCanvasChrome;
}

interface ChromeButtonProps {
	icon: React.ReactNode;
	label: string;
	title: string;
	ariaLabel: string;
	pressed: boolean;
	live?: boolean;
	onClick: () => void;
	testId?: string;
}

/**
 * A button drawn exactly like Excalidraw's Library button (its
 * `sidebar-trigger` markup and styles), so Maestro's controls match it.
 */
function ChromeButton({
	icon,
	label,
	title,
	ariaLabel,
	pressed,
	live = false,
	onClick,
	testId,
}: ChromeButtonProps) {
	const className = [
		'sidebar-trigger',
		'sketch-chrome-button',
		pressed && 'active',
		live && 'sketch-chrome-button--live',
	]
		.filter(Boolean)
		.join(' ');
	return (
		<button
			type="button"
			className={className}
			onClick={onClick}
			title={title}
			aria-label={ariaLabel}
			aria-pressed={pressed}
			data-testid={testId}
		>
			<div>{icon}</div>
			<div className="sidebar-trigger__label">{label}</div>
		</button>
	);
}

export function SketchTopRightUI({ chrome }: SketchTopRightUIProps) {
	const { collaborate } = chrome;
	return (
		<ChromeButton
			icon={<UserPlus strokeWidth={ICON_STROKE} />}
			label="Collaborate"
			title={collaborate.shortcut ? `Collaborate (${collaborate.shortcut})` : 'Collaborate'}
			ariaLabel="Collaborate on this sketch"
			pressed={collaborate.open}
			live={collaborate.live}
			onClick={collaborate.onToggle}
			testId="sketch-collaborate-button"
		/>
	);
}

export interface SketchFooterProps {
	Footer: typeof ExcalidrawFooter;
	Sidebar: typeof ExcalidrawSidebar;
	/** The room's screening badge, or null while the sketch has no live room. */
	badge: React.ReactNode;
}

/**
 * The canvas footer: the screening badge at the center, and Excalidraw's
 * Library button moved to the right beside Help.
 */
export function SketchFooter({ Footer, Sidebar, badge }: SketchFooterProps) {
	return (
		<Footer>
			<div className="sketch-chrome-footer">
				<div className="sketch-chrome-badge">{badge}</div>
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
