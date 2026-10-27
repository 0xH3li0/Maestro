/**
 * The "Publish anyway" chip (spec section 8.5, D3) and its place in the
 * Sketch chat pane: a held bot reply names the server-stamped actor (A2) and
 * the screen's reason, and its two buttons answer for that request only.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SketchChatPane } from '../../../../renderer/components/SketchBook/SketchChatPane';
import { SketchHeldReplyChip } from '../../../../renderer/components/SketchBook/SketchHeldReplyChip';
import type { SketchBotRequest } from '../../../../renderer/stores/sketchSessionStore';
import { mockTheme } from '../../../helpers/mockTheme';

const held: SketchBotRequest = {
	replyTo: 'm1',
	actor: { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw', capLabel: '#3' },
	text: 'draw a box',
	ts: 1,
	status: 'held',
	verdict: { status: 'clean', score: 0.04, sourceLabel: 'Prompt Guard 2', locality: 'local' },
	posture: 'restricted',
	heldReason: 'Flagged by Prompt Guard 2 (0.91) as possibly holding a secret.',
};

describe('SketchHeldReplyChip', () => {
	it('shows the actor line and the reason', () => {
		render(
			<SketchHeldReplyChip
				request={held}
				theme={mockTheme}
				onPublish={vi.fn()}
				onDiscard={vi.fn()}
			/>
		);
		expect(screen.getByText('Reply held before posting')).toBeTruthy();
		expect(
			screen.getByText('Answering "Sam" · guest, read-write link #3, not verified')
		).toBeTruthy();
		expect(screen.getByText(held.heldReason!)).toBeTruthy();
	});

	it('falls back to a plain reason when the screen gave none', () => {
		render(
			<SketchHeldReplyChip
				request={{ ...held, heldReason: undefined }}
				theme={mockTheme}
				onPublish={vi.fn()}
				onDiscard={vi.fn()}
			/>
		);
		expect(screen.getByText('The secret screen flagged the reply.')).toBeTruthy();
	});

	it('answers Publish anyway and Discard with the request it holds', () => {
		const onPublish = vi.fn();
		const onDiscard = vi.fn();
		render(
			<SketchHeldReplyChip
				request={held}
				theme={mockTheme}
				onPublish={onPublish}
				onDiscard={onDiscard}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Publish anyway' }));
		expect(onPublish).toHaveBeenCalledWith('m1');
		fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
		expect(onDiscard).toHaveBeenCalledWith('m1');
	});
});

describe('SketchChatPane with held replies', () => {
	it('draws one chip per held reply after the messages', () => {
		const onPublishHeld = vi.fn();
		render(
			<SketchChatPane
				messages={[
					{
						id: 'c1',
						actor: { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' },
						text: '@bot draw a box',
						ts: 1,
					},
				]}
				theme={mockTheme}
				heldReplies={[held, { ...held, replyTo: 'm2' }]}
				onPublishHeld={onPublishHeld}
			/>
		);
		expect(screen.getByText('@bot draw a box')).toBeTruthy();
		const chips = screen.getAllByRole('group', { name: 'Held bot reply' });
		expect(chips).toHaveLength(2);
		fireEvent.click(screen.getAllByRole('button', { name: 'Publish anyway' })[1]);
		expect(onPublishHeld).toHaveBeenCalledWith('m2');
	});

	it('draws no chip without held replies', () => {
		render(<SketchChatPane messages={[]} theme={mockTheme} />);
		expect(screen.queryByRole('group', { name: 'Held bot reply' })).toBeNull();
	});
});
