/**
 * `dataview:*` IPC. Each handler is a pass-through to one DataviewService request method (the CLI's WS
 * verbs call the same methods), and every index change goes out as `dataview:changed` through the
 * all-windows `safeSend` (DV-7). The DataviewJS channels (`jsSnapshot`, `readInRoot`, D4) pass through the
 * same way, and registration wires the guest host's serving check to the service.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { DataviewChangeEvent } from '../../../../shared/dataview';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	changeListeners: [] as Array<(event: unknown) => void>,
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/dataview/dataview-service', () => ({
	getDataviewService: () => h.service,
}));

import { registerDataviewHandlers } from '../../../../main/ipc/handlers/dataview';
import {
	isDataviewJsServing,
	setDataviewJsServingCheck,
} from '../../../../main/dataview/guest-host';

const queryRequest = { filePath: '/vault/People/A.md', source: 'LIST', agentId: 'agent-1' };
const queryResponse = {
	root: '/vault',
	sshRemoteId: null,
	revision: 3,
	path: 'People/A.md',
	result: { kind: 'list', items: [], idMeaning: { type: 'path' }, warnings: [] },
};
const status = {
	root: '/vault',
	sshRemoteId: null,
	pageCount: 2,
	revision: 3,
	lastScanDurationMs: 5,
	lastScanAt: 1,
	cacheHit: false,
	watchMode: 'chokidar',
};

const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);

let safeSend: Mock<(channel: string, ...args: unknown[]) => void>;

beforeEach(() => {
	h.handlers.clear();
	h.changeListeners = [];
	h.service = {
		query: vi.fn(async () => queryResponse),
		queryInline: vi.fn(async () => ({ ...queryResponse, result: { kind: 'value', value: 'A' } })),
		indexStatus: vi.fn(() => [status]),
		rebuildIndex: vi.fn(async () => status),
		jsSnapshot: vi.fn(async () => ({ ...queryResponse, result: { revision: 3, pages: [] } })),
		readInRoot: vi.fn(async () => ({
			root: '/vault',
			sshRemoteId: null,
			path: 'a.csv',
			text: 'x',
		})),
		jsServing: vi.fn(() => true),
		onChange: vi.fn((listener: (event: unknown) => void) => {
			h.changeListeners.push(listener);
			return () => undefined;
		}),
	};
	safeSend = vi.fn<(channel: string, ...args: unknown[]) => void>();
	setDataviewJsServingCheck(() => false);
	registerDataviewHandlers({ safeSend });
});

describe('dataview IPC', () => {
	it('registers the four DQL channels and the two DataviewJS channels', () => {
		expect([...h.handlers.keys()].sort()).toEqual([
			'dataview:jsSnapshot',
			'dataview:query',
			'dataview:queryInline',
			'dataview:readInRoot',
			'dataview:rebuild',
			'dataview:status',
		]);
	});

	it('answers the DataviewJS snapshot and in-root reads through the service', async () => {
		const snapshotRequest = { filePath: '/vault/People/A.md', agentId: 'agent-1' };
		await expect(invoke('dataview:jsSnapshot', snapshotRequest)).resolves.toMatchObject({
			root: '/vault',
			result: { revision: 3 },
		});
		expect(h.service!.jsSnapshot).toHaveBeenCalledWith(snapshotRequest);

		const readRequest = { ...snapshotRequest, path: 'a.csv' };
		await expect(invoke('dataview:readInRoot', readRequest)).resolves.toMatchObject({ text: 'x' });
		expect(h.service!.readInRoot).toHaveBeenCalledWith(readRequest);

		h.service!.readInRoot.mockRejectedValueOnce(new Error('Dataview: ../x is not a path inside'));
		await expect(invoke('dataview:readInRoot', { ...readRequest, path: '../x' })).rejects.toThrow(
			'not a path inside'
		);
	});

	it('wires the guest host to ask the service whether DataviewJS may run', () => {
		expect(isDataviewJsServing()).toBe(true);
		h.service!.jsServing.mockReturnValue(false);
		expect(isDataviewJsServing()).toBe(false);
	});

	it('runs a block through the service and returns its answer unchanged', async () => {
		await expect(invoke('dataview:query', queryRequest)).resolves.toEqual(queryResponse);
		expect(h.service!.query).toHaveBeenCalledWith(queryRequest);
	});

	it('evaluates an inline expression through the service', async () => {
		const request = {
			filePath: '/vault/People/A.md',
			expression: '= this.file.name',
			agentId: 'a',
		};
		await expect(invoke('dataview:queryInline', request)).resolves.toMatchObject({
			result: { kind: 'value', value: 'A' },
		});
		expect(h.service!.queryInline).toHaveBeenCalledWith(request);
	});

	it('reports status for one root or, with no request, every open root', async () => {
		await expect(invoke('dataview:status', { root: '/vault' })).resolves.toEqual([status]);
		expect(h.service!.indexStatus).toHaveBeenLastCalledWith({ root: '/vault' });
		await invoke('dataview:status');
		expect(h.service!.indexStatus).toHaveBeenLastCalledWith({});
	});

	it('rebuilds a root through the service', async () => {
		await expect(
			invoke('dataview:rebuild', { root: '/vault', agentId: 'agent-1' })
		).resolves.toEqual(status);
		expect(h.service!.rebuildIndex).toHaveBeenCalledWith({ root: '/vault', agentId: 'agent-1' });
	});

	it('rejects with the service error, so an unresolvable SSH remote fails loudly', async () => {
		h.service!.query.mockRejectedValueOnce(
			new Error('SSH remote execution is enabled for this session but the configured remote')
		);
		await expect(invoke('dataview:query', queryRequest)).rejects.toThrow(/SSH remote execution/);
	});

	it('sends every index change to all windows as dataview:changed', () => {
		const event: DataviewChangeEvent = {
			root: '/vault',
			sshRemoteId: null,
			revision: 4,
			changedPaths: ['People/A.md'],
		};
		expect(h.changeListeners).toHaveLength(1);
		h.changeListeners[0](event);
		expect(safeSend).toHaveBeenCalledWith('dataview:changed', event);
	});
});
