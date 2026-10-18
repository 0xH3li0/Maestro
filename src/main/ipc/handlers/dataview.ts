/**
 * Dataview IPC (`dataview:*`, D2, DV-7, DV-14).
 *
 * Thin pass-throughs to the one DataviewService: each handler body is a service request method, and the
 * CLI's WS verbs call the same methods. Main resolves the agent's cwd and SSH remote from its id, so a
 * request never names a host. The DQL channels are on the web bridge's allowlist
 * (`src/main/web-server/handlers/bridgeDenyList.ts`), so the browser build runs DQL too; the DataviewJS
 * channels (`jsSnapshot`, `readInRoot`) are not, since DataviewJS is desktop only (DV-14).
 *
 * Gate (D3): the service's request methods refuse while the `dataview` Encore Feature is off, with the
 * readable `encoreDisabledMessage('dataview')` text, so these handlers and the WS bridge refuse alike
 * and no root opens.
 *
 * `dataview:changed` goes out through the all-windows `safeSend`, which also reaches bridge clients:
 * File Preview can sit in a secondary window.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getDataviewService } from '../../dataview/dataview-service';
import { setDataviewJsServingCheck } from '../../dataview/guest-host';
import type { SafeSendFn } from '../../utils/safe-send';
import type {
	DataviewInlineQueryRequest,
	DataviewJsSnapshotRequest,
	DataviewQueryRequest,
	DataviewReadInRootRequest,
	DataviewRebuildRequest,
	DataviewStatusRequest,
} from '../../../shared/dataview';

const LOG_CONTEXT = '[Dataview]';

export interface DataviewHandlerDependencies {
	safeSend: SafeSendFn;
}

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export function registerDataviewHandlers(deps: DataviewHandlerDependencies): void {
	const service = getDataviewService();

	ipcMain.handle(
		'dataview:query',
		withIpcErrorLogging(opts('query'), async (request: DataviewQueryRequest) =>
			service.query(request)
		)
	);
	ipcMain.handle(
		'dataview:queryInline',
		withIpcErrorLogging(opts('queryInline'), async (request: DataviewInlineQueryRequest) =>
			service.queryInline(request)
		)
	);
	ipcMain.handle(
		'dataview:status',
		withIpcErrorLogging(opts('status'), async (request?: DataviewStatusRequest) =>
			service.indexStatus(request ?? {})
		)
	);
	ipcMain.handle(
		'dataview:rebuild',
		withIpcErrorLogging(opts('rebuild'), async (request: DataviewRebuildRequest) =>
			service.rebuildIndex(request)
		)
	);
	// DataviewJS (D4): desktop only, so neither channel is on the web bridge's allowlist. The service
	// refuses both unless DataviewJS is on and the root trusted, and re-checks every path in main.
	ipcMain.handle(
		'dataview:jsSnapshot',
		withIpcErrorLogging(opts('jsSnapshot'), async (request: DataviewJsSnapshotRequest) =>
			service.jsSnapshot(request)
		)
	);
	ipcMain.handle(
		'dataview:readInRoot',
		withIpcErrorLogging(opts('readInRoot'), async (request: DataviewReadInRootRequest) =>
			service.readInRoot(request)
		)
	);

	// The guest host serves and attaches DataviewJS guests only while this says yes (default deny).
	setDataviewJsServingCheck(() => service.jsServing());

	// DV-7: every open index's changes, to every window and bridge client.
	service.onChange((event) => deps.safeSend('dataview:changed', event));
}
