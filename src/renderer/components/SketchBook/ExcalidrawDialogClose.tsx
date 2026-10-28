/**
 * The ESC pill on every Excalidraw dialog (Help, Export image, Save to
 * file, Mermaid to Excalidraw, confirmations).
 *
 * Every Maestro modal needs a visible way out (`EscCloseButton`), and Excalidraw
 * draws its own close button only on a phone (`Dialog__close`, gated on
 * `isMobile`) with no prop to change that. Every Excalidraw dialog goes through
 * its one `Dialog` -> `Modal`, which portals into its own
 * `.excalidraw-modal-container` under `document.body`. So this host watches the
 * body's direct children, and for each open `.Modal.Dialog` it portals an
 * `EscCloseButton` into a zero-height sticky row at the top of the dialog's
 * scrolling content, so the pill stays in the top right corner while the
 * dialog scrolls.
 *
 * The pill does exactly what Escape does: it dispatches an Escape keydown on
 * the `.Modal`, whose own `onKeyDown` closes the dialog the way Excalidraw
 * means it to (menus reset, focus restored). Calling into Excalidraw's state
 * any other way would bypass that.
 *
 * Every mounted Sketch tab runs a host, and two tiled Sketch tabs share one
 * body, so a dialog is claimed by the first host that sees it
 * ({@link ESC_SLOT_ATTRIBUTE}); the others leave it alone.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';

/** Marks a dialog's content as claimed by a host, so it gets one pill. */
export const ESC_SLOT_ATTRIBUTE = 'data-maestro-esc-slot';

let nextSlotId = 0;

const DIALOG_CONTENT_SELECTOR =
	':scope > .excalidraw-modal-container .Modal.Dialog > .Modal__content';

/** Close an Excalidraw dialog the way the Escape key does. */
export function closeExcalidrawDialog(content: HTMLElement): void {
	content
		.closest('.Modal')
		?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
}

export function ExcalidrawDialogEscHost({ theme }: { theme: Theme }) {
	const [slots, setSlots] = React.useState<readonly HTMLElement[]>([]);

	React.useEffect(() => {
		/** Dialog content -> the slot this host put in it. */
		const owned = new Map<HTMLElement, HTMLElement>();

		const sync = () => {
			let changed = false;
			for (const [content, slot] of owned) {
				if (content.isConnected) continue;
				owned.delete(content);
				slot.remove();
				changed = true;
			}
			for (const content of document.body.querySelectorAll<HTMLElement>(DIALOG_CONTENT_SELECTOR)) {
				if (content.hasAttribute(ESC_SLOT_ATTRIBUTE)) continue;
				const slot = document.createElement('div');
				slot.setAttribute('data-maestro-esc-row', String(++nextSlotId));
				// Zero height and sticky: no layout shift, and the pill stays put while
				// the dialog's content scrolls under it.
				Object.assign(slot.style, {
					position: 'sticky',
					top: '0',
					height: '0',
					zIndex: '3',
				});
				content.setAttribute(ESC_SLOT_ATTRIBUTE, '');
				content.prepend(slot);
				owned.set(content, slot);
				changed = true;
			}
			if (changed) setSlots([...owned.values()]);
		};

		// A dialog's container is appended to the body, then filled in the same
		// commit (Excalidraw's `useCreatePortalContainer` renders twice). Look
		// once that commit has painted.
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				sync();
			});
		};
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true });
		sync();

		return () => {
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
			for (const [content, slot] of owned) {
				content.removeAttribute(ESC_SLOT_ATTRIBUTE);
				slot.remove();
			}
			owned.clear();
		};
	}, []);

	return (
		<>
			{slots.map((slot) =>
				createPortal(
					<EscCloseButton
						theme={theme}
						onClose={() => {
							const content = slot.parentElement;
							if (content) closeExcalidrawDialog(content);
						}}
						className="absolute top-3 right-3"
						testId="excalidraw-dialog-esc"
					/>,
					slot,
					slot.getAttribute('data-maestro-esc-row')
				)
			)}
		</>
	);
}
