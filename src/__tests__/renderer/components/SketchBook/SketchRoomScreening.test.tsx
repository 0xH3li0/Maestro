/**
 * The screening badge (wire contract X10) in both states, naming the cloud
 * engine from main's consent module, and the Y4 banner shown only while a
 * guest request met a failed screen.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SketchScreenOutageBanner,
	SketchScreeningBadge,
} from '../../../../renderer/components/SketchBook/SketchRoomScreening';
import type { RoomStatsActor } from '../../../../shared/sketch/protocol';
import type { SketchRoomStats } from '../../../../shared/sketch/room-stats';
import type { InjectionSourceInfo } from '../../../../shared/local-models/injection-screen';
import { mockTheme } from '../../../helpers/mockTheme';

const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

function statusWith(source: InjectionSourceInfo | null) {
	return { consent: {}, source, sourceCovered: source !== null, rooms: [] };
}

function actor(overrides: Partial<RoomStatsActor>): RoomStatsActor {
	return {
		actorId: 'g1',
		kind: 'guest',
		name: 'Sam',
		role: 'rw',
		online: true,
		ops: 0,
		toBot: 0,
		denyStreak: 0,
		denialsTotal: 0,
		guardrailTotal: 0,
		guardrailByReason: { injection: 0, other: 0 },
		unavailableTotal: 0,
		lockedOut: false,
		lastSeen: 0,
		...overrides,
	};
}

function stats(actors: RoomStatsActor[]): SketchRoomStats {
	return {
		guestEdited: false,
		actors,
		caps: [],
		flaggedActors: [],
		screening: 'local',
		screeningSince: 1,
	};
}

beforeEach(() => {
	sketchApi.screeningConsentStatus.mockReset().mockResolvedValue(statusWith(null));
	sketchApi.onScreeningChanged.mockReset().mockImplementation(() => () => {});
});

describe('SketchScreeningBadge', () => {
	it('renders nothing before the room has a screening value', () => {
		render(<SketchScreeningBadge screening={null} theme={mockTheme} />);
		expect(screen.queryByTestId('sketch-screening-badge')).toBeNull();
	});

	it('says local screening and does not ask main for the engine', () => {
		render(<SketchScreeningBadge screening="local" theme={mockTheme} />);
		const badge = screen.getByTestId('sketch-screening-badge');
		expect(badge.textContent).toBe('Local screening');
		expect(badge.getAttribute('title')).toBe('Guest text is screened on this computer.');
		expect(sketchApi.screeningConsentStatus).not.toHaveBeenCalled();
	});

	it('names Jev and its host for a cloud room', async () => {
		sketchApi.screeningConsentStatus.mockResolvedValue(
			statusWith({
				kind: 'jev',
				locality: 'cloud',
				host: 'api.typesafe.ai',
				label: 'Jev (TypeSafe cloud)',
			})
		);
		render(<SketchScreeningBadge screening="cloud" theme={mockTheme} />);
		await waitFor(() =>
			expect(screen.getByTestId('sketch-screening-badge').textContent).toBe('Cloud screening: Jev')
		);
		expect(screen.getByTestId('sketch-screening-badge').getAttribute('title')).toContain(
			'Jev, by TypeSafe, api.typesafe.ai'
		);
	});

	it('still says cloud when the engine cannot be read', async () => {
		sketchApi.screeningConsentStatus.mockRejectedValue(new Error('Sketch Book is off'));
		render(<SketchScreeningBadge screening="cloud" theme={mockTheme} />);
		await waitFor(() => expect(sketchApi.screeningConsentStatus).toHaveBeenCalled());
		expect(screen.getByTestId('sketch-screening-badge').textContent).toBe('Cloud screening');
	});

	it('reads the engine again on a screening change', async () => {
		let push: (() => void) | null = null;
		sketchApi.onScreeningChanged.mockImplementation((callback: () => void) => {
			push = callback;
			return () => {};
		});
		render(<SketchScreeningBadge screening="cloud" theme={mockTheme} />);
		await waitFor(() => expect(sketchApi.screeningConsentStatus).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId('sketch-screening-badge').textContent).toBe('Cloud screening');

		sketchApi.screeningConsentStatus.mockResolvedValue(
			statusWith({ kind: 'openjev', locality: 'cloud', host: 'gpu.example.com', label: 'OpenJev' })
		);
		await act(async () => push?.());
		await waitFor(() =>
			expect(screen.getByTestId('sketch-screening-badge').textContent).toBe(
				'Cloud screening: OpenJev'
			)
		);
	});
});

describe('SketchScreenOutageBanner', () => {
	it('renders nothing without stats or while every unavailableTotal is 0', () => {
		const { container, rerender } = render(
			<SketchScreenOutageBanner stats={null} theme={mockTheme} />
		);
		expect(container.querySelector('[data-sketch-screen-outage]')).toBeNull();
		rerender(<SketchScreenOutageBanner stats={stats([actor({})])} theme={mockTheme} />);
		expect(container.querySelector('[data-sketch-screen-outage]')).toBeNull();
	});

	it('counts the failed guest requests over every actor', () => {
		render(
			<SketchScreenOutageBanner
				stats={stats([
					actor({ actorId: 'g1', unavailableTotal: 2 }),
					actor({ actorId: 'g2', unavailableTotal: 1 }),
				])}
				theme={mockTheme}
			/>
		);
		expect(screen.getByRole('status').textContent).toBe('Your screen failed 3 guest requests');
	});
});
