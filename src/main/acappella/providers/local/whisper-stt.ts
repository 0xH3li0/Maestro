/**
 * Local speech-to-text on Whisper, running on ONNX Runtime.
 *
 * Selectable, but no longer the local default: Parakeet (`parakeet-stt.ts`) is,
 * because Whisper Base mangles names and casing on exactly the short dictated
 * commands this feature exists for. Whisper stays for anyone who already
 * downloaded it or wants the smaller model.
 *
 * The streaming policy (cadence, stability, endpointing, silence) is shared with
 * every local recogniser and lives in `chunked-stt.ts`. The inference lives in
 * `whisper/engine.ts`. This file only binds the two to the catalog model.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WHISPER_BASE_EN_ID } from '../../../../shared/local-models/model-catalog';
import { WHISPER_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { modelFilePath } from '../../models/model-store';
import {
	ChunkedLocalSttProvider,
	type ChunkedLocalSttOptions,
	type LocalSttEngine,
} from './chunked-stt';
import { WhisperEngine, WHISPER_MAX_SAMPLES } from './whisper/engine';

// Re-exported so existing importers keep their one import site.
export { sanitizeTranscript } from './chunked-stt';

/**
 * The catalog files this provider loads, by their path inside the model dir.
 *
 * Named here rather than inlined so the set a decode needs and the set the
 * catalog downloads can be compared at a glance when either changes.
 */
const ENCODER_FILE = 'onnx/encoder_model.onnx';
const DECODER_FILE = 'onnx/decoder_model_merged_q4.onnx';
const TOKENIZER_FILE = 'tokenizer.json';

export interface WhisperSttOptions extends ChunkedLocalSttOptions {
	/** Directory override for the model files. Defaults to the installed catalog model. */
	modelDir?: string;
}

/** What this provider needs of {@link WhisperEngine}, so a test can stand in for it. */
export type WhisperEngineLike = LocalSttEngine;

export class WhisperSttProvider extends ChunkedLocalSttProvider {
	readonly id = WHISPER_STT_PROVIDER_ID;
	readonly label = 'Whisper (local)';
	protected readonly engineName = 'Whisper';
	// One encoder pass covers a fixed 30 s window.
	protected readonly maxSamples = WHISPER_MAX_SAMPLES;

	private readonly modelDirOverride?: string;

	constructor(options: WhisperSttOptions = {}) {
		super(options);
		this.modelDirOverride = options.modelDir;
	}

	protected async createEngine(): Promise<LocalSttEngine> {
		return new WhisperEngine({
			encoderPath: this.modelFile(ENCODER_FILE),
			decoderPath: this.modelFile(DECODER_FILE),
			tokenizerJson: await readFile(this.modelFile(TOKENIZER_FILE), 'utf8'),
			providerId: this.id,
		});
	}

	/** Absolute path of one catalog file, honouring a test's directory override. */
	private modelFile(relative: string): string {
		return this.modelDirOverride
			? join(this.modelDirOverride, relative)
			: modelFilePath(WHISPER_BASE_EN_ID, relative);
	}
}
