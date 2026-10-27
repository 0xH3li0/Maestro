/**
 * Maestro's controls inside the Sketch Book canvas (SketchCanvasChrome):
 * Collaborate and Room at the top right, Library in the footer beside Help.
 */

import type { ComponentProps, ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	SketchLibraryTrigger,
	SketchTopRightUI,
	type SketchCanvasChrome,
} from '../../../../renderer/components/SketchBook/SketchCanvasChrome';

type ButtonProps = { onSelect: () => void; children?: ReactNode; className?: string };

const FakeButton = (({ onSelect, children, className, ...rest }: ButtonProps) => (
	<button type="button" className={className} onClick={onSelect} {...rest}>
		{children}
	</button>
)) as unknown as ComponentProps<typeof SketchTopRightUI>['Button'];

const FakeFooter = (({ children }: { children?: ReactNode }) => (
	<footer data-testid="excalidraw-footer">{children}</footer>
)) as unknown as ComponentProps<typeof SketchLibraryTrigger>['Footer'];

const FakeSidebar = {
	Trigger: ({
		name,
		tab,
		title,
		className,
		children,
	}: {
		name: string;
		tab?: string;
		title?: string;
		className?: string;
		children?: ReactNode;
	}) => (
		<label
			data-testid="sidebar-trigger"
			data-name={name}
			data-tab={tab}
			title={title}
			className={className}
		>
			{children}
		</label>
	),
} as unknown as ComponentProps<typeof SketchLibraryTrigger>['Sidebar'];

function chromeWith(overrides: Partial<SketchCanvasChrome> = {}): SketchCanvasChrome {
	return {
		collaborate: { open: false, live: false, shortcut: '⌘ ⇧ C', onToggle: vi.fn() },
		room: null,
		badge: null,
		...overrides,
	};
}

describe('SketchTopRightUI', () => {
	it('shows only Collaborate while the sketch has no room, with its chord in the title', () => {
		const chrome = chromeWith();
		render(<SketchTopRightUI Button={FakeButton} chrome={chrome} />);

		const collaborate = screen.getByTestId('sketch-collaborate-button');
		expect(collaborate.textContent).toBe('Collaborate');
		expect(collaborate.getAttribute('title')).toBe('Collaborate (⌘ ⇧ C)');
		expect(collaborate.getAttribute('aria-pressed')).toBe('false');
		expect(collaborate.className).not.toMatch(/\bactive\b/);
		expect(screen.queryByLabelText('Show the room')).toBeNull();

		fireEvent.click(collaborate);
		expect(chrome.collaborate.onToggle).toHaveBeenCalledTimes(1);
	});

	it('titles Collaborate without a chord when it is unbound', () => {
		render(
			<SketchTopRightUI
				Button={FakeButton}
				chrome={chromeWith({
					collaborate: { open: false, live: false, shortcut: '', onToggle: vi.fn() },
				})}
			/>
		);

		expect(screen.getByTestId('sketch-collaborate-button').getAttribute('title')).toBe(
			'Collaborate'
		);
	});

	it('marks Collaborate active while the room is live and shows Room and the badge', () => {
		const onRoom = vi.fn();
		render(
			<SketchTopRightUI
				Button={FakeButton}
				chrome={chromeWith({
					collaborate: { open: true, live: true, shortcut: '⌘ ⇧ C', onToggle: vi.fn() },
					room: { open: true, onToggle: onRoom },
					badge: <span data-testid="screening-badge">Local screening</span>,
				})}
			/>
		);

		const collaborate = screen.getByTestId('sketch-collaborate-button');
		expect(collaborate.className).toMatch(/\bactive\b/);
		expect(collaborate.getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('screening-badge')).toBeTruthy();

		const room = screen.getByLabelText('Show the room');
		expect(room.className).toMatch(/\bactive\b/);
		fireEvent.click(room);
		expect(onRoom).toHaveBeenCalledTimes(1);
	});
});

describe('SketchLibraryTrigger', () => {
	it('puts a Library trigger for the default sidebar into the footer', () => {
		render(<SketchLibraryTrigger Footer={FakeFooter} Sidebar={FakeSidebar} />);

		const trigger = screen.getByTestId('sidebar-trigger');
		expect(screen.getByTestId('excalidraw-footer').contains(trigger)).toBe(true);
		expect(trigger.dataset.name).toBe('default');
		expect(trigger.dataset.tab).toBe('library');
		expect(trigger.textContent).toBe('Library');
	});
});
