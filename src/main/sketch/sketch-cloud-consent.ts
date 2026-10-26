/**
 * Sketch Book cloud screening consent (spec section 8.10, G2 to G4, H1): the
 * rules that decide whether guest text may go to a cloud screening engine.
 *
 * Two separate things must hold, on purpose:
 *
 * - The CONSENT protects the conductor, who chose the third party. It is
 *   stored per engine in `sketchBook.cloudScreenConsent`; an OpenJev consent
 *   is bound to its host, so a new URL asks again (G2). It is granted only
 *   through a confirmation that names the provider, its host and what leaves
 *   the machine: the desktop dialog, or the CLI's own prompt for a person at
 *   the terminal. An agent caller always gets the desktop dialog (A1).
 * - The ROOM FLAG protects guests, who joined on an end-to-end promise. A room
 *   may use a cloud engine only when (1) the conductor confirmed the engine in
 *   force while the room is live, and (2) the server echoed `cloud` for the
 *   room (`welcome.screening` or a `screening` frame), so guests were told
 *   first (G4). The echo's `since` bounds what the cloud engine may see (H1).
 *
 * The live confirmation is cleared whenever the engine in force changes while
 * the room is live (G3), so a stored consent alone is not enough after a live
 * switch. A room that goes live with a covered cloud engine already in force
 * counts as confirmed: that is the first use the consent answered (G2). The
 * confirmation is bound to the exact source (kind and host), and a change
 * event holds every cloud check until the new source is read, so a switch
 * between the check and the send cannot leak text.
 *
 * {@link SketchCloudConsent.roomScreening} is the value the room client sends
 * as `screening.set`: `cloud` only when guest text may actually go to a cloud
 * engine, else `local` (a room whose screen is `off` reports `local`: with the
 * screen off guest text goes nowhere). Every change is published as a
 * {@link SketchScreeningChange} on {@link sketchCloudConsentEvents} and to
 * every window, which sends `screening.set` on a changed value and raises the
 * confirmation through {@link SketchCloudConsent.confirmCloudScreening} when
 * `confirmNeeded` is set.
 *
 * The module registers itself as the guardrail's cloud policy
 * (`setSketchCloudScreeningPolicy`) when started.
 */

import { BrowserWindow, dialog } from 'electron';
import { EventEmitter } from 'events';
import type Store from 'electron-store';
import { encoreDisabledMessage, isEncoreFeatureEnabled } from '../../shared/encoreFeatureDefaults';
import type {
	InjectionSourceInfo,
	InjectionSourceResolution,
} from '../../shared/local-models/injection-screen';
import {
	cloudEngineOfSource,
	consentCoversSource,
	isSketchCloudEngine,
	normalizeSketchCloudScreenConsent,
	screenSourceKey,
	sketchCloudEngineLabel,
	sketchCloudScreeningDisclosure,
	SKETCH_BOOK_SETTINGS_KEY,
	SKETCH_CLOUD_SCREEN_CONSENT_SETTING,
	withConsentGranted,
	withConsentRevoked,
	type SketchCloudEngine,
	type SketchCloudScreenConsent,
	type SketchRoomScreeningStatus,
	type SketchScreeningChange,
	type SketchScreeningConsentStatus,
} from '../../shared/sketch/cloud-consent';
import { SCREENINGS, type Screening } from '../../shared/sketch/protocol';
import { resolveInjectionSource } from '../local-models/injection-screen';
import { onSystemOneChanged } from '../local-models/system-one/service';
import { getSettingsStore } from '../stores/getters';
import type { MaestroSettings } from '../stores/types';
import { logger } from '../utils/logger';
import type { SafeSendFn } from '../utils/safe-send';
import { captureException } from '../utils/sentry';
import { setSketchCloudScreeningPolicy, type SketchCloudScreeningPolicy } from './sketch-guardrail';

const LOG_CTX = '[SketchBook][CloudConsent]';

/** The push channel every window hears a {@link SketchScreeningChange} on. */
export const SKETCH_SCREENING_CHANGED_CHANNEL = 'sketch:screeningChanged';

/** What a confirmation asks. */
export interface SketchCloudConfirmPrompt {
	engine: SketchCloudEngine;
	host?: string;
	reason: 'grant' | 'live-switch';
	/** The agent that asked, when an agent caller asked (A1). */
	requestedBy?: string;
}

