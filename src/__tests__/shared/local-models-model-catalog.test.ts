/**
 * @file local-models-model-catalog.test.ts
 *
 * The catalog is a promise to the user about exactly which bytes will be
 * fetched. These tests guard the properties that make that promise checkable:
 * pinned revisions (never `main`), real 64-hex SHA-256s, computed totals, and a
 * frozen table nothing downstream can edit in place.
 */

import { describe, it, expect } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	DEBERTA_INJECTION_V2_ID,
	EMBEDDINGGEMMA_300M_ID,
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_CATALOG,
	LOCAL_MODEL_KIND_LABELS,
	LOCAL_MODEL_KIND_ORDER,
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
	getLocalModel,
	groupByLocalModelKind,
	isLocalModelId,
	localModelsForRuntime,
	sumModelBytes,
} from '../../shared/local-models/model-catalog';
import { NATIVE_RUNTIMES } from '../../shared/local-models/native-runtimes';
import { MODEL_SETS } from '../../shared/acappella/voice-models';

const EMBEDDING_IDS = [BGE_SMALL_EN_ID, EMBEDDINGGEMMA_300M_ID];
const CLASSIFIER_IDS = [PROMPT_GUARD_2_22M_ID, DEBERTA_INJECTION_V2_ID];

describe('local model catalog', () => {
	it('contains every model Maestro can install', () => {
		expect(LOCAL_MODEL_CATALOG.map((entry) => entry.id).sort()).toEqual(
			[
				HEY_JARVIS_WAKE_ID,
				KOKORO_82M_ID,
				OPENWAKEWORD_BASE_ID,
				PARAKEET_TDT_V2_ID,
				QWEN3_1_7B_ID,
				WHISPER_BASE_EN_ID,
				...EMBEDDING_IDS,
				...CLASSIFIER_IDS,
			].sort()
		);
	});

	it('pins every revision to a commit, never a moving ref', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
			expect(entry.revision).not.toBe('main');
			for (const file of entry.files) {
				// A `/main/` URL would make the hash below meaningless: the bytes
				// behind it could change without the catalog knowing.
				expect(file.sourceUrl).toContain(`/resolve/${entry.revision}/`);
				expect(file.sourceUrl).not.toContain('/resolve/main/');
			}
		}
	});

	it('carries a real SHA-256 and a positive size for every file', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.files.length).toBeGreaterThan(0);
			for (const file of entry.files) {
				expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(file.bytes).toBeGreaterThan(0);
				// Relative, POSIX, and never escaping the install root.
				expect(file.path.startsWith('/')).toBe(false);
				expect(file.path).not.toContain('..');
				expect(file.path).not.toContain('\\');
			}
		}
	});

	it('names a license and a license URL for every model', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.license).toBeTruthy();
			expect(entry.licenseUrl).toMatch(/^https:\/\//);
		}
	});

	it('computes each model total from its files', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.bytes).toBe(entry.files.reduce((total, file) => total + file.bytes, 0));
		}
	});

	it('is frozen all the way down', () => {
		expect(Object.isFrozen(LOCAL_MODEL_CATALOG)).toBe(true);
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(Object.isFrozen(entry)).toBe(true);
			expect(Object.isFrozen(entry.files)).toBe(true);
			for (const file of entry.files) expect(Object.isFrozen(file)).toBe(true);
		}
	});

	it('looks models up by id and rejects anything else', () => {
		expect(getLocalModel(WHISPER_BASE_EN_ID)?.kind).toBe('stt');
		expect(getLocalModel(PARAKEET_TDT_V2_ID)?.kind).toBe('stt');
		expect(getLocalModel('../../etc/passwd')).toBeUndefined();
		expect(isLocalModelId(KOKORO_82M_ID)).toBe(true);
		expect(isLocalModelId('nope')).toBe(false);
	});

	it('ignores unknown ids when summing', () => {
		expect(sumModelBytes(['nope'])).toBe(0);
		expect(sumModelBytes([WHISPER_BASE_EN_ID, 'nope'])).toBe(
			getLocalModel(WHISPER_BASE_EN_ID)!.bytes
		);
	});

	it('names a known runtime for every model, and maps each kind to the right one', () => {
		const runtimeIds = NATIVE_RUNTIMES.map((runtime) => runtime.id);
		for (const entry of LOCAL_MODEL_CATALOG) expect(runtimeIds).toContain(entry.runtime);
		// GGUF weights are read by llama.cpp; everything else in the catalog is ONNX.
		expect(getLocalModel(QWEN3_1_7B_ID)?.kind).toBe('text-gen');
		expect(getLocalModel(QWEN3_1_7B_ID)?.runtime).toBe('llama');
		expect(localModelsForRuntime('llama').map((entry) => entry.id)).toEqual([QWEN3_1_7B_ID]);
		expect(
			localModelsForRuntime('onnx')
				.map((entry) => entry.id)
				.sort()
		).toEqual(
			[
				HEY_JARVIS_WAKE_ID,
				KOKORO_82M_ID,
				OPENWAKEWORD_BASE_ID,
				PARAKEET_TDT_V2_ID,
				WHISPER_BASE_EN_ID,
				...EMBEDDING_IDS,
				...CLASSIFIER_IDS,
			].sort()
		);
	});

	it('records pending only for models nothing in this build can read', () => {
		for (const id of [KOKORO_82M_ID, QWEN3_1_7B_ID]) {
			expect(getLocalModel(id)?.pending).toEqual(expect.any(String));
		}
		for (const id of [
			PARAKEET_TDT_V2_ID,
			WHISPER_BASE_EN_ID,
			OPENWAKEWORD_BASE_ID,
			HEY_JARVIS_WAKE_ID,
			...EMBEDDING_IDS,
			...CLASSIFIER_IDS,
		]) {
			expect(getLocalModel(id)?.pending).toBeUndefined();
		}
	});

	it('carries a run spec exactly when the kind needs one', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.embedding !== undefined).toBe(entry.kind === 'embedding');
			expect(entry.classifier !== undefined).toBe(entry.kind === 'classifier');
		}
		for (const id of EMBEDDING_IDS) expect(getLocalModel(id)?.kind).toBe('embedding');
		for (const id of CLASSIFIER_IDS) expect(getLocalModel(id)?.kind).toBe('classifier');
		for (const id of [...EMBEDDING_IDS, ...CLASSIFIER_IDS]) {
			expect(getLocalModel(id)?.runtime).toBe('onnx');
		}
	});

	it('points every encoder spec at a graph and tokenizer the entry downloads', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			const spec = entry.embedding ?? entry.classifier;
			if (!spec) continue;
			const paths = entry.files.map((file) => file.path);
			expect(paths).toContain(spec.modelFile);
			expect(spec.modelFile).toMatch(/\.onnx$/);
			const tokenizerDir = spec.tokenizerDir ? `${spec.tokenizerDir}/` : '';
			expect(paths).toContain(`${tokenizerDir}tokenizer.json`);
			expect(paths).toContain(`${tokenizerDir}tokenizer_config.json`);
			expect(spec.maxTokens).toBeGreaterThan(0);
			expect(spec.outputName).toBeTruthy();
			expect(Object.isFrozen(spec)).toBe(true);
		}
	});

	it('downloads the external weights beside a graph that needs them', () => {
		// The q4 EmbeddingGemma graph keeps its weights in `.onnx_data`, opened by
		// relative path, so both must sit in the same directory.
		const gemma = getLocalModel(EMBEDDINGGEMMA_300M_ID)!;
		const paths = gemma.files.map((file) => file.path);
		expect(paths).toContain(`${gemma.embedding!.modelFile}_data`);
	});

	it('records the pooling and dimensions each embedding model needs', () => {
		const bge = getLocalModel(BGE_SMALL_EN_ID)!.embedding!;
		expect(bge).toMatchObject({
			dimensions: 384,
			pooling: 'cls',
			normalize: true,
			outputName: 'last_hidden_state',
		});
		expect(bge.queryPrefix).toBeUndefined();
		const gemma = getLocalModel(EMBEDDINGGEMMA_300M_ID)!.embedding!;
		// The graph pools and projects itself; re-pooling its token states would
		// skip the projection.
		expect(gemma).toMatchObject({
			dimensions: 768,
			pooling: 'graph',
			normalize: true,
			outputName: 'sentence_embedding',
			maxTokens: 2048,
		});
		expect(gemma.queryPrefix).toBe('task: search result | query: ');
		expect(gemma.documentPrefix).toBe('title: none | text: ');
	});

	it('names each classifier label in logit order, with a flagged label among them', () => {
		for (const id of CLASSIFIER_IDS) {
			const spec = getLocalModel(id)!.classifier!;
			expect(spec.labels).toContain(spec.positiveLabel);
			expect(spec.maxTokens).toBe(512);
			expect(spec.outputName).toBe('logits');
			expect(Object.isFrozen(spec.labels)).toBe(true);
		}
		expect(getLocalModel(PROMPT_GUARD_2_22M_ID)!.classifier!.labels).toEqual([
			'BENIGN',
			'MALICIOUS',
		]);
		expect(getLocalModel(PROMPT_GUARD_2_22M_ID)!.classifier!.positiveLabel).toBe('MALICIOUS');
		expect(getLocalModel(DEBERTA_INJECTION_V2_ID)!.classifier!.labels).toEqual([
			'SAFE',
			'INJECTION',
		]);
	});

	it('reads the ProtectAI tokenizer from the onnx directory it was exported with', () => {
		const spec = getLocalModel(DEBERTA_INJECTION_V2_ID)!.classifier!;
		expect(spec.tokenizerDir).toBe('onnx');
		expect(spec.modelFile).toBe('onnx/model.onnx');
	});

	it('keeps embedding and classifier models out of every voice bundle', () => {
		for (const set of Object.values(MODEL_SETS)) {
			for (const id of [...EMBEDDING_IDS, ...CLASSIFIER_IDS]) {
				expect(set.modelIds).not.toContain(id);
			}
		}
	});
});

describe('kind labels and grouping', () => {
	it('labels and orders every kind exactly once', () => {
		expect([...LOCAL_MODEL_KIND_ORDER].sort()).toEqual(Object.keys(LOCAL_MODEL_KIND_LABELS).sort());
		expect(new Set(LOCAL_MODEL_KIND_ORDER).size).toBe(LOCAL_MODEL_KIND_ORDER.length);
	});

	it('groups the catalog in kind order, keeps catalog order, and drops empty kinds', () => {
		const groups = groupByLocalModelKind(LOCAL_MODEL_CATALOG, (entry) => entry.kind);
		expect(groups.map((group) => group.kind)).toEqual(
			LOCAL_MODEL_KIND_ORDER.filter((kind) => LOCAL_MODEL_CATALOG.some((e) => e.kind === kind))
		);
		expect(groups.flatMap((group) => group.items).length).toBe(LOCAL_MODEL_CATALOG.length);
		const embeddings = groups.find((group) => group.kind === 'embedding');
		expect(embeddings?.items.map((entry) => entry.id)).toEqual(EMBEDDING_IDS);
		expect(groupByLocalModelKind([], (entry: { kind: 'stt' }) => entry.kind)).toEqual([]);
	});
});
