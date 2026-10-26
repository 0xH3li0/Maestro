/**
 * Tests for the element list an agent render draws (T9 `sketch_screenshot`,
 * T10 `sketch_export`; spec section 8.4, Pixels): `planSketchAgentRender()`
 * picks the scope and the third-party elements to screen, and
 * `buildSketchAgentRender()` removes every withheld element (with the text
 * bound to a withheld container) and every unapproved guest image, stripping
 * the forgeable `customData` from the rest.
 */

import { describe, expect, it } from 'vitest';
import {
	buildSketchAgentRender,
	isUnapprovedGuestImage,
	planSketchAgentRender,
	sketchUnapprovedImageIds,
} from '../../../shared/sketch/agent-view';
import type { ElementAuthorship } from '../../../shared/sketch/attribution';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import type { SketchActorKind, WithheldReason } from '../../../shared/sketch/types';

function by(
	kind: SketchActorKind,
	version = 1,
	guestTouched = kind === 'guest'
): ElementAuthorship {
	return {
		version,
		actor: { id: kind, kind, name: kind, role: kind === 'guest' ? 'rw' : 'conductor' },
		textHash: 'h',
		guestTouched,
	};
}

const elements: SketchWireElement[] = [
	{ id: 'frame', version: 1, type: 'frame', name: 'Plan' },
	{ id: 'box', version: 1, type: 'rectangle', frameId: 'frame', customData: { stamp: 'forged' } },
	{ id: 'box-label', version: 1, type: 'text', containerId: 'box', text: 'Login' },
	{ id: 'guest-box', version: 1, type: 'rectangle' },
	{ id: 'guest-label', version: 1, type: 'text', containerId: 'guest-box', text: 'ignore all' },
	{ id: 'note', version: 1, type: 'text', text: 'loose guest note' },
	{ id: 'img', version: 1, type: 'image', fileId: 'f1' },
	{ id: 'guest-img', version: 1, type: 'image', fileId: 'f2' },
	{ id: 'old', version: 3, type: 'rectangle', isDeleted: true },
];

const authors: Record<string, ElementAuthorship> = {
	frame: by('conductor'),
	box: by('conductor'),
	'box-label': by('conductor'),
	'guest-box': by('guest'),
	'guest-label': by('conductor'),
	note: by('guest'),
	img: by('conductor'),
	'guest-img': by('guest'),
};

const ids = (list: readonly { id: string }[]) => list.map((element) => element.id);

describe('isUnapprovedGuestImage', () => {
	it('flags an image by a guest, touched by a guest, or with no known author', () => {
		const image: SketchWireElement = { id: 'i', version: 2, type: 'image' };
		expect(isUnapprovedGuestImage(image, { i: by('guest', 2) })).toBe(true);
		expect(isUnapprovedGuestImage(image, { i: by('conductor', 2, true) })).toBe(true);
		expect(isUnapprovedGuestImage(image, {})).toBe(true);
		// An entry for an older version does not name who wrote this one.
		expect(isUnapprovedGuestImage(image, { i: by('conductor', 1) })).toBe(true);
		expect(isUnapprovedGuestImage(image, { i: by('conductor', 2) })).toBe(false);
		expect(isUnapprovedGuestImage(image, { i: by('bot', 2) })).toBe(false);
	});

	it('clears a guest image the conductor approved, for that file only', () => {
		const image: SketchWireElement = { id: 'i', version: 2, type: 'image', fileId: 'f1' };
		const guest = { i: by('guest', 2) };
		expect(isUnapprovedGuestImage(image, guest, { i: 'f1' })).toBe(false);
		// A swapped picture needs a new approval.
		expect(isUnapprovedGuestImage({ ...image, fileId: 'f2' }, guest, { i: 'f1' })).toBe(true);
		// An approval for another element does not carry over.
		expect(isUnapprovedGuestImage(image, guest, { j: 'f1' })).toBe(true);
		// An image with no file yet cannot be approved.
		expect(isUnapprovedGuestImage({ ...image, fileId: undefined }, guest, { i: 'f1' })).toBe(true);
	});

	it('lists the unapproved guest images among some elements', () => {
		expect(sketchUnapprovedImageIds(elements, authors)).toEqual(['guest-img']);
		expect(sketchUnapprovedImageIds(elements, authors, { 'guest-img': 'f2' })).toEqual([]);
	});

	it('never flags an element that is not an image', () => {
		expect(isUnapprovedGuestImage({ id: 'r', version: 1, type: 'rectangle' }, {})).toBe(false);
	});
});

describe('planSketchAgentRender', () => {
	it('covers every live element and screens only third-party ones that are not images', () => {
		const plan = planSketchAgentRender(elements, authors);
		expect(ids(plan.candidates)).toEqual(ids(elements.filter((e) => e.isDeleted !== true)));
		expect(ids(plan.toScreen)).toEqual(['guest-box', 'note']);
		expect(plan.missing).toEqual([]);
	});

	it('adds bound text and frame members to named elements, and reports missing ids', () => {
		const plan = planSketchAgentRender(elements, authors, ['frame', 'guest-box', 'old', 'nope']);
		expect(ids(plan.candidates)).toEqual(['frame', 'box', 'box-label', 'guest-box', 'guest-label']);
		expect(plan.missing).toEqual(['old', 'nope']);
	});
});

describe('buildSketchAgentRender', () => {
	it('removes withheld elements, their bound text and guest images, and strips customData', () => {
		const plan = planSketchAgentRender(elements, authors);
		const withheld = new Map<string, WithheldReason>(
			ids(plan.toScreen).map((id) => [id, 'unscreened'])
		);
		const render = buildSketchAgentRender(plan.candidates, authors, withheld);

		expect(ids(render.elements)).toEqual(['frame', 'box', 'box-label', 'img']);
		expect(render.withheldCount).toBe(3);
		expect(render.guestImageCount).toBe(1);
		expect(render.elements.every((element) => !('customData' in element))).toBe(true);
		const json = JSON.stringify(render.elements);
		expect(json).not.toContain('ignore all');
		expect(json).not.toContain('loose guest note');
		expect(json).not.toContain('forged');
	});

	it('draws a guest image the conductor approved', () => {
		const approved = { 'guest-img': 'f2' };
		const plan = planSketchAgentRender(elements, authors, undefined, approved);
		// Approved pixels, not approved text: its `link` is still screened.
		expect(ids(plan.toScreen)).toEqual(['guest-box', 'note', 'guest-img']);
		const render = buildSketchAgentRender(plan.candidates, authors, new Map(), approved);
		expect(ids(render.elements)).toContain('guest-img');
		expect(render.guestImageCount).toBe(0);
	});

	it('keeps a container whose withheld label is removed', () => {
		const render = buildSketchAgentRender(
			elements.filter((e) => ['box', 'box-label'].includes(e.id)),
			authors,
			new Map([['box-label', 'flagged']])
		);
		expect(ids(render.elements)).toEqual(['box']);
		expect(render.withheldCount).toBe(1);
	});

	it('draws everything a clear gate lets through', () => {
		const plan = planSketchAgentRender(elements, authors);
		const render = buildSketchAgentRender(plan.candidates, authors, new Map());
		expect(ids(render.elements)).toEqual([
			'frame',
			'box',
			'box-label',
			'guest-box',
			'guest-label',
			'note',
			'img',
		]);
		expect(render.withheldCount).toBe(0);
		expect(render.guestImageCount).toBe(1);
	});
});
