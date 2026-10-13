/**
 * Consultation budget - the setting's contract (key, default, range).
 *
 * Three processes read the stored value (the renderer, main, and the CLI), and
 * the CLI can write any JSON under the key, so the normalizer is the only thing
 * standing between a hand-written value and the enforcement code.
 */

import { describe, it, expect } from 'vitest';

import {
	CONSULT_CHAIN_ENV_VAR,
	CONSULT_DEPTH_ENV_VAR,
	DEFAULT_MAX_CONSULTATIONS_PER_TURN,
	MAX_CONSULTATIONS_PER_TURN_CEILING,
	MAX_CONSULTATIONS_PER_TURN_SETTING,
	buildConsultChainEnv,
	childConsultChain,
	isConsultChainId,
	normalizeMaxConsultationsPerTurn,
	parseConsultChain,
	readConsultChainEnv,
	withoutConsultChainEnv,
} from '../../shared/consultBudget';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

describe('consultBudget', () => {
	it('defaults to 25', () => {
		expect(DEFAULT_MAX_CONSULTATIONS_PER_TURN).toBe(25);
	});

	it('names a key the settings registry knows, with the same default', () => {
		const meta = SETTINGS_METADATA[MAX_CONSULTATIONS_PER_TURN_SETTING];
		expect(meta).toBeDefined();
		expect(meta.type).toBe('number');
		expect(meta.default).toBe(DEFAULT_MAX_CONSULTATIONS_PER_TURN);
		expect(meta.description).toContain(`0-${MAX_CONSULTATIONS_PER_TURN_CEILING}`);
	});

	describe('normalizeMaxConsultationsPerTurn', () => {
		it('keeps 0, which turns peer consults off rather than meaning unset', () => {
			expect(normalizeMaxConsultationsPerTurn(0)).toBe(0);
		});

		it('keeps a whole number in range', () => {
			expect(normalizeMaxConsultationsPerTurn(1)).toBe(1);
			expect(normalizeMaxConsultationsPerTurn(25)).toBe(25);
			expect(normalizeMaxConsultationsPerTurn(MAX_CONSULTATIONS_PER_TURN_CEILING)).toBe(
				MAX_CONSULTATIONS_PER_TURN_CEILING
			);
		});

		it('rounds a fraction down, so a budget is never more than was typed', () => {
			expect(normalizeMaxConsultationsPerTurn(3.9)).toBe(3);
			expect(normalizeMaxConsultationsPerTurn(0.5)).toBe(0);
		});

		it('clamps below 0 and above the ceiling', () => {
			expect(normalizeMaxConsultationsPerTurn(-1)).toBe(0);
			expect(normalizeMaxConsultationsPerTurn(MAX_CONSULTATIONS_PER_TURN_CEILING + 1)).toBe(
				MAX_CONSULTATIONS_PER_TURN_CEILING
			);
		});

		it.each([undefined, null, '25', '', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY])(
			'reads %j as the default',
			(raw) => {
				expect(normalizeMaxConsultationsPerTurn(raw)).toBe(DEFAULT_MAX_CONSULTATIONS_PER_TURN);
			}
		);
	});

	describe('isConsultChainId', () => {
		it('accepts a UUID and other plain ids', () => {
			expect(isConsultChainId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
			expect(isConsultChainId('chain_1')).toBe(true);
			expect(isConsultChainId('a')).toBe(true);
			expect(isConsultChainId('a'.repeat(64))).toBe(true);
		});

		it.each([
			'',
			' ',
			'a b',
			'-leading-dash',
			'__proto__',
			'../escape',
			'a/b',
			'a.b',
			'a'.repeat(65),
			undefined,
			null,
			42,
			{},
		])('refuses %j', (value) => {
			expect(isConsultChainId(value)).toBe(false);
		});
	});

	describe('the chain in the environment', () => {
		it('round-trips the chain id and depth', () => {
			const env = buildConsultChainEnv({ chainId: 'chain-1', depth: 2 });
			expect(env).toEqual({ [CONSULT_CHAIN_ENV_VAR]: 'chain-1', [CONSULT_DEPTH_ENV_VAR]: '2' });
			expect(readConsultChainEnv(env)).toEqual({ chainId: 'chain-1', depth: 2 });
		});

		it('uses the variable names the CLI and the docs name', () => {
			expect(CONSULT_CHAIN_ENV_VAR).toBe('MAESTRO_CONSULT_CHAIN');
			expect(CONSULT_DEPTH_ENV_VAR).toBe('MAESTRO_CONSULT_DEPTH');
		});

		it('reads no chain from an environment that has none, or a blank one', () => {
			expect(readConsultChainEnv({})).toBeUndefined();
			expect(readConsultChainEnv({ [CONSULT_CHAIN_ENV_VAR]: '  ' })).toBeUndefined();
			expect(readConsultChainEnv({ [CONSULT_DEPTH_ENV_VAR]: '3' })).toBeUndefined();
		});

		it('reads no chain from an id the counter would refuse', () => {
			expect(
				readConsultChainEnv({ [CONSULT_CHAIN_ENV_VAR]: '../escape', [CONSULT_DEPTH_ENV_VAR]: '1' })
			).toBeUndefined();
		});

		it.each([undefined, '', 'deep', '-1', '1.5', '1e2', ' '])(
			'keeps the chain and reads depth %j as 0, so a damaged depth never resets the budget',
			(depth) => {
				expect(
					readConsultChainEnv({
						[CONSULT_CHAIN_ENV_VAR]: 'chain-1',
						[CONSULT_DEPTH_ENV_VAR]: depth,
					})
				).toEqual({ chainId: 'chain-1', depth: 0 });
			}
		);
	});

	describe('parseConsultChain', () => {
		it('narrows a chain that arrived as data', () => {
			expect(parseConsultChain({ chainId: 'chain-1', depth: 3, extra: true })).toEqual({
				chainId: 'chain-1',
				depth: 3,
			});
			expect(parseConsultChain({ chainId: 'chain-1', depth: '4' })).toEqual({
				chainId: 'chain-1',
				depth: 4,
			});
		});

		it.each([undefined, null, 'chain-1', 7, [], {}, { depth: 1 }, { chainId: 'a b', depth: 1 }])(
			'reads %j as no chain',
			(value) => {
				expect(parseConsultChain(value)).toBeUndefined();
			}
		);

		it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}])(
			'reads depth %j as 0',
			(depth) => {
				expect(parseConsultChain({ chainId: 'chain-1', depth })).toEqual({
					chainId: 'chain-1',
					depth: 0,
				});
			}
		);
	});

	describe('childConsultChain', () => {
		it('keeps the chain and goes one hop deeper', () => {
			const root = { chainId: 'chain-1', depth: 0 };
			expect(childConsultChain(root)).toEqual({ chainId: 'chain-1', depth: 1 });
			expect(childConsultChain(childConsultChain(root))).toEqual({ chainId: 'chain-1', depth: 2 });
			expect(root).toEqual({ chainId: 'chain-1', depth: 0 });
		});
	});

	describe('withoutConsultChainEnv', () => {
		it('collapses a chain-only record to undefined, like an agent with no overrides', () => {
			expect(
				withoutConsultChainEnv(buildConsultChainEnv({ chainId: 'chain-1', depth: 0 }))
			).toBeUndefined();
			expect(withoutConsultChainEnv(undefined)).toBeUndefined();
		});

		it('keeps real configuration and leaves the input untouched', () => {
			const env = {
				...buildConsultChainEnv({ chainId: 'chain-1', depth: 0 }),
				CLAUDE_CONFIG_DIR: '/cfg',
			};
			expect(withoutConsultChainEnv(env)).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
			expect(env).toHaveProperty(CONSULT_CHAIN_ENV_VAR);
		});
	});
});
