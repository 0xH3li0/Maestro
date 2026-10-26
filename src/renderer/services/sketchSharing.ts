/**
 * The renderer half of Sketch Book sharing (spec section 6): joining a
 * shared sketch's room, and the Share panel's actions.
 *
 * Main owns sharing (`sketch-service.ts`): it creates the room, seals the
 * snapshot, mints and revokes links. This window owns the room client, so
 * main tells it to join or leave (`syncRoom`, through
 * `sketchRemoteCommands.ts`), and a Sketch tab that opens a shared sketch
 * joins by itself ({@link ensureSketchRoomConnected}), which is how a room
 * comes back after a restart.
 *
 * A minted link holds the room key and the cap, so it is copied to the
 * clipboard and acknowledged with `flashCopiedToClipboard()`; the flash names
 * the link, never shows it.
 */

import type {
	SketchElementVersion,
	SketchRoomJoin,
	SketchShareOptions,
	SketchShareResult,
} from '../../shared/sketch/commands';
import type { SketchLinkRole } from '../../shared/sketch/types';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { logger } from '../utils/logger';
import { connectSketchRoom, disconnectSketchRoom, getSketchRoomClient } from './sketchRoomClient';

const LOG_CTX = '[SketchBook][Share]';

/** Joins in flight, so two callers (a tab mount, a `syncRoom`) never open two sockets. */
const joining = new Map<string, Promise<void>>();

/** Join the room with `connection`, replacing any client the sketch has; or leave it. */
export async function applySketchRoomConnection(
	sketchId: string,
	connection: SketchRoomJoin | null,
	baseline?: SketchElementVersion[]
): Promise<void> {
	if (!connection) {
		disconnectSketchRoom(sketchId);
		return;
	}
	await connectSketchRoom({
		sketchId,
		roomId: connection.roomId,
		roomKey: connection.roomKey,
		ownerToken: connection.ownerToken,
		serverUrl: connection.serverUrl,
		...(connection.bot ? { bot: connection.bot } : {}),
		...(baseline ? { baseline } : {}),
	});
}

/**
 * Join a shared sketch's room when this window has no client for it yet.
 * Does nothing for a sketch that is not shared, or with no owner sign-in.
 */
export function ensureSketchRoomConnected(sketchId: string): Promise<void> {
	if (getSketchRoomClient(sketchId)) return Promise.resolve();
	const inFlight = joining.get(sketchId);
	if (inFlight) return inFlight;
	const join = (async () => {
		try {
			const connection = await window.maestro.sketch.roomConnection(sketchId);
			if (connection && !getSketchRoomClient(sketchId)) {
				await applySketchRoomConnection(sketchId, connection);
			}
		} catch (error) {
			logger.warn('Could not join the sketch room', LOG_CTX, {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			joining.delete(sketchId);
		}
	})();
	joining.set(sketchId, join);
	return join;
}

/** How a link is named in the copy acknowledgement. */
export function sketchLinkLabel(role: SketchLinkRole, label?: string): string {
	const kind = role === 'rw' ? 'Edit link' : 'View link';
	return label ? `${kind} "${label}"` : kind;
}

/**
 * Share (the room on the first share, then a new link) and copy the link.
 * Resolves with the result and whether the clipboard took the link: the
 * server returns a link's cap once, so a failed copy leaves `link.url` as the
 * only copy for the caller to show.
 */
export async function shareSketchAndCopyLink(
	sketchId: string,
	options: SketchShareOptions
): Promise<{ result: SketchShareResult; copied: boolean }> {
	const result = await window.maestro.sketch.share(sketchId, options);
	const copied = await safeClipboardWrite(result.link.url);
	if (copied) flashCopiedToClipboard(sketchLinkLabel(result.link.role, result.link.label));
	return { result, copied };
}
