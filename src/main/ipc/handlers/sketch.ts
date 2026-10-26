/**
 * Sketch Book IPC (`sketch:*`).
 *
 * Thin pass-throughs to the one SketchService (`src/main/sketch/sketch-service.ts`);
 * the CLI's WS verbs call the same methods. The service refuses every call
 * while the `sketchBook` Encore Feature is off, with the readable
 * `encoreDisabledMessage('sketchBook')` text, and checks each argument, so
 * these handlers carry no logic of their own.
 *
 * Desktop only: no `sketch:` channel is on the web bridge's allowlist
 * (`src/main/web-server/handlers/bridgeDenyList.ts`). Sketch Book shares
 * through RunMaestro.ai, never through the web interface (Q13).
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getSketchService } from '../../sketch/sketch-service';
import type { SaveToProjectOptions } from '../../sketch/sketch-store';
import type { SketchScene } from '../../../shared/sketch/types';

const LOG_CONTEXT = '[SketchBook]';

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export function registerSketchHandlers(): void {
	const service = getSketchService();

	ipcMain.handle(
		'sketch:create',
		withIpcErrorLogging(opts('create'), async (input: { ownerAgentId: string; name?: string }) =>
			service.createSketch(input)
		)
	);
	ipcMain.handle(
		'sketch:list',
		withIpcErrorLogging(opts('list'), async (filter?: { ownerAgentId?: string }) =>
			service.listSketches(filter)
		)
	);
	ipcMain.handle(
		'sketch:get',
		withIpcErrorLogging(opts('get'), async (sketchId: string) => service.getSketch(sketchId))
	);
	ipcMain.handle(
		'sketch:readScene',
		withIpcErrorLogging(opts('readScene'), async (sketchId: string) => service.readScene(sketchId))
	);
	ipcMain.handle(
		'sketch:writeScene',
		withIpcErrorLogging(opts('writeScene'), async (sketchId: string, scene: SketchScene) =>
			service.writeScene(sketchId, scene)
		)
	);
	ipcMain.handle(
		'sketch:rename',
		withIpcErrorLogging(opts('rename'), async (sketchId: string, name: string) =>
			service.renameSketch(sketchId, name)
		)
	);
	ipcMain.handle(
		'sketch:delete',
		withIpcErrorLogging(opts('delete'), async (sketchId: string) => service.deleteSketch(sketchId))
	);
	ipcMain.handle(
		'sketch:saveToProject',
		withIpcErrorLogging(
			opts('saveToProject'),
			async (sketchId: string, destDir: string, options?: SaveToProjectOptions) =>
				service.saveSketchToProject(sketchId, destDir, options)
		)
	);
}
