/**
 * "Let collaborators ask the agent" (SketchBotPolicyToggle, spec section 5):
 * the switch follows the live room, turning it on shows the trust warning and
 * sends `writers` only on confirm, turning it off sends `conductor` at once,
 * it is greyed out with the reason while B2 is unavailable, and offers the
 * Prompt Guard 2 download while the screen is off.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SketchBotPolicyToggle } from '../../../../renderer/components/SketchBook/SketchBotPolicyToggle';
import {
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../../renderer/stores/sketchSessionStore';
import type { SketchB2Availability } from '../../../../shared/sketch/bot-policy';
import type { BotPolicy } from '../../../../shared/sketch/types';
import { mockTheme } from '../../../helpers/mockTheme';

const SKETCH_ID = 'sketch-1';
const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

function room(botPolicy: BotPolicy, connection: SketchRoomState['connection'] = 'live') {
	const state: SketchRoomState = {
		roomId: 'r1',
		connection,
		notice: null,
		actor: null,
		role: 'conductor',
		botPolicy,
		botOnline: true,
		guestEdited: false,
		headSeq: 0,
		keyEpoch: 1,
		syncedSeq: 0,
		screening: { reported: 'local', server: 'local', since: 1 },
		botPolicyNotice: null,
	};
	useSketchSessionStore.getState().updateSketchRoom(SKETCH_ID, () => state);
}

function availability(value: SketchB2Availability) {
	sketchApi.botPolicyStatus.mockResolvedValue({
		sketchId: SKETCH_ID,
		policy: 'conductor',
		availability: value,
	});
}

function renderToggle() {
	return render(
		<SketchBotPolicyToggle sketchId={SKETCH_ID} sketchName="Roadmap" theme={mockTheme} />
	);
}

function toggle() {
	return screen.getByRole('switch', { name: 'Let collaborators ask the agent' });
}

beforeEach(async () => {
	vi.clearAllMocks();
	useSketchSessionStore.setState({ sessions: {} });
	sketchApi.readScene.mockResolvedValue({
		type: 'excalidraw',
		version: 2,
		elements: [],
		appState: {},
		files: {},
	});
	await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
	availability({ ok: true });
	sketchApi.setBotPolicy.mockResolvedValue({
		sketchId: SKETCH_ID,
		policy: 'writers',
		availability: { ok: true },
	});
	sketchApi.onBotPolicyChanged.mockReturnValue(() => {});
});

describe('SketchBotPolicyToggle', () => {
	it('shows the trust warning first and sends writers only on confirm', async () => {
		room('conductor');
		renderToggle();
		await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(false));

		fireEvent.click(toggle());
		expect(screen.getByText('Let collaborators ask the agent?')).toBeTruthy();
		expect(screen.getByText(/"Roadmap"/)).toBeTruthy();
		expect(sketchApi.setBotPolicy).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Let them ask' }));
		await waitFor(() => expect(sketchApi.setBotPolicy).toHaveBeenCalledWith(SKETCH_ID, 'writers'));
	});

	it('sends nothing when the warning is cancelled', async () => {
		room('conductor');
		renderToggle();
		await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(false));
		fireEvent.click(toggle());
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Let collaborators ask the agent?')).toBeNull();
		expect(sketchApi.setBotPolicy).not.toHaveBeenCalled();
	});

	it('turns writers off at once', async () => {
		room('writers');
		renderToggle();
		await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
		fireEvent.click(toggle());
		await waitFor(() =>
			expect(sketchApi.setBotPolicy).toHaveBeenCalledWith(SKETCH_ID, 'conductor')
		);
		expect(screen.queryByText('Let collaborators ask the agent?')).toBeNull();
	});

	it('is greyed out with the reason while B2 is unavailable, with no download offer', async () => {
		availability({ ok: false, reason: 'Claude Code cannot run restricted turns.' });
		room('conductor');
		renderToggle();
		expect(await screen.findByText('Claude Code cannot run restricted turns.')).toBeTruthy();
		expect(toggle().hasAttribute('disabled')).toBe(true);
		expect(screen.queryByRole('button', { name: /Download Prompt Guard 2/ })).toBeNull();
	});

	it('offers the one-click download while the screen is off, and reads availability after', async () => {
		availability({ ok: false, reason: 'The screen is off.', offerScreenDownload: true });
		room('conductor');
		renderToggle();
		const download = await screen.findByRole('button', {
			name: 'Download Prompt Guard 2 (77 MB)',
		});
		availability({ ok: true });
		await act(async () => {
			fireEvent.click(download);
		});
		expect(sketchApi.installScreen).toHaveBeenCalled();
		await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(false));
	});

	it('shows why a download failed', async () => {
		availability({ ok: false, reason: 'The screen is off.', offerScreenDownload: true });
		sketchApi.installScreen.mockResolvedValueOnce({
			installed: false,
			assigned: false,
			error: 'Network down.',
		});
		room('conductor');
		renderToggle();
		fireEvent.click(await screen.findByRole('button', { name: /Download Prompt Guard 2/ }));
		expect(await screen.findByText('Network down.')).toBeTruthy();
	});

	it('is disabled while the room is not connected', async () => {
		room('conductor', 'reconnecting');
		renderToggle();
		expect(
			await screen.findByText('Collaborators can ask the agent once the room is connected.')
		).toBeTruthy();
		expect(toggle().hasAttribute('disabled')).toBe(true);
	});

	it("shows main's refusal of writers", async () => {
		sketchApi.setBotPolicy.mockRejectedValueOnce(new Error('The screen is off.'));
		room('conductor');
		renderToggle();
		await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(false));
		fireEvent.click(toggle());
		fireEvent.click(screen.getByRole('button', { name: 'Let them ask' }));
		expect(await screen.findByRole('alert')).toBeTruthy();
	});

	it('reads availability again when main says it changed', async () => {
		let changed: ((change: { sketchId?: string }) => void) | null = null;
		sketchApi.onBotPolicyChanged.mockImplementation((callback) => {
			changed = callback;
			return () => {};
		});
		room('conductor');
		renderToggle();
		await waitFor(() => expect(sketchApi.botPolicyStatus).toHaveBeenCalledTimes(1));
		availability({ ok: false, reason: 'Consent was revoked.' });
		await act(async () => {
			changed?.({});
		});
		expect(await screen.findByText('Consent was revoked.')).toBeTruthy();
		await act(async () => {
			changed?.({ sketchId: 'other-sketch' });
		});
		expect(sketchApi.botPolicyStatus).toHaveBeenCalledTimes(2);
	});
});
