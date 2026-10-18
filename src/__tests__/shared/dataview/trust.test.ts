/**
 * Tests for the DataviewJS trust comparison (src/shared/dataview/trust.ts, D3, DV-12): how a vault root is
 * matched against `dataviewJsTrustedRoots`.
 */

import { describe, expect, it } from 'vitest';
import { isTrustedDataviewRoot, normalizeTrustedRoot } from '../../../shared/dataview';

describe('normalizeTrustedRoot', () => {
	it('drops surrounding whitespace and trailing separators', () => {
		expect(normalizeTrustedRoot('  /Users/me/Vault/  ')).toBe('/Users/me/Vault');
		expect(normalizeTrustedRoot('/Users/me/Vault//')).toBe('/Users/me/Vault');
		expect(normalizeTrustedRoot('C:\\Vault\\')).toBe('C:\\Vault');
	});

	it('keeps a filesystem root whole', () => {
		expect(normalizeTrustedRoot('/')).toBe('/');
		expect(normalizeTrustedRoot('//')).toBe('/');
		expect(normalizeTrustedRoot('C:\\')).toBe('C:\\');
		expect(normalizeTrustedRoot('C:\\\\')).toBe('C:\\');
		expect(normalizeTrustedRoot('')).toBe('');
	});
});

describe('isTrustedDataviewRoot', () => {
	it('matches a listed root, however its trailing separator is spelled', () => {
		expect(isTrustedDataviewRoot('/Users/me/Vault', ['/Users/me/Vault/'])).toBe(true);
		expect(isTrustedDataviewRoot('/Users/me/Vault/', ['/Users/me/Vault'])).toBe(true);
	});

	it('never trusts a parent, a child, a sibling with a shared prefix, or another case', () => {
		const trusted = ['/Users/me/Vault'];
		expect(isTrustedDataviewRoot('/Users/me', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/Users/me/Vault/Sub', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/Users/me/Vault2', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/users/me/vault', trusted)).toBe(false);
	});

	it('trusts nothing for an empty list, an empty root, or entries that are not strings', () => {
		expect(isTrustedDataviewRoot('/Users/me/Vault', [])).toBe(false);
		expect(isTrustedDataviewRoot('', [''])).toBe(false);
		expect(isTrustedDataviewRoot('  ', ['  '])).toBe(false);
		expect(isTrustedDataviewRoot('/v', [null, 1, { root: '/v' }, ['/v']])).toBe(false);
	});
});
