/**
 * The Sketch Book store (spec section 3, Binding record).
 *
 *   userData/sketches/index.json                     every SketchRecord, plus the
 *                                                    sealed secrets of each sketch
 *   userData/sketches/<agentId>/<sketchId>.excalidraw the scene, in Excalidraw's own
 *                                                    file format
 *
 * Every write is serialized through one `createKeyedWriteQueue()`: scene writes
 * per sketch, index writes under one key of their own, so two saves of the same
 * sketch never interleave and a rename never races a create. A change that
 * touches both (create, delete) takes the sketch key first and the index key
 * inside it; nothing takes them the other way round, so the queue cannot
 * deadlock.
 *
 * An index that is not JSON is moved aside by `createStoreDeserializer()` and
 * the store starts empty; the scene files stay on disk untouched. A scene file
 * that is not JSON is refused by name and never written over.
 *
 * The AES room key and the owner token are sealed with `safeStorageSeal()`
 * (obscured where the OS has no key store) and live in the index beside the
 * records, never inside them, so no read of a record can carry one out.
 *
 * Paths are rebuilt from the data directory, the owner and the sketch id on
 * every read. The `filePath` stored in a record is informational: a hand-edited
 * index cannot point the store at a file outside `sketches/`.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

import { parseJsonWithBom, assertSerializedJsonIsSafe } from '../../shared/jsonUtils';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import type { SketchRecord, SketchScene, SketchShare } from '../../shared/sketch/types';
import { generateUUID } from '../../shared/uuid';
import { createStoreDeserializer } from '../stores/corrupt-store-recovery';
import { atomicWriteFile, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
} from '../utils/real-path-containment';
import { safeStorageSeal, type SealProvider } from '../utils/safe-storage-seal';
import {
	sealSecret,
	unsealSecret,
	isStoredSecret,
	type StoredSecret,
} from '../utils/sealed-state-file';

const LOG_CONTEXT = 'SketchStore';

export const SKETCHES_DIR_NAME = 'sketches';
export const SKETCH_INDEX_FILE = 'index.json';
export const SKETCH_FILE_EXTENSION = '.excalidraw';
export const DEFAULT_SKETCH_NAME = 'Untitled Sketch';
export const SKETCH_NAME_MAX_CHARS = 120;

/** The queue key of the index, which no sketch id (a UUID) can equal. */
const INDEX_KEY = '#index';

/** A sketch id is a UUID; nothing else may become a file name. */
const SKETCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An owner agent id becomes a folder name, so it must be one plain segment. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The secrets a sketch may hold. Sealed on disk, never part of a record. */
export type SketchSecretName = 'roomKey' | 'ownerToken';
const SKETCH_SECRET_NAMES: readonly SketchSecretName[] = ['roomKey', 'ownerToken'];
export type SketchSecrets = Partial<Record<SketchSecretName, string>>;

/** Why the store refused. */
export type SketchStoreErrorCode =
	| 'not-found'
	| 'invalid-agent'
	| 'invalid-scene'
	| 'scene-unreadable'
	| 'invalid-destination'
	| 'outside-destination'
	| 'exists';

export class SketchStoreError extends Error {
	readonly code: SketchStoreErrorCode;

	constructor(code: SketchStoreErrorCode, message: string) {
		super(message);
		this.name = 'SketchStoreError';
		this.code = code;
	}
}

export function isSketchStoreError(error: unknown): error is SketchStoreError {
	return error instanceof SketchStoreError;
}

/** What `index.json` holds. */
interface SketchIndex {
	version: 1;
	sketches: Record<string, SketchRecord>;
	secrets: Record<string, Partial<Record<SketchSecretName, StoredSecret>>>;
}

export interface SketchStoreDeps {
	/** Maestro's data directory. Called on every operation, never cached. */
	dataDir: () => string;
	/** The OS seal. Built lazily: `safeStorage` works only after `ready`. */
	osSeal: () => SealProvider;
	now?: () => number;
	newId?: () => string;
}

