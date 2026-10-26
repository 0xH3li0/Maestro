/**
 * Which shortcuts belong to an Encore Feature, and whether they exist right now.
 *
 * `useMainKeyboardHandler` already refuses to fire these chords while their
 * feature is off. This is the other half: a disabled feature's shortcut must
 * not be LISTED either (Shortcuts Help, Settings -> Shortcuts, the Usage
 * Dashboard's unused list) or counted in the keyboard-mastery denominator,
 * where a chord that cannot fire would hold the user below 100% forever.
 *
 * A new Encore Feature that adds a shortcut adds its id here.
 */

import type { EncoreFeatureFlags, Shortcut } from '../types';
import { canOpenComputerHistory } from './computerHistoryAvailability';
import { canUseSketchBook } from './sketchBookAvailability';

export const SHORTCUT_ENCORE_FLAGS: Readonly<Record<string, keyof EncoreFeatureFlags>> = {
	usageDashboard: 'usageStats',
	openSymphony: 'symphony',
	directorNotes: 'directorNotes',
	searchDirectorNotes: 'directorNotes',
	openCue: 'maestroCue',
	computerHistory: 'computerHistory',
	toggleConcerto: 'concerto',
	toggleCadenzas: 'concerto',
	toggleThroughputGauge: 'throughputGauge',
	newSketchBook: 'sketchBook',
};

type EncoreFlagsInput = Partial<EncoreFeatureFlags> | null | undefined;

/**
 * Features that need more than their flag: each is also withheld on the
 * web-desktop build. The hotkey, palette and menu ask the same predicate.
 */
const FLAG_AVAILABILITY: Partial<
	Record<keyof EncoreFeatureFlags, (encoreFeatures: EncoreFlagsInput) => boolean>
> = {
	computerHistory: canOpenComputerHistory,
	sketchBook: canUseSketchBook,
};

/** False only for a shortcut whose Encore Feature is switched off. */
export function isShortcutAvailable(shortcutId: string, encoreFeatures: EncoreFlagsInput): boolean {
	const flag = SHORTCUT_ENCORE_FLAGS[shortcutId];
	if (!flag) return true;
	const available = FLAG_AVAILABILITY[flag];
	if (available) return available(encoreFeatures);
	return encoreFeatures?.[flag] === true;
}

/** Drop the shortcuts of every Encore Feature that is switched off. */
export function availableShortcuts<T extends Shortcut>(
	shortcuts: Record<string, T>,
	encoreFeatures: EncoreFlagsInput
): Record<string, T> {
	const available: Record<string, T> = {};
	for (const [id, shortcut] of Object.entries(shortcuts)) {
		if (isShortcutAvailable(id, encoreFeatures)) available[id] = shortcut;
	}
	return available;
}
