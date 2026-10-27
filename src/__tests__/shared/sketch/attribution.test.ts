/**
 * Tests for Sketch Book attribution (src/shared/sketch/attribution.ts, spec
 * section 7): the display stamp `stampLocalEdits` writes into `customData`,
 * and the author map entry `nextElementAuthorship` keeps from incoming ops.
 */

import { describe, it, expect } from 'vitest';
import {
	SKETCH_ACTOR_NAME_MAX_CHARS,
	botEditor,
	conductorEditor,
	describeSketchActor,
	sketchActorNameLabel,
	sketchActorRoleLabel,
	nextElementAuthorship,
	readElementStamp,
	sketchTextFields,
	sketchTextHash,
	stampLocalEdits,
	type ElementAuthorship,
} from '../../../shared/sketch/attribution';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import type { SketchActor } from '../../../shared/sketch/types';

const NOW = 1_760_000_000_000;

const conductor = conductorEditor('Pedram');
const guestEditor = { id: 'guest-1', name: 'Ada', kind: 'guest' as const };
const bot = botEditor('agent-42', 'Sketch Bot', { id: 'conductor', name: 'Pedram' });

function rect(id: string, version: number, extra: Partial<SketchWireElement> = {}) {
	return { id, version, type: 'rectangle', x: 0, y: 0, ...extra } as SketchWireElement;
}

function actor(kind: SketchActor['kind'], id = `${kind}-1`): SketchActor {
	return { id, kind, name: kind, role: kind === 'conductor' ? 'conductor' : 'rw' };
}

describe('stampLocalEdits', () => {
	it('gives a new element createdBy and lastEditedBy, both the editor', () => {
		const result = stampLocalEdits([], [rect('a', 1)], conductor, NOW);

		expect(result.changedIds).toEqual(['a']);
		const stamp = readElementStamp(result.elements[0]);
		expect(stamp).toEqual({ createdBy: conductor, lastEditedBy: conductor, lastEditedAt: NOW });
	});

	it('restamps a pasted element that arrived carrying another stamp', () => {
		const pasted = rect('a', 1, {
			customData: { createdBy: guestEditor, lastEditedBy: guestEditor, lastEditedAt: 1 },
		});

		const [element] = stampLocalEdits([], [pasted], conductor, NOW).elements;

		expect(readElementStamp(element)?.createdBy).toEqual(conductor);
	});

	it('changes only lastEditedBy and lastEditedAt when another actor edits', () => {
		const synced = stampLocalEdits([], [rect('a', 1)], guestEditor, 100).elements;
		const edited = { ...synced[0], version: 2, x: 50 };

		const [element] = stampLocalEdits(synced, [edited], conductor, NOW).elements;
		const stamp = readElementStamp(element);

		expect(stamp?.createdBy).toEqual(guestEditor);
		expect(stamp?.lastEditedBy).toEqual(conductor);
		expect(stamp?.lastEditedAt).toBe(NOW);
		expect(element.x).toBe(50);
	});

	it('invents no creator for an edited element that had none', () => {
		const synced = [rect('a', 1)];

		const [element] = stampLocalEdits(synced, [rect('a', 2)], conductor, NOW).elements;
		const data = element.customData as Record<string, unknown>;

		expect(data.createdBy).toBeUndefined();
		expect(data.lastEditedBy).toEqual(conductor);
		expect(readElementStamp(element)).toBeNull();
	});

	it('records the deleter on the isDeleted tombstone', () => {
		const synced = stampLocalEdits([], [rect('a', 1)], guestEditor, 100).elements;
		const tombstone = { ...synced[0], version: 2, isDeleted: true };

		const result = stampLocalEdits(synced, [tombstone], conductor, NOW);
		const stamp = readElementStamp(result.elements[0]);

		expect(result.changedIds).toEqual(['a']);
		expect(result.elements[0].isDeleted).toBe(true);
		expect(stamp?.createdBy).toEqual(guestEditor);
		expect(stamp?.lastEditedBy).toEqual(conductor);
	});

	it('leaves an unchanged element untouched (the synced object itself)', () => {
		const synced = stampLocalEdits([], [rect('a', 1), rect('b', 1)], guestEditor, 100).elements;
		const next = [synced[0], { ...synced[1], version: 2 }];

		const result = stampLocalEdits(synced, next, conductor, NOW);

		expect(result.changedIds).toEqual(['b']);
		expect(result.elements[0]).toBe(synced[0]);
		expect(readElementStamp(result.elements[0])?.lastEditedBy).toEqual(guestEditor);
	});

	it('carries onBehalfOf on a bot edit', () => {
		const synced = stampLocalEdits([], [rect('a', 1)], conductor, 100).elements;

		const [element] = stampLocalEdits(synced, [{ ...synced[0], version: 2 }], bot, NOW).elements;
		const stamp = readElementStamp(element);

		expect(stamp?.lastEditedBy).toEqual({
			id: 'agent:agent-42',
			name: 'Sketch Bot',
			kind: 'bot',
			onBehalfOf: { id: 'conductor', name: 'Pedram' },
		});
		expect(stamp?.createdBy).toEqual(conductor);
	});

	it('never bumps version, keeps other customData keys, and copies changed elements', () => {
		const original = rect('a', 3, { customData: { theme: 'note' } });

		const [element] = stampLocalEdits([], [original], conductor, NOW).elements;

		expect(element.version).toBe(3);
		expect(element).not.toBe(original);
		expect((element.customData as Record<string, unknown>).theme).toBe('note');
		expect(original.customData).toEqual({ theme: 'note' });
	});

	it('does not alias the editor object into the stamp', () => {
		const onBehalfOf = { id: 'conductor', name: 'Pedram' };
		const editor = botEditor('agent-1', 'Bot', onBehalfOf);

		const [element] = stampLocalEdits([], [rect('a', 1)], editor, NOW).elements;
		onBehalfOf.name = 'Changed';
		if (editor.onBehalfOf) editor.onBehalfOf.name = 'Changed';

		expect(readElementStamp(element)?.lastEditedBy.onBehalfOf?.name).toBe('Pedram');
	});

	it('keeps the order of the next scene', () => {
		const next = [rect('c', 1), rect('a', 1), rect('b', 1)];

		const result = stampLocalEdits([], next, conductor, NOW);

		expect(result.elements.map((element) => element.id)).toEqual(['c', 'a', 'b']);
	});
});

