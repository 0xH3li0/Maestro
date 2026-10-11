/**
 * Chain of thought export: the per-agent switch, and where each chain stands.
 *
 * Everything this feature remembers lives here and nowhere else: which agents
 * are recorded, into which folder, the newest hash of every chain, and each
 * agent's last write and last failure. None of it is copied onto the agent
 * (`Session`) object, into settings, or into the agent configs. Nothing under
 * `src/cli` or `src/main/web-server` may read this module.
 *
 * WHAT AN AGENT CAN FIND ON DISK
 * One file in Maestro's data folder, `maestro-device-state.json`. When the
 * operating system offers encryption, the file holds one field, `blob`: the
 * whole state, sealed with the key the OS keeps for this app. The folder
 * paths, the agent ids, and the field names are all inside the seal. When the
 * OS offers none (a Linux machine with no keyring), the file holds `plain`,
 * the state as readable JSON, and every status says `unencrypted` so the
 * person can be told.
 *
 * The limit, stated plainly: Maestro and its agents run as the same OS user.
 * The seal keeps a search of the disk from turning up a log folder. It does
 * not stop a process that sets out to get the same key from the OS.
 *
 * For someone who never turned this on there is no file, and the OS key store
 * is never asked for anything: not at start, and not at any turn.
 *
 * WHY THE HEAD IS KEPT HERE
 * A log folder cannot vouch for records that were removed from its end. So the
 * newest hash of each chain is kept here, outside the folder, and the verifier
 * compares the two.
 *
 * ONE FOLDER, ONE CHAIN
 * An agent has at most one chain per folder, and no two agents share a folder.
 * A change of folder closes the current chain into `pastChains` and opens a
 * chain in the new folder, so the old folder can still be verified. A turn
 * that started before the change keeps writing to the old chain, so a head can
 * arrive for a chain that is already closed: `getChainState` and
 * `setChainHead` go by folder, never by "the current chain". Going back to a
 * folder that holds a chain takes that chain up again. A second chain started
 * at the genesis hash in the same folder would repeat every position, and the
 * verifier reports that as a break.
 *
 * WHEN IT SAVES
 * A change the person makes (`setAgentConfig`) is saved before the call
 * returns. The head and the status change with every record, so they are saved
 * a moment later, and once more on the way out of the app (`flushSync`). An
 * app that stops hard in between loses nothing for good: the writer finds the
 * records past the stored head at its next write and takes them up.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../shared/cotExport/types';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainState,
	CotFolderValidation,
	CotLastError,
	CotPastChain,
} from '../../shared/cotExport/types';
import { corruptStorePath, createStoreDeserializer } from '../stores/corrupt-store-recovery';
import { getSessionsStore } from '../stores/getters';
import { debounce } from '../utils/debounce';
import { logger } from '../utils/logger';
import { safeStorageSeal } from '../utils/safe-storage-seal';
import type { SealProvider } from '../utils/safe-storage-seal';
import { countTurnFilesOnDay, isSameFolder, validateAgentFolder } from './layout';
import type { AgentFolderContext } from './layout';

// ============================================================================
// Contract
// ============================================================================

/**
 * Name of the store file, without its `.json`. It is bland on purpose: a name
 * that said what the file is for would be the one signal this feature must
 * not give. The name is friction, not security. What protects the content is
 * the seal, and the header above says how far that goes.
 */
export const COT_CONFIG_STORE_NAME = 'maestro-device-state';

/**
 * How long a new head or a new status waits before it is saved. They change
 * with every record of a turn, and one save covers them all.
 */
const PERSIST_DEBOUNCE_MS = 500;

const LOG_CONTEXT = 'Stores';

/** What the person is told when the saved state could not be read at start. */
const UNREADABLE_MESSAGE =
	'Maestro could not read the saved settings for this feature, so it is off for every agent until you turn it on again.';

/** Everything the store holds about one agent. */
interface CotAgentEntry {
	config: CotAgentConfig;
	/**
	 * The chain in `config.folder`. Null exactly when no folder is chosen, so
	 * an agent that is on always has a chain to write to.
	 */
	chain: CotChainState | null;
	/** Chains in folders the agent used before. Kept so they can be verified. */
	pastChains: CotPastChain[];
	status: { lastWriteAt?: number; lastError?: CotLastError };
}

