/**
 * The renderer half of Sketch Book sharing (spec section 6): joining a
 * shared sketch's room, and the Collaborate panel's actions.
 *
 * Main owns sharing (`sketch-service.ts`): it creates the room, seals the
 * snapshot, mints and revokes links. This window owns the room client, so
 * main tells it to join or leave (`syncRoom`, through
 * `sketchRemoteCommands.ts`), and a Sketch tab that opens a shared sketch
 * joins by itself ({@link ensureSketchRoomConnected}), which is how a room
 * comes back after a restart. Every join hands the client to the bot relay
 * (`sketchBotRelay.ts`) and the bot policy sync (`sketchBotPolicy.ts`), and
 * leaving detaches both.
 *
 * A link holds the room key and the cap, so it is copied to the clipboard and
 * acknowledged with `flashCopiedToClipboard()`; the flash names the link,
 * never shows it. Main keeps each live link's cap sealed, so any live link
 * can be copied again ({@link copyExistingSketchLink}).
 */

import type {
	SketchElementVersion,
	SketchMintedLink,
	SketchRoomJoin,
	SketchShareOptions,
	SketchShareResult,
} from '../../shared/sketch/commands';
import type { SketchLinkRole } from '../../shared/sketch/types';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { logger } from '../utils/logger';
import { attachSketchBotRelay, detachSketchBotRelay } from './sketchBotRelay';
import { attachSketchBotPolicySync, detachSketchBotPolicySync } from './sketchBotPolicy';
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
		detachSketchBotRelay(sketchId);
		detachSketchBotPolicySync(sketchId);
		disconnectSketchRoom(sketchId);
		return;
	}
	const client = await connectSketchRoom({
		sketchId,
		roomId: connection.roomId,
		roomKey: connection.roomKey,
		ownerToken: connection.ownerToken,
		serverUrl: connection.serverUrl,
		...(connection.bot ? { bot: connection.bot } : {}),
		...(baseline ? { baseline } : {}),
	});
	// The bot relay answers this room's `@bot` requests (spec section 5).
	attachSketchBotRelay(sketchId, client);
	// Main mirrors the room's policy and demotes `writers` when B2 is gone.
	attachSketchBotPolicySync(sketchId, client);
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

/** Copy a minted link and name it in the flash. False when the clipboard refused it. */
export async function copySketchLink(link: SketchMintedLink): Promise<boolean> {
	const copied = await safeClipboardWrite(link.url);
	if (copied) flashCopiedToClipboard(sketchLinkLabel(link.role, link.label));
	return copied;
}

/**
 * Share (the room on the first share, then a new link) and copy the link.
 * Resolves with the result and whether the clipboard took the link, so the
 * caller can show `link.url` when it did not.
 */
export async function shareSketchAndCopyLink(
	sketchId: string,
	options: SketchShareOptions
): Promise<{ result: SketchShareResult; copied: boolean }> {
	const result = await window.maestro.sketch.share(sketchId, options);
	return { result, copied: await copySketchLink(result.link) };
}

/** Copy a live link again; main rebuilds it from the sealed cap. */
export async function copyExistingSketchLink(
	sketchId: string,
	capId: string
): Promise<{ url: string; copied: boolean }> {
	const link = await window.maestro.sketch.link(sketchId, capId);
	return { url: link.url, copied: await copySketchLink(link) };
}

/** Revoke one link, mint its replacement with the same access, and copy it. */
export async function resetSketchLinkAndCopy(
	sketchId: string,
	capId: string
): Promise<{ result: SketchShareResult; copied: boolean }> {
	const result = await window.maestro.sketch.resetLink(sketchId, capId);
	return { result, copied: await copySketchLink(result.link) };
}
