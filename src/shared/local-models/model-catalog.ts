/**
 * Local Models catalog - the bill of materials for every local model.
 *
 * Local models are the one part of Maestro that ships a binary payload the user
 * has to fetch, so this file is the contract that makes that honest: every byte
 * downloaded is named here, with a PINNED revision, a real SHA-256, a real size,
 * and the license it arrives under. Every setup surface renders this table
 * verbatim - there is no second list of "what we download" anywhere in the app.
 *
 * Three rules this file exists to enforce:
 *
 *   1. **Pinned revisions, never `main`.** A moving ref means the bytes behind a
 *      hash can change under us, which turns SHA-256 verification into a
 *      superstition and makes "it worked yesterday" unreproducible.
 *   2. **Sizes are data, not copy.** Every total is COMPUTED from the file sizes
 *      below, so a button can say "Download (~311 MB)" without a hard-coded
 *      number that drifts the moment a revision is bumped.
 *   3. **Multiple files per model where the model genuinely has them.** A wake
 *      word needs its mel front end AND its embedding head; a TTS voice needs a
 *      voice pack. Recording one file per model would have shipped a catalog
 *      that verifies clean and cannot run, which is exactly the class of failure
 *      the hashes are here to prevent. Every FILE carries its own `sourceUrl` /
 *      `sha256` / `bytes`; the model carries the total.
 *
 * The hashes are the Hugging Face LFS object ids, which ARE the SHA-256 of the
 * file contents, read from `/api/models/<repo>/paths-info/<revision>` at the
 * pinned revision. Do not hand-edit one without re-reading it from the API.
 *
 * This table is consumer-neutral. A feature that needs its own words for a model
 * (a capability tag, a bundle) keys them by model id in its own module rather
 * than adding a field here.
 *
 * Sizes are formatted for display with `formatSize()` from
 * `src/shared/formatters.ts`. Do not add another size formatter.
 */

import type { NativeRuntimeId } from './native-runtimes';
import type {
	LocalClassifierSpec,
	LocalEmbeddingSpec,
	LocalEncoderGraph,
	LocalModelEntry,
	LocalModelFile,
	LocalModelKind,
} from './types';

