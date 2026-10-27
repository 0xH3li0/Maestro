/**
 * The room parts of the Collaborate panel's tabs (SketchRoomSections, spec
 * sections 6, 8.8 and 8.9): People lists members from the live `room.stats`
 * with Kick (said to be temporary) and Unlock through `roomAction`; Safety
 * lists flagged elements from the audit log with a one-click delete of the
 * ones the board still holds. The links are the Share tab's own rows
 * (SketchSharePanel.test.tsx).
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ deleteSketchElementsAsConductor: vi.fn() }));
vi.mock('../../../../renderer/services/sketchAgentWrites', () => writes);

import {
	findRoomStatsCap,
	SketchFlaggedElements,
	SketchRoomMembers,
} from '../../../../renderer/components/SketchBook/SketchRoomSections';
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

function runner() {
	return vi.fn(async (action: () => Promise<unknown>) => {
		await action();
	});
}

function renderMembers(stats: SketchRoomStats | null = makeStats()) {
	const run = runner();
	render(
		<SketchRoomMembers
			sketchId={SKETCH_ID}
			theme={mockTheme}
			stats={stats}
			busy={false}
			run={run}
		/>
	);
	return { run };
}

function renderFlagged(stats: SketchRoomStats | null = makeStats()) {
	const run = runner();
	const onError = vi.fn();
	render(
		<SketchFlaggedElements
			sketchId={SKETCH_ID}
			theme={mockTheme}
			stats={stats}
			busy={false}
			run={run}
			onError={onError}
		/>
	);
	return { run, onError };
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

describe('SketchRoomMembers', () => {
	it('shows each member with role, the counters that are not zero, and lock state', () => {
		renderMembers();
		const sam = row('[data-sketch-room-actor="guest-1"]');
		expect(within(sam).getByText('"Sam"')).toBeTruthy();
		expect(within(sam).getByText('guest, read-write link #3, not verified')).toBeTruthy();
		expect(within(sam).getByText('Locked out')).toBeTruthy();
		expect(sam.textContent).toContain('Online');
		expect(sam.textContent).toContain('3 @bot');
		expect(sam.textContent).toContain('deny streak 3');
		expect(sam.textContent).toContain('rejected 3');
		expect(sam.textContent).toContain('screen failed 2');
		expect(sam.textContent).not.toContain('ops');
		const ana = row('[data-sketch-room-actor="guest-2"]');
		expect(within(ana).queryByText('Unlock')).toBeNull();
	});

	it('shows only presence for a member whose counters are all zero', () => {
		renderMembers();
		const ana = row('[data-sketch-room-actor="guest-2"]');
		const facts = Array.from(
			ana.querySelectorAll('[data-sketch-meta-line] > span.whitespace-nowrap')
		).map((fact) => fact.textContent);
		expect(facts).toEqual([expect.stringMatching(/^Seen /)]);
	});

	it('says once, under the list, that kick is temporary and revoke is the real fix', () => {
		renderMembers();
		expect(screen.getAllByText(/Kick is temporary/)).toHaveLength(1);
		expect(screen.getByText(/Kick is temporary/).textContent).toMatch(/Revoke the link/);
	});

	it('kicks and unlocks through roomAction, by the panel runner', async () => {
		const { run } = renderMembers();
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
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('says why there are no members before the server reports', () => {
		setRoom(null);
		renderMembers(null);
		expect(screen.getByText('Waiting for the room to report who is in it.')).toBeTruthy();
		expect(document.querySelector('[data-sketch-room-actor]')).toBeNull();
	});
});

describe('SketchFlaggedElements', () => {
	it('lists the flagged elements the board still holds, and deletes one as the conductor', async () => {
		const { run } = renderFlagged();
		await waitFor(() =>
			expect(document.querySelector('[data-sketch-flagged-element="el-live"]')).toBeTruthy()
		);
		expect(document.querySelector('[data-sketch-flagged-element="el-gone"]')).toBeNull();
		const live = row('[data-sketch-flagged-element="el-live"]');
		expect(live.textContent).toContain('Flagged by Prompt Guard 2 22M, 0.97 (on this computer)');
		fireEvent.click(within(live).getByRole('button', { name: 'Delete the flagged text' }));
		await waitFor(() =>
			expect(writes.deleteSketchElementsAsConductor).toHaveBeenCalledWith(SKETCH_ID, ['el-live'])
		);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('hands an unreadable audit log to the panel error line', async () => {
		sketchApi.roomAudit.mockRejectedValueOnce(new Error('Sketch Book: no room.'));
		const { onError } = renderFlagged();
		await waitFor(() => expect(onError).toHaveBeenCalledWith('Sketch Book: no room.'));
	});
});

describe('findRoomStatsCap', () => {
	it('finds a link by id in the stats, and nothing without stats', () => {
		expect(findRoomStatsCap(makeStats(), 'Cap000000001')?.label).toBe('Review');
		expect(findRoomStatsCap(makeStats(), 'nope')).toBeUndefined();
		expect(findRoomStatsCap(null, 'Cap000000001')).toBeUndefined();
	});
});
