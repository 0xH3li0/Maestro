/**
 * @file floatingWidgets.test.ts
 * @description The floating-widget contract: id validation, the widget specs,
 * and the throughput gauge's command guard.
 */

import { describe, it, expect } from 'vitest';
import {
	FLOATING_WIDGET_IDS,
	FLOATING_WIDGET_SPECS,
	isFloatingWidgetId,
	isThroughputGaugeWidgetCommand,
} from '../../shared/floatingWidgets';

describe('isFloatingWidgetId', () => {
	it('accepts every known widget id', () => {
		for (const id of FLOATING_WIDGET_IDS) {
			expect(isFloatingWidgetId(id)).toBe(true);
		}
	});

	it('refuses unknown strings, including near misses', () => {
		expect(isFloatingWidgetId('')).toBe(false);
		expect(isFloatingWidgetId('throughput')).toBe(false);
		expect(isFloatingWidgetId('Throughput-Gauge')).toBe(false);
		expect(isFloatingWidgetId(' media-player')).toBe(false);
		expect(isFloatingWidgetId('constructor')).toBe(false);
	});

	it('refuses values that are not strings', () => {
		for (const value of [undefined, null, 0, 1, true, {}, [], ['media-player']]) {
			expect(isFloatingWidgetId(value)).toBe(false);
		}
	});
});

describe('FLOATING_WIDGET_SPECS', () => {
	it('has one spec per id, keyed by its own id', () => {
		expect(Object.keys(FLOATING_WIDGET_SPECS).sort()).toEqual([...FLOATING_WIDGET_IDS].sort());
		for (const id of FLOATING_WIDGET_IDS) {
			expect(FLOATING_WIDGET_SPECS[id].id).toBe(id);
		}
	});

	it('names the window that owns each widget', () => {
		expect(FLOATING_WIDGET_SPECS['throughput-gauge'].authority).toBe('app');
		expect(FLOATING_WIDGET_SPECS['media-player'].authority).toBe('widget');
	});

	it('never opens a widget below its own minimum size', () => {
		for (const id of FLOATING_WIDGET_IDS) {
			const { defaultSize, minSize } = FLOATING_WIDGET_SPECS[id];
			expect(defaultSize.width).toBeGreaterThanOrEqual(minSize.width);
			expect(defaultSize.height).toBeGreaterThanOrEqual(minSize.height);
		}
	});
});

describe('isThroughputGaugeWidgetCommand', () => {
	it('accepts the hide and reset-peak commands', () => {
		expect(isThroughputGaugeWidgetCommand({ type: 'hide' })).toBe(true);
		expect(isThroughputGaugeWidgetCommand({ type: 'reset-peak' })).toBe(true);
	});

	it('refuses unknown or misspelled command types', () => {
		for (const type of ['', 'show', 'Hide', 'reset', 'resetPeak', 'toString', 'constructor']) {
			expect(isThroughputGaugeWidgetCommand({ type })).toBe(false);
		}
	});

	it('refuses values that are not command objects', () => {
		for (const value of [
			undefined,
			null,
			'hide',
			0,
			true,
			{},
			[],
			['hide'],
			{ type: 1 },
			{ kind: 'hide' },
		]) {
			expect(isThroughputGaugeWidgetCommand(value)).toBe(false);
		}
	});
});
