/**
 * dataviewSurface - how a document surface opts into Dataview rendering (D3, D7,
 * DV-10).
 *
 * File Preview (Rich and Fast tiers) and the Auto Run preview are the only
 * Dataview surfaces. Each one reads `useDataviewEnabled()`, adds
 * `withDataviewLanguageRenderers()` to its `customLanguageRenderers`, passes
 * `dataviewInlineCodeRenderer()` as `renderInlineCode`, and wraps its rendered
 * markdown in a `DataviewDocumentContext` provider. With the Encore Feature off,
 * all three return the surface's own values unchanged, so a `dataview` fence
 * renders as the ordinary highlighted code it always was and nothing of Dataview
 * is mounted (zero footprint). No other surface calls these, and the chat preset
 * builds its code blocks without custom renderers at all.
 */

import type React from 'react';
import type { Theme } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { DataviewBlock } from './DataviewBlock';
import { createDataviewInlineCodeRenderer } from './DataviewInlineQuery';

/** The shape of a `customLanguageRenderers` map (`createMarkdownComponents()`). */
export type LanguageRenderers = Record<string, React.ComponentType<{ code: string; theme: Theme }>>;

/** The fence languages Dataview renders, each to its block component. */
export const DATAVIEW_LANGUAGE_RENDERERS: LanguageRenderers = Object.freeze({
	dataview: DataviewBlock,
});

/** Whether the Dataview Encore Feature is on. */
export function useDataviewEnabled(): boolean {
	return useSettingsStore((s) => s.encoreFeatures?.dataview === true);
}

/** The surface's renderers plus Dataview's while the feature is on; the surface's own otherwise. */
export function withDataviewLanguageRenderers(
	renderers: LanguageRenderers,
	enabled: boolean
): LanguageRenderers {
	return enabled ? { ...renderers, ...DATAVIEW_LANGUAGE_RENDERERS } : renderers;
}

/** The `renderInlineCode` option for an inline `` `= expr` `` span, or undefined while the feature is off. */
export function dataviewInlineCodeRenderer(
	theme: Theme,
	enabled: boolean
): ((code: string, fallback: React.ReactElement) => React.ReactNode | null) | undefined {
	return enabled ? createDataviewInlineCodeRenderer(theme) : undefined;
}
