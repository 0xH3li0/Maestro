/**
 * Tests for the shared provider-availability rules behind both pickers.
 */

import { describe, expect, it } from 'vitest';
import {
	filterToAvailableProviders,
	providerLocationLabel,
	tabProviderSwitchProblem,
} from '../../../renderer/utils/providerAvailability';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

interface Provider {
	id: string;
	available: boolean;
}

const PROVIDERS: Provider[] = [
	{ id: 'claude-code', available: true },
	{ id: 'codex', available: false },
	{ id: 'opencode', available: true },
];

const isAvailable = (provider: Provider) => provider.available;

describe('filterToAvailableProviders', () => {
	it('hides what this machine cannot run', () => {
		expect(filterToAvailableProviders(PROVIDERS, isAvailable, false).map((p) => p.id)).toEqual([
			'claude-code',
			'opencode',
		]);
	});

	it('returns everything when asked to show all', () => {
		expect(filterToAvailableProviders(PROVIDERS, isAvailable, true)).toEqual(PROVIDERS);
	});

	it('falls back to the full list when nothing is installed', () => {
		// A picker filtered to zero rows has no way to reach per-provider settings
		// and no way to proceed - it is a dead end, not an empty state.
		const none = PROVIDERS.map((p) => ({ ...p, available: false }));
		expect(filterToAvailableProviders(none, isAvailable, false)).toEqual(none);
	});

	it('falls back to the full list when nothing is installed, even with a pinned row', () => {
		// The availability bar reads "nothing detected" as "showing everything", so
		// a pin must not turn the fallback into a one-row list.
		const none = PROVIDERS.map((p) => ({ ...p, available: false }));
		expect(filterToAvailableProviders(none, isAvailable, false, (p) => p.id === 'codex')).toEqual(
			none
		);
	});

	it('keeps a pinned provider that would otherwise be filtered out', () => {
		expect(
			filterToAvailableProviders(PROVIDERS, isAvailable, false, (p) => p.id === 'codex').map(
				(p) => p.id
			)
		).toEqual(['claude-code', 'codex', 'opencode']);
	});

	it('does not duplicate a pinned provider that is already available', () => {
		expect(
			filterToAvailableProviders(PROVIDERS, isAvailable, false, (p) => p.id === 'claude-code').map(
				(p) => p.id
			)
		).toEqual(['claude-code', 'opencode']);
	});

	it('preserves the input order rather than floating the available ones', () => {
		// The pickers sort before filtering, so reordering here would silently
		// override the order the caller chose.
		const reversed = [...PROVIDERS].reverse();
		expect(filterToAvailableProviders(reversed, isAvailable, false).map((p) => p.id)).toEqual([
			'opencode',
			'claude-code',
		]);
	});
});

describe('providerLocationLabel', () => {
	it('names the remote host when detection ran over SSH', () => {
		expect(providerLocationLabel('build-box')).toBe('on build-box');
	});

	it('says locally when no remote is selected', () => {
		expect(providerLocationLabel()).toBe('locally');
		expect(providerLocationLabel(null)).toBe('locally');
		expect(providerLocationLabel('')).toBe('locally');
	});
});

describe('tabProviderSwitchProblem', () => {
	const session = createMockSession({ toolType: 'claude-code' });
	const tab = createMockAITab();
	it('shares flag, direction and availability refusals with the switch action', () => {
		expect(tabProviderSwitchProblem(session, tab, 'codex', false, true)).toContain(
			'Ensemble is disabled'
		);
		expect(tabProviderSwitchProblem(session, tab, 'opencode', true, true)).toContain(
			'from Claude Code to OpenCode is not available'
		);
		expect(tabProviderSwitchProblem(session, tab, 'codex', true, false)).toContain(
			'Codex is not installed on this host'
		);
		expect(tabProviderSwitchProblem(session, tab, 'codex', true, true)).toBeUndefined();
	});
	it('keeps the current provider usable even when detection stops finding it', () => {
		expect(tabProviderSwitchProblem(session, tab, 'claude-code', true, false)).toBeUndefined();
	});
	it('disables same-provider pins and inheritance on SSH', () => {
		expect(
			tabProviderSwitchProblem(
				{ ...session, sshRemoteId: 'remote' },
				tab,
				'claude-code',
				true,
				true
			)
		).toContain('live SSH acceptance was skipped');
	});
});
