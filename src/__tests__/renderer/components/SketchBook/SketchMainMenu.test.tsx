/**
 * The Sketch Book canvas menu (SketchMainMenu): Excalidraw's default items in
 * their default order, without the "Excalidraw links" group (Socials), plus
 * Maestro's Collaborate item after the export items.
 */

import type { ComponentProps, ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SketchMainMenu } from '../../../../renderer/components/SketchBook/SketchMainMenu';

const ITEM_NAMES = [
	'LoadScene',
	'SaveToActiveFile',
	'Export',
	'SaveAsImage',
	'SearchMenu',
	'Help',
	'ClearCanvas',
	'Socials',
	'ToggleTheme',
	'ChangeCanvasBackground',
] as const;

function stubItem(name: string) {
	return () => <div data-testid="menu-item">{name}</div>;
}

const FakeMainMenu = Object.assign(
	({ children }: { children?: ReactNode }) => <div data-testid="main-menu">{children}</div>,
	{
		DefaultItems: Object.fromEntries(ITEM_NAMES.map((name) => [name, stubItem(name)])),
		Item: ({
			children,
			onSelect,
			shortcut,
			icon: _icon,
			...rest
		}: {
			children?: ReactNode;
			onSelect?: () => void;
			shortcut?: string;
			icon?: ReactNode;
		}) => (
			<button type="button" {...rest} data-testid="menu-item" onClick={onSelect}>
				{children}
				{shortcut !== undefined && <kbd data-testid="menu-item-shortcut">{shortcut}</kbd>}
			</button>
		),
		Separator: () => <hr data-testid="menu-separator" />,
		Group: ({ children }: { children?: ReactNode }) => (
			<div data-testid="menu-group">{children}</div>
		),
	}
) as unknown as ComponentProps<typeof SketchMainMenu>['MainMenu'];

function renderMenu(overrides: Partial<ComponentProps<typeof SketchMainMenu>> = {}) {
	const onCollaborate = vi.fn();
	render(
		<SketchMainMenu
			MainMenu={FakeMainMenu}
			onCollaborate={onCollaborate}
			collaborateShortcut="⌘ ⇧ C"
			{...overrides}
		/>
	);
	return { onCollaborate };
}

describe('SketchMainMenu', () => {
	it('keeps the default items in order, adds Collaborate, and drops the Excalidraw links group', () => {
		renderMenu();

		expect(
			screen
				.getAllByTestId('menu-item')
				.map((item) => item.firstChild?.textContent ?? item.textContent)
		).toEqual([
			'LoadScene',
			'SaveToActiveFile',
			'Export',
			'SaveAsImage',
			'Collaborate...',
			'SearchMenu',
			'Help',
			'ClearCanvas',
			'ToggleTheme',
			'ChangeCanvasBackground',
		]);
		expect(screen.queryByText('Socials')).toBeNull();
		expect(screen.queryByTestId('menu-group')).toBeNull();
		expect(screen.getAllByTestId('menu-separator')).toHaveLength(1);
	});

	it('opens the Collaborate panel and shows its chord', () => {
		const { onCollaborate } = renderMenu();

		expect(screen.getByTestId('menu-item-shortcut').textContent).toBe('⌘ ⇧ C');
		fireEvent.click(screen.getByText('Collaborate...'));
		expect(onCollaborate).toHaveBeenCalledTimes(1);
	});

	it('shows no chord when Collaborate is unbound', () => {
		renderMenu({ collaborateShortcut: '' });

		expect(screen.queryByTestId('menu-item-shortcut')).toBeNull();
	});
});
