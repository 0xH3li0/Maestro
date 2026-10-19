/**
 * @file floatingWidgets.test.ts
 * @description The floating-widget contract: id validation and the widget specs.
 */

import { describe, it, expect } from 'vitest';
import {
	FLOATING_WIDGET_IDS,
	FLOATING_WIDGET_SPECS,
	isFloatingWidgetId,
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

	it('never opens a widget below its own minimum size', () => {
		for (const id of FLOATING_WIDGET_IDS) {
			const { defaultSize, minSize } = FLOATING_WIDGET_SPECS[id];
			expect(defaultSize.width).toBeGreaterThanOrEqual(minSize.width);
			expect(defaultSize.height).toBeGreaterThanOrEqual(minSize.height);
		}
	});
});
