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

/**
 * Where an encoder model's graph and tokenizer live inside its install
 * directory. Shared by every kind that runs a tokenizer in front of an ONNX
 * graph, because a model's files are not always at the root (an `onnx/`
 * subdirectory is common) and a service must never guess which `.onnx` in the
 * file list is the graph rather than its external weights.
 */
export interface LocalEncoderGraph {
	/** The ONNX graph to load. Always one of the entry's `files[].path`. */
	readonly modelFile: string;
	/**
	 * Directory holding `tokenizer.json` (and `tokenizer_config.json`), relative
	 * to the install directory. Empty string for the root.
	 */
	readonly tokenizerDir: string;
	/** The model's token window. Longer input is truncated or windowed by the caller. */
	readonly maxTokens: number;
	/** The graph output the service reads. */
	readonly outputName: string;
}

/**
 * How an embedding model's per-token states become one vector.
 *
 * - `cls`: the first token's hidden state (BERT-style retrieval models).
 * - `mean`: the attention-masked average of every token's hidden state.
 * - `graph`: the graph already pools (and projects) and `outputName` is the
 *   finished sentence embedding. Re-pooling its token states instead would skip
 *   the projection layers and produce vectors in the wrong space.
 */
export type LocalEmbeddingPooling = 'cls' | 'mean' | 'graph';

export interface LocalEmbeddingSpec extends LocalEncoderGraph {
	/** Width of the vector the service returns. */
	readonly dimensions: number;
	readonly pooling: LocalEmbeddingPooling;
	/** L2-normalize so cosine similarity is a dot product. */
	readonly normalize: true;
	/** Prepended to a search query before tokenizing, for models trained with one. */
	readonly queryPrefix?: string;
	/** Prepended to an indexed document before tokenizing, for models trained with one. */
	readonly documentPrefix?: string;
}

export interface LocalClassifierSpec extends LocalEncoderGraph {
	/** Label per output index, in the graph's logit order (the model's `id2label`). */
	readonly labels: readonly string[];
	/** The label that means "flag this". Always one of `labels`. */
	readonly positiveLabel: string;
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
	/** How to run the model. Present exactly when `kind` is `embedding`. */
	readonly embedding?: LocalEmbeddingSpec;
	/** How to run the model. Present exactly when `kind` is `classifier`. */
	readonly classifier?: LocalClassifierSpec;
}
