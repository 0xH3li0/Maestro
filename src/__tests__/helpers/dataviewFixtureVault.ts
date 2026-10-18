/**
 * The shared Dataview fixture vault (src/__tests__/fixtures/dataview-vault/) and the creation-time
 * rule its README sets: file creation time on disk is not stable, so tests stub `file.ctime` (and so
 * `file.cday`) from each note's frontmatter `created` date.
 */

import path from 'path';
import { DateTime } from 'luxon';
import type { VaultFs } from '../../main/dataview/vault-fs';

export const DATAVIEW_FIXTURE_VAULT = path.resolve(__dirname, '..', 'fixtures', 'dataview-vault');

/** The note's `created` date read from its raw text, so a note whose YAML is broken still gets one. */
export function fixtureCreatedTime(content: string): number {
	const match = /^created: (\d{4}-\d{2}-\d{2})$/m.exec(content);
	if (!match) throw new Error('fixture note has no frontmatter created date');
	return DateTime.fromISO(match[1]).toMillis();
}

/**
 * Wrap a `VaultFs` so every listed page's `ctime` is its frontmatter `created` date. A page without
 * one (the vault README) keeps the time the file system reported.
 */
export function withFixtureCreatedTimes(vaultFs: VaultFs): VaultFs {
	return {
		...vaultFs,
		async list() {
			const listing = await vaultFs.list();
			for (const [relPath, stat] of listing.stats) {
				const content = await vaultFs.readText(relPath);
				if (/^created: /m.test(content)) stat.ctime = fixtureCreatedTime(content);
			}
			return listing;
		},
	};
}
