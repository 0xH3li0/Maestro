/**
 * CloudScreeningConsentHost: opens the cloud screening confirmation when main
 * reports `confirmNeeded` for a live room this window holds, never in a window
 * without one, never while Sketch Book is off, and keeps a dismissed question
 * shut until a different one asks.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudScreeningConsentHost } from '../../../../renderer/components/SketchBook/CloudScreeningConsentHost';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../../renderer/stores/sketchSessionStore';
import type { SketchScreeningChange } from '../../../../shared/sketch/cloud-consent';
import { mockTheme } from '../../../helpers/mockTheme';

const SKETCH_ID = 'sketch-1';
const sketchApi = window.maestro.sketch as unknown as Record<string, ReturnType<typeof vi.fn>>;

let push: ((change: SketchScreeningChange) => void) | null = null;

function holdRoom() {
	const state: SketchRoomState = {
		roomId: 'r1',
		connection: 'live',
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
	};
	useSketchSessionStore.setState({
		sessions: { [SKETCH_ID]: { room: state } as never },
	});
}

function change(confirm?: SketchScreeningChange['confirmNeeded']): SketchScreeningChange {
	return {
		consent: {},
		rooms: [{ sketchId: SKETCH_ID, screening: 'local' }],
		...(confirm ? { confirmNeeded: confirm } : {}),
	};
}

function renderHost() {
	return render(
		<LayerStackProvider>
			<CloudScreeningConsentHost theme={mockTheme} />
		</LayerStackProvider>
	);
}

function setSketchBook(on: boolean) {
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, sketchBook: on },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	push = null;
	sketchApi.onScreeningChanged.mockImplementation((callback: typeof push) => {
		push = callback;
		return () => {
			push = null;
		};
	});
	useSketchSessionStore.setState({ sessions: {} });
	setSketchBook(true);
});

const JEV = { engine: 'jev' as const, host: 'api.typesafe.ai', reason: 'grant' as const };

describe('CloudScreeningConsentHost', () => {
	it('opens the confirmation for a live room this window holds', () => {
		holdRoom();
		renderHost();
		act(() => push?.(change(JEV)));
		expect(screen.getByRole('dialog', { name: 'Cloud screening' })).toBeInTheDocument();
		expect(screen.getByText('Jev, by TypeSafe, api.typesafe.ai')).toBeInTheDocument();
	});

	it('does not ask in a window that holds none of the rooms', () => {
		renderHost();
		act(() => push?.(change(JEV)));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('closes when the question goes away (the conductor allowed it elsewhere)', () => {
		holdRoom();
		renderHost();
		act(() => push?.(change(JEV)));
		act(() => push?.(change()));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('keeps a dismissed question shut until a different one asks', () => {
		holdRoom();
		renderHost();
		act(() => push?.(change(JEV)));
		fireEvent.click(screen.getByRole('button', { name: 'Not now (Esc)' }));
		act(() => push?.(change(JEV)));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		act(() => push?.(change({ engine: 'openjev', host: 'gpu.example.com', reason: 'grant' })));
		expect(screen.getByText('OpenJev at gpu.example.com')).toBeInTheDocument();
	});

	it('asks again after the question went away and came back', () => {
		holdRoom();
		renderHost();
		act(() => push?.(change(JEV)));
		fireEvent.click(screen.getByRole('button', { name: 'Not now (Esc)' }));
		act(() => push?.(change()));
		act(() => push?.(change(JEV)));
		expect(screen.getByRole('dialog', { name: 'Cloud screening' })).toBeInTheDocument();
	});

	it('listens to nothing while Sketch Book is off', () => {
		setSketchBook(false);
		holdRoom();
		renderHost();
		expect(sketchApi.onScreeningChanged).not.toHaveBeenCalled();
	});
});
