/**
 * How the cloud screening confirmation names the engine and its host, the
 * words it shows (spec section 8.10, G2 and G4), and the key that keeps a
 * dismissed question shut.
 */

import { describe, expect, it } from 'vitest';
import {
	sketchCloudConfirmKey,
	sketchCloudEngineWhere,
	sketchCloudScreeningDisclosure,
	SKETCH_CLOUD_SCREENING_GUEST_BADGE,
} from '../../../shared/sketch/cloud-consent';

describe('sketchCloudEngineWhere', () => {
	it('names Jev with its maker and host, defaulting to the hosted service', () => {
		expect(sketchCloudEngineWhere('jev', 'api.typesafe.ai')).toBe(
			'Jev, by TypeSafe, api.typesafe.ai'
		);
		expect(sketchCloudEngineWhere('jev')).toBe('Jev, by TypeSafe, api.typesafe.ai');
	});

	it('names an OpenJev server by its host', () => {
		expect(sketchCloudEngineWhere('openjev', 'gpu.example.com:8000')).toBe(
			'OpenJev at gpu.example.com:8000'
		);
		expect(sketchCloudEngineWhere('openjev')).toBe('OpenJev');
	});
});

describe('sketchCloudScreeningDisclosure', () => {
	it('names the host, what leaves the machine, and the badge guests will see', () => {
		const disclosure = sketchCloudScreeningDisclosure({
			engine: 'openjev',
			host: 'gpu.example.com',
			reason: 'grant',
		});
		expect(disclosure.message).toContain('OpenJev at gpu.example.com');
		expect(disclosure.detail).toContain('decrypted guest chat and canvas text');
		expect(disclosure.detail).toContain(`"${SKETCH_CLOUD_SCREENING_GUEST_BADGE}"`);
	});
});

describe('sketchCloudConfirmKey', () => {
	it('tells questions apart by engine, host and reason, ignoring host case', () => {
		const jev = sketchCloudConfirmKey({ engine: 'jev', reason: 'grant' });
		expect(sketchCloudConfirmKey({ engine: 'jev', reason: 'live-switch' })).not.toBe(jev);
		expect(sketchCloudConfirmKey({ engine: 'openjev', host: 'A.example', reason: 'grant' })).toBe(
			sketchCloudConfirmKey({ engine: 'openjev', host: 'a.example', reason: 'grant' })
		);
		expect(
			sketchCloudConfirmKey({ engine: 'openjev', host: 'a.example', reason: 'grant' })
		).not.toBe(sketchCloudConfirmKey({ engine: 'openjev', host: 'b.example', reason: 'grant' }));
	});
});
