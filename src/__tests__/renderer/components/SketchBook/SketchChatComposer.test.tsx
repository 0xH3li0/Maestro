/**
 * The Sketch tab's chat composer (SketchChatComposer, inside SketchChatPane):
 * Enter sends and clears the draft, Shift+Enter does not send, a failed send
 * keeps the draft and says why, and the placeholder says where a message goes.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SketchChatComposer } from '../../../../renderer/components/SketchBook/SketchChatComposer';
import { SketchChatPane } from '../../../../renderer/components/SketchBook/SketchChatPane';
import { CHAT_MAX_CHARS } from '../../../../shared/sketch/payloads';
import { mockTheme } from '../../../helpers/mockTheme';

function box(): HTMLTextAreaElement {
	return screen.getByLabelText('Message') as HTMLTextAreaElement;
}

describe('SketchChatComposer', () => {
	it('sends on Enter and clears the draft', async () => {
		const onSend = vi.fn(async () => undefined);
		render(<SketchChatComposer theme={mockTheme} shared onSend={onSend} />);

		fireEvent.change(box(), { target: { value: 'hello room' } });
		fireEvent.keyDown(box(), { key: 'Enter' });

		await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello room'));
		await waitFor(() => expect(box().value).toBe(''));
	});

	it('does not send on Shift+Enter or with an empty draft', () => {
		const onSend = vi.fn(async () => undefined);
		render(<SketchChatComposer theme={mockTheme} shared onSend={onSend} />);

		fireEvent.keyDown(box(), { key: 'Enter' });
		fireEvent.change(box(), { target: { value: 'two lines' } });
		fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
		expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
			false
		);
	});

	it('keeps the draft and shows why when the send fails', async () => {
		const onSend = vi.fn(async () => {
			throw new Error('Sketch Book: the room is not connected, so the message was not sent.');
		});
		render(<SketchChatComposer theme={mockTheme} shared onSend={onSend} />);

		fireEvent.change(box(), { target: { value: 'hello' } });
		fireEvent.click(screen.getByRole('button', { name: 'Send' }));

		expect((await screen.findByRole('alert')).textContent).toContain('not connected');
		expect(box().value).toBe('hello');
	});

	it('refuses a draft over the cap', () => {
		const onSend = vi.fn(async () => undefined);
		render(<SketchChatComposer theme={mockTheme} shared onSend={onSend} />);

		fireEvent.change(box(), { target: { value: 'x'.repeat(CHAT_MAX_CHARS + 1) } });

		expect(screen.getByRole('alert').textContent).toContain(`at most ${CHAT_MAX_CHARS}`);
		expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('says where a message goes, shared or not, in a short placeholder and the hint', () => {
		const hint = () => document.querySelector('[data-sketch-chat-hint]')?.textContent;
		const { rerender } = render(
			<SketchChatComposer theme={mockTheme} shared onSend={vi.fn(async () => undefined)} />
		);
		expect(box().placeholder).toBe('Message the room');
		expect(hint()).toBe('@bot asks the agent');
		rerender(
			<SketchChatComposer theme={mockTheme} shared={false} onSend={vi.fn(async () => undefined)} />
		);
		expect(box().placeholder).toBe('Ask the agent');
		expect(hint()).toBe('Only the agent reads this');
	});
});

describe('SketchChatPane composer', () => {
	it('ends in the composer only when it can send', () => {
		const { rerender } = render(<SketchChatPane messages={[]} theme={mockTheme} />);
		expect(screen.queryByLabelText('Message')).toBeNull();
		expect(screen.getByText('No messages yet.')).toBeTruthy();

		rerender(
			<SketchChatPane
				messages={[]}
				theme={mockTheme}
				shared
				onSend={vi.fn(async () => undefined)}
			/>
		);
		expect(screen.getByLabelText('Message')).toBeTruthy();
	});
});