/** Build the pinned resolve URL for a repo file. */
function hfUrl(repo: string, revision: string, path: string): string {
	return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

interface ModelDraftBase {
	id: string;
	displayName: string;
	runtime: NativeRuntimeId;
	repo: string;
	revision: string;
	license: string;
	licenseUrl: string;
	description: string;
	files: Array<{ path: string; sha256: string; bytes: number }>;
	pending?: string;
}

/**
 * A draft carries its run spec exactly when its kind needs one, so an embedding
 * model without pooling metadata, or a classifier without labels, does not
 * compile.
 */
type ModelDraft =
	| (ModelDraftBase & { kind: 'embedding'; embedding: LocalEmbeddingSpec })
	| (ModelDraftBase & { kind: 'classifier'; classifier: LocalClassifierSpec })
	| (ModelDraftBase & { kind: Exclude<LocalModelKind, 'embedding' | 'classifier'> });

/**
 * Check that an encoder spec points at files the entry actually downloads. A
 * spec naming a graph or tokenizer outside the file list would verify clean and
 * then fail to load, so it is refused when the catalog module loads.
 */
function assertEncoderGraphFiles(draft: ModelDraftBase, graph: LocalEncoderGraph): void {
	const paths = new Set(draft.files.map((file) => file.path));
	const tokenizerPath = graph.tokenizerDir
		? `${graph.tokenizerDir}/tokenizer.json`
		: 'tokenizer.json';
	for (const required of [graph.modelFile, tokenizerPath]) {
		if (!paths.has(required)) {
			throw new Error(`Model "${draft.id}" needs "${required}" but does not download it.`);
		}
	}
}

/** Freeze the kind-specific run spec, validating it against the file list. */
function freezeRunSpec(draft: ModelDraft): Pick<LocalModelEntry, 'embedding' | 'classifier'> {
	if (draft.kind === 'embedding') {
		assertEncoderGraphFiles(draft, draft.embedding);
		return { embedding: Object.freeze({ ...draft.embedding }) };
	}
	if (draft.kind === 'classifier') {
		assertEncoderGraphFiles(draft, draft.classifier);
		if (!draft.classifier.labels.includes(draft.classifier.positiveLabel)) {
			throw new Error(
				`Model "${draft.id}" flags "${draft.classifier.positiveLabel}", which is not one of its labels.`
			);
		}
		return {
			classifier: Object.freeze({
				...draft.classifier,
				labels: Object.freeze([...draft.classifier.labels]),
			}),
		};
	}
	return {};
}

/**
 * Freeze a draft into a catalog entry: expand each file's pinned URL and sum the
 * total. Deep-frozen so a consumer cannot mutate the catalog it renders from -
 * this table is the thing the user consented to, and a renderer that could edit
 * a hash in place would make that consent meaningless.
 */
function defineModel(draft: ModelDraft): LocalModelEntry {
	const files = draft.files.map((file) =>
		Object.freeze({
			path: file.path,
			sourceUrl: hfUrl(draft.repo, draft.revision, file.path),
			sha256: file.sha256,
			bytes: file.bytes,
		})
	);

	return Object.freeze({
		id: draft.id,
		displayName: draft.displayName,
		kind: draft.kind,
		runtime: draft.runtime,
		repo: draft.repo,
		revision: draft.revision,
		license: draft.license,
		licenseUrl: draft.licenseUrl,
		description: draft.description,
		files: Object.freeze(files),
		bytes: files.reduce((total, file) => total + file.bytes, 0),
		...(draft.pending ? { pending: draft.pending } : {}),
		...freezeRunSpec(draft),
	});
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const PARAKEET_TDT_V2_ID = 'parakeet-tdt-0.6b-v2';
export const WHISPER_BASE_EN_ID = 'whisper-base-en';
export const KOKORO_82M_ID = 'kokoro-82m';
export const OPENWAKEWORD_BASE_ID = 'openwakeword-base';
export const HEY_JARVIS_WAKE_ID = 'openwakeword-hey-jarvis';
export const QWEN3_1_7B_ID = 'qwen3-1.7b-instruct-q4km';
export const BGE_SMALL_EN_ID = 'bge-small-en-v1.5';
export const EMBEDDINGGEMMA_300M_ID = 'embeddinggemma-300m';
export const PROMPT_GUARD_2_22M_ID = 'prompt-guard-2-22m';
export const DEBERTA_INJECTION_V2_ID = 'deberta-v3-base-prompt-injection-v2';

/**
 * Every model Maestro can install, in the order a setup surface lists them.
 *
 * Ordered smallest-commitment-first within a kind so a panel reads as a
 * progression rather than as a wall of gigabytes.
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = Object.freeze([
	defineModel({
		id: PARAKEET_TDT_V2_ID,
		displayName: 'Parakeet TDT 0.6B (English)',
		kind: 'stt',
		runtime: 'onnx',
		// NVIDIA's Parakeet TDT 0.6B v2, exported to ONNX by the onnx-asr project.
		// The local default: it gets agent names, casing, and punctuation right
		// where Whisper Base does not, and decodes a few seconds of speech in
		// about 150 ms. The int8 graphs, because the fp32 encoder is 2.4 GB for no
		// audible gain on dictated commands. See `local-models/stt/parakeet/engine.ts`.
		repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
		revision: '0bbb45a3365852604aef28b538a8f066f4ccaa85',
		license: 'CC-BY-4.0',
		licenseUrl: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2',
		description:
			'Fast, accurate English speech recognition that runs on the CPU. Transcribes on this machine, so no audio leaves it.',
		files: [
			{
				// The NeMo log-mel front end, as a graph, so it is never re-derived by hand.
				path: 'nemo128.onnx',
				sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
				bytes: 139764,
			},
			{
				path: 'encoder-model.int8.onnx',
				sha256: '3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155',
				bytes: 652184014,
			},
			{
				path: 'decoder_joint-model.int8.onnx',
				sha256: 'a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3',
				bytes: 8998286,
			},
			{
				// Not an LFS object, so this is the SHA-256 of the bytes served at the
				// pinned revision rather than an LFS oid.
				path: 'vocab.txt',
				sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
				bytes: 9384,
			},
		],
	}),
	defineModel({
		id: WHISPER_BASE_EN_ID,
		displayName: 'Whisper Base (English)',
		kind: 'stt',
		runtime: 'onnx',
		// The ONNX export, not the ggml one. Local speech-to-text runs on ONNX
		// Runtime - the same runtime text-to-speech and the wake word already need -
		// because the whisper.cpp binding publishes no prebuilt binary on any
		// platform and compiles at install time. That made it the one slot that
		// could never ship. See `local-models/stt/whisper/engine.ts`.
		repo: 'onnx-community/whisper-base.en',
		revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/onnx-community/whisper-base.en',
		description:
			'English-only speech recognition that runs on the CPU. Transcribes on this machine, so no audio leaves it.',
		// Encoder plus the MERGED q4 decoder. The merged graph carries both the
		// with-cache and without-cache branches, so one file serves the first pass
		// and every step after it; the q4 weights cost about a third of the fp32
		// download for no measurable accuracy loss on dictated commands.
		files: [
			{
				path: 'onnx/encoder_model.onnx',
				sha256: '1cc86302d480b061452d348638064383ab41b6f3333ddd0e423532d14edaf535',
				bytes: 82468078,
			},
			{
				path: 'onnx/decoder_model_merged_q4.onnx',
				sha256: '7770ac574b71a704191ec52becac42b4a4126af26f54ed653f31c8f16af31f99',
				bytes: 123600371,
			},
			{
				path: 'tokenizer.json',
				sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
				bytes: 2405679,
			},
		],
	}),
	defineModel({
		id: OPENWAKEWORD_BASE_ID,
		displayName: 'openWakeWord Base',
		kind: 'wake-word',
		runtime: 'onnx',
		repo: 'littlebearlabs/openwakeword-features',
		revision: '5e032d9ecdb798f9182ca8088284cf934f10d68e',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/littlebearlabs/openwakeword-features/blob/main/LICENSE',
		description:
			'The always-on front end that listens for the wake and stop words. Small, always local, and never optional: hands-free means something is listening, and that something must be on this machine.',
		files: [
			{
				path: 'melspectrogram.onnx',
				sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
				bytes: 1087958,
			},
			{
				path: 'embedding_model.onnx',
				sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
				bytes: 1326578,
			},
		],
	}),
	defineModel({
		id: HEY_JARVIS_WAKE_ID,
		displayName: 'Wake phrase: "Hey Jarvis"',
		kind: 'wake-word',
		runtime: 'onnx',
		// openWakeWord's own pretrained "hey jarvis" classifier (release v0.5.1).
		// Served from a pinned Hugging Face mirror so it rides the same pinned
		// resolve URL as every other model; the hash is the one published with the
		// official GitHub release asset, verified byte for byte against the mirror.
		repo: 'harvestsu/openwakeword-onnx',
		revision: '93d1bd6f4f48750cb6a76206ce5bd92d846820c8',
		// The openWakeWord CODE is Apache-2.0, but its pretrained models are not:
		// they are non-commercial. Stated here so the setup surface shows it before the
		// download rather than burying it in a README.
		license: 'CC-BY-NC-SA-4.0',
		licenseUrl: 'https://github.com/dscripka/openWakeWord#license',
		description:
			'The detector for the default wake phrase, "hey jarvis". Runs on this machine on top of the wake word front end.',
		files: [
			{
				path: 'hey_jarvis_v0.1.onnx',
				sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
				bytes: 1271370,
			},
		],
	}),
	defineModel({
		id: KOKORO_82M_ID,
		displayName: 'Kokoro 82M',
		kind: 'tts',
		runtime: 'onnx',
		repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
		revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
		description:
			'A neural voice that speaks replies and spoken notices from this machine, in American English. One bundled voice (Heart).',
		// Speaks since the phoneme front end shipped (espeak-ng through the
		// `phonemizer` package, `src/main/acappella/providers/local/kokoro/`).
		files: [
			{
				path: 'onnx/model.onnx',
				sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
				bytes: 325532232,
			},
			{
				path: 'voices/af_heart.bin',
				sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
				bytes: 522240,
			},
			// The phoneme vocabulary. Small, but the model is unusable without it:
			// its ids are what the front end maps phonemes onto.
			{
				path: 'tokenizer.json',
				sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
				bytes: 3497,
			},
		],
	}),
	defineModel({
		id: QWEN3_1_7B_ID,
		displayName: 'Qwen3 1.7B Instruct (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		repo: 'unsloth/Qwen3-1.7B-GGUF',
		revision: 'd7f544eead698dbd1f15126ef60b45a1e1933222',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF',
		description:
			'A small general text model that runs on this machine: names tabs, writes short summaries, drafts shell commands and pull requests, and answers yes or no for the Cue gate. The largest download here, and one you can skip if you already run Ollama or LM Studio.',
		// Installable since the llama runtime was proven on real hardware
		// (docs/architecture/local-models.md, "Llama runtime on real hardware").
		// It is NOT offered for voice routing: see `unofferedLocalModels` on that
		// task for the measured reason.
		files: [
			{
				path: 'Qwen3-1.7B-Q4_K_M.gguf',
				sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
				bytes: 1107409472,
			},
		],
	}),

	// Embedding and classifier models. Small JSON files (configs, tokenizers
	// under a few MB) are not LFS objects in these repos, so their hashes are the
	// SHA-256 of the bytes served at the pinned revision rather than LFS oids.

	defineModel({
		id: BGE_SMALL_EN_ID,
		displayName: 'BGE Small (English)',
		kind: 'embedding',
		runtime: 'onnx',
		// BAAI's bge-small-en-v1.5, exported to ONNX by Xenova. The default
		// embedding model: 384 dimensions, a 34 MB download, and quick on the CPU.
		// `model_quantized.onnx` is the q8 graph transformers.js loads by default.
		repo: 'Xenova/bge-small-en-v1.5',
		revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
		license: 'MIT',
		licenseUrl: 'https://huggingface.co/BAAI/bge-small-en-v1.5',
		description:
			'Turns text into vectors so history, transcripts, and documents can be found by meaning. Small and fast, and runs on this machine.',
		embedding: {
			modelFile: 'onnx/model_quantized.onnx',
			tokenizerDir: '',
			maxTokens: 512,
			outputName: 'last_hidden_state',
			dimensions: 384,
			pooling: 'cls',
			normalize: true,
			// BGE v1.5 retrieves well without an instruction; documents and queries
			// are embedded as written.
		},
		files: [
			{
				path: 'onnx/model_quantized.onnx',
				sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
				bytes: 34014426,
			},
			{
				path: 'tokenizer.json',
				sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
				bytes: 711396,
			},
			{
				path: 'tokenizer_config.json',
				sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
				bytes: 366,
			},
			{
				path: 'special_tokens_map.json',
				sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
				bytes: 125,
			},
			{
				path: 'config.json',
				sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
				bytes: 683,
			},
		],
	}),
	defineModel({
		id: EMBEDDINGGEMMA_300M_ID,
		displayName: 'EmbeddingGemma 300M',
		kind: 'embedding',
		runtime: 'onnx',
		// Google's EmbeddingGemma, ONNX export by onnx-community. The quality
		// option: 768 dimensions (Matryoshka-truncatable to 512, 256, or 128) and a
		// 2048-token window. The q4 graph keeps its weights in an external
		// `.onnx_data` file beside it, which ONNX Runtime opens by relative path, so
		// both must land in the same `onnx/` directory.
		//
		// The graph pools and projects itself: its `sentence_embedding` output is
		// the finished vector. Mean-pooling `last_hidden_state` instead would skip
		// the dense projection layers. It is trained with task prefixes, so a query
		// and a document are embedded differently.
		repo: 'onnx-community/embeddinggemma-300m-ONNX',
		revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
		// Distributed under the Gemma Terms of Use, which require passing the terms
		// (and the prohibited use policy) along with the model.
		license: 'Gemma',
		licenseUrl: 'https://ai.google.dev/gemma/terms',
		description:
			'Higher-quality search by meaning with a longer reading window. A larger download than BGE Small, and runs on this machine.',
		embedding: {
			modelFile: 'onnx/model_q4.onnx',
			tokenizerDir: '',
			maxTokens: 2048,
			outputName: 'sentence_embedding',
			dimensions: 768,
			pooling: 'graph',
			normalize: true,
			queryPrefix: 'task: search result | query: ',
			documentPrefix: 'title: none | text: ',
		},
		files: [
			{
				path: 'onnx/model_q4.onnx',
				sha256: 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
				bytes: 519322,
			},
			{
				path: 'onnx/model_q4.onnx_data',
				sha256: '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02',
				bytes: 196725760,
			},
			{
				path: 'tokenizer.json',
				sha256: '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
				bytes: 20323312,
			},
			{
				path: 'tokenizer_config.json',
				sha256: '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
				bytes: 1156830,
			},
			{
				path: 'special_tokens_map.json',
				sha256: '2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397',
				bytes: 662,
			},
			{
				path: 'config.json',
				sha256: '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
				bytes: 1765,
			},
		],
	}),
	defineModel({
		id: PROMPT_GUARD_2_22M_ID,
		displayName: 'Llama Prompt Guard 2 22M',
		kind: 'classifier',
		runtime: 'onnx',
		// Meta's Llama Prompt Guard 2 (22M, DeBERTa-xsmall), the default
		// prompt-injection classifier. Meta's own repo is gated, so this is
		// gravitee-io's ONNX re-upload. A third-party mirror is trustworthy here
		// ONLY because the revision and every hash below are pinned: the bytes
		// cannot change without this table changing too. `model.quant.onnx` is
		// their quantized graph (72 MB against 284 MB unquantized).
		//
		// License: the Llama 4 Community License. Redistribution or a product
		// built with it must display "Built with Llama" and carry the notice
		// "Llama 4 is licensed under the Llama 4 Community License, Copyright ©
		// Meta Platforms, Inc. All Rights Reserved." The user docs repeat this.
		repo: 'gravitee-io/Llama-Prompt-Guard-2-22M-onnx',
		revision: 'da68d0f6023c7aeaf6b256eec549de295d5e8740',
		license: 'Llama-4-Community-License',
		licenseUrl: 'https://www.llama.com/llama4/license/',
		description:
			'Scores untrusted text, such as an issue comment, for prompt injection before an agent reads it. Small, and runs on this machine.',
		classifier: {
			modelFile: 'model.quant.onnx',
			tokenizerDir: '',
			maxTokens: 512,
			outputName: 'logits',
			labels: ['BENIGN', 'MALICIOUS'],
			positiveLabel: 'MALICIOUS',
		},
		files: [
			{
				path: 'model.quant.onnx',
				sha256: '38c3f03e30a4d5d229aeb7bf638e778322f8179d0ed0d4953eb22f88d8e0cf6b',
				bytes: 72542430,
			},
			{
				path: 'tokenizer.json',
				sha256: '92c8b45d0b12ae0dd9680fbfe9804503542c377d65838558cd0b48a795385dde',
				bytes: 8649291,
			},
			{
				path: 'tokenizer_config.json',
				sha256: 'b1c18af55c6bab08e20873c67d7dc5783eda002a7934f543c4db33f3f89c5099',
				bytes: 1475,
			},
			{
				path: 'special_tokens_map.json',
				sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
				bytes: 970,
			},
			{
				path: 'config.json',
				sha256: 'db1a6dabb734766632a009e17fa72ac4d110505f4be0651654dafc30002461cc',
				bytes: 1006,
			},
		],
	}),
	defineModel({
		id: DEBERTA_INJECTION_V2_ID,
		displayName: 'DeBERTa v3 Prompt Injection v2',
		kind: 'classifier',
		runtime: 'onnx',
		// ProtectAI's fine-tuned DeBERTa-v3-base, the alternative classifier: a
		// permissive license, at about ten times Prompt Guard's download. Its ONNX
		// export and the tokenizer that matches it live in the repo's `onnx/`
		// directory, so the files keep that prefix and the tokenizer is read from
		// there.
		repo: 'protectai/deberta-v3-base-prompt-injection-v2',
		revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2',
		description:
			'An alternative prompt-injection classifier under a permissive license. A much larger download than Prompt Guard, and runs on this machine.',
		classifier: {
			modelFile: 'onnx/model.onnx',
			tokenizerDir: 'onnx',
			maxTokens: 512,
			outputName: 'logits',
			labels: ['SAFE', 'INJECTION'],
			positiveLabel: 'INJECTION',
		},
		files: [
			{
				path: 'onnx/model.onnx',
				sha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c',
				bytes: 738563188,
			},
			{
				path: 'onnx/tokenizer.json',
				sha256: '752fe5f0d5678ad563e1bd2ecc1ddf7a3ba7e2024d0ac1dba1a72975e26dff2f',
				bytes: 8648886,
			},
			{
				path: 'onnx/tokenizer_config.json',
				sha256: '77d3dd1a9c30397a06545251ed9274bd92e4a85feb98497eeed50c920f962274',
				bytes: 1392,
			},
			{
				path: 'onnx/special_tokens_map.json',
				sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
				bytes: 970,
			},
			{
				path: 'onnx/config.json',
				sha256: '3093743035223c46b1497a72e939e56fa0a50afbd7bafbf7eb8aad060b8d23f8',
				bytes: 1014,
			},
		],
	}),
]);

const CATALOG_BY_ID = new Map(LOCAL_MODEL_CATALOG.map((entry) => [entry.id, entry]));

/** Look a model up by id. Undefined for an id that is not in the catalog. */
export function getLocalModel(id: string): LocalModelEntry | undefined {
	return CATALOG_BY_ID.get(id);
}

/** True when `id` names a catalog entry. The guard every path boundary uses. */
export function isLocalModelId(id: string): boolean {
	return CATALOG_BY_ID.has(id);
}

/** Every catalog model a runtime reads, in catalog order. */
export function localModelsForRuntime(runtimeId: NativeRuntimeId): LocalModelEntry[] {
	return LOCAL_MODEL_CATALOG.filter((entry) => entry.runtime === runtimeId);
}

/**
 * The GGUF file llama.cpp opens for a text-generation model, or undefined for
 * an entry that is not one. The in-process engine and the model server both
 * load this file, so they cannot disagree on which of a model's files it is.
 */
export function localModelGgufFile(entry: LocalModelEntry): LocalModelFile | undefined {
	if (entry.kind !== 'text-gen' || entry.runtime !== 'llama') return undefined;
	return entry.files.find((file) => file.path.toLowerCase().endsWith('.gguf'));
}

/** Total bytes of an arbitrary selection of models. Unknown ids contribute zero. */
export function sumModelBytes(ids: readonly string[]): number {
	return ids.reduce((total, id) => total + (getLocalModel(id)?.bytes ?? 0), 0);
}

/**
 * What each kind is called in front of a person. One table so the Settings tab,
 * the CLI, and the docs cannot name a kind three different ways.
 */
export const LOCAL_MODEL_KIND_LABELS: Readonly<Record<LocalModelKind, string>> = Object.freeze({
	'text-gen': 'Text generation',
	embedding: 'Embeddings',
	classifier: 'Classifiers',
	stt: 'Speech-to-text',
	tts: 'Text-to-speech',
	'wake-word': 'Wake word',
});

/**
 * The order kinds are listed in. General-purpose kinds first, voice kinds last,
 * so a user who never turns voice on reads the models they can use before the
 * ones they cannot.
 */
export const LOCAL_MODEL_KIND_ORDER: readonly LocalModelKind[] = Object.freeze([
	'text-gen',
	'embedding',
	'classifier',
	'stt',
	'tts',
	'wake-word',
]);

/**
 * Group items by model kind in {@link LOCAL_MODEL_KIND_ORDER}, keeping each
 * group in the order given. `kindOf` reads the kind off whatever the caller
 * holds (a catalog entry, a listing). Kinds with no item are left out, so a
 * caller never draws an empty heading.
 */
export function groupByLocalModelKind<T>(
	items: readonly T[],
	kindOf: (item: T) => LocalModelKind
): { kind: LocalModelKind; items: T[] }[] {
	return LOCAL_MODEL_KIND_ORDER.map((kind) => ({
		kind,
		items: items.filter((item) => kindOf(item) === kind),
	})).filter((group) => group.items.length > 0);
}
