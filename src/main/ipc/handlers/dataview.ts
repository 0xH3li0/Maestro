/**
 * Dataview IPC (`dataview:*`, D2, DV-7, DV-14).
 *
 * Thin pass-throughs to the one DataviewService: each handler body is a service request method, and the
 * CLI's WS verbs call the same methods. Main resolves the agent's cwd and SSH remote from its id, so a
 * request never names a host. Every channel here is on the web bridge's allowlist
 * (`src/main/web-server/handlers/bridgeDenyList.ts`), so the browser build runs DQL too.
 *
 * `dataview:changed` goes out through the all-windows `safeSend`, which also reaches bridge clients:
 * File Preview can sit in a secondary window.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getDataviewService } from '../../dataview/dataview-service';
import type { SafeSendFn } from '../../utils/safe-send';
import type {
	DataviewInlineQueryRequest,
	DataviewQueryRequest,
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

	// DV-7: every open index's changes, to every window and bridge client.
	service.onChange((event) => deps.safeSend('dataview:changed', event));
}
