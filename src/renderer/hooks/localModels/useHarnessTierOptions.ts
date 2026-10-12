/**
 * useHarnessTierOptions - what each installed harness can launch a tier on.
 *
 * One row per installed harness that can select a model, each with its own
 * catalogue and the Run on targets the sources list (`listHarnessTierOptions`
 * in the main process, the function `maestro-cli models tiers options` calls).
 *
 * Mounting asks once. The harness lists come from the agent detector's cache
 * when it is warm, the model server answers from disk, and a saved source is a
 * server the user already chose to call. `refresh()` asks every harness again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HarnessTierOptions } from '../../../shared/local-models/tier-options';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export interface HarnessTierOptionsState {
	/** Null until the first answer lands. */
	options: HarnessTierOptions[] | null;
	loading: boolean;
	/** Why the list could not be read, when it could not. */
	error: string | null;
	/** Ask every harness and source again, past the detector's cache. */
	refresh: () => Promise<void>;
}

export function useHarnessTierOptions(): HarnessTierOptionsState {
	const [options, setOptions] = useState<HarnessTierOptions[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const mounted = useRef(true);
	// A slow first listing must not overwrite the refresh that came after it.
	const latest = useRef(0);

	const load = useCallback(async (refresh: boolean) => {
		const request = ++latest.current;
		setLoading(true);
		try {
			const next = await window.maestro.localModels.tiers.options({ refresh });
			if (!mounted.current || request !== latest.current) return;
			setOptions(next);
			setError(null);
		} catch (err) {
			if (!mounted.current || request !== latest.current) return;
			setError(ipcErrorMessage(err));
		} finally {
			if (mounted.current && request === latest.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load(false);
		return () => {
			mounted.current = false;
		};
	}, [load]);

	const refresh = useCallback(() => load(true), [load]);

	return { options, loading, error, refresh };
}
