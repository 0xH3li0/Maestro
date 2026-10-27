/**
 * The Room panel (SketchRoomPanel, spec sections 6, 8.8 and 8.9): members and
 * links from the live `room.stats`, Kick (said to be temporary), Unlock and
 * Unsuspend through `roomAction`, Revoke and Reset all access through the
 * Collaborate panel's verbs, the Y4 banner, and flagged elements from the audit log
 * with a one-click delete of the ones the board still holds.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ deleteSketchElementsAsConductor: vi.fn() }));
vi.mock('../../../../renderer/services/sketchAgentWrites', () => writes);

import { SketchRoomPanel } from '../../../../renderer/components/SketchBook/SketchRoomPanel';
import {
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../../renderer/stores/sketchSessionStore';
import type { SketchRoomStats } from '../../../../shared/sketch/room-stats';
import type { SketchFlaggedElement } from '../../../../shared/sketch/room-admin';
import { mockTheme } from '../../../helpers/mockTheme';

const SKETCH_ID = 'sketch-1';
const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeStats(fields: Partial<SketchRoomStats> = {}): SketchRoomStats {
	return {
		guestEdited: true,
		actors: [
			{
				actorId: 'guest-1',
				kind: 'guest',
				name: 'Sam',
				capId: 'Cap000000001',
				capLabel: '#3',
				role: 'rw',
				online: true,
				ops: 4,
				toBot: 3,
				denyStreak: 3,
				denialsTotal: 3,
				guardrailTotal: 3,
				guardrailByReason: { injection: 3, other: 0 },
				unavailableTotal: 2,
				lockedOut: true,
				lastSeen: 1,
			},
			{
				actorId: 'guest-2',
				kind: 'guest',
				name: 'Ana',
				role: 'ro',
				online: false,
				ops: 0,
				toBot: 0,
				denyStreak: 0,
				denialsTotal: 0,
				guardrailTotal: 0,
				guardrailByReason: { injection: 0, other: 0 },
				unavailableTotal: 0,
				lockedOut: false,
				lastSeen: Date.now() - 60_000,
			},
		],
		caps: [
			{
				capId: 'Cap000000001',
				label: 'Review',
				role: 'rw',
				expiresAt: Date.now() + 3 * 86_400_000,
				revoked: false,
				botSuspended: true,
				guardrailTotal: 5,
				online: 1,
			},
			{
				capId: 'Cap000000002',
				label: 'Old',
				role: 'ro',
				expiresAt: null,
				revoked: true,
				botSuspended: false,
				guardrailTotal: 0,
				online: 0,
			},
		],
		flaggedActors: ['guest-1'],
		screening: 'local',
		screeningSince: 1,
		...fields,
	};
}

function setRoom(
	stats: SketchRoomStats | null,
	connection: SketchRoomState['connection'] = 'live'
) {
	const state: SketchRoomState = {
		roomId: 'r1',
		connection,
		notice: null,
		actor: null,
		role: 'conductor',
		botPolicy: 'conductor',
		botOnline: true,
		guestEdited: false,
		headSeq: 0,
		keyEpoch: 1,
		syncedSeq: 0,
		screening: { reported: 'local', server: 'local', since: 1 },
		botPolicyNotice: null,
		stats,
	};
	useSketchSessionStore.getState().updateSketchRoom(SKETCH_ID, () => state);
}

const flagged: SketchFlaggedElement[] = [
	{
		elementId: 'el-live',
		version: 2,
		actor: { id: 'guest-1', kind: 'guest' },
		score: 0.97,
		source: 'Prompt Guard 2 22M',
		locality: 'local',
		ts: Date.now() - 5_000,
	},
	{
		elementId: 'el-gone',
		version: 1,
		actor: { id: 'guest-1', kind: 'guest' },
		score: 0.91,
		source: 'Prompt Guard 2 22M',
		locality: 'local',
		ts: Date.now() - 6_000,
	},
];

function renderPanel(onClose = vi.fn()) {
	render(<SketchRoomPanel sketchId={SKETCH_ID} theme={mockTheme} onClose={onClose} />);
	return { onClose };
}

function row(selector: string): HTMLElement {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`no ${selector}`);
	return element as HTMLElement;
}

beforeEach(async () => {
	vi.clearAllMocks();
	useSketchSessionStore.setState({ sessions: {} });
	sketchApi.readScene.mockResolvedValue({
		type: 'excalidraw',
		version: 2,
		elements: [
			{ id: 'el-live', type: 'text', version: 2 },
			{ id: 'el-gone', type: 'text', version: 2, isDeleted: true },
		],
		appState: {},
		files: {},
	});
	sketchApi.roomAudit.mockResolvedValue({ sketchId: SKETCH_ID, entries: [], flagged });
	sketchApi.roomAction.mockResolvedValue({ sketchId: SKETCH_ID, connection: 'live', stats: null });
	writes.deleteSketchElementsAsConductor.mockResolvedValue(['el-live']);
	await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
	setRoom(makeStats());
});

describe('SketchRoomPanel', () => {
	it('asks the server for fresh stats once on open', async () => {
		renderPanel();
		await waitFor(() => expect(sketchApi.roomStats).toHaveBeenCalledWith(SKETCH_ID));
	});

	it('shows each member with role, counters and lock state', () => {
		renderPanel();
		const sam = row('[data-sketch-room-actor="guest-1"]');
		expect(within(sam).getByText('"Sam" · guest, read-write link #3, not verified')).toBeTruthy();
		expect(within(sam).getByText('Locked out')).toBeTruthy();
		expect(sam.textContent).toContain('Online');
		expect(sam.textContent).toContain('4 ops');
		expect(sam.textContent).toContain('3 @bot');
		expect(sam.textContent).toContain('deny streak 3');
		expect(sam.textContent).toContain('rejected 3');
		expect(sam.textContent).toContain('screen failed 2');
		const ana = row('[data-sketch-room-actor="guest-2"]');
		expect(ana.textContent).toContain('Last seen');
		expect(within(ana).queryByText('Unlock')).toBeNull();
	});

	it('says that kick is temporary and revoke is the real fix', () => {
		renderPanel();
		expect(screen.getByText(/Kick is temporary/).textContent).toMatch(/Revoke the link/);
	});

	it('kicks and unlocks through roomAction', async () => {
		renderPanel();
		const sam = row('[data-sketch-room-actor="guest-1"]');
		fireEvent.click(within(sam).getByText('Kick'));
		await waitFor(() =>
			expect(sketchApi.roomAction).toHaveBeenCalledWith(SKETCH_ID, 'kick', { actorId: 'guest-1' })
		);
		fireEvent.click(within(sam).getByText('Unlock'));
		await waitFor(() =>
			expect(sketchApi.roomAction).toHaveBeenCalledWith(SKETCH_ID, 'unlock', {
				actorId: 'guest-1',
			})
		);
	});

	it('shows each link with expiry and suspension, and unsuspends or revokes it', async () => {
		renderPanel();
		const review = row('[data-sketch-room-cap="Cap000000001"]');
		expect(within(review).getByText('@bot suspended')).toBeTruthy();
		expect(review.textContent).toContain(' · expires ');
		fireEvent.click(within(review).getByText('Unsuspend'));
		await waitFor(() =>
			expect(sketchApi.roomAction).toHaveBeenCalledWith(SKETCH_ID, 'unsuspend', {
				capId: 'Cap000000001',
			})
		);
		fireEvent.click(within(review).getByText('Revoke'));
		await waitFor(() =>
			expect(sketchApi.revokeLink).toHaveBeenCalledWith(SKETCH_ID, 'Cap000000001')
		);
		const old = row('[data-sketch-room-cap="Cap000000002"]');
		expect(old.textContent).toContain('revoked');
		expect(within(old).queryByText('Revoke')).toBeNull();
	});

	it('shows the Y4 banner while a screen outage is counted', () => {
		renderPanel();
		expect(row('[data-sketch-screen-outage]').textContent).toBe(
			'Your screen failed 2 guest requests'
		);
	});

	it('lists the flagged elements the board still holds, and deletes one as the conductor', async () => {
		renderPanel();
		await waitFor(() =>
			expect(document.querySelector('[data-sketch-flagged-element="el-live"]')).toBeTruthy()
		);
		expect(document.querySelector('[data-sketch-flagged-element="el-gone"]')).toBeNull();
		const live = row('[data-sketch-flagged-element="el-live"]');
		expect(live.textContent).toContain('Flagged by Prompt Guard 2 22M, 0.97 (on this computer)');
		fireEvent.click(within(live).getByText('Delete'));
		await waitFor(() =>
			expect(writes.deleteSketchElementsAsConductor).toHaveBeenCalledWith(SKETCH_ID, ['el-live'])
		);
	});

	it('asks again in place before Reset all access', async () => {
		renderPanel();
		fireEvent.click(screen.getByText('Reset all access'));
		expect(sketchApi.rotate).not.toHaveBeenCalled();
		expect(screen.getByText(/Every link stops working/)).toBeTruthy();
		fireEvent.click(screen.getByText('Cancel'));
		fireEvent.click(screen.getByText('Reset all access'));
		const buttons = screen.getAllByText('Reset all access');
		fireEvent.click(buttons[buttons.length - 1]);
		await waitFor(() => expect(sketchApi.rotate).toHaveBeenCalledWith(SKETCH_ID));
	});

	it('shows an action error', async () => {
		sketchApi.roomAction.mockRejectedValueOnce(
			new Error('Sketch Book: the room is not connected yet.')
		);
		renderPanel();
		fireEvent.click(within(row('[data-sketch-room-actor="guest-1"]')).getByText('Kick'));
		expect((await screen.findByRole('alert')).textContent).toContain('not connected');
	});

	it('says why there are no members before the server reports', () => {
		setRoom(null);
		renderPanel();
		expect(screen.getByText('Waiting for the room to report who is in it.')).toBeTruthy();
		expect(document.querySelector('[data-sketch-room-actor]')).toBeNull();
	});

	it('closes on its close button', () => {
		const { onClose } = renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Close the Room panel' }));
		expect(onClose).toHaveBeenCalled();
	});
});
