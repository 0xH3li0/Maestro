/**
 * Local speech-to-text on Parakeet TDT, running on ONNX Runtime. The local
 * default.
 *
 * The streaming policy (cadence, stability, endpointing, silence) is shared with
 * every local recogniser and lives in `chunked-stt.ts`. The inference lives in
 * `parakeet/engine.ts`. This file only binds the two to the catalog model.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PARAKEET_TDT_V2_ID } from '../../../../shared/local-models/model-catalog';
import { LOCAL_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { modelFilePath } from '../../../local-models/model-store';
import {
	ChunkedLocalSttProvider,
	type ChunkedLocalSttOptions,
	type LocalSttEngine,
} from './chunked-stt';
import { ParakeetEngine, PARAKEET_MAX_SAMPLES } from './parakeet/engine';

/** The catalog files this provider loads, by their path inside the model dir. */
const PREPROCESSOR_FILE = 'nemo128.onnx';
const ENCODER_FILE = 'encoder-model.int8.onnx';
const DECODER_JOINT_FILE = 'decoder_joint-model.int8.onnx';
const VOCAB_FILE = 'vocab.txt';

export interface ParakeetSttOptions extends ChunkedLocalSttOptions {
	/** Directory override for the model files. Defaults to the installed catalog model. */
	modelDir?: string;
}

export class ParakeetSttProvider extends ChunkedLocalSttProvider {
	readonly id = LOCAL_STT_PROVIDER_ID;
	readonly label = 'Parakeet (local)';
	protected readonly engineName = 'Parakeet';
	protected readonly maxSamples = PARAKEET_MAX_SAMPLES;

	private readonly modelDirOverride?: string;

	constructor(options: ParakeetSttOptions = {}) {
		super(options);
		this.modelDirOverride = options.modelDir;
	}

	protected createEngine(): Promise<LocalSttEngine> {
		return createParakeetEngine({ providerId: this.id, modelDir: this.modelDirOverride });
	}
}

/**
 * Build a Parakeet engine over the installed catalog model.
 *
 * Shared by the speech-to-text provider and the transcription-based wake word,
 * so the two cannot disagree about which files make up the model.
 */
export async function createParakeetEngine(options: {
	providerId: string;
	/** Directory override for the model files. Defaults to the installed catalog model. */
	modelDir?: string;
}): Promise<ParakeetEngine> {
	const file = (relative: string) =>
		options.modelDir
			? join(options.modelDir, relative)
			: modelFilePath(PARAKEET_TDT_V2_ID, relative);
	return new ParakeetEngine({
		preprocessorPath: file(PREPROCESSOR_FILE),
		encoderPath: file(ENCODER_FILE),
		decoderJointPath: file(DECODER_JOINT_FILE),
		vocabText: await readFile(file(VOCAB_FILE), 'utf8'),
		providerId: options.providerId,
	});
}
