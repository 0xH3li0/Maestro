/**
 * Tests for the Sketch Book plaintext payload codecs
 * (src/shared/sketch/payloads.ts): a round trip of every payload kind, the
 * fields each kind keeps, and the failure modes of `encodePayload` (throws)
 * and `decodePayload` (never throws).
 */

import { describe, it, expect } from 'vitest';
import {
	CHAT_MAX_CHARS,
	decodePayload,
	encodePayload,
	payloadCharCount,
	sceneSnapshotPayloads,
	SKETCH_PAYLOAD_KINDS,
	type SketchPayloadByKind,
	type SketchPayloadKind,
} from '../../../shared/sketch/payloads';

const rectangle = {
	id: 'el-1',
	type: 'rectangle',
	version: 3,
	versionNonce: 42,
	x: 10,
	y: 20,
	width: 100,
	height: 50,
	strokeColor: '#9146ff',
};

/** One full payload per kind, every optional field set. */
const SAMPLES: { [K in SketchPayloadKind]: SketchPayloadByKind[K] } = {
	delta: { v: 1, elements: [rectangle, { id: 'el-2', version: 7, isDeleted: true }] },
	snapshot: {
		v: 1,
		type: 'excalidraw',
		elements: [rectangle],
		appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
		files: ['file-1'],
	},
	file: {
		v: 1,
		id: 'file-1',
		mimeType: 'image/png',
		dataURL: 'data:image/png;base64,iVBORw0KGgo=',
		created: 1_700_000_000_000,
	},
	chat: { v: 1, text: 'Draw the auth flow, please.' },
	'bot.reply': { v: 1, text: 'Added three boxes.', elementIds: ['el-1', 'el-2'] },
	presence: {
		v: 1,
		pointer: { x: 1.5, y: -2 },
		button: 'down',
		selectedElementIds: ['el-1'],
		username: 'Ada',
	},
};

/** One invalid payload per kind. */
const INVALID: Record<SketchPayloadKind, unknown> = {
	delta: { v: 1, elements: [{ id: 'el-1', version: 1.5 }] },
	snapshot: { ...SAMPLES.snapshot, type: 'tldraw' },
	file: { ...SAMPLES.file, dataURL: 'https://cdn.example.com/x.png' },
	chat: { v: 1, text: 42 },
	'bot.reply': { v: 1, text: 'ok', elementIds: [1, 2] },
	presence: { v: 1, button: 'middle' },
};

function decodeOk<K extends SketchPayloadKind>(kind: K, json: string): SketchPayloadByKind[K] {
	const result = decodePayload(kind, json);
	if (!result.ok) throw new Error(`expected ${kind} to decode, got ${result.error}`);
	return result.payload;
}

describe('sketch payload kinds', () => {
	it('lists every kind of contract section 3', () => {
		expect([...SKETCH_PAYLOAD_KINDS].sort()).toEqual(
			['bot.reply', 'chat', 'delta', 'file', 'presence', 'snapshot'].sort()
		);
	});
});

describe('encodePayload / decodePayload round trips', () => {
	for (const kind of SKETCH_PAYLOAD_KINDS) {
		it(`round-trips a full ${kind} payload`, () => {
			const json = encodePayload(kind, SAMPLES[kind]);
			expect(decodeOk(kind, json)).toEqual(SAMPLES[kind]);
		});

		it(`rejects an invalid ${kind} payload on both sides`, () => {
			expect(() => encodePayload(kind, INVALID[kind] as never)).toThrow(`Sketch ${kind} payload:`);
			const result = decodePayload(kind, JSON.stringify(INVALID[kind]));
			expect(result.ok).toBe(false);
		});

		it(`rejects a ${kind} payload with the wrong version`, () => {
			const result = decodePayload(kind, JSON.stringify({ ...SAMPLES[kind], v: 2 }));
			expect(result).toEqual({ ok: false, error: 'v must be 1' });
		});
	}

	it('round-trips the minimal optional shapes', () => {
		expect(decodeOk('presence', encodePayload('presence', { v: 1 }))).toEqual({ v: 1 });
		expect(decodeOk('bot.reply', encodePayload('bot.reply', { v: 1, text: '' }))).toEqual({
			v: 1,
			text: '',
		});
		const snapshot = {
			...SAMPLES.snapshot,
			appState: { viewBackgroundColor: '#000', gridSize: null },
		};
		expect(decodeOk('snapshot', encodePayload('snapshot', snapshot))).toEqual(snapshot);
	});
});

