// `maestro-cli models index` - what the semantic index's background indexer is
// doing: its state, how many sources (History entries, Director's Notes
// synopses, transcript turns) are indexed out of how many exist, and why it
// stopped when it cannot run.
//
// It runs in the desktop over the WS bridge and answers with the same record
// the `localModels:semanticIndex:status` IPC channel does, which is what
// Settings -> Local Models draws. It reads memory only: no file, no model.
//
// The indexer has no "start" verb, here or in the app. It runs whenever
// Semantic search is assigned a source (`maestro-cli models assign
// semantic-search <source>`) and indexes Cue runs only when the
// `semanticIndexCue` setting is on (`maestro-cli settings set semanticIndexCue
// true`).
//
// Exit codes, for scripts: 0 unless the indexer is `unavailable`. `off` is the
// default and not a failure.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { formatSemanticIndexProgress } from '../output/formatter';
import type { SemanticIndexProgress } from '../../shared/local-models/embedding-index';

/** A memory read in the app; anything slower than this is the bridge, not the work. */
const INDEX_STATUS_TIMEOUT_MS = 10_000;

interface IndexOptions {
	json?: boolean;
}

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

export async function modelsIndex(options: IndexOptions): Promise<void> {
	let reply: { success: boolean; progress?: SemanticIndexProgress; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_semantic_index_status' },
				'local_models_semantic_index_status_result',
				INDEX_STATUS_TIMEOUT_MS
			)
		);
	} catch (error) {
		fail(
			error instanceof Error ? error.message : String(error),
			options.json,
			exitCodeForError(error)
		);
	}

	if (!reply.success || !reply.progress) {
		fail(reply.error || 'Index status check failed', options.json);
	}
	const progress = reply.progress;
	const ok = progress.state !== 'unavailable';

	if (options.json) console.log(JSON.stringify({ success: ok, ...progress }));
	else console.log(formatSemanticIndexProgress(progress));
	if (!ok) exitWith(ExitCode.GeneralError);
}
