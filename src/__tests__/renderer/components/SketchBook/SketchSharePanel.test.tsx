/**
 * The Collaborate panel (SketchSharePanel, spec section 6): it waits on main's
 * confirmation poll whenever a confirmation is pending, also when it opens on
 * one, and turns to the signed-in state on its own. Once shared it splits
 * into Share, People and Safety tabs: each live link on Share offers Copy,
 * Reset, Revoke and (when suspended) Unsuspend with its room stats, Reset all
 * access on Safety asks again in place, and the footer holds Stop sharing.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sharing = vi.hoisted(() => ({
	shareSketchAndCopyLink: vi.fn(),
	copyExistingSketchLink: vi.fn(),
	resetSketchLinkAndCopy: vi.fn(),
}));
const room = vi.hoisted(() => ({ stats: null as unknown }));
vi.mock('../../../../renderer/services/sketchSharing', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/services/sketchSharing')>()),
	...sharing,
}));
vi.mock('../../../../renderer/components/SketchBook/SketchBotPolicyToggle', () => ({
	SketchBotPolicyToggle: () => null,
}));
vi.mock(
	'../../../../renderer/components/SketchBook/SketchRoomSections',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('../../../../renderer/components/SketchBook/SketchRoomSections')
		>()),
		SketchRoomMembers: () => <div data-testid="room-members" />,
		SketchFlaggedElements: () => <div data-testid="flagged-elements" />,
		useSketchRoomStats: () => room.stats,
	})
);

import { SketchSharePanel } from '../../../../renderer/components/SketchBook/SketchSharePanel';
import { __resetRememberedModalTabsForTests } from '../../../../renderer/components/ui/ModalTabStrip';
import type { SketchOwnerStatus } from '../../../../shared/sketch/server';
import type { SketchMintedLink } from '../../../../shared/sketch/commands';
import type { SketchRecord } from '../../../../shared/sketch/types';
import type { SketchRoomStats } from '../../../../shared/sketch/room-stats';
import { mockTheme } from '../../../helpers/mockTheme';

const SKETCH_ID = 'sketch-1';
const SERVER = 'https://sketch.runmaestro.ai';
const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

const pending: SketchOwnerStatus = {
	state: 'pending',
	email: 'owner@example.com',
	serverUrl: SERVER,
	requestedAt: 1,
	otherServer: false,
};
const confirmed: SketchOwnerStatus = {
	state: 'confirmed',
	email: 'owner@example.com',
	serverUrl: SERVER,
	confirmedAt: 2,
	storage: 'os',
	otherServer: false,
};

const LINK: SketchMintedLink = {
	capId: 'Cap000000001',
	role: 'rw',
	label: '',
	expiresAt: Date.now() + 86_400_000,
	url: `${SERVER}/s/room#key.cap`,
};

function record(links: { capId: string; revoked: boolean }[] | null): SketchRecord {
	return {
		sketchId: SKETCH_ID,
		ownerAgentId: 'agent-1',
		name: 'Untitled Sketch',
		filePath: 'sketch.excalidraw',
		createdAt: 1,
		guestEdited: false,
		share: links
			? {
					roomId: 'room',
					keyEpoch: 1,
					botPolicy: 'conductor',
					links: links.map((link) => ({
						...link,
						role: 'rw' as const,
						label: '',
						createdAt: Date.now(),
						expiresAt: null,
					})),
				}
			: null,
	} as SketchRecord;
}

function renderPanel() {
	return render(<SketchSharePanel sketchId={SKETCH_ID} theme={mockTheme} onClose={vi.fn()} />);
}

describe('SketchSharePanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sketchApi.get = vi.fn(async () => record(null));
		sketchApi.ownerStatus = vi.fn(async () => pending);
		sketchApi.waitForOwner = vi.fn(() => new Promise(() => undefined));
		sketchApi.registerOwner = vi.fn(async () => ({ status: pending, email: 'sent' }));
		sketchApi.revokeLink = vi.fn(async () => record([]));
		sketchApi.rotate = vi.fn(async () => record([]));
		sketchApi.roomAction = vi.fn(async () => ({ sketchId: SKETCH_ID, stats: null }));
		room.stats = null;
		// The panel remembers its tab for the app session; each test opens on Share.
		__resetRememberedModalTabsForTests();
	});

	it('waits for the click when it opens on a pending confirmation', async () => {
		let resolve: (status: SketchOwnerStatus) => void = () => undefined;
		sketchApi.waitForOwner = vi.fn(
			() => new Promise<SketchOwnerStatus>((done) => (resolve = done))
		);
		renderPanel();

		expect(await screen.findByText(/A confirmation email went to owner@example.com/)).toBeTruthy();
		expect(sketchApi.waitForOwner).toHaveBeenCalledTimes(1);

		resolve(confirmed);
		expect(await screen.findByRole('button', { name: /Share and copy link/ })).toBeTruthy();
		expect(document.querySelector('[data-sketch-collaborate-footer]')?.textContent).toContain(
			'owner@example.com'
		);
		// Not shared yet: no tabs, no Stop sharing.
		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull();
	});

	it('starts one wait after Send, not one per render', async () => {
		sketchApi.ownerStatus = vi
			.fn()
			.mockResolvedValueOnce({
				state: 'signed-out',
				email: null,
				serverUrl: null,
				otherServer: false,
			})
			.mockResolvedValue(pending);
		renderPanel();

		fireEvent.change(await screen.findByLabelText('Email'), {
			target: { value: 'owner@example.com' },
		});
		expect(sketchApi.waitForOwner).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));

		await waitFor(() => expect(sketchApi.registerOwner).toHaveBeenCalledWith('owner@example.com'));
		await waitFor(() => expect(sketchApi.waitForOwner).toHaveBeenCalledTimes(1));
		await screen.findByRole('button', { name: 'Send it again' });
		expect(sketchApi.waitForOwner).toHaveBeenCalledTimes(1);
	});

	it('copies a live link again, and shows it when the clipboard refuses', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		sharing.copyExistingSketchLink.mockResolvedValueOnce({ url: LINK.url, copied: true });
		renderPanel();

		const row = await findLinkRow(LINK.capId);
		fireEvent.click(within(row).getByRole('button', { name: /Copy/ }));
		await waitFor(() =>
			expect(sharing.copyExistingSketchLink).toHaveBeenCalledWith(SKETCH_ID, LINK.capId)
		);
		expect(screen.queryByText(/The clipboard refused the link/)).toBeNull();

		sharing.copyExistingSketchLink.mockResolvedValueOnce({ url: LINK.url, copied: false });
		fireEvent.click(within(row).getByRole('button', { name: /Copy/ }));
		expect(await screen.findByDisplayValue(LINK.url)).toBeTruthy();
	});

	it('shows why a link cannot be copied', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		sharing.copyExistingSketchLink.mockRejectedValueOnce(
			new Error('Sketch Book: the edit link was made before links were kept.')
		);
		renderPanel();

		fireEvent.click(within(await findLinkRow(LINK.capId)).getByRole('button', { name: /Copy/ }));
		expect((await screen.findByRole('alert')).textContent).toContain('made before links were kept');
	});

	it('resets one link and copies its replacement', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		sharing.resetSketchLinkAndCopy.mockResolvedValue({
			result: { record: record(null), createdRoom: false, link: LINK },
			copied: true,
		});
		renderPanel();

		fireEvent.click(within(await findLinkRow(LINK.capId)).getByRole('button', { name: /Reset/ }));
		await waitFor(() =>
			expect(sharing.resetSketchLinkAndCopy).toHaveBeenCalledWith(SKETCH_ID, LINK.capId)
		);
	});

	it('joins each link with its room stats, and unsuspends or revokes it', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		room.stats = {
			caps: [
				{
					capId: LINK.capId,
					label: '',
					role: 'rw',
					expiresAt: null,
					revoked: false,
					botSuspended: true,
					guardrailTotal: 5,
					online: 2,
				},
			],
			actors: [],
		} as unknown as SketchRoomStats;
		renderPanel();

		const row = await findLinkRow(LINK.capId);
		expect(within(row).getByText('@bot suspended')).toBeTruthy();
		expect(within(row).getByText('2 online')).toBeTruthy();
		expect(within(row).getByText('rejected 5')).toBeTruthy();

		fireEvent.click(within(row).getByRole('button', { name: 'Unsuspend' }));
		await waitFor(() =>
			expect(sketchApi.roomAction).toHaveBeenCalledWith(SKETCH_ID, 'unsuspend', {
				capId: LINK.capId,
			})
		);
		fireEvent.click(within(row).getByRole('button', { name: /^Revoke/ }));
		await waitFor(() => expect(sketchApi.revokeLink).toHaveBeenCalledWith(SKETCH_ID, LINK.capId));
	});

	it('splits a shared sketch into Share, People and Safety, counting the people', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		room.stats = { caps: [], actors: [{}, {}, {}] } as unknown as SketchRoomStats;
		renderPanel();

		const tabs = await screen.findAllByRole('tab');
		expect(tabs.map((tab) => tab.textContent)).toEqual(['Share', 'People3', 'Safety']);
		expect(screen.queryByTestId('room-members')).toBeNull();

		fireEvent.click(screen.getByRole('tab', { name: /People/ }));
		expect(screen.getByTestId('room-members')).toBeTruthy();
		expect(document.querySelector('[data-sketch-link]')).toBeNull();

		// Fresh stats are asked for once the panel shows a shared sketch.
		expect(sketchApi.roomStats).toHaveBeenCalledWith(SKETCH_ID);
	});

	it('asks again in place before Stop sharing, from the footer', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		sketchApi.unshare = vi.fn(async () => record(null));
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
		expect(sketchApi.unshare).not.toHaveBeenCalled();
		expect(screen.getByText(/The room is deleted on RunMaestro.ai/)).toBeTruthy();
		const confirms = screen.getAllByRole('button', { name: 'Stop sharing' });
		fireEvent.click(confirms[confirms.length - 1]);
		await waitFor(() => expect(sketchApi.unshare).toHaveBeenCalledWith(SKETCH_ID));
	});

	it('lists no revoked link', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: true }]));
		renderPanel();

		await screen.findByText('No live links.');
		expect(document.querySelector(`[data-sketch-link="${LINK.capId}"]`)).toBeNull();
	});

	it('asks again in place before Reset all access', async () => {
		sketchApi.ownerStatus = vi.fn(async () => confirmed);
		sketchApi.get = vi.fn(async () => record([{ capId: LINK.capId, revoked: false }]));
		renderPanel();

		fireEvent.click(await screen.findByRole('tab', { name: 'Safety' }));
		expect(screen.getByTestId('flagged-elements')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /Reset all access/ }));
		expect(sketchApi.rotate).not.toHaveBeenCalled();
		expect(screen.getByText(/Every link stops working/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /Reset all access/ }));
		await waitFor(() => expect(sketchApi.rotate).toHaveBeenCalledWith(SKETCH_ID));
	});
});

async function findLinkRow(capId: string): Promise<HTMLElement> {
	await waitFor(() => expect(document.querySelector(`[data-sketch-link="${capId}"]`)).toBeTruthy());
	return document.querySelector(`[data-sketch-link="${capId}"]`) as HTMLElement;
}
