/**
 * Where a renderer build puts Excalidraw's font files, relative to the
 * renderer document. The Vite plugin that copies them
 * (`scripts/vite-excalidraw-assets.ts`) and the renderer module that points
 * Excalidraw at them (`src/renderer/components/SketchBook/excalidrawAssets.ts`)
 * both read this one value, so the files and the URL can never disagree.
 */
export const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets';