/** The state as it is sealed, or written under `plain`. */
interface CotStoreState {
	agents: Record<string, CotAgentEntry>;
}

/** The store file: one of the two fields, never both. */
interface CotStoreFile {
	/** Base64 of the sealed state. */
	blob?: string;
	/** The state in the clear, on a system that offers no encryption. */
	plain?: unknown;
}

/**
 * The answer to a change of config. `reason` is one sentence for the person
 * who made the change. On a refusal nothing was changed.
 */
export type CotSetConfigResult =
	| { ok: true; config: CotAgentConfig }
	| { ok: false; reason: string };

/** Everything the store needs from outside. */
export interface CotConfigStoreDeps {
	/** The folder that holds the store file. */
	cwd: string;
	/** Seals the state with a key the OS holds, when the OS has one to offer. */
	seal: SealProvider;
	/**
	 * What `validateAgentFolder` checks a folder against. It is asked at every
	 * change of config, because agents come and go.
	 */
	getFolderContext: () => AgentFolderContext;
	/**
	 * A failure was kept as an agent's last error. It is told every failure,
	 * with no limit on how often, and nothing for an agent that was never set
	 * up. A throw from it goes nowhere.
	 */
	onError?: CotFailureListener;
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

/** Hears a failure the store kept: which agent, and what went wrong. */
export type CotFailureListener = (agentId: string, error: CotLastError) => void;

export interface CotConfigStore {
	/** What the person chose for the agent. An agent never set up is off, with no folder. */
	getAgentConfig(agentId: string): CotAgentConfig;
	/**
	 * Changes what the person chose, and saves it before returning.
	 *
	 * A folder is checked with `validateAgentFolder` whenever export goes from
	 * off to on or the folder is a new one, and the real path is what gets
	 * stored. Turning export OFF with the folder left as it is always works: a
	 * folder that has gone bad must not be able to keep the person from
	 * stopping.
	 *
	 * The check runs when the person decides, not at every turn. A folder that
	 * passed stays in use if an agent is later given a workspace around it.
	 */
	setAgentConfig(
		agentId: string,
		next: { enabled: boolean; folder: string | null }
	): CotSetConfigResult;
	/**
	 * Whether `folder` may hold this agent's log, with nothing changed in the
	 * store: the checks of `validateAgentFolder`, and no chain of another agent
	 * in it. It is the check `setAgentConfig` runs, so a folder that passes
	 * here is one that call accepts. A folder that passes and does not exist
	 * yet is created.
	 */
	validateFolder(agentId: string, folder: string): CotFolderValidation;
	/**
	 * Whether the agent's turns are recorded. Served from memory with no disk
	 * read, because it is asked at the start of every turn of every agent.
	 */
	isEnabled(agentId: string): boolean;
	/**
	 * The agent's chain in `folder`, current or past, or null when it has none
	 * there. This is the writer's `getChainState`.
	 */
	getChainState(agentId: string, folder: string): CotChainState | null;
	/** Every chain of the agent, for a verify of each folder it has used. */
	getChains(agentId: string): { current: CotChainState | null; past: CotPastChain[] };
	/**
	 * The new head of the chain in `state.folder`, which can be a past chain.
	 * This is the writer's `onHeadAdvanced`. A head for a folder that holds no
	 * chain of the agent is ignored: a head never creates a chain.
	 */
	setChainHead(agentId: string, state: CotChainState): void;
	/** A record was written at `at`. */
	recordWrite(agentId: string, at: number): void;
	/** A record could not be written, or a head could not be checked. */
	recordError(agentId: string, message: string, at: number): void;
	/** What the Edit Agent dialog shows. It reads today's folders to count turns. */
	getStatus(agentId: string): Promise<CotAgentStatus>;
	/** Saves now whatever is still waiting. For the way out of the app. */
	flushSync(): void;
}

// ============================================================================
// Reading a stored state
// ============================================================================

const DEFAULT_CONFIG: CotAgentConfig = { enabled: false, folder: null, updatedAt: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readChain(raw: unknown): CotChainState | null {
	if (!isRecord(raw)) return null;
	const { folder, head, chainSeq } = raw;
	if (typeof folder !== 'string' || typeof head !== 'string' || typeof chainSeq !== 'number') {
		return null;
	}
	return { folder, head, chainSeq };
}

function readLastError(raw: unknown): CotLastError | undefined {
	if (!isRecord(raw) || typeof raw.message !== 'string' || typeof raw.at !== 'number') {
		return undefined;
	}
	return { message: raw.message, at: raw.at };
}

/**
 * One agent's entry, with the rules the rest of this module relies on put
 * back in force: a chain only in the chosen folder, and no agent on without a
 * chain. Maestro writes no other shape itself. The `plain` form is a file a
 * person can edit, and a newer or older build can have written it.
 *
 * A chain is never dropped: one that does not belong to the chosen folder is
 * kept as a past chain, because its head is the only copy.
 */
function readEntry(raw: unknown): CotAgentEntry | null {
	if (!isRecord(raw)) return null;
	const config = isRecord(raw.config) ? raw.config : {};
	const folder = typeof config.folder === 'string' && config.folder !== '' ? config.folder : null;
	const updatedAt = typeof config.updatedAt === 'number' ? config.updatedAt : 0;

	const pastChains: CotPastChain[] = [];
	for (const item of Array.isArray(raw.pastChains) ? raw.pastChains : []) {
		const past = readChain(item);
		if (!past) continue;
		const closedAt = (item as Record<string, unknown>).closedAt;
		pastChains.push({ ...past, closedAt: typeof closedAt === 'number' ? closedAt : updatedAt });
	}

	const stored = readChain(raw.chain);
	const chain = stored && folder !== null && isSameFolder(stored.folder, folder) ? stored : null;
	if (stored && !chain) pastChains.push({ ...stored, closedAt: updatedAt });

	const status: CotAgentEntry['status'] = {};
	if (isRecord(raw.status)) {
		if (typeof raw.status.lastWriteAt === 'number') status.lastWriteAt = raw.status.lastWriteAt;
		const lastError = readLastError(raw.status.lastError);
		if (lastError) status.lastError = lastError;
	}

	return {
		config: { enabled: config.enabled === true && chain !== null, folder, updatedAt },
		chain,
		pastChains,
		status,
	};
}

/** The agents of a stored state. Throws when `raw` is not a state at all. */
function readAgents(raw: unknown): Map<string, CotAgentEntry> {
	if (!isRecord(raw) || !isRecord(raw.agents)) {
		throw new Error('The stored state has no agents.');
	}
	const agents = new Map<string, CotAgentEntry>();
	for (const [agentId, value] of Object.entries(raw.agents)) {
		const entry = readEntry(value);
		if (entry) agents.set(agentId, entry);
	}
	return agents;
}

/** Why a save failed, in one sentence. */
function describeSaveError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code
		? `Maestro could not save the change (${code}).`
		: 'Maestro could not save the change.';
}

// ============================================================================
// Store
// ============================================================================

export function createCotConfigStore(deps: CotConfigStoreDeps): CotConfigStore {
	const now = deps.now ?? Date.now;
	const storePath = path.resolve(deps.cwd, `${COT_CONFIG_STORE_NAME}.json`);
	const store = new Store<CotStoreFile>({
		name: COT_CONFIG_STORE_NAME,
		cwd: deps.cwd,
		deserialize: createStoreDeserializer<CotStoreFile>(storePath),
	});

	// A Map, not an object: an agent id arrives from outside this module, and a
	// Map has no key that means something else.
	let agents = new Map<string, CotAgentEntry>();
	/** The agents that are on. `isEnabled` reads only this. */
	let enabledAgents = new Set<string>();
	/**
	 * Set when the file on disk could not be read at start. It is shown as the
	 * last error of every agent the person has not set up again since.
	 */
	let loadProblem: CotLastError | null = null;
	/**
	 * The file on disk is one this start could not read. It is moved aside,
	 * never written over, before the first save.
	 */
	let unreadableOnDisk = false;
	let saveFailing = false;

	function refreshEnabled(): void {
		const next = new Set<string>();
		for (const [agentId, entry] of agents) {
			if (entry.config.enabled) next.add(agentId);
		}
		enabledAgents = next;
	}

	/**
	 * Writes `next` to disk, sealed when the OS can seal. It throws when the
	 * state could not be saved, and then the file on disk is as it was.
	 */
	function write(next: Map<string, CotAgentEntry>): void {
		if (unreadableOnDisk) {
			// The bytes this start could not read can be another start's whole
			// state: a keyring that was locked today, or a build signed with
			// another key. Keep them. If they cannot be moved, nothing is written.
			if (fs.existsSync(storePath)) {
				fs.renameSync(storePath, corruptStorePath(storePath, new Date(now())));
			}
			unreadableOnDisk = false;
		}
		const state: CotStoreState = { agents: Object.fromEntries(next) };
		// Assigning the whole document replaces it, so a `plain` left from a
		// time without encryption does not stay beside a new `blob`.
		store.store = deps.seal.available()
			? { blob: deps.seal.seal(JSON.stringify(state)).toString('base64') }
			: { plain: state };
	}

	const persistSoon = debounce(() => {
		try {
			write(agents);
			saveFailing = false;
		} catch (error) {
			// The change is still in memory, and the next one tries the save
			// again. Logged once per run of failures, under the file's own bland
			// name, so a full disk does not fill the log as well.
			if (!saveFailing) {
				const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown error';
				logger.warn(`Could not save ${COT_CONFIG_STORE_NAME}.json (${code}).`, LOG_CONTEXT);
			}
			saveFailing = true;
		}
	}, PERSIST_DEBOUNCE_MS);

	function load(): void {
		let file: CotStoreFile;
		try {
			file = store.store;
		} catch {
			markUnreadable();
			return;
		}
		if (typeof file.blob === 'string') {
			try {
				// With no encryption on offer today there is no key to open it with.
				if (!deps.seal.available()) throw new Error('No encryption is available.');
				agents = readAgents(JSON.parse(deps.seal.unseal(Buffer.from(file.blob, 'base64'))));
			} catch {
				markUnreadable();
			}
			return;
		}
		if (file.plain === undefined) return; // A first start: nothing is stored yet.
		try {
			agents = readAgents(file.plain);
		} catch {
			markUnreadable();
			return;
		}
		// The state lay in the clear because there was no key then. There is one
		// now, so seal it. If that fails it stays as it is until the next save.
		if (deps.seal.available()) {
			try {
				write(agents);
			} catch {
				// Nothing is lost: the readable file is still the whole state.
			}
		}
	}

	function markUnreadable(): void {
		agents = new Map();
		unreadableOnDisk = true;
		loadProblem = { message: UNREADABLE_MESSAGE, at: now() };
		logger.warn(`Could not read ${COT_CONFIG_STORE_NAME}.json. Starting empty.`, LOG_CONTEXT);
	}

	/** The agent's chain in `folder`, as the live object, and where it is kept. */
	function findChain(
		entry: CotAgentEntry,
		folder: string
	): { chain: CotChainState; pastIndex: number } | null {
		if (entry.chain && isSameFolder(entry.chain.folder, folder)) {
			return { chain: entry.chain, pastIndex: -1 };
		}
		const pastIndex = entry.pastChains.findIndex((past) => isSameFolder(past.folder, folder));
		return pastIndex === -1 ? null : { chain: entry.pastChains[pastIndex], pastIndex };
	}

	/** Whether an agent other than `agentId` has, or had, a chain in `folder`. */
	function isFolderOfAnotherAgent(agentId: string, folder: string): boolean {
		for (const [otherId, other] of agents) {
			if (otherId === agentId) continue;
			if (other.config.folder !== null && isSameFolder(other.config.folder, folder)) return true;
			if (findChain(other, folder)) return true;
		}
		return false;
	}

	function validateFolder(agentId: string, candidate: string): CotFolderValidation {
		const validation = validateAgentFolder(candidate, deps.getFolderContext());
		if (!validation.ok) return validation;
		if (isFolderOfAnotherAgent(agentId, validation.resolved)) {
			return {
				ok: false,
				reason:
					'That folder already holds the log of another agent. Choose a folder that only this agent uses.',
			};
		}
		return validation;
	}

	load();
	refreshEnabled();

	return {
		getAgentConfig(agentId) {
			return { ...(agents.get(agentId)?.config ?? DEFAULT_CONFIG) };
		},

		setAgentConfig(agentId, next) {
			const entry: CotAgentEntry = agents.get(agentId) ?? {
				config: { ...DEFAULT_CONFIG },
				chain: null,
				pastChains: [],
				status: {},
			};
			const stored = entry.config.folder;
			const asked =
				typeof next.folder === 'string' && next.folder.trim() !== '' ? next.folder : null;
			const enabled = next.enabled === true;

			let folder: string | null = null;
			if (asked === null) {
				if (enabled) return { ok: false, reason: 'Choose a folder before you turn export on.' };
			} else if (
				stored !== null &&
				isSameFolder(asked, stored) &&
				(!enabled || entry.config.enabled)
			) {
				// The folder is left as it is and export is not being turned on, so
				// no new decision is made and none is checked. This is what lets the
				// person turn export off when the folder has gone bad.
				folder = stored;
			} else {
				const validation = validateFolder(agentId, asked);
				if (!validation.ok) return validation;
				// Another spelling of the stored folder (a symlink, another case)
				// is the stored folder. Keep the stored text, so the chain's
				// folder and the config's folder stay one string.
				folder =
					stored !== null && isSameFolder(validation.resolved, stored)
						? stored
						: validation.resolved;
			}

			const folderChanged = folder !== stored;
			if (!folderChanged && enabled === entry.config.enabled) {
				// Nothing to change, so nothing to save. An agent that was never
				// set up gets no entry for being asked to stay off.
				return { ok: true, config: { ...entry.config } };
			}
			const at = now();
			let chain = entry.chain;
			let pastChains = entry.pastChains;
			if (folderChanged && chain) {
				pastChains = [...pastChains, { ...chain, closedAt: at }];
				chain = null;
			}
			if (folder !== null && chain === null) {
				const target = folder;
				const resumed = pastChains.find((past) => isSameFolder(past.folder, target));
				if (resumed) {
					pastChains = pastChains.filter((past) => past !== resumed);
					chain = { folder: resumed.folder, head: resumed.head, chainSeq: resumed.chainSeq };
					folder = resumed.folder;
				} else {
					chain = { folder: target, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
				}
			}

			// A failure belongs to the setup it happened under. A new folder, or
			// turning export back on, starts clean, and the next failure says so
			// again. Turning it off keeps the failure, so the reason stays visible.
			const startsClean = folderChanged || (enabled && !entry.config.enabled);
			const status = { ...entry.status };
			if (startsClean) delete status.lastError;

			const nextEntry: CotAgentEntry = {
				config: { enabled, folder, updatedAt: at },
				chain,
				pastChains,
				status,
			};
			// Save first, and take the change into memory only once it is on
			// disk: a switch that reads as on and is gone after a restart is
			// worse than one that says it could not be changed.
			const candidate = new Map(agents);
			candidate.set(agentId, nextEntry);
			try {
				write(candidate);
			} catch (error) {
				return { ok: false, reason: describeSaveError(error) };
			}
			agents = candidate;
			saveFailing = false;
			// That save held every head and status as well, so nothing is waiting.
			persistSoon.cancel();
			refreshEnabled();
			return { ok: true, config: { ...nextEntry.config } };
		},

		validateFolder,

		isEnabled(agentId) {
			return enabledAgents.has(agentId);
		},

		getChainState(agentId, folder) {
			const entry = agents.get(agentId);
			const found = entry ? findChain(entry, folder) : null;
			if (!found) return null;
			const { folder: chainFolder, head, chainSeq } = found.chain;
			return { folder: chainFolder, head, chainSeq };
		},

		getChains(agentId) {
			const entry = agents.get(agentId);
			return {
				current: entry?.chain ? { ...entry.chain } : null,
				past: (entry?.pastChains ?? []).map((past) => ({ ...past })),
			};
		},

		setChainHead(agentId, state) {
			const entry = agents.get(agentId);
			const found = entry ? findChain(entry, state.folder) : null;
			if (!entry || !found) return;
			// The stored folder text is kept: only the head and its position move.
			if (found.pastIndex === -1) {
				entry.chain = { folder: found.chain.folder, head: state.head, chainSeq: state.chainSeq };
			} else {
				entry.pastChains[found.pastIndex] = {
					...entry.pastChains[found.pastIndex],
					head: state.head,
					chainSeq: state.chainSeq,
				};
			}
			persistSoon();
		},

		recordWrite(agentId, at) {
			const entry = agents.get(agentId);
			if (!entry) return;
			entry.status.lastWriteAt = at;
			persistSoon();
		},

		recordError(agentId, message, at) {
			const entry = agents.get(agentId);
			if (!entry) return;
			entry.status.lastError = { message, at };
			persistSoon();
			try {
				deps.onError?.(agentId, { message, at });
			} catch {
				// The failure is kept above. A listener that fails must not throw
				// into the write path that reported it.
			}
		},

		async getStatus(agentId) {
			const entry = agents.get(agentId);
			const config = entry?.config ?? DEFAULT_CONFIG;
			let turnsToday = 0;
			if (config.folder !== null) {
				try {
					turnsToday = await countTurnFilesOnDay(config.folder, new Date(now()));
				} catch {
					// A folder that cannot be read shows no turns. The write path
					// reports that failure itself, as the agent's last error.
				}
			}
			const status: CotAgentStatus = {
				enabled: config.enabled,
				folder: config.folder,
				turnsToday,
				unencrypted: !deps.seal.available(),
			};
			if (entry?.status.lastWriteAt !== undefined) status.lastWriteAt = entry.status.lastWriteAt;
			// An agent the person has not set up since a failed start is off
			// because of that failure, so that is what its status says.
			const lastError = entry ? entry.status.lastError : (loadProblem ?? undefined);
			if (lastError) status.lastError = { ...lastError };
			return status;
		},

		flushSync() {
			persistSoon.flush();
		},
	};
}

// ============================================================================
// The app's store
// ============================================================================

let _store: CotConfigStore | null = null;
let _failureListener: CotFailureListener | null = null;

/**
 * Who is told when the app's store keeps a failure, or null for nobody. It can
 * be set before or after the store is made, and a second call replaces the
 * first. The IPC handlers of this feature set it, to tell the person.
 */
export function setCotFailureListener(listener: CotFailureListener | null): void {
	_failureListener = listener;
}

/**
 * Every folder a local agent works in: its working directory, its project
 * root, and its Auto Run folder (which can lie outside the project, and which
 * the agent is told it may write to). An agent on an SSH remote is left out:
 * its paths are paths on another machine.
 */
function localAgentDirs(): string[] {
	const sessions: unknown = getSessionsStore().get('sessions', []);
	const dirs: string[] = [];
	if (!Array.isArray(sessions)) return dirs;
	for (const session of sessions) {
		if (!isRecord(session)) continue;
		const ssh = session.sessionSshRemoteConfig;
		if (isRecord(ssh) && ssh.enabled === true) continue;
		for (const dir of [session.cwd, session.projectRoot, session.autoRunFolderPath]) {
			if (typeof dir === 'string' && dir.trim() !== '') dirs.push(dir);
		}
	}
	return dirs;
}

/**
 * The app's one store, made at the first call.
 *
 * It is made late for two reasons: `safeStorage` works only after the app's
 * `ready` event, and a test must be able to mock `electron` before this module
 * touches it. Do not call this before the app is ready.
 *
 * The file lies in the app's own data folder: per device, never in the sync
 * folder, and never shared between a development run and the installed app,
 * which seal with different keys and could not read each other's file.
 */
export function getCotConfigStore(): CotConfigStore {
	if (_store === null) {
		const userDataPath = app.getPath('userData');
		_store = createCotConfigStore({
			cwd: userDataPath,
			seal: safeStorageSeal(safeStorage),
			getFolderContext: () => ({
				agentDirs: localAgentDirs(),
				userDataPath,
				homeDir: os.homedir(),
			}),
			// Read at each failure, so a listener set after this point is heard.
			onError: (agentId, error) => _failureListener?.(agentId, error),
		});
	}
	return _store;
}

/**
 * Saves whatever the app's store still has waiting. For the quit path, where
 * no later timer tick can be relied on. It does nothing when the store was
 * never made, and it never makes one.
 */
export function flushCotConfigStoreSync(): void {
	_store?.flushSync();
}

/** Drops the app's store and its listener so the next call starts new. For tests. */
export function __resetCotConfigStoreForTests(): void {
	_store = null;
	_failureListener = null;
}
