/**
 * Sketch Book cloud screening consent (spec section 8.10, G2 to G4): a local
 * source is always allowed; a cloud source needs the stored consent for that
 * engine (OpenJev bound to its host), the conductor's live confirmation for
 * the room, and the server's `cloud` echo with a `since`. A live switch to
 * cloud clears the confirmation (G3), `off` reports `local`, and a revoke is
 * read on the next check.
 *
 * Everything the module reads is injected (settings, source, confirmation),
 * so these run against an in-memory setting and a source the test sets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
	dialog: { showMessageBox: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => {
		throw new Error('the consent tests inject every store read');
	},
}));
vi.mock('../../../main/local-models/injection-screen', () => ({
	resolveInjectionSource: vi.fn(() => {
		throw new Error('the consent tests inject resolveSource');
	}),
}));
vi.mock('../../../main/local-models/system-one/service', () => ({
	onSystemOneChanged: vi.fn(() => () => {}),
}));
vi.mock('../../../main/sketch/sketch-guardrail', () => ({
	setSketchCloudScreeningPolicy: vi.fn(),
}));

import {
	createSketchCloudConsent,
	type SketchCloudConfirmPrompt,
	type SketchCloudConsent,
} from '../../../main/sketch/sketch-cloud-consent';
import type {
	InjectionSourceInfo,
	InjectionSourceResolution,
} from '../../../shared/local-models/injection-screen';
import type { SketchScreeningChange } from '../../../shared/sketch/cloud-consent';

const LOCAL: InjectionSourceInfo = {
	kind: 'local-classifier',
	locality: 'local',
	label: 'Prompt Guard 2 22M',
};
const JEV: InjectionSourceInfo = {
	kind: 'jev',
	locality: 'cloud',
	host: 'api.typesafe.ai',
	label: 'Jev (TypeSafe cloud)',
};
const openJev = (host: string): InjectionSourceInfo => ({
	kind: 'openjev',
	locality: 'cloud',
	host,
	label: `OpenJev (${host})`,
});

const SKETCH = 'sketch-1';
const SINCE = 1_700_000_000_000;

let settings: Record<string, unknown>;
let source: InjectionSourceResolution;
let confirmAnswer: boolean;
let prompts: SketchCloudConfirmPrompt[];
let changes: SketchScreeningChange[];
let consent: SketchCloudConsent;

function build(): SketchCloudConsent {
	return createSketchCloudConsent({
		readSettings: () => settings,
		writeConsent: (next) => {
			settings = { ...settings, cloudScreenConsent: next };
		},
		resolveSource: async () => source,
		confirm: async (prompt) => {
			prompts.push(prompt);
			return confirmAnswer;
		},
		isEnabled: () => true,
		publish: (change) => changes.push(change),
		now: () => 42,
	});
}

/** A live room whose server echoed `cloud`. */
async function liveCloudRoom(sketchId = SKETCH): Promise<void> {
	await consent.setRoomLive(sketchId, true);
	consent.reportServerScreening(sketchId, 'cloud', SINCE);
}

beforeEach(() => {
	settings = {};
	source = LOCAL;
	confirmAnswer = true;
	prompts = [];
	changes = [];
	consent = build();
});

describe('local sources', () => {
	it('always allows a local source, with no consent, room or echo', async () => {
		expect(consent.isCloudScreeningAllowed(SKETCH, LOCAL)).toBe(true);
		expect(
			consent.isCloudScreeningAllowed(SKETCH, { ...LOCAL, kind: 'local-judge', label: 'Judge' })
		).toBe(true);
		expect(consent.hasConsent(LOCAL)).toBe(true);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
	});

	it('reports local for a screen that is off or unavailable', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = { status: 'off' };
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
		await expect(consent.setRoomLive(SKETCH, true)).resolves.toBe('local');
		expect(changes.at(-1)?.rooms).toEqual([{ sketchId: SKETCH, screening: 'local' }]);
		expect(changes.at(-1)?.confirmNeeded).toBeUndefined();

		source = { status: 'unavailable', reason: 'System One has no engine chosen.' };
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
	});
});

