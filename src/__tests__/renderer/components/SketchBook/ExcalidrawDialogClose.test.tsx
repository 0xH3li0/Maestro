/**
 * ExcalidrawDialogEscHost: every Excalidraw dialog gets Maestro's ESC pill,
 * since Excalidraw draws no close button on desktop. The pill closes the
 * dialog the way Escape does (a keydown on the `.Modal`), one host claims each
 * dialog when two Sketch tabs are mounted, and nothing is left behind when the
 * host unmounts.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ESC_SLOT_ATTRIBUTE,
	ExcalidrawDialogEscHost,
} from '../../../../renderer/components/SketchBook/ExcalidrawDialogClose';
import { mockTheme } from '../../../helpers/mockTheme';

/** An Excalidraw dialog as `Modal` portals it into the body. */
function openDialog(): { container: HTMLElement; modal: HTMLElement; content: HTMLElement } {
	const container = document.createElement('div');
	container.className = 'excalidraw excalidraw-modal-container';
	const modal = document.createElement('div');
	modal.className = 'Modal Dialog';
	const content = document.createElement('div');
	content.className = 'Modal__content';
	content.appendChild(document.createElement('div')).className = 'Island';
	modal.appendChild(content);
	container.appendChild(modal);
	document.body.appendChild(container);
	return { container, modal, content };
}

describe('ExcalidrawDialogEscHost', () => {
	afterEach(() => {
		for (const node of document.body.querySelectorAll('.excalidraw-modal-container')) node.remove();
	});

	it('puts the ESC pill on a dialog that opens, and closes it with Escape', async () => {
		render(<ExcalidrawDialogEscHost theme={mockTheme} />);
		expect(screen.queryByTestId('excalidraw-dialog-esc')).toBeNull();

		const { modal, content } = openDialog();
		const pill = await screen.findByTestId('excalidraw-dialog-esc');
		// First child of the scrolling content: a sticky row, so it stays in view.
		expect(content.firstElementChild?.contains(pill)).toBe(true);

		const keys = vi.fn((event: KeyboardEvent) => event.key);
		modal.addEventListener('keydown', keys);
		fireEvent.click(pill);
		expect(keys).toHaveReturnedWith('Escape');
	});

	it('covers a dialog that was already open when it mounted', () => {
		openDialog();
		render(<ExcalidrawDialogEscHost theme={mockTheme} />);
		expect(screen.getAllByTestId('excalidraw-dialog-esc')).toHaveLength(1);
	});

	it('gives a dialog one pill when two Sketch tabs are mounted', () => {
		openDialog();
		render(
			<>
				<ExcalidrawDialogEscHost theme={mockTheme} />
				<ExcalidrawDialogEscHost theme={mockTheme} />
			</>
		);
		expect(screen.getAllByTestId('excalidraw-dialog-esc')).toHaveLength(1);
	});

	it('drops the pill when the dialog closes, and cleans up on unmount', async () => {
		const first = openDialog();
		const { unmount } = render(<ExcalidrawDialogEscHost theme={mockTheme} />);
		expect(screen.getByTestId('excalidraw-dialog-esc')).toBeTruthy();

		act(() => first.container.remove());
		await waitFor(() => expect(screen.queryByTestId('excalidraw-dialog-esc')).toBeNull());

		const second = openDialog();
		await screen.findByTestId('excalidraw-dialog-esc');
		unmount();
		expect(second.content.hasAttribute(ESC_SLOT_ATTRIBUTE)).toBe(false);
		expect(second.content.querySelector('[data-maestro-esc-row]')).toBeNull();
	});
});
