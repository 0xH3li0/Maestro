/**
 * Sketch Book presence on sleep, wake and quit (spec section 5, wire contract
 * obligation 5): main tells every window, which sends the bot frame.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	SKETCH_PRESENCE_CHANNEL,
	createSketchPresence,
} from '../../../main/sketch/sketch-presence';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function setup(enabled = true) {
	const publish = vi.fn();
	const isEnabled = vi.fn(() => enabled);
	return { publish, isEnabled, presence: createSketchPresence({ publish, isEnabled }) };
}

describe('createSketchPresence', () => {
	it('pushes offline on suspend and online on resume to every window', () => {
		const { publish, presence } = setup();

		presence.suspend();
		presence.resume();

		expect(publish.mock.calls).toEqual([
			[SKETCH_PRESENCE_CHANNEL, { online: false, reason: 'suspend' }],
			[SKETCH_PRESENCE_CHANNEL, { online: true, reason: 'resume' }],
		]);
	});

	it('pushes offline once on quit and never online again', () => {
		const { publish, presence } = setup();

		presence.quit();
		presence.quit();
		presence.resume();
		presence.suspend();

		expect(publish.mock.calls).toEqual([
			[SKETCH_PRESENCE_CHANNEL, { online: false, reason: 'quit' }],
		]);
	});

	it('sends nothing while Sketch Book is off', () => {
		const { publish, presence } = setup(false);

		presence.suspend();
		presence.resume();
		presence.quit();

		expect(publish).not.toHaveBeenCalled();
	});
});