describe('payload field rules', () => {
	it('keeps every Excalidraw element field as sent', () => {
		const [element] = decodeOk('delta', JSON.stringify({ v: 1, elements: [rectangle] })).elements;
		expect(element).toEqual(rectangle);
	});

	it('drops unknown top-level fields', () => {
		const chat = decodeOk('chat', JSON.stringify({ v: 1, text: 'hi', name: 'Mallory' }));
		expect(chat).toEqual({ v: 1, text: 'hi' });
		const appState = decodeOk(
			'snapshot',
			JSON.stringify({
				...SAMPLES.snapshot,
				appState: { viewBackgroundColor: '#fff', gridSize: null, theme: 'dark' },
			})
		).appState;
		expect(appState).toEqual({ viewBackgroundColor: '#fff', gridSize: null });
		const presence = decodeOk(
			'presence',
			JSON.stringify({ v: 1, pointer: { x: 1, y: 2, tool: 'laser' } })
		);
		expect(presence).toEqual({ v: 1, pointer: { x: 1, y: 2 } });
	});

	it('requires element id and an integer version, and a boolean isDeleted', () => {
		for (const bad of [
			{ version: 1 },
			{ id: '', version: 1 },
			{ id: 'el', version: '1' },
			{ id: 'el', version: 1, isDeleted: 'yes' },
		]) {
			expect(decodePayload('delta', JSON.stringify({ v: 1, elements: [bad] })).ok).toBe(false);
		}
	});

	it('caps chat and bot.reply text at 4,000 code points', () => {
		const atCap = '\u{1F600}'.repeat(CHAT_MAX_CHARS);
		expect(payloadCharCount(atCap)).toBe(CHAT_MAX_CHARS);
		expect(atCap.length).toBe(CHAT_MAX_CHARS * 2);
		expect(decodePayload('chat', JSON.stringify({ v: 1, text: atCap })).ok).toBe(true);
		const over = `${atCap}x`;
		expect(decodePayload('chat', JSON.stringify({ v: 1, text: over }))).toEqual({
			ok: false,
			error: `text over ${CHAT_MAX_CHARS} characters`,
		});
		expect(() => encodePayload('bot.reply', { v: 1, text: over })).toThrow(/characters/);
	});

	it('rejects a non-finite pointer and a non-string username', () => {
		expect(decodePayload('presence', '{"v":1,"pointer":{"x":"1","y":2}}').ok).toBe(false);
		expect(decodePayload('presence', '{"v":1,"username":7}').ok).toBe(false);
	});

	it('rejects a file without a data URL or a numeric created time', () => {
		expect(decodePayload('file', JSON.stringify({ ...SAMPLES.file, created: 'now' })).ok).toBe(
			false
		);
		expect(decodePayload('file', JSON.stringify({ ...SAMPLES.file, id: '' })).ok).toBe(false);
	});
});

describe('decodePayload never throws', () => {
	it('returns an error for invalid json and non-objects', () => {
		expect(decodePayload('chat', '{oops')).toEqual({ ok: false, error: 'invalid json' });
		for (const raw of ['null', '[]', '"text"', '42']) {
			expect(() => decodePayload('chat', raw)).not.toThrow();
			expect(decodePayload('chat', raw).ok).toBe(false);
		}
	});

	it('returns an error for an unknown kind', () => {
		const result = decodePayload('bogus' as SketchPayloadKind, '{"v":1}');
		expect(result).toEqual({ ok: false, error: 'unknown kind bogus' });
	});
});

describe('sceneSnapshotPayloads', () => {
	const image = {
		id: 'file-1',
		mimeType: 'image/png',
		dataURL: 'data:image/png;base64,AAAA',
		created: 5,
	};

	it('makes a snapshot naming every usable file, and one file payload each', () => {
		const { snapshot, files } = sceneSnapshotPayloads({
			elements: [rectangle],
			appState: { viewBackgroundColor: '#123456', gridSize: 20, zoom: { value: 2 } },
			files: { 'file-1': image },
		});
		expect(snapshot).toEqual({
			v: 1,
			type: 'excalidraw',
			elements: [rectangle],
			appState: { viewBackgroundColor: '#123456', gridSize: 20 },
			files: ['file-1'],
		});
		expect(files).toEqual([{ v: 1, ...image }]);
		// Both pass the guards the guest client runs.
		expect(() => encodePayload('snapshot', snapshot)).not.toThrow();
		expect(() => encodePayload('file', files[0])).not.toThrow();
	});

	it('defaults the background and grid, and leaves out a file that is not a binary file', () => {
		const { snapshot, files } = sceneSnapshotPayloads({
			elements: [],
			appState: {},
			files: {
				bad: { mimeType: 'image/png', dataURL: 'https://example.com/x.png' },
				'no-time': { mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' },
				junk: 'x',
			},
		});
		expect(snapshot.appState).toEqual({ viewBackgroundColor: '#ffffff', gridSize: null });
		expect(snapshot.files).toEqual(['no-time']);
		expect(files.map((file) => [file.id, file.created])).toEqual([['no-time', 0]]);
	});
});
