/**
 * DataviewJS trust (D3, DV-12): the vault roots whose scripts run without asking, listed in the setting
 * `dataviewJsTrustedRoots`. One comparison rule, so main (which refuses a DataviewJS snapshot or file read in
 * an untrusted root), the renderer, and the CLI agree on what "trusted" means.
 *
 * A root is compared as main spells an index root (`DataviewQueryResponse.root`): an absolute local path, or a
 * POSIX path on an SSH remote. The list holds plain strings, so a trusted root trusts that path on every host.
 */

/**
 * `root` as the trust list stores and compares it: surrounding whitespace and trailing separators dropped (the
 * settings store trims entries too). A filesystem root keeps its separator: `/` and `C:\` stay as they are.
 */
export function normalizeTrustedRoot(root: string): string {
	const trimmed = root.trim();
	const stripped = trimmed.replace(/[/\\]+$/, '');
	if (stripped === '') return trimmed.slice(0, 1);
	if (/^[A-Za-z]:$/.test(stripped)) return trimmed.slice(0, 3);
	return stripped;
}

/** Whether `root` is in `trustedRoots`. Entries that are not strings are ignored. */
export function isTrustedDataviewRoot(root: string, trustedRoots: readonly unknown[]): boolean {
	const wanted = normalizeTrustedRoot(root);
	if (wanted === '') return false;
	return trustedRoots.some(
		(entry) => typeof entry === 'string' && normalizeTrustedRoot(entry) === wanted
	);
}