describe('Jev', () => {
	it('refuses Jev without a stored consent, even with a live room and an echo', async () => {
		source = JEV;
		await liveCloudRoom();
		expect(consent.hasConsent(JEV)).toBe(false);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
		expect(changes.at(-1)?.confirmNeeded).toEqual({
			engine: 'jev',
			host: 'api.typesafe.ai',
			reason: 'grant',
		});
	});

	it('refuses Jev with consent and a live confirmation until the server echoes cloud', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		await expect(consent.setRoomLive(SKETCH, true)).resolves.toBe('cloud');
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		expect(consent.cloudScreeningSince(SKETCH)).toBeNull();

		// An echo that still says local does not open the room either.
		consent.reportServerScreening(SKETCH, 'local', SINCE);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);

		// A cloud echo with no since leaves H1 without a bound.
		consent.reportServerScreening(SKETCH, 'cloud', null);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
	});

	it('allows Jev with consent, the live confirmation and the cloud echo, and records since', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		await liveCloudRoom();
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);
		expect(consent.cloudScreeningSince(SKETCH)).toBe(SINCE);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('cloud');

		// Another room the conductor never opened is not allowed.
		expect(consent.isCloudScreeningAllowed('sketch-2', JEV)).toBe(false);
	});

	it('accepts an echo that arrives before the room reports its join', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		consent.reportServerScreening(SKETCH, 'cloud', SINCE);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		await consent.setRoomLive(SKETCH, true);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);
	});

	it('refuses a run whose source differs from the one the room confirmed', async () => {
		settings = {
			cloudScreenConsent: {
				jev: { grantedAt: 1 },
				openjev: { host: 'jev.example.com', grantedAt: 1 },
			},
		};
		source = JEV;
		await liveCloudRoom();
		expect(consent.isCloudScreeningAllowed(SKETCH, openJev('jev.example.com'))).toBe(false);
	});
});

describe('a live switch to cloud (G3)', () => {
	it('refuses after a switch from local to Jev while a room is live, even with a stored consent', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = LOCAL;
		await liveCloudRoom();
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');

		source = JEV;
		await consent.refresh();
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
		expect(changes.at(-1)?.confirmNeeded).toEqual({
			engine: 'jev',
			host: 'api.typesafe.ai',
			reason: 'live-switch',
		});

		// The conductor confirms: the room may use Jev once the server echoes cloud.
		await expect(consent.confirmCloudScreening()).resolves.toBe(true);
		expect(prompts.at(-1)).toEqual({
			engine: 'jev',
			host: 'api.typesafe.ai',
			reason: 'live-switch',
		});
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('cloud');
		expect(changes.at(-1)?.confirmNeeded).toBeUndefined();
	});

	it('clears a confirmation the room already had when the engine leaves and comes back', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		await liveCloudRoom();
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);

		source = LOCAL;
		await consent.refresh();
		source = JEV;
		await consent.refresh();
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		const room = (await consent.status()).rooms[0];
		expect(room).toMatchObject({ sketchId: SKETCH, liveConfirmed: false, screening: 'local' });
	});

	it('stays refused when the conductor declines the confirmation', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		await liveCloudRoom();
		source = JEV;
		await consent.refresh();
		confirmAnswer = false;
		await expect(consent.confirmCloudScreening()).resolves.toBe(false);
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
	});

	it('holds every cloud check while a change is being read back', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		let releaseRefresh!: () => void;
		const pending = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let reads = 0;
		const pausing = createSketchCloudConsent({
			readSettings: () => settings,
			resolveSource: async () => {
				reads += 1;
				if (reads > 1) await pending;
				return source;
			},
			isEnabled: () => true,
		});
		await pausing.setRoomLive(SKETCH, true);
		pausing.reportServerScreening(SKETCH, 'cloud', SINCE);
		expect(pausing.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);
		const refreshing = pausing.refresh();
		expect(pausing.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		releaseRefresh();
		await refreshing;
		expect(pausing.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);
	});
});

