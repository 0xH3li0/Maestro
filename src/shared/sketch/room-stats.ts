/**
 * What the conductor is told about a shared sketch's room: the screening badge
 * (wire contract X10, spec section 8.10) and the Y4 outage banner (spec
 * section 8.9). One copy, so the Sketch tab header, the Collaborate panel and
 * `maestro-cli sketch stats` say the same words.
 *
 * Bundled into the renderer and the CLI, so it imports nothing from Electron
 * or Node.
 */

import type { SketchCloudEngine } from './cloud-consent';
import type { RoomStatsActor, RoomStatsFrame, Screening } from './protocol';

/** A `room.stats` frame as the session keeps it (the server pushes one after `welcome` and on a change). */
export type SketchRoomStats = Omit<RoomStatsFrame, 't'>;

/**
 * The badge for a room's screening value: "Local screening", or "Cloud
 * screening: Jev" / "Cloud screening: OpenJev". A cloud value whose engine is
 * not known (the engine changed, or the read failed) still says cloud.
 */
export function sketchScreeningBadgeLabel(
	screening: Screening,
	engine: SketchCloudEngine | null
): string {
	if (screening === 'local') return 'Local screening';
	if (engine === 'jev') return 'Cloud screening: Jev';
	if (engine === 'openjev') return 'Cloud screening: OpenJev';
	return 'Cloud screening';
}

/** Y4: how many guest requests the conductor's screen could not check, over every actor. */
export function sketchScreenOutageTotal(
	actors: readonly Pick<RoomStatsActor, 'unavailableTotal'>[]
): number {
	return actors.reduce((total, actor) => total + Math.max(0, actor.unavailableTotal), 0);
}

/** The Y4 banner, or null while no guest request met a failed screen. */
export function sketchScreenOutageBanner(total: number): string | null {
	if (total <= 0) return null;
	return `Your screen failed ${total} guest ${total === 1 ? 'request' : 'requests'}`;
}
