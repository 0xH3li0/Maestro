/**
 * QuickChatRoot - the Quick Chat window's view.
 *
 * Its icon buttons explain themselves in a hover overlay rather than a native
 * `title`, which macOS does not show in this panel while another app is active.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QuickChatRoot } from '../../../renderer/quickChat/QuickChatRoot';
import { EMPTY_QUICK_CHAT_SNAPSHOT, type QuickChatSnapshot } from '../../../shared/quickChat';

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
