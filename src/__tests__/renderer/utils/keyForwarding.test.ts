/**
 * forwardKeyToMainHandler: a swallowed keystroke reaches `window` as a
 * cancelable keydown carrying the fields a shortcut match reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardKeyToMainHandler } from '../../../renderer/utils/keyForwarding';

describe('forwardKeyToMainHandler', () => {
	const listener = vi.fn();

	afterEach(() => {
		window.removeEventListener('keydown', listener);
		listener.mockClear();
	});

	it('dispatches a copy of the key on window', () => {
		window.addEventListener('keydown', listener);

		forwardKeyToMainHandler({
			key: 'k',
			code: 'KeyK',
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
		});

		expect(listener).toHaveBeenCalledTimes(1);
		const event = listener.mock.calls[0][0] as KeyboardEvent;
		expect((event.target as Window).document).toBe(document);
		expect(event).toMatchObject({
			type: 'keydown',
			key: 'k',
			code: 'KeyK',
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
			cancelable: true,
		});
	});
});
