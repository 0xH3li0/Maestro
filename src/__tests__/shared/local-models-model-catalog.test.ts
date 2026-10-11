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
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_CATALOG,
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
	getLocalModel,
	isLocalModelId,
	localModelsForRuntime,
	sumModelBytes,
} from '../../shared/local-models/model-catalog';
import { NATIVE_RUNTIMES } from '../../shared/local-models/native-runtimes';

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
		]) {
			expect(getLocalModel(id)?.pending).toBeUndefined();
		}
	});
});
