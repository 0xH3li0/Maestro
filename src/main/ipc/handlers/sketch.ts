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
import { getSketchBotTurnService } from '../../sketch/sketch-bot-turns';
import {
	setSketchWindowResolver,
	type SketchWindowResolver,
} from '../../sketch/sketch-renderer-bridge';
import type { SaveToProjectOptions } from '../../sketch/sketch-store';
import { getSketchCloudConsent, startSketchCloudConsent } from '../../sketch/sketch-cloud-consent';
import { getSketchBotPolicy, startSketchBotPolicyWatch } from '../../sketch/sketch-bot-policy';
import type { SafeSendFn } from '../../utils/safe-send';
import type { SketchCloudEngine } from '../../../shared/sketch/cloud-consent';
import type { SketchSceneForSnapshot, SketchShareOptions } from '../../../shared/sketch/commands';
import type { BotPolicy } from '../../../shared/sketch/types';
import type { Screening } from '../../../shared/sketch/protocol';
import type {
	SketchBotScreenRequest,
	SketchScene,
	SketchTurnPosture,
} from '../../../shared/sketch/types';

const LOG_CONTEXT = '[SketchBook]';

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export interface SketchHandlerDeps {
	/** The window that owns an agent, or the primary window for `null`. */
	resolveWindow?: SketchWindowResolver;
	/** Pushes `sketch:screeningChanged` and `sketch:botPolicyChanged` to every window. */
	safeSend?: SafeSendFn;
}

export function registerSketchHandlers(deps: SketchHandlerDeps = {}): void {
	if (deps.resolveWindow) setSketchWindowResolver(deps.resolveWindow);
	const service = getSketchService();
	// Cloud screening consent (spec section 8.10): registers the guardrail's
	// cloud policy and follows the assignments and the System One engine.
	startSketchCloudConsent({ safeSend: deps.safeSend });
	const consent = getSketchCloudConsent();
	// B2 policy (spec section 5): puts a room on `writers` back on `conductor`
	// when an input of `isB2Available()` changes under it.
	startSketchBotPolicyWatch({ safeSend: deps.safeSend });
	const botPolicy = getSketchBotPolicy();

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

	// Sharing (spec section 6). The Share panel calls these; `maestro-cli sketch
	// share|unshare|revoke-link|rotate|owner` reaches the same service methods
	// over the WS bridge, where an agent caller gets the A1 confirmation. A
	// person in the Sketch tab is the conductor, so these pass no caller.
	ipcMain.handle(
		'sketch:ownerStatus',
		withIpcErrorLogging(opts('ownerStatus'), async () => service.ownerStatus())
	);
	ipcMain.handle(
		'sketch:registerOwner',
		withIpcErrorLogging(opts('registerOwner'), async (email: string) =>
			service.registerOwner(email)
		)
	);
	ipcMain.handle(
		'sketch:waitForOwner',
		withIpcErrorLogging(opts('waitForOwner'), async (options?: { timeoutMs?: number }) =>
			service.waitForOwner(options)
		)
	);
	ipcMain.handle(
		'sketch:signOutOwner',
		withIpcErrorLogging(opts('signOutOwner'), async () => service.signOutOwner())
	);
	ipcMain.handle(
		'sketch:share',
		withIpcErrorLogging(opts('share'), async (sketchId: string, options?: SketchShareOptions) =>
			service.shareSketch(sketchId, options)
		)
	);
	ipcMain.handle(
		'sketch:unshare',
		withIpcErrorLogging(opts('unshare'), async (sketchId: string) =>
			service.unshareSketch(sketchId)
		)
	);
	ipcMain.handle(
		'sketch:revokeLink',
		withIpcErrorLogging(opts('revokeLink'), async (sketchId: string, capId: string) =>
			service.revokeSketchLink(sketchId, capId)
		)
	);
	ipcMain.handle(
		'sketch:rotate',
		withIpcErrorLogging(opts('rotate'), async (sketchId: string) => service.rotateSketch(sketchId))
	);
	ipcMain.handle(
		'sketch:uploadSnapshot',
		withIpcErrorLogging(
			opts('uploadSnapshot'),
			async (sketchId: string, input: SketchSceneForSnapshot) =>
				service.uploadSnapshot(sketchId, input)
		)
	);
	ipcMain.handle(
		'sketch:roomConnection',
		withIpcErrorLogging(opts('roomConnection'), async (sketchId: string) =>
			service.roomConnection(sketchId)
		)
	);
	ipcMain.handle(
		'sketch:screenBotRequest',
		withIpcErrorLogging(
			opts('screenBotRequest'),
			async (sketchId: string, request: SketchBotScreenRequest) =>
				service.screenBotRequest(sketchId, request)
		)
	);

	// Bot turns (spec section 5): the window runs the turn; main checks the
	// posture, builds the digest, screens the reply, and keeps the session id.
	const botTurns = getSketchBotTurnService();
	ipcMain.handle(
		'sketch:prepareBotTurn',
		withIpcErrorLogging(
			opts('prepareBotTurn'),
			async (sketchId: string, posture: SketchTurnPosture) =>
				botTurns.prepareBotTurn(sketchId, posture)
		)
	);
	ipcMain.handle(
		'sketch:screenBotReply',
		withIpcErrorLogging(opts('screenBotReply'), async (sketchId: string, text: string) =>
			botTurns.screenBotReply(sketchId, text)
		)
	);
	ipcMain.handle(
		'sketch:setBotSessionId',
		withIpcErrorLogging(
			opts('setBotSessionId'),
			async (sketchId: string, botSessionId: string | null) =>
				botTurns.setBotSessionId(sketchId, botSessionId)
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
		withIpcErrorLogging(
			opts('grantScreeningConsent'),
			async (engine: SketchCloudEngine, host?: string) =>
				consent.grantConsent(engine, typeof host === 'string' && host ? host : undefined)
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

	// Who may ask the bot (spec section 5, B2). The Share panel's toggle calls
	// these; `maestro-cli sketch bot-policy` reaches the same service over the
	// WS bridge, where an agent's `writers` gets the A1 confirmation. The room
	// client reports what the server says (`noteRoomBotPolicy`).
	ipcMain.handle(
		'sketch:botPolicyStatus',
		withIpcErrorLogging(opts('botPolicyStatus'), async (sketchId: string) =>
			botPolicy.status(sketchId)
		)
	);
	ipcMain.handle(
		'sketch:setBotPolicy',
		withIpcErrorLogging(opts('setBotPolicy'), async (sketchId: string, policy: BotPolicy) =>
			botPolicy.setPolicy(sketchId, policy)
		)
	);
	ipcMain.handle(
		'sketch:noteRoomBotPolicy',
		withIpcErrorLogging(opts('noteRoomBotPolicy'), async (sketchId: string, policy: BotPolicy) =>
			botPolicy.noteRoomPolicy(sketchId, policy)
		)
	);
	ipcMain.handle(
		'sketch:installScreen',
		withIpcErrorLogging(opts('installScreen'), async () => botPolicy.installScreen())
	);
	ipcMain.handle(
		'sketch:localScreenOption',
		withIpcErrorLogging(opts('localScreenOption'), async () => botPolicy.localScreenOption())
	);
	ipcMain.handle(
		'sketch:switchScreenToLocal',
		withIpcErrorLogging(opts('switchScreenToLocal'), async () => botPolicy.switchScreenToLocal())
	);
}