describe('botEditor', () => {
	it('prefixes the agent id and omits onBehalfOf when none is given', () => {
		expect(botEditor('x', 'Bot')).toEqual({ id: 'agent:x', name: 'Bot', kind: 'bot' });
	});
});

describe('readElementStamp', () => {
	it('returns null for missing or malformed stamps', () => {
		expect(readElementStamp(rect('a', 1))).toBeNull();
		expect(
			readElementStamp(
				rect('a', 1, {
					customData: { createdBy: conductor, lastEditedBy: { id: 'x' }, lastEditedAt: NOW },
				})
			)
		).toBeNull();
		expect(
			readElementStamp(
				rect('a', 1, {
					customData: { createdBy: conductor, lastEditedBy: conductor, lastEditedAt: 'now' },
				})
			)
		).toBeNull();
	});
});

describe('sketchTextHash', () => {
	it('reads the screened fields in a fixed order, null when missing', () => {
		expect(sketchTextFields(rect('a', 1, { text: 'hi', link: 'https://x' }))).toEqual([
			'hi',
			null,
			null,
			'https://x',
		]);
	});

	it('ignores a move or restyle and changes with the text', async () => {
		const base = await sketchTextHash(rect('a', 1, { text: 'hello' }));
		const moved = await sketchTextHash(rect('a', 2, { text: 'hello', x: 99, strokeColor: '#f00' }));
		const retexted = await sketchTextHash(rect('a', 3, { text: 'hello!' }));

		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(moved).toBe(base);
		expect(retexted).not.toBe(base);
	});
});

