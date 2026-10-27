/**
 * The B2 approval chip (spec section 5) and the "Run with full access"
 * control (Q2) in the Sketch chat pane: a waiting chip names the
 * server-stamped actor (A2), the request and the gate's verdict and answers
 * Run or Deny for that request only; a running chip has no buttons; the pane
 * says how many requests wait behind the per-link limit; and escalation shows
 * only on the messages it is offered on.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SketchApprovalChip } from '../../../../renderer/components/SketchBook/SketchApprovalChip';
import { SketchChatPane } from '../../../../renderer/components/SketchBook/SketchChatPane';
import type {
	SketchBotRequest,
	SketchChatMessage,
} from '../../../../renderer/stores/sketchSessionStore';
import { mockTheme } from '../../../helpers/mockTheme';

const waiting: SketchBotRequest = {
	replyTo: 'm1',
	actor: { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw', capLabel: '#3' },
	text: 'draw a box',
	ts: 1,
	status: 'awaiting_approval',
	verdict: { status: 'clean', score: 0.04, sourceLabel: 'Prompt Guard 2', locality: 'local' },
	posture: 'restricted',
};

const conductorMessage: SketchChatMessage = {
	id: 'chat-1',
	actor: { id: 'c1', kind: 'conductor', name: 'Pedram', role: 'conductor' },
	text: '@bot tidy the layout',
	ts: 2,
	request: { replyTo: 'local-1', posture: 'restricted', shared: false },
};

describe('SketchApprovalChip', () => {
	it('shows the actor line, the request and the verdict while it waits', () => {
		render(
			<SketchApprovalChip request={waiting} theme={mockTheme} onRun={vi.fn()} onDeny={vi.fn()} />
		);
		expect(screen.getByRole('group', { name: 'Bot request awaiting approval' })).toBeTruthy();
		expect(screen.getByText('"Sam" · guest, read-write link #3, not verified')).toBeTruthy();
		expect(screen.getByText('draw a box')).toBeTruthy();
		expect(screen.getByText('Screened: clean, Prompt Guard 2, 0.04')).toBeTruthy();
	});

	it('answers Run and Deny with the request it holds', () => {
		const onRun = vi.fn();
		const onDeny = vi.fn();
		render(
			<SketchApprovalChip request={waiting} theme={mockTheme} onRun={onRun} onDeny={onDeny} />
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		expect(onRun).toHaveBeenCalledWith('m1');
		fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
		expect(onDeny).toHaveBeenCalledWith('m1');
	});

	it('has no buttons once the turn runs', () => {
		render(
			<SketchApprovalChip
				request={{ ...waiting, status: 'running' }}
				theme={mockTheme}
				onRun={vi.fn()}
				onDeny={vi.fn()}
			/>
		);
		expect(screen.getByRole('group', { name: 'Running bot request' })).toBeTruthy();
		expect(screen.getByText('Running, restricted')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
	});
});

describe('SketchChatPane approvals', () => {
	it('draws one chip per approval and counts the requests waiting behind them', () => {
		const onRunRequest = vi.fn();
		render(
			<SketchChatPane
				messages={[]}
				theme={mockTheme}
				approvals={[waiting, { ...waiting, replyTo: 'm2' }]}
				waitingApprovals={2}
				onRunRequest={onRunRequest}
			/>
		);
		expect(screen.getAllByRole('group', { name: 'Bot request awaiting approval' })).toHaveLength(2);
		expect(screen.getByText('2 more requests wait behind these.')).toBeTruthy();
		fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[1]);
		expect(onRunRequest).toHaveBeenCalledWith('m2');
	});

	it('says one request waits in the singular', () => {
		render(
			<SketchChatPane messages={[]} theme={mockTheme} approvals={[waiting]} waitingApprovals={1} />
		);
		expect(screen.getByText('1 more request waits behind these.')).toBeTruthy();
	});

	it('draws no chip and no count without approvals', () => {
		render(<SketchChatPane messages={[]} theme={mockTheme} />);
		expect(screen.queryByRole('group', { name: 'Bot request awaiting approval' })).toBeNull();
		expect(screen.queryByText(/behind these/)).toBeNull();
	});
});

describe('SketchChatPane "Run with full access"', () => {
	it('shows on an escalatable conductor message and runs its request', () => {
		const onEscalate = vi.fn();
		render(
			<SketchChatPane
				messages={[conductorMessage]}
				theme={mockTheme}
				escalatable={new Set(['chat-1'])}
				onEscalate={onEscalate}
			/>
		);
		expect(screen.getByText('A guest edited this board, so this ran restricted.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Run with full access' }));
		expect(onEscalate).toHaveBeenCalledWith('local-1');
	});

	it('is absent on a message it is not offered on', () => {
		render(
			<SketchChatPane
				messages={[conductorMessage, { ...conductorMessage, id: 'chat-2', request: undefined }]}
				theme={mockTheme}
				escalatable={new Set(['chat-2'])}
			/>
		);
		expect(screen.queryByRole('button', { name: 'Run with full access' })).toBeNull();
	});
});
