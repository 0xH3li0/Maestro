/**
 * What System One keeps between launches, in one small file in Maestro's data
 * folder:
 *
 *   system-one.json
 *     engine        off | jev-cloud | openjev | local-judge
 *     openJevUrl    the user's OpenJev server
 *     timeoutMs     the request budget for Jev and OpenJev
 *     models        the pinned model of each remote engine
 *     failPolicies  the per-task fail policies the user changed
 *     keys          one sealed API key per remote engine
 *
 * **Per device, on purpose.** A key sealed by this machine's key store opens
 * nowhere else, and an engine chosen on a machine with no key for it would fail
 * every request. So the choice travels with the key: this file is never in the
 * synced settings.
 *
 * **A key is write-only.** It is sealed with the key the OS holds for the app
 * (`sealSecret`), or obscured on a machine with no OS key store, and the stored
 * record says which. Nothing here returns it to a surface: the one reader is
 * the service, which hands it to the client for a call. A key that cannot be
 * unsealed is reported as exactly that and left in place, since another start
 * may be able to read it; Replace or Clear is the person's decision.
 *
 * The file itself (owner-only, atomic, one change at a time, a non-JSON file
 * moved aside) is `createPrivateStateFile`.
 */

import {
	parseSystemOneSettings,
	SYSTEM_ONE_REMOTE_ENGINE_IDS,
	type SystemOneSettings,
} from '../../../shared/local-models/system-one-settings';
import type { SystemOneRemoteEngineId } from '../../../shared/local-models/system-one';
import type { SecretStorage } from '../../../shared/secretStorage';
import type { SealProvider } from '../../utils/safe-storage-seal';
import {
	createPrivateStateFile,
	isSealedSecretError,
	isStoredSecret,
	sealSecret,
	unsealSecret,
	type SealedSecretErrorKind,
	type StoredSecret,
} from '../../utils/sealed-state-file';

const LOG_CONTEXT = 'SystemOne';

/** The file, relative to the data folder. */
export const SYSTEM_ONE_STATE_FILE = 'system-one.json';

type StoredKeys = Partial<Record<SystemOneRemoteEngineId, StoredSecret>>;

interface StoredState extends SystemOneSettings {
	keys: StoredKeys;
}

function normalizeState(parsed: unknown): StoredState {
	const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
	const stored = (record.keys && typeof record.keys === 'object' ? record.keys : {}) as Record<
		string,
		unknown
	>;
	const keys: StoredKeys = {};
	for (const engine of SYSTEM_ONE_REMOTE_ENGINE_IDS) {
		const key = stored[engine];
		if (isStoredSecret(key)) keys[engine] = key;
	}
	return { ...parseSystemOneSettings(record), keys };
}

const stateFile = createPrivateStateFile<StoredState>({
	fileName: SYSTEM_ONE_STATE_FILE,
	normalize: normalizeState,
	logContext: LOG_CONTEXT,
	whenCorrupt: 'System One is off until an engine is chosen again',
});

function settingsOf(state: StoredState): SystemOneSettings {
	const { keys: _keys, ...settings } = state;
	return settings;
}

/** The settings as stored. A machine that never set System One up reads as off. */
export async function readSystemOneSettings(dataDir: string): Promise<SystemOneSettings> {
	return settingsOf(await stateFile.read(dataDir));
}

/**
 * Change the settings. `change` gets the stored settings and returns the next
 * ones, or throws to refuse; it runs inside the file's queue, so two changes
 * made at once are applied one after the other and neither is lost.
 */
export function updateSystemOneSettings(
	dataDir: string,
	change: (current: SystemOneSettings) => SystemOneSettings
): Promise<SystemOneSettings> {
	return stateFile.update(dataDir, async (state, save) => {
		const next = change(settingsOf(state));
		await save({ ...next, keys: state.keys });
		return next;
	});
}

/** What reading one engine's stored key found. */
export type StoredSystemOneKey =
	| { state: 'none' }
	| { state: 'ok'; key: string; storage: SecretStorage }
	/** A key is stored and does not open. `reason` is why. */
	| { state: 'unreadable'; storage: SecretStorage; reason: SealedSecretErrorKind };

/** One engine's stored key, opened. Never throws for a key that will not open. */
export async function readSystemOneStoredKey(
	dataDir: string,
	engine: SystemOneRemoteEngineId,
	osSeal: SealProvider
): Promise<StoredSystemOneKey> {
	const stored = (await stateFile.read(dataDir)).keys[engine];
	if (!stored) return { state: 'none' };
	try {
		return { state: 'ok', key: unsealSecret(stored, osSeal), storage: stored.storage };
	} catch (error) {
		if (!isSealedSecretError(error)) throw error;
		return { state: 'unreadable', storage: stored.storage, reason: error.kind };
	}
}

/**
 * Seal and store one engine's key, replacing the one it had. Answers with how
 * it was sealed. Throws a `SealedSecretError` (`seal-failed`) when it could not
 * be sealed, and then the file is as it was.
 */
export function storeSystemOneKey(
	dataDir: string,
	engine: SystemOneRemoteEngineId,
	key: string,
	osSeal: SealProvider
): Promise<SecretStorage> {
	return stateFile.update(dataDir, async (state, save) => {
		const stored = sealSecret(key, osSeal);
		await save({ ...state, keys: { ...state.keys, [engine]: stored } });
		return stored.storage;
	});
}

/** Forget one engine's stored key. Answers whether there was one. */
export function clearSystemOneKey(
	dataDir: string,
	engine: SystemOneRemoteEngineId
): Promise<boolean> {
	return stateFile.update(dataDir, async (state, save) => {
		if (!state.keys[engine]) return false;
		const keys = { ...state.keys };
		delete keys[engine];
		await save({ ...state, keys });
		return true;
	});
}
