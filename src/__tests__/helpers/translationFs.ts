import * as path from 'node:path';
import { vi } from 'vitest';
import { localTranslationFs } from '../../shared/maestro-lib/translation/local-fs';
import type { TranslationFs } from '../../shared/maestro-lib/translation/fs-port';

/** Native paths deliberately do not exist locally, so an accidental local fallback fails. */
export function remapTranslationFs(virtualRoot: string, backingRoot: string) {
	const backingPath = (file: string): string => {
		const relative = path.relative(virtualRoot, file);
		if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
			throw new Error(`Native port received a path outside its root: ${file}`);
		return path.join(backingRoot, relative);
	};
	const virtualPath = (file: string): string => {
		const relative = path.relative(backingRoot, file);
		return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
			? file
			: path.join(virtualRoot, relative);
	};
	const nativeFs = {
		paths: path as path.PlatformPath,
		readFile: vi.fn<TranslationFs['readFile']>((file) =>
			localTranslationFs.readFile(backingPath(file))
		),
		readdir: vi.fn<TranslationFs['readdir']>((file, options) =>
			localTranslationFs.readdir(backingPath(file), options)
		),
		stat: vi.fn<TranslationFs['stat']>((file) => localTranslationFs.stat(backingPath(file))),
		lstat: vi.fn<TranslationFs['lstat']>((file) => localTranslationFs.lstat(backingPath(file))),
		realpath: vi.fn<TranslationFs['realpath']>(async (file) =>
			virtualPath(await localTranslationFs.realpath(backingPath(file)))
		),
		mkdir: vi.fn<TranslationFs['mkdir']>((file, options) =>
			localTranslationFs.mkdir(backingPath(file), options)
		),
		createExclusive: vi.fn<TranslationFs['createExclusive']>((file, bytes, options) =>
			localTranslationFs.createExclusive(backingPath(file), bytes, options)
		),
		atomicWrite: vi.fn<TranslationFs['atomicWrite']>((file, bytes, options) =>
			localTranslationFs.atomicWrite(backingPath(file), bytes, options)
		),
		unlink: vi.fn<TranslationFs['unlink']>((file) => localTranslationFs.unlink(backingPath(file))),
		symlink: vi.fn<TranslationFs['symlink']>((target, file) =>
			localTranslationFs.symlink(
				path.isAbsolute(target) ? backingPath(target) : target,
				backingPath(file)
			)
		),
		readlink: vi.fn<TranslationFs['readlink']>(async (file) => {
			const target = await localTranslationFs.readlink(backingPath(file));
			return path.isAbsolute(target) ? virtualPath(target) : target;
		}),
		exists: vi.fn<TranslationFs['exists']>((file) => localTranslationFs.exists(backingPath(file))),
	} satisfies TranslationFs;
	return { nativeFs, backingPath };
}