export interface SketchCloudConsentDeps {
	/** The raw `sketchBook` setting. */
	readSettings?: () => unknown;
	/** Store the consent at `sketchBook.cloudScreenConsent`. */
	writeConsent?: (consent: SketchCloudScreenConsent) => void;
	/** The screen's source in force; sends nothing. */
	resolveSource?: () => Promise<InjectionSourceResolution>;
	/** Ask the conductor. Resolves true only on an explicit yes. */
	confirm?: (prompt: SketchCloudConfirmPrompt) => Promise<boolean>;
	/** Whether the Sketch Book Encore Feature is on. */
	isEnabled?: () => boolean;
	/** Push a change to every window. */
	publish?: (change: SketchScreeningChange) => void;
	now?: () => number;
}

/** One live room, as this module tracks it. */
interface RoomState {
	/** `setRoomLive` ran: the room's first confirmation was decided. */
	joined: boolean;
	/** The source the conductor confirmed while the room is live, or null. */
	confirmedSource: InjectionSourceInfo | null;
	/** The server's echo for the room. */
	server: { screening: Screening; since: number | null } | null;
}

export interface SketchCloudConsent extends SketchCloudScreeningPolicy {
	/** The stored consent, normalized. */
	getConsent(): SketchCloudScreenConsent;
	/** Grant one engine (OpenJev: for `host`, or the host in force). Confirms live rooms on that engine. */
	grantConsent(engine: SketchCloudEngine, host?: string): Promise<SketchScreeningConsentStatus>;
	/**
	 * The CLI's grant. An agent caller (`fromAgent`) gets the desktop
	 * confirmation and nothing is stored unless the conductor allows it (A1).
	 */
	requestGrant(
		engine: SketchCloudEngine,
		caller?: { fromAgent?: string }
	): Promise<SketchScreeningConsentStatus>;
	revokeConsent(engine: SketchCloudEngine): Promise<SketchScreeningConsentStatus>;
	/**
	 * Raise the confirmation for the cloud engine in force (G2 first use, G3
	 * live switch). On yes: store the consent if missing and confirm every live
	 * room. Resolves false when declined or when the engine in force is local.
	 */
	confirmCloudScreening(): Promise<boolean>;
	/** The value the room client reports as `screening.set` for this room. */
	roomScreening(sketchId: string): Promise<Screening>;
	/** The room client's socket joined (`welcome`) or left. Resolves with the room's value. */
	setRoomLive(sketchId: string, live: boolean): Promise<Screening>;
	/** The server's `welcome.screening` / `screeningSince` or a `screening {screening, since}` frame. */
	reportServerScreening(sketchId: string, screening: Screening, since: number | null): void;
	/** Re-read the source in force after an assignment or System One change. */
	refresh(): Promise<void>;
	/** The consent setting changed (any writer). */
	handleConsentChanged(): Promise<void>;
	/** The whole state, for `maestro-cli sketch screening-consent status` and Settings. */
	status(): Promise<SketchScreeningConsentStatus>;
	/** Forget every room. */
	reset(): void;
}

/** Main-process listeners: `change` with a {@link SketchScreeningChange}. */
export const sketchCloudConsentEvents = new EventEmitter();

function isSourceInfo(resolved: InjectionSourceResolution): resolved is InjectionSourceInfo {
	return !('status' in resolved);
}

function sameSource(a: InjectionSourceInfo | null, b: InjectionSourceInfo): boolean {
	return a !== null && screenSourceKey(a) === screenSourceKey(b);
}

function requireSketchId(sketchId: unknown): string {
	if (typeof sketchId !== 'string' || !sketchId.trim()) {
		throw new Error('Sketch Book: sketchId must be a non-empty string.');
	}
	return sketchId;
}

function requireEngine(engine: unknown): SketchCloudEngine {
	if (!isSketchCloudEngine(engine)) {
		throw new Error(`Sketch Book: engine must be jev or openjev, not ${String(engine)}.`);
	}
	return engine;
}

/** The desktop confirmation: a native dialog on the focused (or first) window. */
async function confirmOnDesktop(prompt: SketchCloudConfirmPrompt): Promise<boolean> {
	const disclosure = sketchCloudScreeningDisclosure(prompt);
	const asker = prompt.requestedBy
		? `\n\nThe agent "${prompt.requestedBy}" asked for this. Allow it only if you meant to.`
		: '';
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: disclosure.title,
		message: disclosure.message,
		detail: `${disclosure.detail}${asker}`,
		buttons: ['Allow', 'Deny'],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
	};
	const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	const answer = parent
		? await dialog.showMessageBox(parent, options)
		: await dialog.showMessageBox(options);
	return answer.response === 0;
}

