/**
 * Sketch Book cloud screening consent (spec section 8.10, G2 to G4): the
 * stored setting, what it covers, and the words a person reads before guest
 * text leaves the machine.
 *
 * The consent protects the conductor (they chose the third party). It is
 * stored per engine in `sketchBook.cloudScreenConsent`; an OpenJev consent is
 * bound to the server host it was given for, so a new URL asks again. The
 * per-room flag that protects guests lives in main
 * (`src/main/sketch/sketch-cloud-consent.ts`).
 *
 * Bundled into the renderer and the CLI, so it imports nothing from Electron
 * or Node.
 */

import type { InjectionSourceInfo } from '../local-models/injection-screen';
import type { Screening } from './protocol';
import {
	normalizeSketchServerUrl,
	SKETCH_SERVER_URL_FIELD,
	sketchServerUrlProblem,
} from './server';

/** The Sketch Book settings object. */
export const SKETCH_BOOK_SETTINGS_KEY = 'sketchBook';

/** The field of {@link SKETCH_BOOK_SETTINGS_KEY} that holds the consent. */
export const SKETCH_CLOUD_SCREEN_CONSENT_FIELD = 'cloudScreenConsent';

/** The dotted setting path, as `maestro-cli settings` and the spec name it. */
export const SKETCH_CLOUD_SCREEN_CONSENT_SETTING = `${SKETCH_BOOK_SETTINGS_KEY}.${SKETCH_CLOUD_SCREEN_CONSENT_FIELD}`;

/** A System One engine that sends text off this machine. */
export type SketchCloudEngine = 'jev' | 'openjev';
export const SKETCH_CLOUD_ENGINES: readonly SketchCloudEngine[] = ['jev', 'openjev'];

/** One engine's consent. `grantedAt` is ms since the epoch. */
export interface SketchJevConsent {
	grantedAt: number;
}

/** OpenJev consent, bound to the host it was given for (G2). */
export interface SketchOpenJevConsent {
	host: string;
	grantedAt: number;
}

/** `sketchBook.cloudScreenConsent` (spec section 8.10, G2). */
export interface SketchCloudScreenConsent {
	jev?: SketchJevConsent;
	openjev?: SketchOpenJevConsent;
}

/** The whole `sketchBook` setting. */
export interface SketchBookSettings {
	cloudScreenConsent?: SketchCloudScreenConsent;
	/** A dev override of the Sketch Book server, for a local `wrangler dev` (`./server`). */
	serverUrl?: string;
}

