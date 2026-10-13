/**
 * Consultation budget - the setting's contract (key, default, range).
 *
 * Three processes read the stored value (the renderer, main, and the CLI), and
 * the CLI can write any JSON under the key, so the normalizer is the only thing
 * standing between a hand-written value and the enforcement code.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_MAX_CONSULTATIONS_PER_TURN,
	MAX_CONSULTATIONS_PER_TURN_CEILING,
	MAX_CONSULTATIONS_PER_TURN_SETTING,
	isConsultChainId,
	normalizeMaxConsultationsPerTurn,
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
});
