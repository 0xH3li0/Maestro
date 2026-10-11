/**
 * @file hands-free.test.ts
 *
 * The always-on wake word behind the Voice Controls toggle. The detector is
 * faked: what is under test is the DECISION - when the microphone opens, when it
 * closes, and what a hit does - not the inference.
 *
 * The bug this exists for: the toggle was persisted and read by nothing, so
 * switching it on opened no microphone and saying the phrase did nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import {
	HandsFreeListener,
	type HandsFreeDeps,
	type HandsFreeSettings,
} from '../../../../main/acappella/wake/hands-free';
import type {
	WakeDetection,
	WakeDetector,
	WakeDetectorOptions,
} from '../../../../main/acappella/wake/wake-detector';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';

/** A detector that arms on start and fires when the test says so. */
function fakeDetector(armed = true) {
	const created: Array<{ options: WakeDetectorOptions; detector: WakeDetector }> = [];
	const create = (options: WakeDetectorOptions): WakeDetector => {
		let running = false;
		const detector = {
			start: vi.fn(async () => {
				running = true;
			}),
			stop: vi.fn(async () => {
				running = false;
			}),
			pushFrame: vi.fn(),
			get isArmed() {
				return running && armed;
			},
		} as unknown as WakeDetector;
		created.push({ options, detector });
		return detector;
	};
	const fire = (index = created.length - 1) => {
		const detection: WakeDetection = {
			phraseId: 'global',
			phrase: 'hey jarvis',
			scope: { kind: 'conductor' },
			score: 0.9,
			at: 0,
			preRoll: [],
		} as unknown as WakeDetection;
		created[index].options.onWake(detection);
	};
	return { create, created, fire };
}

function harness(overrides: Partial<HandsFreeDeps> = {}, armed = true) {
	const settings: HandsFreeSettings = { enabled: true, phrase: 'hey jarvis' };
	let state: VoiceSessionState = 'idle';
	const detectors = fakeDetector(armed);
	const deps: HandsFreeDeps = {
		readSettings: () => settings,
		canRunHandsFree: vi.fn(async () => true),
		getSessionState: () => state,
		startSession: vi.fn(async () => {
			state = 'listening';
		}),
		ensureAudioHost: vi.fn(),
		requestMicPermission: vi.fn(async () => 'granted'),
		startCapture: vi.fn(),
		stopCapture: vi.fn(),
		createDetector: detectors.create,
		...overrides,
	};
	return {
		listener: new HandsFreeListener(deps),
		deps,
		settings,
		detectors,
		setState: (next: VoiceSessionState) => {
			state = next;
		},
	};
}

describe('HandsFreeListener', () => {
	beforeEach(() => vi.clearAllMocks());

	it('opens the microphone and listens when the toggle is on and the phrase can fire', async () => {
		const { listener, deps } = harness();

		await listener.sync();

		expect(listener.isListening).toBe(true);
		expect(deps.ensureAudioHost).toHaveBeenCalled();
		expect(deps.startCapture).toHaveBeenCalledTimes(1);
	});

	it('opens nothing while the toggle is off', async () => {
		const { listener, deps, settings } = harness();
		settings.enabled = false;

		await listener.sync();

		expect(listener.isListening).toBe(false);
		expect(deps.startCapture).not.toHaveBeenCalled();
		expect(deps.requestMicPermission).not.toHaveBeenCalled();
	});

	it('does not hold a microphone open for a phrase the gate says cannot fire', async () => {
		const { listener, deps } = harness({ canRunHandsFree: vi.fn(async () => false) });

		await listener.sync();

		expect(listener.isListening).toBe(false);
		expect(deps.startCapture).not.toHaveBeenCalled();
	});

	it('does not hold a microphone open when the model will not load', async () => {
		const { listener, deps } = harness({}, false);

		await listener.sync();

		expect(listener.isListening).toBe(false);
		expect(deps.startCapture).not.toHaveBeenCalled();
	});

	it('closes the microphone when the toggle is switched off', async () => {
		const { listener, deps, settings } = harness();
		await listener.sync();

		settings.enabled = false;
		await listener.sync();

		expect(listener.isListening).toBe(false);
		expect(deps.stopCapture).toHaveBeenCalledTimes(1);
	});

	it('opens a wake-word session on a hit, keeping the microphone open for it', async () => {
		const { listener, deps, detectors } = harness();
		await listener.sync();

		detectors.fire();
		await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalledTimes(1));

		expect(listener.isListening).toBe(false);
		// The session takes over the stream already flowing; closing it here would
		// drop the user's first words.
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});

	it('re-arms once the session it opened has ended', async () => {
		const { listener, deps, detectors, setState } = harness();
		await listener.sync();
		detectors.fire();
		await vi.waitFor(() => expect(deps.startSession).toHaveBeenCalledTimes(1));

		setState('idle');
		void listener.sync();

		// A sync already in flight (the one the wake queued) folds this request into
		// a follow-up pass, so the re-arm lands a tick later rather than synchronously.
		await vi.waitFor(() => expect(listener.isListening).toBe(true));
		expect(detectors.created).toHaveLength(2);
	});

	it('re-arms when the session it tried to open was refused', async () => {
		const { listener, detectors } = harness({
			startSession: vi.fn(async () => {
				throw new Error('readiness refused');
			}),
		});
		await listener.sync();

		detectors.fire();

		// Deaf after a refused start is the failure mode to avoid.
		await vi.waitFor(() => expect(detectors.created).toHaveLength(2));
		await vi.waitFor(() => expect(listener.isListening).toBe(true));
	});

	it('lends the microphone to the Test button and takes it back', async () => {
		const { listener, deps } = harness();
		await listener.sync();

		await listener.suspend();
		expect(listener.isListening).toBe(false);
		expect(deps.stopCapture).toHaveBeenCalledTimes(1);

		await listener.resume();
		expect(listener.isListening).toBe(true);
	});

	it('re-requests capture when the audio host finishes booting', async () => {
		const { listener, deps } = harness();
		await listener.sync();

		listener.onAudioHostReady();

		expect(deps.startCapture).toHaveBeenCalledTimes(2);
	});

	it('feeds frames to the armed detector only', async () => {
		const { listener, detectors } = harness();
		listener.pushFrame(new Int16Array(320));
		await listener.sync();

		listener.pushFrame(new Int16Array(320));

		expect(detectors.created[0].detector.pushFrame).toHaveBeenCalledTimes(1);
	});
});