describe('nextElementAuthorship', () => {
	it('marks a guest-created element guestTouched with the op server ts', () => {
		const entry = nextElementAuthorship(undefined, {
			version: 1,
			actor: actor('guest'),
			textHash: 'h1',
			opSeq: 7,
			ts: 500,
		});

		expect(entry).toEqual({
			version: 1,
			actor: actor('guest'),
			textHash: 'h1',
			opSeq: 7,
			guestTextAt: 500,
			guestTouched: true,
		});
	});

	it('leaves a conductor-created element untouched by guests', () => {
		const entry = nextElementAuthorship(undefined, {
			version: 1,
			actor: actor('conductor'),
			textHash: 'h1',
		});

		expect(entry.guestTouched).toBe(false);
		expect(entry.guestTextAt).toBeUndefined();
		expect(entry.opSeq).toBeUndefined();
	});

	it('keeps guestTouched and guestTextAt when a conductor or bot moves a guest element', () => {
		const guestEntry: ElementAuthorship = {
			version: 1,
			actor: actor('guest'),
			textHash: 'h1',
			opSeq: 1,
			guestTextAt: 500,
			guestTouched: true,
		};

		const moved = nextElementAuthorship(guestEntry, {
			version: 2,
			actor: actor('conductor'),
			textHash: 'h1',
			opSeq: 2,
			ts: 900,
		});
		const retexted = nextElementAuthorship(moved, {
			version: 3,
			actor: actor('bot'),
			textHash: 'h2',
			opSeq: 3,
			ts: 1000,
		});

		expect(moved.actor.kind).toBe('conductor');
		expect(moved.guestTouched).toBe(true);
		expect(moved.guestTextAt).toBe(500);
		expect(retexted.guestTouched).toBe(true);
		expect(retexted.guestTextAt).toBe(500);
	});

	it('moves guestTextAt only when a guest changes the text', () => {
		const first = nextElementAuthorship(undefined, {
			version: 1,
			actor: actor('guest'),
			textHash: 'h1',
			ts: 500,
		});

		const restyled = nextElementAuthorship(first, {
			version: 2,
			actor: actor('guest'),
			textHash: 'h1',
			ts: 600,
		});
		const rewritten = nextElementAuthorship(restyled, {
			version: 3,
			actor: actor('guest'),
			textHash: 'h2',
			ts: 700,
		});

		expect(restyled.guestTextAt).toBe(500);
		expect(rewritten.guestTextAt).toBe(700);
	});
});

describe('describeSketchActor', () => {
	it('names a guest with the link and says it is not verified (A2)', () => {
		expect(
			describeSketchActor({
				id: 'g1',
				kind: 'guest',
				name: 'Sam',
				role: 'rw',
				capId: 'cap-3',
				capLabel: '#3',
			})
		).toBe('"Sam" · guest, read-write link #3, not verified');
		expect(describeSketchActor({ id: 'g2', kind: 'guest', name: 'Ada', role: 'ro' })).toBe(
			'"Ada" · guest, view-only link, not verified'
		);
	});

	it('names the conductor and the bot by kind alone', () => {
		expect(describeSketchActor(actor('conductor'))).toBe('"conductor" · conductor');
		expect(describeSketchActor(actor('bot'))).toBe('"bot" · bot');
	});

	it('quotes and caps a chosen name so it cannot break the line', () => {
		const line = describeSketchActor({
			id: 'g1',
			kind: 'guest',
			name: `Sam"\n${'x'.repeat(200)}`,
			role: 'rw',
			capLabel: 'team\nlink',
		});
		expect(line).not.toContain('\n');
		expect(line.startsWith('"Sam\\"')).toBe(true);
		const quoted = JSON.parse(line.slice(0, line.indexOf(' · '))) as string;
		expect(Array.from(quoted)).toHaveLength(SKETCH_ACTOR_NAME_MAX_CHARS);
		expect(line).toContain('read-write link team link, not verified');
	});
});

describe('sketchActorNameLabel and sketchActorRoleLabel', () => {
	it('are the two halves describeSketchActor joins', () => {
		const sam: SketchActor = {
			id: 'g1',
			kind: 'guest',
			name: 'Sam',
			role: 'rw',
			capLabel: '  #3 ',
		};
		expect(sketchActorNameLabel(sam)).toBe('"Sam"');
		expect(sketchActorRoleLabel(sam)).toBe('guest, read-write link #3, not verified');
		expect(describeSketchActor(sam)).toBe(
			`${sketchActorNameLabel(sam)} · ${sketchActorRoleLabel(sam)}`
		);
		expect(sketchActorRoleLabel({ kind: 'bot', role: 'conductor' })).toBe('bot');
	});
});