export function isSketchCloudEngine(value: unknown): value is SketchCloudEngine {
	return typeof value === 'string' && (SKETCH_CLOUD_ENGINES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGrantedAt(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The stored consent with anything malformed dropped. A hand-edited or
 * corrupt value never reads as a consent: an entry without a valid
 * `grantedAt`, or an OpenJev entry without a host, is no consent at all.
 */
export function normalizeSketchCloudScreenConsent(raw: unknown): SketchCloudScreenConsent {
	if (!isRecord(raw)) return {};
	const consent: SketchCloudScreenConsent = {};
	const jev = raw.jev;
	if (isRecord(jev) && isGrantedAt(jev.grantedAt)) {
		consent.jev = { grantedAt: jev.grantedAt };
	}
	const openjev = raw.openjev;
	if (
		isRecord(openjev) &&
		isGrantedAt(openjev.grantedAt) &&
		typeof openjev.host === 'string' &&
		openjev.host.trim()
	) {
		consent.openjev = { host: openjev.host.trim().toLowerCase(), grantedAt: openjev.grantedAt };
	}
	return consent;
}

/** The whole `sketchBook` setting, normalized. */
export function normalizeSketchBookSettings(raw: unknown): SketchBookSettings {
	const consent = normalizeSketchCloudScreenConsent(
		isRecord(raw) ? raw[SKETCH_CLOUD_SCREEN_CONSENT_FIELD] : undefined
	);
	const serverUrl = normalizeSketchServerUrl(
		isRecord(raw) ? raw[SKETCH_SERVER_URL_FIELD] : undefined
	);
	return {
		...(Object.keys(consent).length > 0 ? { cloudScreenConsent: consent } : {}),
		...(serverUrl ? { serverUrl } : {}),
	};
}

/** The cloud engine a screen source runs on, or null for a local source. */
export function cloudEngineOfSource(source: InjectionSourceInfo): SketchCloudEngine | null {
	if (source.locality !== 'cloud') return null;
	if (source.kind === 'jev') return 'jev';
	if (source.kind === 'openjev') return 'openjev';
	return null;
}

/**
 * Whether a stored consent covers this source. A local source needs none. An
 * OpenJev source is covered only by a consent for the same host; a source
 * with no host is never covered (nobody consented to an unnamed server).
 */
export function consentCoversSource(
	consent: SketchCloudScreenConsent,
	source: InjectionSourceInfo
): boolean {
	if (source.locality === 'local') return true;
	const engine = cloudEngineOfSource(source);
	if (engine === 'jev') return consent.jev !== undefined;
	if (engine === 'openjev') {
		const host = source.host?.trim().toLowerCase();
		return Boolean(host && consent.openjev && consent.openjev.host === host);
	}
	return false;
}

/**
 * The consent with one engine granted. OpenJev needs the host it is for; a
 * new grant replaces an older one (and its host).
 */
export function withConsentGranted(
	consent: SketchCloudScreenConsent,
	engine: SketchCloudEngine,
	grantedAt: number,
	host?: string
): SketchCloudScreenConsent {
	if (engine === 'jev') return { ...consent, jev: { grantedAt } };
	const boundHost = host?.trim().toLowerCase();
	if (!boundHost) {
		throw new Error('OpenJev consent is bound to a server host, and none was given.');
	}
	return { ...consent, openjev: { host: boundHost, grantedAt } };
}

/** The consent with one engine revoked. */
export function withConsentRevoked(
	consent: SketchCloudScreenConsent,
	engine: SketchCloudEngine
): SketchCloudScreenConsent {
	const next = { ...consent };
	delete next[engine];
	return next;
}

/** What a source key looks like: kind plus host, so an OpenJev host change is a new source. */
export function screenSourceKey(source: InjectionSourceInfo): string {
	return `${source.kind}|${source.host?.trim().toLowerCase() ?? ''}`;
}

/** How a cloud engine is named to a person. */
export function sketchCloudEngineLabel(engine: SketchCloudEngine): string {
	return engine === 'jev' ? 'Jev (TypeSafe cloud)' : 'OpenJev';
}

/**
 * The G2 disclosure: the provider, its host, and what leaves the machine. One
 * copy, so the desktop dialog, the CLI prompt and the Settings row say the
 * same thing.
 */
export function sketchCloudScreeningDisclosure(input: {
	engine: SketchCloudEngine;
	host?: string;
	/** Why the question is asked: a first use, or an engine change while a room is live (G3). */
	reason?: 'grant' | 'live-switch';
}): { title: string; message: string; detail: string } {
	const provider = sketchCloudEngineLabel(input.engine);
	const where = input.host ? `${provider} at ${input.host}` : provider;
	const title =
		input.reason === 'live-switch'
			? `Sketch Book screening changed to ${provider}`
			: `Screen Sketch Book guests with ${provider}?`;
	const message =
		input.reason === 'live-switch'
			? `The screening engine changed to ${where} while a shared sketch is live. Guest text stays withheld from your agent until you confirm.`
			: `Sketch Book will send guest text to ${where} for its prompt-injection screen.`;
	const detail = [
		`What leaves this computer: decrypted guest chat and canvas text, and your agent's replies before they are posted (the secret screen).`,
		'Secrets are redacted on the way out. Guests are told the room is screened by a cloud service before any of their text is sent.',
		'Revoke it any time in Settings > Plugins > Sketch Book, or with maestro-cli sketch screening-consent revoke.',
	].join('\n\n');
	return { title, message, detail };
}

/** The screening state a CLI read or a Settings row shows. */
export interface SketchScreeningConsentStatus {
	consent: SketchCloudScreenConsent;
	/** The engine in force for the screen, as a person reads it, or null when the screen is off. */
	source: InjectionSourceInfo | null;
	/** Why there is no source (`off` or the unavailable reason). */
	sourceProblem?: string;
	/** Whether the stored consent covers the source in force. */
	sourceCovered: boolean;
	/** Each live room's screening value and the server's confirmation. */
	rooms: SketchRoomScreeningStatus[];
}

/** One live room, as the consent module sees it. */
export interface SketchRoomScreeningStatus {
	sketchId: string;
	/** What the desktop reports for the room now (`screening.set`). */
	screening: Screening;
	/** The conductor confirmed the cloud engine in force while the room is live (G3). */
	liveConfirmed: boolean;
	/** The server's echo (`welcome.screening` or a `screening` frame), or null before one. */
	serverScreening: Screening | null;
	serverSince: number | null;
}

/** The push to every window when a room's screening value or the consent may have changed. */
export interface SketchScreeningChange {
	consent: SketchCloudScreenConsent;
	/** The value each live room should report; the room client sends `screening.set` on a change. */
	rooms: { sketchId: string; screening: Screening }[];
	/**
	 * Set when the engine in force is cloud and a live room needs the conductor
	 * to confirm it (G2 first use, G3 live switch). The renderer raises the
	 * confirmation through `confirmCloudScreening()`.
	 */
	confirmNeeded?: { engine: SketchCloudEngine; host?: string; reason: 'grant' | 'live-switch' };
}

/** Refusal text for a direct settings write: consent is only granted through the confirmation. */
export const SKETCH_CONSENT_SETTINGS_WRITE_MESSAGE = `${SKETCH_CLOUD_SCREEN_CONSENT_SETTING} is granted only with a confirmation. Use "maestro-cli sketch screening-consent grant|revoke --engine jev|openjev".`;

/**
 * Why a `maestro-cli settings set` write under `sketchBook` is refused, or
 * null when allowed. The consent is never written this way: it must pass the
 * confirmation that names the provider and what leaves the machine (G2, A1).
 * `path` is the path under `sketchBook` (empty for the whole object).
 */
export function sketchBookSettingProblem(path: string, value: unknown): string | null {
	const touchesConsent =
		path === SKETCH_CLOUD_SCREEN_CONSENT_FIELD ||
		path.startsWith(`${SKETCH_CLOUD_SCREEN_CONSENT_FIELD}.`) ||
		(path === '' && isRecord(value) && SKETCH_CLOUD_SCREEN_CONSENT_FIELD in value);
	if (touchesConsent) return SKETCH_CONSENT_SETTINGS_WRITE_MESSAGE;
	if (path === SKETCH_SERVER_URL_FIELD) return sketchServerUrlProblem(value);
	if (path === '' && isRecord(value)) {
		const unknownField = Object.keys(value).find(
			(field) => sketchBookSettingPathProblem(field) !== null
		);
		if (unknownField) return sketchBookSettingPathProblem(unknownField);
		return sketchServerUrlProblem(value[SKETCH_SERVER_URL_FIELD]);
	}
	return sketchBookSettingPathProblem(path);
}

/** Why `path` names nothing under `sketchBook`, or null when it does. */
export function sketchBookSettingPathProblem(path: string): string | null {
	if (
		path === '' ||
		path === SKETCH_CLOUD_SCREEN_CONSENT_FIELD ||
		path.startsWith(`${SKETCH_CLOUD_SCREEN_CONSENT_FIELD}.`) ||
		path === SKETCH_SERVER_URL_FIELD
	) {
		return null;
	}
	return `${SKETCH_BOOK_SETTINGS_KEY}.${path} is not a Sketch Book setting. The fields are ${SKETCH_CLOUD_SCREEN_CONSENT_FIELD} and ${SKETCH_SERVER_URL_FIELD}.`;
}
