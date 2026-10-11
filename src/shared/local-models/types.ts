/**
 * Core Local Models types.
 *
 * Local Models is the one place Maestro downloads, verifies, stores, and runs a
 * model on this machine. Every feature that wants a local model (voice, tab
 * naming, AI command mode, semantic search, and whatever comes next) is a
 * CONSUMER of this vocabulary, never a second owner of it. A consumer that needs
 * its own words for a model (the voice slot a recogniser fills, the bundle a
 * setup screen offers) layers them on top, keyed by model id, in its own module.
 *
 * Nothing here knows which feature asked for a model. That is the rule that
 * keeps this table from growing one field per consumer.
 */

import type { NativeRuntimeId } from './native-runtimes';

/**
 * What a model does, in consumer-neutral terms.
 *
 * Deliberately not a list of features: a `text-gen` model can route a spoken
 * command, name a tab, or draft a shell command, and the catalog must not have to
 * change when a fourth consumer starts using it.
 */
export type LocalModelKind = 'wake-word' | 'stt' | 'tts' | 'text-gen' | 'embedding' | 'classifier';

/** One downloadable file. A model is one or more of these. */
export interface LocalModelFile {
	/**
	 * Path under the model's install directory, and the path within the source
	 * repo. Always POSIX-separated: it is joined onto the install root, so it must
	 * never be absolute and must never contain `..`.
	 */
	readonly path: string;
	/** Fully pinned download URL. `/resolve/<40-hex revision>/`, never `/main/`. */
	readonly sourceUrl: string;
	/** Lowercase hex SHA-256 of the file contents. */
	readonly sha256: string;
	readonly bytes: number;
}

export interface LocalModelEntry {
	/** Stable id. Also the install directory name, so it must be filename-safe. */
	readonly id: string;
	readonly displayName: string;
	readonly kind: LocalModelKind;
	/**
	 * The native runtime that reads this model's weights.
	 *
	 * Recorded on the model rather than on the runtime, so a runtime never has to
	 * know which features exist: a consumer asks "which runtime does this model
	 * need?" and derives its own grouping from the answer.
	 */
	readonly runtime: NativeRuntimeId;
	/** Hugging Face repo id, for the "where did this come from" line. */
	readonly repo: string;
	/** The pinned commit. 40 hex characters; `main` is rejected by the tests. */
	readonly revision: string;
	/** SPDX-ish identifier as published on the model card. */
	readonly license: string;
	readonly licenseUrl: string;
	/** One sentence for the bill of materials. */
	readonly description: string;
	readonly files: readonly LocalModelFile[];
	/** Sum of every file's `bytes`. Computed, never typed by hand. */
	readonly bytes: number;
	/**
	 * Why nothing in this build can run the model yet, or undefined when it runs.
	 *
	 * A pending model stays in the catalog so a download that already happened
	 * can be seen, verified, and removed, but it is offered for download nowhere:
	 * not in a bundle and not on its own row. Fetching weights nothing can read
	 * is the one download this table must never invite.
	 */
	readonly pending?: string;
}