export function createSketchCloudConsent(deps: SketchCloudConsentDeps = {}): SketchCloudConsent {
	const readSettings =
		deps.readSettings ?? (() => getSettingsStore().get(SKETCH_BOOK_SETTINGS_KEY));
	const writeConsent =
		deps.writeConsent ??
		((consent: SketchCloudScreenConsent) =>
			getSettingsStore().set(SKETCH_CLOUD_SCREEN_CONSENT_SETTING, consent));
	const resolveSource = deps.resolveSource ?? resolveInjectionSource;
	const confirm = deps.confirm ?? confirmOnDesktop;
	const isEnabled =
		deps.isEnabled ?? (() => isEncoreFeatureEnabled(getSettingsStore(), 'sketchBook'));
	const publish = deps.publish ?? (() => {});
	const now = deps.now ?? Date.now;

	const rooms = new Map<string, RoomState>();
	/** The source key last read, so a refresh can tell a change from a repeat. */
	let lastSourceKey: string | null | undefined;
	/** Change events not yet read back: every cloud check is held until they are. */
	let pendingChanges = 0;
	let refreshChain: Promise<void> = Promise.resolve();

	function requireEnabled(): void {
		if (!isEnabled()) throw new Error(encoreDisabledMessage('sketchBook'));
	}

	function getConsent(): SketchCloudScreenConsent {
		const raw = readSettings();
		return normalizeSketchCloudScreenConsent(
			raw && typeof raw === 'object' ? (raw as Record<string, unknown>).cloudScreenConsent : null
		);
	}

	function keyOf(resolved: InjectionSourceResolution): string {
		return isSourceInfo(resolved) ? screenSourceKey(resolved) : `none|${resolved.status}`;
	}

	/** The value a room reports, given the source in force. */
	function screeningFor(
		room: RoomState | undefined,
		resolved: InjectionSourceResolution
	): Screening {
		if (!isSourceInfo(resolved) || resolved.locality === 'local') return 'local';
		if (!consentCoversSource(getConsent(), resolved)) return 'local';
		// A room not yet live would be confirmed on joining with a covered engine.
		if (!room) return 'cloud';
		return sameSource(room.confirmedSource, resolved) ? 'cloud' : 'local';
	}

	/** Whether a live room still needs the conductor to confirm the cloud source in force. */
	function confirmNeededFor(
		resolved: InjectionSourceResolution
	): SketchScreeningChange['confirmNeeded'] {
		if (!isSourceInfo(resolved)) return undefined;
		const engine = cloudEngineOfSource(resolved);
		if (!engine) return undefined;
		const covered = consentCoversSource(getConsent(), resolved);
		const waiting = [...rooms.values()].some(
			(room) => !covered || !sameSource(room.confirmedSource, resolved)
		);
		if (!waiting || rooms.size === 0) return undefined;
		return {
			engine,
			...(resolved.host ? { host: resolved.host } : {}),
			reason: covered ? 'live-switch' : 'grant',
		};
	}

	function announce(resolved: InjectionSourceResolution): void {
		const change: SketchScreeningChange = {
			consent: getConsent(),
			rooms: [...rooms.entries()].map(([sketchId, room]) => ({
				sketchId,
				screening: screeningFor(room, resolved),
			})),
		};
		const confirmNeeded = confirmNeededFor(resolved);
		if (confirmNeeded) change.confirmNeeded = confirmNeeded;
		sketchCloudConsentEvents.emit('change', change);
		try {
			publish(change);
		} catch (error) {
			void captureException(error, { operation: 'sketch:publishScreeningChange' });
		}
	}

	/** Confirm the source in force for every live room the stored consent covers. */
	function confirmLiveRooms(resolved: InjectionSourceInfo): void {
		if (!consentCoversSource(getConsent(), resolved)) return;
		for (const room of rooms.values()) room.confirmedSource = resolved;
	}

	async function status(): Promise<SketchScreeningConsentStatus> {
		requireEnabled();
		const resolved = await resolveSource();
		const consent = getConsent();
		const source = isSourceInfo(resolved) ? resolved : null;
		const roomRows: SketchRoomScreeningStatus[] = [...rooms.entries()].map(([sketchId, room]) => ({
			sketchId,
			screening: screeningFor(room, resolved),
			liveConfirmed: source !== null && sameSource(room.confirmedSource, source),
			serverScreening: room.server?.screening ?? null,
			serverSince: room.server?.since ?? null,
		}));
		return {
			consent,
			source,
			...(isSourceInfo(resolved)
				? {}
				: {
						sourceProblem:
							resolved.status === 'off' ? 'The prompt-injection screen is off.' : resolved.reason,
					}),
			sourceCovered: source !== null && consentCoversSource(consent, source),
			rooms: roomRows,
		};
	}

	async function grantConsent(
		engine: SketchCloudEngine,
		host?: string
	): Promise<SketchScreeningConsentStatus> {
		requireEnabled();
		requireEngine(engine);
		const resolved = await resolveSource();
		let boundHost = host;
		if (engine === 'openjev' && !boundHost) {
			if (!isSourceInfo(resolved) || resolved.kind !== 'openjev' || !resolved.host) {
				throw new Error(
					'OpenJev consent is bound to a server host. Set OpenJev as the System One engine first (Settings > Models > System One).'
				);
			}
			boundHost = resolved.host;
		}
		writeConsent(withConsentGranted(getConsent(), engine, now(), boundHost));
		logger.info(`Cloud screening consent granted for ${sketchCloudEngineLabel(engine)}`, LOG_CTX, {
			engine,
			...(boundHost ? { host: boundHost } : {}),
		});
		// The grant is the conductor's explicit confirmation of this engine.
		if (isSourceInfo(resolved) && cloudEngineOfSource(resolved) === engine) {
			confirmLiveRooms(resolved);
		}
		announce(resolved);
		return status();
	}

	async function requestGrant(
		engine: SketchCloudEngine,
		caller: { fromAgent?: string } = {}
	): Promise<SketchScreeningConsentStatus> {
		requireEnabled();
		requireEngine(engine);
		if (caller.fromAgent) {
			const resolved = await resolveSource();
			const host =
				isSourceInfo(resolved) && cloudEngineOfSource(resolved) === engine
					? resolved.host
					: undefined;
			const allowed = await confirm({
				engine,
				...(host ? { host } : {}),
				reason: 'grant',
				requestedBy: caller.fromAgent,
			});
			if (!allowed) {
				throw new Error(
					`The conductor did not allow cloud screening on ${sketchCloudEngineLabel(engine)}. Nothing was changed.`
				);
			}
		}
		return grantConsent(engine);
	}

	async function revokeConsent(engine: SketchCloudEngine): Promise<SketchScreeningConsentStatus> {
		requireEnabled();
		requireEngine(engine);
		writeConsent(withConsentRevoked(getConsent(), engine));
		logger.info(`Cloud screening consent revoked for ${sketchCloudEngineLabel(engine)}`, LOG_CTX);
		await handleConsentChanged();
		return status();
	}

	async function confirmCloudScreening(): Promise<boolean> {
		requireEnabled();
		const resolved = await resolveSource();
		if (!isSourceInfo(resolved)) return false;
		const engine = cloudEngineOfSource(resolved);
		if (!engine) return false;
		const covered = consentCoversSource(getConsent(), resolved);
		const allowed = await confirm({
			engine,
			...(resolved.host ? { host: resolved.host } : {}),
			reason: covered ? 'live-switch' : 'grant',
		});
		if (!allowed) {
			logger.info('Cloud screening confirmation declined', LOG_CTX, { engine });
			return false;
		}
		// Read again: the engine may have changed while the dialog was open.
		const current = await resolveSource();
		if (!isSourceInfo(current) || !sameSource(current, resolved)) {
			announce(current);
			return false;
		}
		if (!covered) writeConsent(withConsentGranted(getConsent(), engine, now(), resolved.host));
		confirmLiveRooms(resolved);
		announce(resolved);
		return true;
	}

	async function roomScreening(sketchId: string): Promise<Screening> {
		requireSketchId(sketchId);
		if (!isEnabled()) return 'local';
		return screeningFor(rooms.get(sketchId), await resolveSource());
	}

	async function setRoomLive(sketchId: string, live: boolean): Promise<Screening> {
		requireSketchId(sketchId);
		if (!live) {
			rooms.delete(sketchId);
			return 'local';
		}
		const resolved = await resolveSource();
		let room = rooms.get(sketchId);
		if (!room?.joined) {
			// A room that joins with a covered cloud engine in force is the first use
			// the consent answered (G2); an engine change after this point asks again.
			const covered =
				isSourceInfo(resolved) &&
				resolved.locality === 'cloud' &&
				consentCoversSource(getConsent(), resolved);
			room = {
				joined: true,
				confirmedSource: covered ? resolved : null,
				server: room?.server ?? null,
			};
			rooms.set(sketchId, room);
		}
		lastSourceKey ??= keyOf(resolved);
		announce(resolved);
		return isEnabled() ? screeningFor(room, resolved) : 'local';
	}

	function reportServerScreening(
		sketchId: string,
		screening: Screening,
		since: number | null
	): void {
		requireSketchId(sketchId);
		if (!SCREENINGS.includes(screening)) {
			throw new Error(`Sketch Book: screening must be local or cloud, not ${String(screening)}.`);
		}
		const validSince = typeof since === 'number' && Number.isFinite(since) ? since : null;
		let room = rooms.get(sketchId);
		if (!room) {
			// The echo can arrive before the room client reports the join.
			room = { joined: false, confirmedSource: null, server: null };
			rooms.set(sketchId, room);
		}
		room.server = { screening, since: validSince };
	}

	async function runRefresh(): Promise<void> {
		try {
			const resolved = await resolveSource();
			const key = keyOf(resolved);
			const changed = lastSourceKey !== undefined && key !== lastSourceKey;
			lastSourceKey = key;
			if (rooms.size === 0) return;
			if (changed) {
				// G3: the engine changed while rooms are live. Every room asks again.
				for (const room of rooms.values()) room.confirmedSource = null;
				logger.info('Screening source changed while a room is live: confirmation cleared', LOG_CTX);
			}
			announce(resolved);
		} finally {
			pendingChanges = Math.max(0, pendingChanges - 1);
		}
	}

	function refresh(): Promise<void> {
		pendingChanges += 1;
		refreshChain = refreshChain.then(runRefresh).catch((error) => {
			void captureException(error, { operation: 'sketch:refreshCloudScreening' });
		});
		return refreshChain;
	}

	async function handleConsentChanged(): Promise<void> {
		const consent = getConsent();
		for (const room of rooms.values()) {
			if (room.confirmedSource && !consentCoversSource(consent, room.confirmedSource)) {
				room.confirmedSource = null;
			}
		}
		if (rooms.size === 0) return;
		announce(await resolveSource());
	}

	return {
		hasConsent: (source) => consentCoversSource(getConsent(), source),
		isCloudScreeningAllowed(sketchId, source) {
			if (source.locality === 'local') return true;
			if (!isEnabled() || pendingChanges > 0) return false;
			if (!consentCoversSource(getConsent(), source)) return false;
			const room = rooms.get(sketchId);
			if (!room || !sameSource(room.confirmedSource, source)) return false;
			return room.server?.screening === 'cloud' && room.server.since !== null;
		},
		cloudScreeningSince(sketchId) {
			const server = rooms.get(sketchId)?.server;
			return server?.screening === 'cloud' ? server.since : null;
		},
		getConsent,
		grantConsent,
		requestGrant,
		revokeConsent,
		confirmCloudScreening,
		roomScreening,
		setRoomLive,
		reportServerScreening,
		refresh,
		handleConsentChanged,
		status,
		reset: () => {
			rooms.clear();
			lastSourceKey = undefined;
		},
	};
}

