/**
 * Hugging Face tokenizers for the ONNX model kinds (embeddings, classifiers).
 *
 * An ONNX encoder takes token ids, not text, and the ids have to be the exact
 * ones the model was trained on: a near-miss tokenizer produces a vector that
 * looks healthy and means nothing. So the tokenizer is never re-implemented
 * per model. Every model ships its own `tokenizer.json` (plus, usually, a
 * `tokenizer_config.json`), and `@huggingface/tokenizers` runs it: WordPiece,
 * Unigram and BPE, pure JavaScript, no native code.
 *
 * Two things this module adds on top of the library:
 *
 *   - **Truncation that keeps the special tokens.** The library has none, and
 *     cutting the encoded ids at `maxLength` drops the trailing `[SEP]` / `</s>`
 *     the model expects, which degrades the output silently. Truncation here
 *     shortens the CONTENT and re-wraps it in whatever the model's
 *     post-processor added, so the layout is right for every tokenizer family
 *     without knowing which one it is.
 *   - **Tensors-ready output.** ONNX Runtime wants `int64` inputs, so ids come
 *     back as `BigInt64Array`s rather than number arrays each caller converts.
 *
 * Loaded tokenizers are cached per directory: `tokenizer.json` is large (the
 * bge-small one is 700 KB of vocabulary) and parsing it per call would dwarf
 * the inference it feeds.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tokenizer } from '@huggingface/tokenizers';

/** The tokenizer definition every Hugging Face model ships. */
export const TOKENIZER_FILENAME = 'tokenizer.json';

/** Optional metadata (special tokens, `model_max_length`). */
export const TOKENIZER_CONFIG_FILENAME = 'tokenizer_config.json';

/**
 * `model_max_length` values at or above this are the transformers library's
 * "no limit recorded" sentinel (it writes `1e30`), not a real window.
 */
const UNBOUNDED_MODEL_MAX_LENGTH = 1_000_000;

export interface TokenizerEncodeOptions {
	/**
	 * Longest sequence to produce, special tokens included. Defaults to the
	 * tokenizer's own `model_max_length` when it records one.
	 */
	maxLength?: number;
	/**
	 * Shorten an over-long input to `maxLength` (default `true`). With `false`
	 * the full sequence is returned, as the Python tokenizers do.
	 */
	truncation?: boolean;
}

export interface TokenizedInput {
	inputIds: BigInt64Array;
	attentionMask: BigInt64Array;
	/** Present when the tokenizer's post-processor assigns segment ids (BERT). */
	tokenTypeIds?: BigInt64Array;
}

export interface LocalTokenizer {
	/** Directory the tokenizer was loaded from (resolved). */
	readonly dir: string;
	/** The model's own window, or `undefined` when the config records none. */
	readonly modelMaxLength: number | undefined;
	encode(text: string, options?: TokenizerEncodeOptions): TokenizedInput;
}

const cache = new Map<string, Promise<LocalTokenizer>>();

/**
 * Load (once) the tokenizer in a model's install directory.
 *
 * A failed load is not cached, so a model repaired after a bad install is
 * picked up on the next call rather than failing until restart.
 */
export function loadTokenizer(dir: string): Promise<LocalTokenizer> {
	const key = path.resolve(dir);
	const cached = cache.get(key);
	if (cached) return cached;
	const pending = readTokenizer(key);
	cache.set(key, pending);
	pending.catch(() => {
		if (cache.get(key) === pending) cache.delete(key);
	});
	return pending;
}

/**
 * Forget a cached tokenizer (one directory, or all of them). A model's files
 * change on reinstall and removal; the cache must not outlive them.
 */
export function clearTokenizerCache(dir?: string): void {
	if (dir === undefined) cache.clear();
	else cache.delete(path.resolve(dir));
}

async function readTokenizer(dir: string): Promise<LocalTokenizer> {
	const definition = JSON.parse(await fs.readFile(path.join(dir, TOKENIZER_FILENAME), 'utf8'));
	const config = await readOptionalJson(path.join(dir, TOKENIZER_CONFIG_FILENAME));
	return createLocalTokenizer(dir, definition, config);
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	return JSON.parse(raw) as Record<string, unknown>;
}

/** Build a tokenizer from already-parsed files. Exported for tests. */
export function createLocalTokenizer(
	dir: string,
	definition: object,
	config: Record<string, unknown>
): LocalTokenizer {
	const tokenizer = new Tokenizer(definition, config);
	const declared = config.model_max_length;
	const modelMaxLength =
		typeof declared === 'number' && declared > 0 && declared < UNBOUNDED_MODEL_MAX_LENGTH
			? declared
			: undefined;

	return {
		dir: path.resolve(dir),
		modelMaxLength,
		encode(text, options = {}) {
			const maxLength = options.maxLength ?? modelMaxLength;
			const truncation = options.truncation ?? true;
			const full = tokenizer.encode(text, { return_token_type_ids: true });
			let ids = full.ids;
			let typeIds = full.token_type_ids;
			if (truncation && maxLength !== undefined && ids.length > maxLength) {
				const content = tokenizer.encode(text, { add_special_tokens: false }).ids;
				const kept = truncationLayout(ids, content, maxLength);
				ids = kept(ids);
				if (typeIds) typeIds = kept(typeIds);
			}
			return {
				inputIds: toInt64(ids),
				attentionMask: new BigInt64Array(ids.length).fill(1n),
				...(typeIds ? { tokenTypeIds: toInt64(typeIds) } : {}),
			};
		},
	};
}

/**
 * Work out which positions of a wrapped sequence survive truncation.
 *
 * A single sequence is post-processed as `prefix + content + suffix` (`[CLS]
 * ... [SEP]`, `<s> ... </s>`, `<bos> ...`), so the prefix length is wherever the
 * content run starts. Everything outside the content is kept; the content is
 * cut to fit what remains of `maxLength`. Returns a slicer so the token type
 * ids are cut at exactly the same positions as the ids.
 */
function truncationLayout(
	full: readonly number[],
	content: readonly number[],
	maxLength: number
): <T>(values: readonly T[]) => T[] {
	const specials = full.length - content.length;
	const budget = maxLength - specials;
	if (budget < 1) {
		throw new Error(
			`Tokenizer maxLength ${maxLength} leaves no room for content beside ${specials} special tokens`
		);
	}
	const prefix = findContentStart(full, content);
	const contentEnd = prefix + content.length;
	return (values) => [...values.slice(0, prefix + budget), ...values.slice(contentEnd)];
}

function findContentStart(full: readonly number[], content: readonly number[]): number {
	const specials = full.length - content.length;
	for (let start = 0; start <= specials; start++) {
		let matches = true;
		for (let i = 0; i < content.length; i++) {
			if (full[start + i] !== content[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	// The post-processor rewrote content tokens rather than wrapping them. No
	// tokenizer in the catalog does that; failing beats truncating the wrong span.
	throw new Error('Tokenizer post-processor does not wrap its content; cannot truncate safely');
}

function toInt64(values: readonly number[]): BigInt64Array {
	const out = new BigInt64Array(values.length);
	for (let i = 0; i < values.length; i++) out[i] = BigInt(values[i]);
	return out;
}
