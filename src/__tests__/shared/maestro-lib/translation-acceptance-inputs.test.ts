// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
	acceptanceProviderVersion,
	validateAcceptanceInputs,
} from '../../../../scripts/provider-translation-acceptance/driver';

describe('prepared acceptance authorization', () => {
	it.each([
		['claude-code', '2.1.296 (Claude Code)', '2.1.296'],
		['claude-code', '2.1.301 (Claude Code)', '2.1.301'],
		['claude-code', '2.1.297-rc.1 (Claude Code)', '2.1.297-rc.1'],
		['claude-code', '2.1.296+build.1 (Claude Code)', '2.1.296+build.1'],
		['codex', 'codex-cli 0.163.0\n', '0.163.0'],
	] as const)(
		'uses range preflight and preserves %s version from %s',
		(provider, output, version) => {
			expect(acceptanceProviderVersion(provider, output)).toBe(version);
		}
	);
	it.each([
		['claude-code', '2.1.295 (Claude Code)'],
		['claude-code', '2.1.296-rc.1 (Claude Code)'],
		['claude-code', '2.1.296garbage (Claude Code)'],
		['claude-code', 'garbage'],
		['codex', 'codex-cli 0.162.0'],
		['codex', ''],
	] as const)('refuses unsupported %s version output %s', (provider, output) => {
		expect(() => acceptanceProviderVersion(provider, output)).toThrow('no declared schema mapping');
	});
	it('requires explicit opt-in and refuses credentials outside checkout scratch', () => {
		const workspace = '/isolated/project';
		expect(() => validateAcceptanceInputs(workspace, [])).toThrow('explicit opt-in');
		const args = [
			'--execute-isolated-acceptance',
			'--claude-auth',
			'/default/.claude/credentials',
			'--codex-auth',
			'/isolated/project/.maestro/scratch/auth.json',
			'--recall-question',
			'Recall a synthetic fact',
			'--expected-recall',
			'azure kite',
		];
		expect(() => validateAcceptanceInputs(workspace, args)).toThrow('checkout scratch');
		args[2] = '/isolated/project/.maestro/scratch/claude.json';
		expect(validateAcceptanceInputs(workspace, args).expected).toBe('azure kite');
		expect(() => validateAcceptanceInputs(workspace, args.slice(0, -2))).toThrow(
			'--expected-recall'
		);
	});
});
