/**
 * Tests for the Dataview preload API (`window.maestro.dataview`): one request object per channel, and a
 * `dataview:changed` subscription that hands over the event and unsubscribes cleanly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createDataviewApi } from '../../../main/preload/dataview';

describe('Dataview Preload API', () => {
	let api: ReturnType<typeof createDataviewApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createDataviewApi();
	});

	it('sends a block query as one request object', async () => {
		const request = { filePath: '/vault/A.md', source: 'LIST', agentId: 'agent-1' };
		mockInvoke.mockResolvedValue({ root: '/vault', revision: 1, result: { kind: 'list' } });
		await api.query(request);
		expect(mockInvoke).toHaveBeenCalledWith('dataview:query', request);
	});

	it('sends an inline query as one request object', async () => {
		const request = { filePath: '/vault/A.md', expression: '= 1 + 1', agentId: 'agent-1' };
		await api.queryInline(request);
		expect(mockInvoke).toHaveBeenCalledWith('dataview:queryInline', request);
	});

	it('asks for every open root when status gets no request', async () => {
		await api.status();
		expect(mockInvoke).toHaveBeenCalledWith('dataview:status', {});
		await api.status({ root: '/vault' });
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:status', { root: '/vault' });
	});

	it('rebuilds a root', async () => {
		await api.rebuild({ root: '/vault', agentId: 'agent-1' });
		expect(mockInvoke).toHaveBeenCalledWith('dataview:rebuild', {
			root: '/vault',
			agentId: 'agent-1',
		});
	});

	it('subscribes to dataview:changed and unsubscribes the same listener', () => {
		const handler = vi.fn();
		const unsubscribe = api.onChanged(handler);

		expect(mockOn).toHaveBeenCalledWith('dataview:changed', expect.any(Function));
		const listener = mockOn.mock.calls[0][1] as (event: unknown, change: unknown) => void;
		const change = { root: '/vault', sshRemoteId: null, revision: 2, changedPaths: ['A.md'] };
		listener({}, change);
		expect(handler).toHaveBeenCalledWith(change);

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('dataview:changed', listener);
	});
});
