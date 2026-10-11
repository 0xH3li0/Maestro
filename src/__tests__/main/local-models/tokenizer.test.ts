/**
 * @file tokenizer.test.ts
 *
 * The Local Models tokenizer loader, run against the real `tokenizer.json` of
 * bge-small-en-v1.5 (fixture pinned to Xenova/bge-small-en-v1.5 at revision
 * ea104dacec62c0de699686887e3f920caeb4f3e3). The ids asserted here are the
 * standard bert-base-uncased vocabulary ids, so a regression in the library or
 * in the truncation layout shows up as a wrong number, not a vague mismatch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	clearTokenizerCache,
	createLocalTokenizer,
	loadTokenizer,
	TOKENIZER_CONFIG_FILENAME,
	TOKENIZER_FILENAME,
} from '../../../main/local-models/tokenizer';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/tokenizers/bge-small-en-v1.5');

const ids = (values: BigInt64Array | undefined) => Array.from(values ?? [], Number);

describe('loadTokenizer', () => {
	beforeEach(() => clearTokenizerCache());

	it('encodes a known sentence to the WordPiece ids the model was trained on', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		const encoded = tokenizer.encode('How do I rename a tab?');

		expect(ids(encoded.inputIds)).toEqual([
			101, 2129, 2079, 1045, 14916, 14074, 1037, 21628, 1029, 102,
		]);
		expect(ids(encoded.attentionMask)).toEqual(new Array(10).fill(1));
		expect(ids(encoded.tokenTypeIds)).toEqual(new Array(10).fill(0));
		expect(encoded.inputIds).toBeInstanceOf(BigInt64Array);
	});

	it('reads model_max_length from tokenizer_config.json', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		expect(tokenizer.modelMaxLength).toBe(512);
	});

	it('caches per directory and returns the same tokenizer', async () => {
		const first = await loadTokenizer(FIXTURE_DIR);
		const second = await loadTokenizer(FIXTURE_DIR + path.sep);
		expect(second).toBe(first);
		clearTokenizerCache(FIXTURE_DIR);
		expect(await loadTokenizer(FIXTURE_DIR)).not.toBe(first);
	});

	it('works without a tokenizer_config.json and records no window', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
		try {
			await fs.copyFile(
				path.join(FIXTURE_DIR, TOKENIZER_FILENAME),
				path.join(dir, TOKENIZER_FILENAME)
			);
			const tokenizer = await loadTokenizer(dir);
			expect(tokenizer.modelMaxLength).toBeUndefined();
			expect(ids(tokenizer.encode('Hello, World!').inputIds)).toEqual([
				101, 7592, 1010, 2088, 999, 102,
			]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('does not cache a failed load, so a repaired install is picked up', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
		try {
			await expect(loadTokenizer(dir)).rejects.toThrow();
			await fs.copyFile(
				path.join(FIXTURE_DIR, TOKENIZER_FILENAME),
				path.join(dir, TOKENIZER_FILENAME)
			);
			await expect(loadTokenizer(dir)).resolves.toBeDefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('truncation', () => {
	let definition: object;
	let config: Record<string, unknown>;

	beforeEach(async () => {
		definition = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_FILENAME), 'utf8'));
		config = JSON.parse(
			await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_CONFIG_FILENAME), 'utf8')
		);
	});

	it('shortens the content and keeps the trailing [SEP]', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const encoded = tokenizer.encode('How do I rename a tab?', { maxLength: 5 });
		expect(ids(encoded.inputIds)).toEqual([101, 2129, 2079, 1045, 102]);
		expect(ids(encoded.attentionMask)).toEqual([1, 1, 1, 1, 1]);
		expect(ids(encoded.tokenTypeIds)).toEqual([0, 0, 0, 0, 0]);
	});

	it('returns the full sequence when truncation is off', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const encoded = tokenizer.encode('How do I rename a tab?', { maxLength: 5, truncation: false });
		expect(encoded.inputIds.length).toBe(10);
	});

	it('defaults maxLength to the model window', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, {
			...config,
			model_max_length: 4,
		});
		expect(ids(tokenizer.encode('Hello, World!').inputIds)).toEqual([101, 7592, 1010, 102]);
	});

	it('treats the transformers "no limit" sentinel as no window', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, {
			...config,
			model_max_length: 1e30,
		});
		expect(tokenizer.modelMaxLength).toBeUndefined();
		expect(tokenizer.encode('Hello, World!').inputIds.length).toBe(6);
	});

	it('refuses a maxLength with no room left for content', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		expect(() => tokenizer.encode('How do I rename a tab?', { maxLength: 2 })).toThrow(/no room/);
	});
});
