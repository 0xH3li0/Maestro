/**
 * useSteeringVerdictListener - settles delivered chat steers.
 *
 * Two subscriptions, both handed to services/chatSteering.ts: the transcript
 * verdict maestro-p reports on stdout (`process:steering-verdict`), and process
 * exit, which settles any steer whose verdict never arrived. Both are keyed by
 * the full process key (`{sessionId}-ai-{tabId}`), which is what the steer was
 * sent to.
 */

import { useEffect } from 'react';
import { applySteeringVerdict, settlePendingSteersOnExit } from '../../../services/chatSteering';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useSteeringVerdictListener(): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const process = window.maestro?.process;
		if (!process?.onSteeringVerdict) return;

		const unsubscribeVerdict = process.onSteeringVerdict((processKey, verdict) => {
			if (!ownedGate.current?.(processKey)) return;
			applySteeringVerdict(processKey, verdict);
		});
		const unsubscribeExit = process.onExit((processKey: string) => {
			if (!ownedGate.current?.(processKey)) return;
			settlePendingSteersOnExit(processKey);
		});

		return () => {
			unsubscribeVerdict();
			unsubscribeExit();
		};
	}, [ownedGate]);
}
