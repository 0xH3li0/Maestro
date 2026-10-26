import { describe, expect, it } from 'vitest';
import {
	collectSketchOutboundTexts,
	forbiddenSketchPatchKeys,
	mergeNewerSketchElements,
	replaceSketchOutboundTexts,
} from '../../../shared/sketch/agent-writes';

describe('outbound text walk', () => {
	const skeletons = [
		{ type: 'rectangle', id: 'r1', label: { text: 'Login', fontSize: 20 }, link: 'https://x.test' },
		{ type: 'frame', name: 'Flow', children: ['r1'] },
		{ type: 'arrow', x: 0, y: 0, start: { id: 'r1' }, end: { type: 'text', text: 'Home' } },
		{ type: 'text', x: 0, y: 0, text: 'note', originalText: 'note', strokeColor: '#000' },
	];

	it('lists every text field at any depth, in a fixed order, and nothing else', () => {
		expect(collectSketchOutboundTexts(skeletons)).toEqual([
			'Login',
			'https://x.test',
			'Flow',
			'Home',
			'note',
			'note',
		]);
	});

	it('puts screened texts back in the same order without touching other fields', () => {
		const texts = collectSketchOutboundTexts(skeletons).map((text) => text.toUpperCase());
		const replaced = replaceSketchOutboundTexts(skeletons, texts);
		expect(replaced[0]).toEqual({
			type: 'rectangle',
			id: 'r1',
			label: { text: 'LOGIN', fontSize: 20 },
			link: 'HTTPS://X.TEST',
		});
		expect(replaced[2]).toMatchObject({ start: { id: 'r1' }, end: { type: 'text', text: 'HOME' } });
		expect(replaced[3]).toMatchObject({ text: 'NOTE', strokeColor: '#000' });
		// The input is not changed.
		expect(collectSketchOutboundTexts(skeletons)[0]).toBe('Login');
	});

	it('refuses a replacement list of the wrong length', () => {
		expect(() => replaceSketchOutboundTexts(skeletons, ['one'])).toThrow('mismatch');
		const all = collectSketchOutboundTexts(skeletons);
		expect(() => replaceSketchOutboundTexts(skeletons, [...all, 'extra'])).toThrow('mismatch');
	});

	it('refuses a description nested past the depth limit', () => {
		let nested: Record<string, unknown> = { text: 'deep' };
		for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
		expect(() => collectSketchOutboundTexts(nested)).toThrow('nested too deeply');
	});
});

describe('forbiddenSketchPatchKeys', () => {
	it('names the fields a patch may not set, sorted', () => {
		expect(forbiddenSketchPatchKeys({ x: 1, version: 3, customData: {}, isDeleted: true })).toEqual(
			['customData', 'isDeleted', 'version']
		);
		expect(forbiddenSketchPatchKeys({ x: 1, text: 'ok', strokeColor: '#f00' })).toEqual([]);
	});
});

describe('mergeNewerSketchElements', () => {
	it('takes newer versions, keeps the view where it is newer or equal, and appends new elements', () => {
		const viewA = { id: 'a', version: 2 };
		const viewB = { id: 'b', version: 5 };
		const merged = mergeNewerSketchElements(
			[viewA, viewB],
			[
				{ id: 'b', version: 4 },
				{ id: 'a', version: 3, x: 9 },
				{ id: 'c', version: 1 },
			]
		);
		expect(merged).toEqual([{ id: 'a', version: 3, x: 9 }, viewB, { id: 'c', version: 1 }]);
		expect(merged[1]).toBe(viewB);
	});

	it('hands back copies, never the incoming objects', () => {
		const incoming = { id: 'c', version: 1 };
		const [copy] = mergeNewerSketchElements([], [incoming]);
		expect(copy).toEqual(incoming);
		expect(copy).not.toBe(incoming);
	});
});
