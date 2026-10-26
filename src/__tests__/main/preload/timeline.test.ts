/**
 * Timeline preload API.
 *
 * A verb pointed at the wrong channel, or one that drops an argument, fails
 * silently: the promise resolves and the system prompt reads an empty timeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createTimelineApi } from '../../../main/preload/timeline';

describe('Timeline Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('exposes exactly read', () => {
		expect(Object.keys(createTimelineApi())).toEqual(['read']);
	});

	it('reads with the agent id and options in order', async () => {
		mockInvoke.mockResolvedValueOnce([]);
		const options = { sinceMs: 1, tail: 15, perSourceTail: 8 };
		await expect(createTimelineApi().read('a1', options)).resolves.toEqual([]);
		expect(mockInvoke).toHaveBeenCalledWith('timeline:read', 'a1', options);
	});
});