export interface SaveToProjectOptions {
	/** A path relative to the destination. Defaults to the sketch name. */
	fileName?: string;
	/** Replace a file that is already there. Off by default. */
	overwrite?: boolean;
}

export interface SketchStore {
	createSketch(input: { ownerAgentId: string; name?: string }): Promise<SketchRecord>;
	listSketches(filter?: { ownerAgentId?: string }): Promise<SketchRecord[]>;
	getSketch(sketchId: string): Promise<SketchRecord | null>;
	readScene(sketchId: string): Promise<SketchScene>;
	writeScene(sketchId: string, scene: SketchScene): Promise<void>;
	renameSketch(sketchId: string, name: string): Promise<SketchRecord>;
	deleteSketch(sketchId: string): Promise<void>;
	/** Copy the scene into a project folder. Returns the path written. */
	saveSketchToProject(
		sketchId: string,
		destDir: string,
		options?: SaveToProjectOptions
	): Promise<string>;
	/** Seal and store secrets; `null` removes one. */
	setSketchSecrets(
		sketchId: string,
		secrets: Partial<Record<SketchSecretName, string | null>>
	): Promise<void>;
	/** Open the stored secrets. Throws `SealedSecretError` when one will not open. */
	readSketchSecrets(sketchId: string): Promise<SketchSecrets>;
	/** The folder holding the index and every scene. */
	sketchesDir(): string;
}

/** A fresh, empty Excalidraw scene. */
export function emptySketchScene(): SketchScene {
	return {
		type: 'excalidraw',
		version: 2,
		source: 'maestro',
		elements: [],
		appState: { viewBackgroundColor: '#ffffff', gridSize: null },
		files: {},
	};
}

/** A display name: trimmed, capped, and never empty. */
export function normalizeSketchName(name: string | undefined): string {
	const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
	if (!trimmed) return DEFAULT_SKETCH_NAME;
	return Array.from(trimmed).slice(0, SKETCH_NAME_MAX_CHARS).join('');
}

export function isSketchId(value: unknown): value is string {
	return typeof value === 'string' && SKETCH_ID_PATTERN.test(value);
}

