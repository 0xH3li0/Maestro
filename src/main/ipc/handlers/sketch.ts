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
 *
 * Registration also hands the service the window registry
 * (`setSketchWindowResolver`), so `maestro-cli sketch open` and PNG or SVG
 * export reach the window that owns the agent.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getSketchService } from '../../sketch/sketch-service';
import {
	setSketchWindowResolver,
	type SketchWindowResolver,
} from '../../sketch/sketch-renderer-bridge';
import type { SaveToProjectOptions } from '../../sketch/sketch-store';
import { getSketchCloudConsent, startSketchCloudConsent } from '../../sketch/sketch-cloud-consent';
import type { SafeSendFn } from '../../utils/safe-send';
import type { SketchCloudEngine } from '../../../shared/sketch/cloud-consent';
import type { Screening } from '../../../shared/sketch/protocol';
import type { SketchScene } from '../../../shared/sketch/types';

const LOG_CONTEXT = '[SketchBook]';

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export interface SketchHandlerDeps {
	/** The window that owns an agent, or the primary window for `null`. */
	resolveWindow?: SketchWindowResolver;
	/** Pushes `sketch:screeningChanged` to every window (cloud screening consent). */
	safeSend?: SafeSendFn;
}

export function registerSketchHandlers(deps: SketchHandlerDeps = {}): void {
	if (deps.resolveWindow) setSketchWindowResolver(deps.resolveWindow);
	const service = getSketchService();
	// Cloud screening consent (spec section 8.10): registers the guardrail's
	// cloud policy and follows the assignments and the System One engine.
	startSketchCloudConsent({ safeSend: deps.safeSend });
	const consent = getSketchCloudConsent();

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

	// Cloud screening consent (spec section 8.10). The room client reports the
	// room's life and the server's echo; Settings and the confirmation read and
	// change the consent. `maestro-cli sketch screening-consent` reaches the same
	// module over the WS bridge.
	ipcMain.handle(
		'sketch:screeningConsentStatus',
		withIpcErrorLogging(opts('screeningConsentStatus'), async () => consent.status())
	);
	ipcMain.handle(
		'sketch:grantScreeningConsent',
		withIpcErrorLogging(opts('grantScreeningConsent'), async (engine: SketchCloudEngine) =>
			consent.grantConsent(engine)
		)
	);
	ipcMain.handle(
		'sketch:revokeScreeningConsent',
		withIpcErrorLogging(opts('revokeScreeningConsent'), async (engine: SketchCloudEngine) =>
			consent.revokeConsent(engine)
		)
	);
	ipcMain.handle(
		'sketch:confirmCloudScreening',
		withIpcErrorLogging(opts('confirmCloudScreening'), async () => consent.confirmCloudScreening())
	);
	ipcMain.handle(
		'sketch:roomScreening',
		withIpcErrorLogging(opts('roomScreening'), async (sketchId: string) =>
			consent.roomScreening(sketchId)
		)
	);
	ipcMain.handle(
		'sketch:setRoomLive',
		withIpcErrorLogging(opts('setRoomLive'), async (sketchId: string, live: boolean) =>
			consent.setRoomLive(sketchId, live === true)
		)
	);
	ipcMain.handle(
		'sketch:reportServerScreening',
		withIpcErrorLogging(
			opts('reportServerScreening'),
			async (sketchId: string, screening: Screening, since: number | null) =>
				consent.reportServerScreening(sketchId, screening, since)
		)
	);
}