let defaultConsent: SketchCloudConsent | null = null;
let publishToWindows: SafeSendFn | null = null;

/** The app's consent module. */
export function getSketchCloudConsent(): SketchCloudConsent {
	defaultConsent ??= createSketchCloudConsent({
		publish: (change) => publishToWindows?.(SKETCH_SCREENING_CHANGED_CHANNEL, change),
	});
	return defaultConsent;
}

/**
 * Register the consent module as the guardrail's cloud policy and follow the
 * Local Models assignments, the System One engine and the consent setting.
 * Returns the stop. A change written by another process is the settings
 * watcher's to report, through {@link refreshSketchCloudScreening}.
 */
export function startSketchCloudConsent(options: {
	settingsStore?: Store<MaestroSettings>;
	safeSend?: SafeSendFn;
}): () => void {
	publishToWindows = options.safeSend ?? null;
	const consent = getSketchCloudConsent();
	setSketchCloudScreeningPolicy(consent);
	const store = options.settingsStore ?? getSettingsStore();
	const offAssignments = store.onDidChange('localModelAssignments', () => void consent.refresh());
	const offConsent = store.onDidChange(
		SKETCH_BOOK_SETTINGS_KEY,
		() =>
			void consent.handleConsentChanged().catch((error) => {
				void captureException(error, { operation: 'sketch:consentChanged' });
			})
	);
	const offSystemOne = onSystemOneChanged(() => void consent.refresh());
	return () => {
		offAssignments();
		offConsent();
		offSystemOne();
		setSketchCloudScreeningPolicy(null);
		publishToWindows = null;
	};
}

/** Re-read the screen's source after an outside write (`maestro-cli models assign`, a hand edit). */
export function refreshSketchCloudScreening(): void {
	if (!defaultConsent) return;
	void defaultConsent.refresh();
	void defaultConsent.handleConsentChanged().catch((error) => {
		void captureException(error, { operation: 'sketch:consentChanged' });
	});
}
