/**
 * Chain of thought export: the IPC channels of its one control.
 *
 * These channels turn the log on and off, pick its folder, and read it back.
 * A person at the desktop app is the only caller they serve. The main-process
 * handlers refuse every other sender (`assertDesktopSender` in
 * `src/main/ipc/handlers/cot-export.ts`), because the web bridge would
 * otherwise hand any registered channel to anything that holds its token, and
 * an agent's shell can read that token.
 *
 * `HUMAN_ONLY_IPC_CHANNELS` is the list a second lock imports: a caller that
 * dispatches channels for something other than the desktop window can refuse
 * these before it looks a handler up.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

/** Every channel of the feature, by what it does. */
export const COT_EXPORT_CHANNELS = {
	/** What the person chose for an agent. */
	get: 'cotExport:get',
	/** Changes what the person chose. */
	set: 'cotExport:set',
	/** What the Edit Agent dialog shows about an agent's log. */
	status: 'cotExport:status',
	/** Whether a folder may hold an agent's log, with nothing changed. */
	validateFolder: 'cotExport:validateFolder',
	/** Walks every chain of an agent and checks it. */
	verify: 'cotExport:verify',
} as const;

/** The name of one channel in `COT_EXPORT_CHANNELS`. */
export type CotExportChannelName = keyof typeof COT_EXPORT_CHANNELS;

/** One channel of the feature, as it goes over IPC. */
export type CotExportChannel = (typeof COT_EXPORT_CHANNELS)[CotExportChannelName];

/**
 * Channels only a person at the desktop app may invoke. Derived from the
 * record above, so a channel added there is on this list the moment it exists.
 */
export const HUMAN_ONLY_IPC_CHANNELS: readonly CotExportChannel[] = Object.freeze(
	Object.values(COT_EXPORT_CHANNELS)
);