function isAgentId(value: unknown): value is string {
	return typeof value === 'string' && AGENT_ID_PATTERN.test(value) && !/^\.+$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws `invalid-scene` unless `value` is a scene the store can save and reload. */
export function assertSketchScene(value: unknown): asserts value is SketchScene {
	const fail = (detail: string): never => {
		throw new SketchStoreError('invalid-scene', `The scene is not an Excalidraw scene: ${detail}.`);
	};
	if (!isObject(value)) return fail('not an object');
	if (value.type !== 'excalidraw') fail('type must be "excalidraw"');
	if (typeof value.version !== 'number') fail('version must be a number');
	if (!Array.isArray(value.elements)) return fail('elements must be an array');
	for (const element of value.elements) {
		if (
			!isObject(element) ||
			typeof element.id !== 'string' ||
			typeof element.version !== 'number'
		) {
			fail('every element needs a string id and a numeric version');
		}
	}
	if (!isObject(value.appState)) fail('appState must be an object');
	if (!isObject(value.files)) fail('files must be an object');
}

/** A file name for the sketch in a project folder. */
function projectFileName(name: string): string {
	const base = Array.from(name, (char) =>
		char.charCodeAt(0) < 0x20 || '<>:"/\\|?*'.includes(char) ? '-' : char
	)
		.join('')
		.replace(/^[.\s-]+|[.\s]+$/g, '')
		.trim();
	return `${base || DEFAULT_SKETCH_NAME}${SKETCH_FILE_EXTENSION}`;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

export function createSketchStore(deps: SketchStoreDeps): SketchStore {
	const writes = createKeyedWriteQueue();
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? generateUUID;

	const sketchesDir = (): string => path.join(deps.dataDir(), SKETCHES_DIR_NAME);
	const indexPath = (): string => path.join(sketchesDir(), SKETCH_INDEX_FILE);
	const scenePath = (ownerAgentId: string, sketchId: string): string =>
		path.join(sketchesDir(), ownerAgentId, `${sketchId}${SKETCH_FILE_EXTENSION}`);

	/** Keep the usable records and secrets; drop anything that could name a bad path. */
	function normalizeIndex(parsed: unknown): SketchIndex {
		const index: SketchIndex = { version: 1, sketches: {}, secrets: {} };
		if (!isObject(parsed)) return index;
		const sketches = isObject(parsed.sketches) ? parsed.sketches : {};
		for (const [id, raw] of Object.entries(sketches)) {
			if (
				!isObject(raw) ||
				raw.sketchId !== id ||
				!isSketchId(id) ||
				!isAgentId(raw.ownerAgentId)
			) {
				logger.warn(`Dropped an unusable sketch record "${id}" from the index.`, LOG_CONTEXT);
				continue;
			}
			index.sketches[id] = {
				sketchId: id,
				ownerAgentId: raw.ownerAgentId,
				name: normalizeSketchName(typeof raw.name === 'string' ? raw.name : undefined),
				filePath: scenePath(raw.ownerAgentId, id),
				createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
				share: isObject(raw.share) ? (raw.share as unknown as SketchShare) : null,
				...(typeof raw.botSessionId === 'string' ? { botSessionId: raw.botSessionId } : {}),
				guestEdited: raw.guestEdited === true,
			};
		}
		const secrets = isObject(parsed.secrets) ? parsed.secrets : {};
		for (const [id, raw] of Object.entries(secrets)) {
			if (!index.sketches[id] || !isObject(raw)) continue;
			const kept: Partial<Record<SketchSecretName, StoredSecret>> = {};
			for (const name of SKETCH_SECRET_NAMES) {
				if (isStoredSecret(raw[name])) kept[name] = raw[name];
			}
			if (Object.keys(kept).length > 0) index.secrets[id] = kept;
		}
		return index;
	}

	async function loadIndex(): Promise<SketchIndex> {
		const file = indexPath();
		let text: string;
		try {
			text = await fs.readFile(file, 'utf-8');
		} catch (error) {
			if (errorCode(error) === 'ENOENT') return normalizeIndex({});
			throw error;
		}
		// A torn index is moved aside and the store starts empty; the scenes stay.
		return normalizeIndex(createStoreDeserializer<unknown>(file)(text));
	}

	async function saveIndex(index: SketchIndex): Promise<void> {
		const file = indexPath();
		const serialized = JSON.stringify(index, null, '\t');
		assertSerializedJsonIsSafe(serialized, file);
		await fs.mkdir(path.dirname(file), { recursive: true });
		// The index carries sealed secrets: readable by its owner only.
		await atomicWriteFile(file, serialized, { mode: 0o600 });
	}

	const readIndex = (): Promise<SketchIndex> => writes.enqueue(INDEX_KEY, loadIndex);

	function updateIndex<R>(change: (index: SketchIndex) => R): Promise<R> {
		return writes.enqueue(INDEX_KEY, async () => {
			const index = await loadIndex();
			const result = change(index);
			await saveIndex(index);
			return result;
		});
	}

	async function requireRecord(sketchId: string): Promise<SketchRecord> {
		const record = isSketchId(sketchId) ? (await readIndex()).sketches[sketchId] : undefined;
		if (!record) throw new SketchStoreError('not-found', `No sketch has the id "${sketchId}".`);
		return record;
	}

	async function loadScene(record: SketchRecord): Promise<{ text: string; scene: SketchScene }> {
		const file = scenePath(record.ownerAgentId, record.sketchId);
		let text: string;
		try {
			text = await fs.readFile(file, 'utf-8');
		} catch (error) {
			if (errorCode(error) === 'ENOENT') {
				throw new SketchStoreError(
					'scene-unreadable',
					`The scene file of "${record.name}" is missing: ${file}.`
				);
			}
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = parseJsonWithBom(text);
		} catch {
			throw new SketchStoreError(
				'scene-unreadable',
				`The scene file of "${record.name}" is not JSON. It was left in place: ${file}.`
			);
		}
		try {
			assertSketchScene(parsed);
		} catch (error) {
			throw new SketchStoreError(
				'scene-unreadable',
				`${(error as Error).message} The file was left in place: ${file}.`
			);
		}
		return { text, scene: parsed };
	}

	async function storeScene(record: SketchRecord, scene: SketchScene): Promise<void> {
		const file = scenePath(record.ownerAgentId, record.sketchId);
		const serialized = JSON.stringify(scene, null, '\t');
		assertSerializedJsonIsSafe(serialized, file);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await atomicWriteFile(file, serialized);
	}

	return {
		sketchesDir,

		async createSketch({ ownerAgentId, name }) {
			if (!isAgentId(ownerAgentId)) {
				throw new SketchStoreError('invalid-agent', `"${ownerAgentId}" is not a usable agent id.`);
			}
			const sketchId = newId();
			if (!isSketchId(sketchId))
				throw new Error(`Generated sketch id "${sketchId}" is not a UUID.`);
			const record: SketchRecord = {
				sketchId,
				ownerAgentId,
				name: normalizeSketchName(name),
				filePath: scenePath(ownerAgentId, sketchId),
				createdAt: now(),
				share: null,
				guestEdited: false,
			};
			return writes.enqueue(sketchId, async () => {
				// The scene first: a record never points at a file that does not exist.
				await storeScene(record, emptySketchScene());
				await updateIndex((index) => {
					index.sketches[sketchId] = record;
				});
				return { ...record };
			});
		},

		async listSketches(filter) {
			const { sketches } = await readIndex();
			return Object.values(sketches)
				.filter((record) => !filter?.ownerAgentId || record.ownerAgentId === filter.ownerAgentId)
				.sort((a, b) => a.createdAt - b.createdAt || a.sketchId.localeCompare(b.sketchId));
		},

		async getSketch(sketchId) {
			if (!isSketchId(sketchId)) return null;
			return (await readIndex()).sketches[sketchId] ?? null;
		},

		async readScene(sketchId) {
			await requireRecord(sketchId);
			return writes.enqueue(
				sketchId,
				async () => (await loadScene(await requireRecord(sketchId))).scene
			);
		},

		async writeScene(sketchId, scene) {
			assertSketchScene(scene);
			await requireRecord(sketchId);
			// Checked again in the queue: a delete queued first must not be undone by this write.
			await writes.enqueue(sketchId, async () => storeScene(await requireRecord(sketchId), scene));
		},

		async renameSketch(sketchId, name) {
			await requireRecord(sketchId);
			return writes.enqueue(sketchId, () =>
				updateIndex((index) => {
					const record = index.sketches[sketchId];
					if (!record)
						throw new SketchStoreError('not-found', `No sketch has the id "${sketchId}".`);
					record.name = normalizeSketchName(name);
					return { ...record };
				})
			);
		},

		async deleteSketch(sketchId) {
			const record = await requireRecord(sketchId);
			await writes.enqueue(sketchId, async () => {
				await updateIndex((index) => {
					delete index.sketches[sketchId];
					delete index.secrets[sketchId];
				});
				await fs.rm(scenePath(record.ownerAgentId, sketchId), { force: true });
			});
		},

		async saveSketchToProject(sketchId, destDir, options = {}) {
			const record = await requireRecord(sketchId);
			if (!path.isAbsolute(destDir)) {
				throw new SketchStoreError(
					'invalid-destination',
					`The destination must be an absolute folder path: "${destDir}".`
				);
			}
			const fileName = options.fileName ?? projectFileName(record.name);
			const relative = normalizeRootRelativePath(fileName);
			if (relative === null) {
				throw new SketchStoreError(
					'outside-destination',
					`"${fileName}" would land outside ${destDir}. Name a file inside it.`
				);
			}
			if (relative === '') {
				throw new SketchStoreError('invalid-destination', 'The file name is empty.');
			}
			const target = path.join(destDir, ...relative.split('/'));
			// Lexically inside is not enough: a symlink under the folder could point anywhere.
			const realRoot = foldPathCase(realpathThroughAncestor(path.resolve(destDir)));
			if (!isPathWithin(foldPathCase(realpathThroughAncestor(target)), realRoot)) {
				throw new SketchStoreError(
					'outside-destination',
					`${target} resolves outside ${destDir}. Name a file inside it.`
				);
			}
			return writes.enqueue(sketchId, async () => {
				const { text } = await loadScene(await requireRecord(sketchId));
				if (!options.overwrite) {
					try {
						await fs.access(target);
						throw new SketchStoreError('exists', `${target} already exists.`);
					} catch (error) {
						if (isSketchStoreError(error)) throw error;
						if (errorCode(error) !== 'ENOENT') throw error;
					}
				}
				await fs.mkdir(path.dirname(target), { recursive: true });
				await atomicWriteFile(target, text);
				return target;
			});
		},

		async setSketchSecrets(sketchId, secrets) {
			await requireRecord(sketchId);
			// Seal outside the queue: it is CPU work and may ask the OS for its key.
			const sealed: Partial<Record<SketchSecretName, StoredSecret | null>> = {};
			for (const name of SKETCH_SECRET_NAMES) {
				const value = secrets[name];
				if (value === undefined) continue;
				sealed[name] = value === null ? null : sealSecret(value, deps.osSeal());
			}
			await writes.enqueue(sketchId, () =>
				updateIndex((index) => {
					if (!index.sketches[sketchId]) {
						throw new SketchStoreError('not-found', `No sketch has the id "${sketchId}".`);
					}
					const kept = { ...index.secrets[sketchId] };
					for (const [name, value] of Object.entries(sealed) as [
						SketchSecretName,
						StoredSecret | null,
					][]) {
						if (value === null) delete kept[name];
						else kept[name] = value;
					}
					if (Object.keys(kept).length > 0) index.secrets[sketchId] = kept;
					else delete index.secrets[sketchId];
				})
			);
		},

		async readSketchSecrets(sketchId) {
			await requireRecord(sketchId);
			const stored = (await readIndex()).secrets[sketchId] ?? {};
			const opened: SketchSecrets = {};
			for (const name of SKETCH_SECRET_NAMES) {
				const secret = stored[name];
				if (secret) opened[name] = unsealSecret(secret, deps.osSeal());
			}
			return opened;
		},
	};
}

let defaultStore: SketchStore | null = null;

/** The app's store, over `app.getPath('userData')` and the OS seal. */
export function getSketchStore(): SketchStore {
	defaultStore ??= createSketchStore({
		dataDir: () => app.getPath('userData'),
		osSeal: () => safeStorageSeal(safeStorage),
	});
	return defaultStore;
}

export const createSketch: SketchStore['createSketch'] = (input) =>
	getSketchStore().createSketch(input);
export const listSketches: SketchStore['listSketches'] = (filter) =>
	getSketchStore().listSketches(filter);
export const getSketch: SketchStore['getSketch'] = (sketchId) =>
	getSketchStore().getSketch(sketchId);
export const readScene: SketchStore['readScene'] = (sketchId) =>
	getSketchStore().readScene(sketchId);
export const writeScene: SketchStore['writeScene'] = (sketchId, scene) =>
	getSketchStore().writeScene(sketchId, scene);
export const renameSketch: SketchStore['renameSketch'] = (sketchId, name) =>
	getSketchStore().renameSketch(sketchId, name);
export const deleteSketch: SketchStore['deleteSketch'] = (sketchId) =>
	getSketchStore().deleteSketch(sketchId);
export const saveSketchToProject: SketchStore['saveSketchToProject'] = (
	sketchId,
	destDir,
	options
) => getSketchStore().saveSketchToProject(sketchId, destDir, options);
export const setSketchSecrets: SketchStore['setSketchSecrets'] = (sketchId, secrets) =>
	getSketchStore().setSketchSecrets(sketchId, secrets);
export const readSketchSecrets: SketchStore['readSketchSecrets'] = (sketchId) =>
	getSketchStore().readSketchSecrets(sketchId);
