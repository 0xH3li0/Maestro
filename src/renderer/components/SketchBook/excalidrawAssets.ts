/**
 * The one door to Excalidraw: point it at the fonts bundled with the app, then
 * load it lazily.
 *
 * Fonts and assets are served from the app bundle, never the CDN
 * (docs/sketch-book-spec.md section 2, Packaging). `scripts/vite-excalidraw-assets.ts`
 * copies the package's font tree to `<renderer root>/excalidraw-assets/fonts/`;
 * this module sets `window.EXCALIDRAW_ASSET_PATH` to that directory before
 * Excalidraw can resolve a single font URL. Import Excalidraw only through the
 * loaders below, so nothing loads until a sketch opens and the path is always
 * set first.
 *
 * Build output (`npm run build`, 2026-10-26, @excalidraw/excalidraw 0.18.1,
 * @excalidraw/mermaid-to-excalidraw 2.2.2), sizes before gzip:
 *
 *   assets/index-<hash>.js            3185.7 KiB  main renderer entry: no Excalidraw code
 *   assets/excalidrawAssets-<hash>.js    0.7 KiB  this module (lazy)
 *   assets/prod-<hash>.js             1109.8 KiB  @excalidraw/excalidraw (lazy; named after dist/prod)
 *   assets/prod-<hash>.css             141.4 KiB  its stylesheet, plus 4 Assistant-*.woff2 (79 KiB)
 *   assets/dist-<hash>.js               51.2 KiB  @excalidraw/mermaid-to-excalidraw (lazy; mermaid
 *                                                 itself is the existing vendor-mermaid chunk)
 *   55 locale chunks                  1098.3 KiB  loaded one at a time, on language change
 *   pica, image-blob-reduce, file-*      ~80 KiB  image import and file dialogs (lazy)
 *   assets/vendor-syntax-<hash>.js     603.6 KiB  pulled in by the Excalidraw chunk (a shared dep
 *                                                 lands in that manual chunk); lazy, not in the entry
 *   excalidraw-assets/fonts/              13 MB   234 .woff2 files, covering all 230 font URLs the
 *                                                 package references
 *
 * The web-desktop build has the same layout (entry `main-<hash>.js`, also free
 * of Excalidraw). Excalidraw still appends esm.sh as the last URL for each
 * font; it is reached only when the local file fails, and the renderer CSP
 * (`font-src 'self'`) blocks a CDN font load anyway.
 */

import { EXCALIDRAW_ASSET_DIR } from '../../../shared/sketch/assets';

declare global {
	interface Window {
		/** Read by Excalidraw each time it resolves a font URL. */
		EXCALIDRAW_ASSET_PATH?: string | string[];
	}
}

/**
 * The absolute URL of the bundled asset directory for a document at `baseUri`.
 *
 * Absolute on purpose: Excalidraw resolves a `./` or `/` path against
 * `window.location.origin`, which drops the document's own path (the web
 * build's security-token prefix) and is the string `"null"` on an opaque
 * origin.
 */
export function excalidrawAssetPath(baseUri: string): string {
	return new URL(`${EXCALIDRAW_ASSET_DIR}/`, baseUri).href;
}

/** Point Excalidraw at the bundled assets. Idempotent; returns the path set. */
export function installExcalidrawAssetPath(): string {
	const assetPath = excalidrawAssetPath(document.baseURI);
	window.EXCALIDRAW_ASSET_PATH = assetPath;
	return assetPath;
}

/** Load Excalidraw and its stylesheet as a separate lazy chunk. */
export async function loadExcalidraw(): Promise<typeof import('@excalidraw/excalidraw')> {
	installExcalidrawAssetPath();
	const [excalidraw] = await Promise.all([
		import('@excalidraw/excalidraw'),
		import('@excalidraw/excalidraw/index.css'),
	]);
	return excalidraw;
}

/** Load the Mermaid converter (spec T8) as a separate lazy chunk. */
export function loadMermaidToExcalidraw(): Promise<
	typeof import('@excalidraw/mermaid-to-excalidraw')
> {
	installExcalidrawAssetPath();
	return import('@excalidraw/mermaid-to-excalidraw');
}
