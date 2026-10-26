/**
 * excalidrawAssets.ts is the only door to Excalidraw: it points
 * `window.EXCALIDRAW_ASSET_PATH` at the fonts bundled with the app before the
 * package loads, so no font URL ever resolves to the CDN fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	excalidrawAssetPath,
	installExcalidrawAssetPath,
	loadExcalidraw,
	loadMermaidToExcalidraw,
} from '../../../../renderer/components/SketchBook/excalidrawAssets';
import { EXCALIDRAW_ASSET_DIR } from '../../../../shared/sketch/assets';

// The factories run at the moment the loader's dynamic import() evaluates the
// module, so they record what Excalidraw would see when it first loads.
vi.mock('@excalidraw/excalidraw', () => ({
	assetPathAtLoad: window.EXCALIDRAW_ASSET_PATH,
}));
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
	assetPathAtLoad: window.EXCALIDRAW_ASSET_PATH,
}));

const expectedPath = () => new URL(`${EXCALIDRAW_ASSET_DIR}/`, document.baseURI).href;

describe('excalidrawAssets', () => {
	afterEach(() => {
		delete window.EXCALIDRAW_ASSET_PATH;
	});

	describe('excalidrawAssetPath', () => {
		it('resolves beside the Electron app:// document', () => {
			expect(excalidrawAssetPath('app://maestro/index.html')).toBe(
				`app://maestro/${EXCALIDRAW_ASSET_DIR}/`
			);
		});

		it('keeps the web build security-token prefix', () => {
			expect(excalidrawAssetPath('https://host:5176/abc123/index.html')).toBe(
				`https://host:5176/abc123/${EXCALIDRAW_ASSET_DIR}/`
			);
			expect(excalidrawAssetPath('https://host:5176/abc123/')).toBe(
				`https://host:5176/abc123/${EXCALIDRAW_ASSET_DIR}/`
			);
		});

		it('is always absolute, never a ./ or / path Excalidraw would rebase onto the origin', () => {
			expect(excalidrawAssetPath('http://localhost:17173/')).toMatch(/^http:\/\//);
		});
	});

	it('installExcalidrawAssetPath sets the window global from the document base', () => {
		expect(installExcalidrawAssetPath()).toBe(expectedPath());
		expect(window.EXCALIDRAW_ASSET_PATH).toBe(expectedPath());
	});

	it('loadExcalidraw sets the asset path before the package evaluates', async () => {
		const mod = (await loadExcalidraw()) as unknown as { assetPathAtLoad: unknown };
		expect(mod.assetPathAtLoad).toBe(expectedPath());
	});

	it('loadMermaidToExcalidraw sets the asset path before the package evaluates', async () => {
		const mod = (await loadMermaidToExcalidraw()) as unknown as { assetPathAtLoad: unknown };
		expect(mod.assetPathAtLoad).toBe(expectedPath());
	});
});
