/**
 * Preload API for Dataview (`window.maestro.dataview`, D2, DV-7).
 *
 * Mirrors the `dataview:*` channels in `src/main/ipc/handlers/dataview.ts`. Results arrive in wire form;
 * run them through `reviveDataviewResult()` / `reviveDataviewInlineResult()` (`src/shared/dataview`) to
 * get Dataview values back. The web-desktop bridge forwards every channel and the change push (DV-14).
 */

import { ipcRenderer } from 'electron';
import type {
	DataviewChangeEvent,
	DataviewIndexStatus,
	DataviewInlineQueryRequest,
	DataviewInlineResult,
	DataviewQueryRequest,
	DataviewQueryResponse,
	DataviewRebuildRequest,
	DataviewResult,
	DataviewStatusRequest,
} from '../../shared/dataview/types';

/** Creates the Dataview API object for contextBridge exposure. */
export function createDataviewApi() {
	return {
		/** Run one `dataview` block with `this` bound to the note at `request.filePath`. */
		query: (request: DataviewQueryRequest): Promise<DataviewQueryResponse<DataviewResult>> =>
			ipcRenderer.invoke('dataview:query', request),
		/** Evaluate one inline `` `= expr` ``. */
		queryInline: (
			request: DataviewInlineQueryRequest
		): Promise<DataviewQueryResponse<DataviewInlineResult>> =>
			ipcRenderer.invoke('dataview:queryInline', request),
		/** The named open root, or every open root. Never opens one. */
		status: (request?: DataviewStatusRequest): Promise<DataviewIndexStatus[]> =>
			ipcRenderer.invoke('dataview:status', request ?? {}),
		/** Drop a root's cache and index it again; resolves once the full scan has finished. */
		rebuild: (request: DataviewRebuildRequest): Promise<DataviewIndexStatus> =>
			ipcRenderer.invoke('dataview:rebuild', request),
		/** Fires when an open index changes (DV-7). Returns the unsubscribe function. */
		onChanged: (handler: (event: DataviewChangeEvent) => void): (() => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, change: DataviewChangeEvent) =>
				handler(change);
			ipcRenderer.on('dataview:changed', wrapped);
			return () => {
				ipcRenderer.removeListener('dataview:changed', wrapped);
			};
		},
	};
}

export type DataviewApi = ReturnType<typeof createDataviewApi>;
