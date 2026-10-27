/**
 * Opens the cloud screening confirmation (spec section 8.10, G2 and G3) when
 * main's consent module reports a cloud engine in force without a live
 * confirmation for a live room (`SketchScreeningChange.confirmNeeded`).
 *
 * Mounted once in `AppShell`. Every window hears the push, so only a window
 * that holds one of the live rooms asks: the room client in that window is the
 * one that sends `screening.set`. Until the conductor answers, the gate keeps
 * failing closed, so no guest text goes out while the dialog is open.
 *
 * A dismissed question ("Keep local", "Not now", Escape) stays shut until a
 * different engine, host or reason asks, or the question goes away and comes
 * back. Renders nothing and listens to nothing while Sketch Book is off.
 */

import React from 'react';
import type { Theme } from '../../types';
import {
	sketchCloudConfirmKey,
	type SketchCloudConfirmNeeded,
	type SketchScreeningChange,
} from '../../../shared/sketch/cloud-consent';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSketchSessionStore } from '../../stores/sketchSessionStore';
import { canUseSketchBook } from '../../utils/sketchBookAvailability';
import { CloudScreeningConsentDialog } from './CloudScreeningConsentDialog';

/** Whether this window holds a room client for any of the change's live rooms. */
function holdsLiveRoom(change: SketchScreeningChange): boolean {
	const sessions = useSketchSessionStore.getState().sessions;
	return change.rooms.some((room) => {
		const connection = sessions[room.sketchId]?.room?.connection;
		return connection !== undefined && connection !== 'stopped';
	});
}

export function CloudScreeningConsentHost({ theme }: { theme: Theme }) {
	const enabled = useSettingsStore((s) => canUseSketchBook(s.encoreFeatures));
	const [prompt, setPrompt] = React.useState<SketchCloudConfirmNeeded | null>(null);
	const dismissedKey = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (!enabled) {
			setPrompt(null);
			return;
		}
		return window.maestro.sketch.onScreeningChanged((change) => {
			const asked = change.confirmNeeded;
			if (!asked || !holdsLiveRoom(change)) {
				dismissedKey.current = null;
				setPrompt(null);
				return;
			}
			const key = sketchCloudConfirmKey(asked);
			if (key === dismissedKey.current) return;
			setPrompt((current) => (current && sketchCloudConfirmKey(current) === key ? current : asked));
		});
	}, [enabled]);

	const close = React.useCallback(() => {
		if (prompt) dismissedKey.current = sketchCloudConfirmKey(prompt);
		setPrompt(null);
	}, [prompt]);

	if (!enabled || !prompt) return null;
	return (
		<CloudScreeningConsentDialog
			key={sketchCloudConfirmKey(prompt)}
			theme={theme}
			prompt={prompt}
			onClose={close}
		/>
	);
}
