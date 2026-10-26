/**
 * Ship Excalidraw's font files with the renderer and serve them locally.
 *
 * Excalidraw resolves every font URL at runtime against
 * `window.EXCALIDRAW_ASSET_PATH`, and appends the esm.sh CDN as a last-resort
 * fallback. Bundlers never see those URLs (they are plain strings like
 * `./fonts/Excalifont/Excalifont-Regular-<hash>.woff2`), so without this
 * plugin no font is in the build, every lookup misses, and Excalidraw quietly
 * fetches from the CDN: broken offline, and a usage leak. Sketch Book forbids
 * that (docs/sketch-book-spec.md section 2, Packaging).
 *
 * The plugin copies the whole `dist/prod/fonts` tree of the pinned package to
 * `<outDir>/<EXCALIDRAW_ASSET_DIR>/fonts/` at build time, and serves the same
 * tree from the dev server. The renderer points Excalidraw at that directory in
 * `src/renderer/components/SketchBook/excalidrawAssets.ts`.
 *
 * Used by both renderer builds: `vite.config.mts` (Electron) and
 * `vite.config.web-desktop.mts` (browser).
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { EXCALIDRAW_ASSET_DIR } from '../src/shared/sketch/assets';

/** The package's font tree, relative to the project root. */
export const EXCALIDRAW_FONTS_SOURCE = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts';

/** Every `.woff2` under `fontsDir`, as POSIX paths relative to it, sorted. */
export function listExcalidrawFontFiles(fontsDir: string): string[] {
	if (!fs.existsSync(fontsDir)) return [];
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.woff2')) {
				files.push(path.relative(fontsDir, full).split(path.sep).join('/'));
			}
		}
	};
	walk(fontsDir);
	return files.sort();
}

/**
 * Map a request path onto a file in `fontsDir`, or `null` when the path is not
 * an Excalidraw font request or would escape the directory. The asset
 * directory may sit under a prefix (the web build's security-token path), so
 * the match is on the `/<dir>/fonts/` segment, not on the start of the path.
 */
export function resolveExcalidrawFontRequest(fontsDir: string, requestPath: string): string | null {
	const marker = `/${EXCALIDRAW_ASSET_DIR}/fonts/`;
	let pathname: string;
	try {
		pathname = decodeURIComponent(requestPath.split('?')[0] ?? '');
	} catch {
		return null; // malformed escape: not a request this plugin can serve
	}
	const at = pathname.indexOf(marker);
	if (at === -1 || !pathname.endsWith('.woff2')) return null;
	const resolved = path.resolve(fontsDir, pathname.slice(at + marker.length));
	const rel = path.relative(fontsDir, resolved);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return resolved;
}

export function excalidrawAssetsPlugin(projectRoot: string): Plugin {
	const fontsDir = path.join(projectRoot, EXCALIDRAW_FONTS_SOURCE);
	return {
		name: 'maestro-excalidraw-assets',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const file = resolveExcalidrawFontRequest(fontsDir, req.url ?? '');
				if (!file || !fs.existsSync(file)) return next();
				res.setHeader('Content-Type', 'font/woff2');
				res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
				fs.createReadStream(file).pipe(res);
			});
		},
		generateBundle() {
			const files = listExcalidrawFontFiles(fontsDir);
			// A missing tree means a broken install, and a build without fonts
			// would ship a Sketch Book that silently falls back to the CDN.
			if (files.length === 0) {
				this.error(`No Excalidraw fonts found in ${fontsDir}. Run npm install.`);
			}
			for (const rel of files) {
				this.emitFile({
					type: 'asset',
					fileName: `${EXCALIDRAW_ASSET_DIR}/fonts/${rel}`,
					source: fs.readFileSync(path.join(fontsDir, rel)),
				});
			}
		},
	};
}
