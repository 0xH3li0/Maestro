/**
 * The words the conductor sees about a room's screen: the screening badge
 * (wire contract X10) and the Y4 outage banner.
 */

import { describe, expect, it } from 'vitest';
import {
	sketchScreenOutageBanner,
	sketchScreenOutageTotal,
	sketchScreeningBadgeLabel,
} from '../../../shared/sketch/room-stats';

describe('sketchScreeningBadgeLabel', () => {
	it('says local screening for a local room, whatever engine is passed', () => {
		expect(sketchScreeningBadgeLabel('local', null)).toBe('Local screening');
		expect(sketchScreeningBadgeLabel('local', 'jev')).toBe('Local screening');
	});

	it('names the cloud engine', () => {
		expect(sketchScreeningBadgeLabel('cloud', 'jev')).toBe('Cloud screening: Jev');
		expect(sketchScreeningBadgeLabel('cloud', 'openjev')).toBe('Cloud screening: OpenJev');
	});

	it('still says cloud when the engine is not known', () => {
		expect(sketchScreeningBadgeLabel('cloud', null)).toBe('Cloud screening');
	});
});

describe('sketchScreenOutageTotal', () => {
	it('sums every actor and ignores a negative count', () => {
		expect(sketchScreenOutageTotal([])).toBe(0);
		expect(
			sketchScreenOutageTotal([
				{ unavailableTotal: 2 },
				{ unavailableTotal: 0 },
				{ unavailableTotal: 3 },
				{ unavailableTotal: -1 },
			])
		).toBe(5);
	});
});

describe('sketchScreenOutageBanner', () => {
	it('is null while nothing failed', () => {
		expect(sketchScreenOutageBanner(0)).toBeNull();
	});

	it('counts the failed guest requests', () => {
		expect(sketchScreenOutageBanner(1)).toBe('Your screen failed 1 guest request');
		expect(sketchScreenOutageBanner(4)).toBe('Your screen failed 4 guest requests');
	});
});
