/**
 * Chain of thought export: the app's one writer.
 *
 * A chain has one head, and the writer holds it in memory between writes. Two
 * writers on one chain would each seal against a head the other has moved
 * past, and the chain would fork at the first record. So everything in the
 * app that writes a record, or checks a chain against the disk, goes through
 * the writer made here, bound to the app's one store.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import { getCotConfigStore } from './config-store';
import { createCotWriter } from './writer';
import type { CotWriter } from './writer';

let _writer: CotWriter | null = null;

/**
 * The app's one writer, made at the first call.
 *
 * It makes the app's store, so the rule of `getCotConfigStore` holds here
 * too: do not call this before the app's `ready` event.
 *
 * A record that lands moves the stored head of its chain and the time of the
 * agent's last write. A record that is lost is kept as the agent's last error.
 */
export function getCotWriter(): CotWriter {
	if (_writer === null) {
		const store = getCotConfigStore();
		_writer = createCotWriter({
			getChainState: (agentId, folder) => store.getChainState(agentId, folder),
			onHeadAdvanced: (agentId, state) => {
				store.setChainHead(agentId, state);
				store.recordWrite(agentId, Date.now());
			},
			onError: (agentId, error) => store.recordError(agentId, error.message, Date.now()),
			now: Date.now,
		});
	}
	return _writer;
}

/** Drops the app's writer so the next call makes a new one. For tests. */
export function __resetCotWriterForTests(): void {
	_writer = null;
}
