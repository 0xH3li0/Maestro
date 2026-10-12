/**
 * What the Maestro model server keeps between launches, in one small file in
 * Maestro's data folder:
 *
 *   model-server.json
 *     port        chosen the first time the server starts, then kept
 *     bind        'local' (127.0.0.1) or 'network' (0.0.0.0)
 *     maxModels   models loaded at once
 *     key         the API key, sealed
 *
 * **The port is kept**, for the reason the token proxy keeps its own: what
 * points at the server names it (a harness set up by hand, the endpoint Maestro
 * registers for the server), so a port that moved between launches would leave
 * all of that pointing at nothing, or at whatever took the old one. When the
 * port is taken at start, the server does not move: the start fails by name.
 *
 * **The key** is 32 random bytes, made the first time it is needed. It is sealed
 * with the key the OS holds for the app (`safeStorageSeal`), or, on a machine
 * with no OS key store (Linux with no keyring), with `obscuringSeal`, which keeps
 * it from being readable text in the file but is not encryption; `keyStorage`
 * says which. It is never logged. A key that cannot be unsealed (the OS key
 * store was reset, the file came from another machine) is refused by name, and
 * rotating makes a new one.
 *
 * A file that is not JSON is moved aside (`corruptStorePath`) rather than
 * overwritten, so the port and key it held can still be found. Every change goes
 * through one queue and an atomic rename, and the file is readable by its owner
 * only.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { assertSerializedJsonIsSafe, parseJsonWithBom } from '../../../shared/jsonUtils';
import {
	DEFAULT_MODEL_SERVER_BIND,
	DEFAULT_MODEL_SERVER_MAX_MODELS,
	isModelServerBind,
	isModelServerMaxModels,
	MAX_MODEL_SERVER_MAX_MODELS,
	MODEL_SERVER_LOOPBACK_HOST,
	MODEL_SERVER_NAME,
	type ModelServerBind,
	type ModelServerKeyStorage,
} from '../../../shared/local-models/model-server';
import { corruptStorePath } from '../../stores/corrupt-store-recovery';
import { atomicWriteFile, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import { obscuringSeal, type SealProvider } from '../../utils/safe-storage-seal';
import { isTcpPort, pickFreePort } from '../../utils/tcp-port';
import { ModelServerError } from '../errors';

const LOG_CONTEXT = 'ModelServer';

/** The file, relative to the data folder. */
export const MODEL_SERVER_STATE_FILE = 'model-server.json';

/** Bytes of randomness in a key. */
const KEY_BYTES = 32;

/**
 * The key's prefix. Recognizable as Maestro's in a harness's settings, and in
 * the shape `redactSecrets()` already removes from anything Maestro shows or
 * stores.
 */
export const MODEL_SERVER_KEY_PREFIX = 'sk-maestro-';

/** The settings, as the server is started with them. */
export interface ModelServerConfig {
	/** Null until the server was first started. */
	port: number | null;
	bind: ModelServerBind;
	maxModels: number;
	/** Null until a key exists. */
	keyStorage: ModelServerKeyStorage | null;
}

export interface ModelServerKey {
	key: string;
	storage: ModelServerKeyStorage;
}

interface StoredKey {
	sealed: string;
	storage: ModelServerKeyStorage;
}

interface StoredState {
	port?: number;
	bind?: ModelServerBind;
	maxModels?: number;
	key?: StoredKey;
}

const writes = createKeyedWriteQueue();

function statePath(dataDir: string): string {
	return path.join(dataDir, MODEL_SERVER_STATE_FILE);
}

function isStoredKey(value: unknown): value is StoredKey {
	const record = value as Partial<StoredKey> | null;
	return (
		typeof record?.sealed === 'string' &&
		record.sealed.length > 0 &&
		(record.storage === 'os' || record.storage === 'obscured')
	);
}

/** Keep the fields that are usable; a field that is not is dropped with a warning. */
function normalizeState(parsed: unknown): StoredState {
	const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
	const state: StoredState = {};
	if (isTcpPort(record.port)) state.port = record.port;
	else if (record.port !== undefined) logger.warn('Ignoring an unusable port', LOG_CONTEXT);
	if (isModelServerBind(record.bind)) state.bind = record.bind;
	else if (record.bind !== undefined) logger.warn('Ignoring an unusable bind mode', LOG_CONTEXT);
	if (isModelServerMaxModels(record.maxModels)) state.maxModels = record.maxModels;
	else if (record.maxModels !== undefined) {
		logger.warn('Ignoring an unusable model count', LOG_CONTEXT);
	}
	if (isStoredKey(record.key)) state.key = record.key;
	else if (record.key !== undefined) logger.warn('Ignoring an unusable sealed key', LOG_CONTEXT);
	return state;
}

async function readState(dataDir: string): Promise<StoredState> {
	const file = statePath(dataDir);
	let text: string;
	try {
		text = await fs.readFile(file, 'utf-8');
	} catch (error) {
		// No file is the state of a server that was never started.
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
		throw error;
	}
	try {
		return normalizeState(parseJsonWithBom(text));
	} catch {
		const sidecar = corruptStorePath(file);
		await fs.rename(file, sidecar);
		logger.warn(
			`${MODEL_SERVER_STATE_FILE} was not JSON. It was moved to ${path.basename(sidecar)}, and the server starts with a new port and key.`,
			LOG_CONTEXT
		);
		return {};
	}
}

