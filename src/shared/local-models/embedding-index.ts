/**
 * The semantic index's wire vocabulary: what kind of thing a stored vector
 * came from, and what a search hands back.
 *
 * It lives in `shared/` because a hit travels. The embedding store in main
 * produces it, and the search surfaces (the History panel, cross-tab search,
 * `maestro-cli search`) all render the same structure. The vectors themselves
 * never leave main, so nothing here carries one.
 */

/**
 * What a chunk of indexed text belongs to.
 *
 * - `history`         - one History entry.
 * - `directors-notes` - one Director's Notes synopsis.
 * - `transcript`      - one AI tab's persisted transcript.
 */
export const EMBEDDING_SOURCE_TYPES = ['history', 'directors-notes', 'transcript'] as const;

export type EmbeddingSourceType = (typeof EMBEDDING_SOURCE_TYPES)[number];

export function isEmbeddingSourceType(value: unknown): value is EmbeddingSourceType {
	return typeof value === 'string' && (EMBEDDING_SOURCE_TYPES as readonly string[]).includes(value);
}

/** One chunk that matched a query, best first in a result list. */
export interface EmbeddingSearchHit {
	sourceType: EmbeddingSourceType;
	/** The source's own id: a history entry id, a notes id, a tab id. */
	sourceId: string;
	/** The agent the source belongs to, when it belongs to one. */
	agentId: string | null;
	/** Which window of the source's text matched (0-based). */
	chunkIndex: number;
	/** Cosine similarity to the query, from -1 to 1. Higher is closer. */
	score: number;
}

/** How much one embedding model has indexed. */
export interface EmbeddingModelStats {
	modelId: string;
	/** Vector width. One model writes one width. */
	dimensions: number;
	chunks: number;
	/** Chunk counts per source type; a type with nothing indexed reads 0. */
	bySourceType: Record<EmbeddingSourceType, number>;
}

export interface EmbeddingStoreStats {
	/** Chunks across every model, including ones no longer assigned. */
	totalChunks: number;
	/** One entry per model with rows on disk, largest first. */
	models: EmbeddingModelStats[];
	/** Size of the database file's pages in bytes. */
	sizeBytes: number;
}
