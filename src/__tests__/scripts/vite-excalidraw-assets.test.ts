/**
 * scripts/vite-excalidraw-assets.ts ships Excalidraw's fonts with both renderer
 * builds so Sketch Book never falls back to the esm.sh CDN. These tests pin the
 * files it copies, where it emits them, the dev-server path mapping (including
 * traversal), and that the copied tree covers every font URL the pinned
 * package actually references.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	EXCALIDRAW_FONTS_SOURCE,
	excalidrawAssetsPlugin,
	listExcalidrawFontFiles,
	resolveExcalidrawFontRequest,
} from '../../../scripts/vite-excalidraw-assets';
import { EXCALIDRAW_ASSET_DIR } from '../../shared/sketch/assets';

const REPO_ROOT = path.join(__dirname, '../../..');

function plant(root: string, relative: string, content = 'x'): void {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

interface BundleContext {
	emitFile: ReturnType<typeof vi.fn>;
	error: (message: string) => never;
}

function runGenerateBundle(projectRoot: string): BundleContext {
	const ctx: BundleContext = {
		emitFile: vi.fn(),
		error: (message: string) => {
			throw new Error(message);
		},
	};
	const hook = excalidrawAssetsPlugin(projectRoot).generateBundle as unknown as (
		this: BundleContext
	) => void;
	hook.call(ctx);
	return ctx;
}

describe('vite-excalidraw-assets', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'excalidraw-assets-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe('listExcalidrawFontFiles', () => {
		it('lists every nested .woff2 as a sorted POSIX path and skips other files', () => {
			plant(root, 'Virgil/Virgil-Regular.woff2');
			plant(root, 'Excalifont/Excalifont-Regular-abc.woff2');
			plant(root, 'Excalifont/LICENSE.txt');
			plant(root, 'readme.md');
			expect(listExcalidrawFontFiles(root)).toEqual([
				'Excalifont/Excalifont-Regular-abc.woff2',
				'Virgil/Virgil-Regular.woff2',
			]);
		});

		it('returns an empty list when the directory does not exist', () => {
			expect(listExcalidrawFontFiles(path.join(root, 'missing'))).toEqual([]);
		});
	});

	describe('resolveExcalidrawFontRequest', () => {
		const fontsDir = '/app/fonts';
		const at = (rel: string) => path.resolve(fontsDir, rel);

		it('maps a root request onto the fonts directory', () => {
			expect(
				resolveExcalidrawFontRequest(
					fontsDir,
					`/${EXCALIDRAW_ASSET_DIR}/fonts/Virgil/Virgil-Regular.woff2`
				)
			).toBe(at('Virgil/Virgil-Regular.woff2'));
		});

		it('matches under a path prefix (the web build security token) and drops the query', () => {
			expect(
				resolveExcalidrawFontRequest(
					fontsDir,
					`/s3cr3t-token/${EXCALIDRAW_ASSET_DIR}/fonts/Nunito/Nunito-Regular.woff2?v=1`
				)
			).toBe(at('Nunito/Nunito-Regular.woff2'));
		});

		it('rejects requests outside the asset directory or for other file types', () => {
			expect(resolveExcalidrawFontRequest(fontsDir, '/fonts/Inter.woff2')).toBeNull();
			expect(
				resolveExcalidrawFontRequest(fontsDir, `/${EXCALIDRAW_ASSET_DIR}/fonts/Virgil/x.js`)
			).toBeNull();
		});

		it('rejects traversal, including an encoded one', () => {
			expect(
				resolveExcalidrawFontRequest(fontsDir, `/${EXCALIDRAW_ASSET_DIR}/fonts/../../secret.woff2`)
			).toBeNull();
			expect(
				resolveExcalidrawFontRequest(
					fontsDir,
					`/${EXCALIDRAW_ASSET_DIR}/fonts/..%2F..%2Fsecret.woff2`
				)
			).toBeNull();
		});

		it('returns null for a malformed escape instead of throwing', () => {
			expect(
				resolveExcalidrawFontRequest(fontsDir, `/${EXCALIDRAW_ASSET_DIR}/fonts/%E0%A4%A.woff2`)
			).toBeNull();
		});
	});

	describe('generateBundle', () => {
		it('emits every font under <asset dir>/fonts/ with its bytes', () => {
			plant(root, `${EXCALIDRAW_FONTS_SOURCE}/Virgil/Virgil-Regular.woff2`, 'virgil');
			plant(root, `${EXCALIDRAW_FONTS_SOURCE}/Xiaolai/Xiaolai-Regular-1.woff2`, 'xiaolai');
			const ctx = runGenerateBundle(root);
			const emitted = ctx.emitFile.mock.calls.map(([file]) => ({
				type: file.type,
				fileName: file.fileName,
				source: Buffer.from(file.source).toString(),
			}));
			expect(emitted).toEqual([
				{
					type: 'asset',
					fileName: `${EXCALIDRAW_ASSET_DIR}/fonts/Virgil/Virgil-Regular.woff2`,
					source: 'virgil',
				},
				{
					type: 'asset',
					fileName: `${EXCALIDRAW_ASSET_DIR}/fonts/Xiaolai/Xiaolai-Regular-1.woff2`,
					source: 'xiaolai',
				},
			]);
		});

		it('fails the build when the package has no fonts, rather than shipping a CDN fallback', () => {
			expect(() => runGenerateBundle(root)).toThrow(/No Excalidraw fonts found/);
		});
	});

	it('copies every font URL the pinned Excalidraw build references', () => {
		const prodDir = path.join(REPO_ROOT, path.dirname(EXCALIDRAW_FONTS_SOURCE));
		const referenced = new Set<string>();
		for (const name of readdirSync(prodDir)) {
			if (!name.endsWith('.js')) continue;
			const code = readFileSync(path.join(prodDir, name), 'utf8');
			for (const match of code.matchAll(/\.\/fonts\/([\w/.-]+\.woff2)/g)) {
				referenced.add(match[1]);
			}
		}
		expect(referenced.size).toBeGreaterThan(0);
		const copied = new Set(listExcalidrawFontFiles(path.join(REPO_ROOT, EXCALIDRAW_FONTS_SOURCE)));
		expect([...referenced].filter((uri) => !copied.has(uri))).toEqual([]);
	});
});