describe('OpenJev', () => {
	it('binds the consent to its host: a new host is not covered', async () => {
		source = openJev('jev.example.com');
		await consent.grantConsent('openjev');
		expect(settings.cloudScreenConsent).toEqual({
			openjev: { host: 'jev.example.com', grantedAt: 42 },
		});
		await liveCloudRoom();
		expect(consent.isCloudScreeningAllowed(SKETCH, openJev('jev.example.com'))).toBe(true);
		// Host matching ignores case.
		expect(consent.hasConsent(openJev('JEV.example.com'))).toBe(true);

		const moved = openJev('other.example.net');
		source = moved;
		await consent.refresh();
		expect(consent.hasConsent(moved)).toBe(false);
		expect(consent.isCloudScreeningAllowed(SKETCH, moved)).toBe(false);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
		expect(changes.at(-1)?.confirmNeeded).toEqual({
			engine: 'openjev',
			host: 'other.example.net',
			reason: 'grant',
		});
		expect((await consent.status()).sourceCovered).toBe(false);
	});

	it('never covers an OpenJev source with no host', () => {
		settings = { cloudScreenConsent: { openjev: { host: 'jev.example.com', grantedAt: 1 } } };
		const hostless: InjectionSourceInfo = { kind: 'openjev', locality: 'cloud', label: 'OpenJev' };
		expect(consent.hasConsent(hostless)).toBe(false);
	});

	it('refuses an OpenJev grant with no host when OpenJev is not the engine in force', async () => {
		source = JEV;
		await expect(consent.grantConsent('openjev')).rejects.toThrow(/bound to a server host/);
		expect(settings.cloudScreenConsent).toBeUndefined();
	});
});

describe('revoke', () => {
	it('takes effect on the next call', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		await liveCloudRoom();
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(true);

		const status = await consent.revokeConsent('jev');
		expect(status.consent).toEqual({});
		expect(consent.getConsent()).toEqual({});
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
		await expect(consent.roomScreening(SKETCH)).resolves.toBe('local');
		expect(changes.at(-1)?.rooms).toEqual([{ sketchId: SKETCH, screening: 'local' }]);
	});

	it('drops the live confirmation on an outside consent change', async () => {
		settings = { cloudScreenConsent: { jev: { grantedAt: 1 } } };
		source = JEV;
		await liveCloudRoom();
		settings = {};
		await consent.handleConsentChanged();
		// A fresh grant does not bring the old confirmation back by itself.
		settings = { cloudScreenConsent: { jev: { grantedAt: 2 } } };
		expect(consent.isCloudScreeningAllowed(SKETCH, JEV)).toBe(false);
	});
});

describe('the CLI grant (A1)', () => {
	it('asks the conductor when an agent asks, and stores nothing on a no', async () => {
		source = JEV;
		confirmAnswer = false;
		await expect(consent.requestGrant('jev', { fromAgent: 'agent-7' })).rejects.toThrow(
			/did not allow/
		);
		expect(prompts).toEqual([
			{ engine: 'jev', host: 'api.typesafe.ai', reason: 'grant', requestedBy: 'agent-7' },
		]);
		expect(settings.cloudScreenConsent).toBeUndefined();

		confirmAnswer = true;
		const status = await consent.requestGrant('jev', { fromAgent: 'agent-7' });
		expect(status.consent).toEqual({ jev: { grantedAt: 42 } });
	});

	it('grants without the desktop dialog for a person at the terminal', async () => {
		source = JEV;
		await consent.requestGrant('jev');
		expect(prompts).toEqual([]);
		expect(consent.getConsent()).toEqual({ jev: { grantedAt: 42 } });
	});
});
