/**
 * QuickChatRoot - the Quick Chat window's view.
 *
 * Its icon buttons explain themselves in a hover overlay rather than a native
 * `title`, which macOS does not show in this panel while another app is active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QuickChatRoot } from '../../../renderer/quickChat/QuickChatRoot';
import { EMPTY_QUICK_CHAT_SNAPSHOT, type QuickChatSnapshot } from '../../../shared/quickChat';
import { openZoomViewer, useZoomViewerStore } from '../../../renderer/components/ZoomViewer';

function snapshot(patch: Partial<QuickChatSnapshot> = {}): QuickChatSnapshot {
	return { ...EMPTY_QUICK_CHAT_SNAPSHOT, agentId: 'a', agentName: 'Pedsidian', ...patch };
}

async function renderWith(initial: QuickChatSnapshot) {
	vi.mocked(window.maestro.quickChat.getSnapshot).mockResolvedValue(initial);
	render(<QuickChatRoot />);
	await act(async () => {});
}

beforeEach(() => {
	vi.mocked(window.maestro.quickChat.command).mockReset();
});

describe('Keep button', () => {
	it('explains a temporary chat in a hover overlay, not a native title', async () => {
		await renderWith(snapshot({ persistent: false }));
		const button = screen.getByRole('button', { name: /^Keep as a tab\./ });
		expect(button).not.toHaveAttribute('title');

		fireEvent.mouseEnter(button.parentElement!);
		const tooltip = screen.getByRole('tooltip');
		expect(tooltip).toHaveTextContent('Keep as a tab');
		expect(tooltip).toHaveTextContent(
			'Temporary: this chat is deleted when you start a new one. Click to keep it as a tab on Pedsidian.'
		);
	});

	it('explains a kept chat and toggles it back to temporary', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ persistent: false }),
		});
		await renderWith(snapshot({ persistent: true }));
		const button = screen.getByRole('button', { name: /^Kept as a tab\./ });

		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('stays as a tab on Pedsidian');

		await act(async () => fireEvent.click(button));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setPersistent',
			persistent: false,
		});
	});
});

describe('Pin button', () => {
	it('explains what pinning does in a hover overlay', async () => {
		await renderWith(snapshot());
		const button = screen.getByRole('button', { name: /^Pinned on top\./ });
		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Floats above other windows.');
	});
});

describe('keyboard chords', () => {
	it('Cmd+B toggles keep, the same command the bookmark sends', async () => {
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({
			ok: true,
			snapshot: snapshot({ persistent: true }),
		});
		await renderWith(snapshot({ persistent: false }));
		await act(async () => fireEvent.keyDown(window, { key: 'b', metaKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({
			type: 'setPersistent',
			persistent: true,
		});
	});

	it('Cmd+P toggles the pin and prevents the print default', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		const event = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true });
		await act(async () => {
			window.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledWith(false);
	});

	it('acts once on a held chord, ignoring auto-repeat', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		await act(async () => {
			fireEvent.keyDown(window, { key: 'p', metaKey: true });
			fireEvent.keyDown(window, { key: 'p', metaKey: true, repeat: true });
			fireEvent.keyDown(window, { key: 'p', metaKey: true, repeat: true });
		});
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledTimes(1);
	});

	it('answers chords typed in the agent picker filter', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot({ agents: [{ id: 'a', name: 'Pedsidian' }] }));
		await act(async () => fireEvent.keyDown(window, { key: 'k', metaKey: true }));
		const filter = screen.getByTestId('quick-chat-agent-filter');
		await act(async () => fireEvent.keyDown(filter, { key: 'p', metaKey: true }));
		expect(window.maestro.quickChat.setPinned).toHaveBeenCalledWith(false);

		// Cmd+K from the filter closes the picker again.
		await act(async () => fireEvent.keyDown(filter, { key: 'k', metaKey: true }));
		expect(screen.queryByTestId('quick-chat-agent-filter')).toBeNull();
	});

	it('leaves Shift chords to the composer', async () => {
		vi.mocked(window.maestro.quickChat.setPinned).mockClear();
		await renderWith(snapshot());
		await act(async () => fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true }));
		expect(window.maestro.quickChat.setPinned).not.toHaveBeenCalled();
	});

	it('names the chord in the Keep and Pin overlays', async () => {
		await renderWith(snapshot());
		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Keep as a tab\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/B$/);
	});
});

describe('Open in Maestro', () => {
	it('Cmd+T opens the chat as a tab once there is one, and the overlay names the chord', async () => {
		const open = snapshot({ tabId: 't1', messages: [{ id: 'm', role: 'user', text: 'hi' }] });
		vi.mocked(window.maestro.quickChat.command).mockResolvedValue({ ok: true, snapshot: open });
		await renderWith(open);
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		expect(window.maestro.quickChat.command).toHaveBeenCalledWith({ type: 'reveal' });

		fireEvent.mouseEnter(screen.getByRole('button', { name: /^Open in Maestro\./ }).parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent(/T$/);
	});

	it('Cmd+T does nothing before the first message', async () => {
		await renderWith(snapshot({ tabId: null }));
		await act(async () => fireEvent.keyDown(window, { key: 't', metaKey: true }));
		expect(window.maestro.quickChat.command).not.toHaveBeenCalledWith({ type: 'reveal' });
	});
});

describe('header', () => {
	it('shows only the agent, not a "Quick Chat" label', async () => {
		await renderWith(snapshot({ messages: [{ id: 'm', role: 'user', text: 'hi' }] }));
		expect(screen.queryByText('Quick Chat')).toBeNull();
		expect(screen.queryByText('Quick Chat tab')).toBeNull();
	});

	it('explains the agent switcher in an overlay with its chord', async () => {
		await renderWith(snapshot());
		const button = screen.getByTestId('quick-chat-agent-button');
		expect(button).not.toHaveAttribute('title');
		fireEvent.mouseEnter(button.parentElement!);
		expect(screen.getByRole('tooltip')).toHaveTextContent('Switching starts a new chat.');
	});
});

describe('diagram viewer', () => {
	afterEach(() => act(() => useZoomViewerStore.getState().close()));

	it('gives the keyboard back to the viewer, not the hidden composer, when summoned again', async () => {
		let focusInput: (() => void) | undefined;
		vi.mocked(window.maestro.quickChat.onFocusInput).mockImplementationOnce((cb) => {
			focusInput = cb;
			return () => {};
		});
		await renderWith(snapshot());
		act(() =>
			openZoomViewer(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 'Flow')
		);
		screen.getByPlaceholderText(/anything/).focus();

		act(() => focusInput?.());
		expect(document.activeElement).toBe(screen.getByTestId('zoom-viewer'));
	});

	it('opens full screen over the window, and Escape closes it without hiding the window', async () => {
		vi.mocked(window.maestro.quickChat.setFullView).mockClear();
		vi.mocked(window.maestro.quickChat.window).mockClear();
		await renderWith(snapshot());
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		act(() => openZoomViewer(svg, 'Flow'));
		expect(window.maestro.quickChat.setFullView).toHaveBeenLastCalledWith(true);

		await act(async () =>
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
		);
		expect(useZoomViewerStore.getState().request).toBeNull();
		expect(window.maestro.quickChat.setFullView).toHaveBeenLastCalledWith(false);
		expect(window.maestro.quickChat.window).not.toHaveBeenCalledWith('hide');
	});
});