async function writeState(dataDir: string, state: StoredState): Promise<void> {
	const file = statePath(dataDir);
	const serialized = JSON.stringify(state, null, 2);
	assertSerializedJsonIsSafe(serialized, file);
	await fs.mkdir(dataDir, { recursive: true });
	// A temp file left by a crash would keep its old mode through the write.
	await fs.rm(`${file}.tmp`, { force: true });
	await atomicWriteFile(file, serialized, { mode: 0o600 });
}

function configOf(state: StoredState): ModelServerConfig {
	return {
		port: state.port ?? null,
		bind: state.bind ?? DEFAULT_MODEL_SERVER_BIND,
		maxModels: state.maxModels ?? DEFAULT_MODEL_SERVER_MAX_MODELS,
		keyStorage: state.key?.storage ?? null,
	};
}

/** Run a read-modify-write of the file, one at a time. */
function mutate<T>(dataDir: string, fn: (state: StoredState) => Promise<T>): Promise<T> {
	return writes.enqueue(statePath(dataDir), async () => fn(await readState(dataDir)));
}

export function readModelServerConfig(dataDir: string): Promise<ModelServerConfig> {
	return writes.enqueue(statePath(dataDir), async () => configOf(await readState(dataDir)));
}

/**
 * The server's port, chosen and persisted on the first call. The only function
 * that chooses one: call it when the server starts, not before.
 */
export function ensureModelServerPort(dataDir: string): Promise<number> {
	return mutate(dataDir, async (state) => {
		if (state.port !== undefined) return state.port;
		const port = await pickFreePort(MODEL_SERVER_LOOPBACK_HOST);
		await writeState(dataDir, { ...state, port });
		logger.info(`The ${MODEL_SERVER_NAME} will use port ${port}`, LOG_CONTEXT);
		return port;
	});
}

export interface ModelServerSettingsPatch {
	bind?: ModelServerBind;
	maxModels?: number;
}

/** Change the bind mode or the model count. Rejects with `invalid-setting` for a value it does not accept. */
export async function writeModelServerSettings(
	dataDir: string,
	patch: ModelServerSettingsPatch
): Promise<ModelServerConfig> {
	if (patch.bind !== undefined && !isModelServerBind(patch.bind)) {
		throw new ModelServerError(
			`"${String(patch.bind)}" is not a bind mode. Use local or network.`,
			'invalid-setting'
		);
	}
	if (patch.maxModels !== undefined && !isModelServerMaxModels(patch.maxModels)) {
		throw new ModelServerError(
			`"${String(patch.maxModels)}" is not a model count the ${MODEL_SERVER_NAME} accepts. Use a whole number from 1 to ${MAX_MODEL_SERVER_MAX_MODELS}.`,
			'invalid-setting'
		);
	}
	return mutate(dataDir, async (state) => {
		const next: StoredState = {
			...state,
			...(patch.bind !== undefined ? { bind: patch.bind } : {}),
			...(patch.maxModels !== undefined ? { maxModels: patch.maxModels } : {}),
		};
		await writeState(dataDir, next);
		return configOf(next);
	});
}

/**
 * The seal a new key is made with: the OS's when it has one, else the obscuring
 * seal, which is still never readable text.
 */
function sealFor(storage: ModelServerKeyStorage, osSeal: SealProvider): SealProvider {
	return storage === 'os' ? osSeal : obscuringSeal();
}

function newKey(): string {
	return MODEL_SERVER_KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

async function storeNewKey(
	dataDir: string,
	state: StoredState,
	osSeal: SealProvider
): Promise<ModelServerKey> {
	const storage: ModelServerKeyStorage = osSeal.available() ? 'os' : 'obscured';
	const key = newKey();
	let sealed: string;
	try {
		sealed = sealFor(storage, osSeal).seal(key).toString('base64');
	} catch (error) {
		throw new ModelServerError(
			`The ${MODEL_SERVER_NAME} could not seal a new key: ${error instanceof Error ? error.message : String(error)}.`,
			'key-unavailable',
			error
		);
	}
	await writeState(dataDir, { ...state, key: { sealed, storage } });
	if (storage === 'obscured') {
		logger.warn(
			`This system offers no encryption for stored secrets, so the ${MODEL_SERVER_NAME} key is stored obscured, not encrypted`,
			LOG_CONTEXT
		);
	}
	return { key, storage };
}

/**
 * The server's key, made and sealed on the first call. Throws `key-unavailable`
 * when the stored key cannot be unsealed.
 */
export function ensureModelServerKey(
	dataDir: string,
	osSeal: SealProvider
): Promise<ModelServerKey> {
	return mutate(dataDir, async (state) => {
		if (!state.key) return storeNewKey(dataDir, state, osSeal);
		const { sealed, storage } = state.key;
		const seal = sealFor(storage, osSeal);
		if (storage === 'os' && !seal.available()) {
			throw new ModelServerError(
				`The ${MODEL_SERVER_NAME} key is sealed with this system's key store, which is not available now. Rotate the key to make a new one; anything set up with the old key then needs the new one.`,
				'key-unavailable'
			);
		}
		try {
			return { key: seal.unseal(Buffer.from(sealed, 'base64')), storage };
		} catch (error) {
			throw new ModelServerError(
				`The ${MODEL_SERVER_NAME} key could not be unsealed. Rotate the key to make a new one; anything set up with the old key then needs the new one.`,
				'key-unavailable',
				error
			);
		}
	});
}

/** Replace the key with a new one. The old one stops working at the next start. */
export function rotateModelServerKey(
	dataDir: string,
	osSeal: SealProvider
): Promise<ModelServerKey> {
	return mutate(dataDir, (state) => storeNewKey(dataDir, state, osSeal));
}
