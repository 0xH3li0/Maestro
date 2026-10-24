/**
 * @file goalPlan.test.ts
 * @description Tests for the Goal-Driven Auto Run Plan Doc module
 * (src/shared/goalDriven/goalPlan.ts): parse, canonical render, round trip,
 * preservation of human text, and the fresh-run doc.
 */

import { describe, it, expect } from 'vitest';
import {
	createGoalPlanDoc,
	parseGoalPlanDoc,
	renderGoalPlanDoc,
} from '../../../shared/goalDriven/goalPlan';

const CANONICAL = [
	'---',
	'goal-run: run-123',
	'status: running',
	'iteration: 4',
	'max-iterations: 20',
	'progress: 45',
	'updated: 2026-10-16T21:14:00-05:00',
	'---',
	'',
	'## Goal',
	'Migrate auth to the new data layer.',
	'',
	'## Exit Criteria',
	'All auth tests green.',
	'',
	'## Plan',
	'- [x] Map the current auth flow <!-- id:a1 by:agent it:1 -->',
	'- [ ] Migrate the data layer <!-- id:a2 by:agent it:2 -->',
	'  - [ ] Write the migration test first <!-- id:a3 by:agent it:3 -->',
	'- [ ] Do not touch the billing module <!-- id:h1 by:human -->',
	'',
	'## Conductor Notes',
	'Prefer small commits.',
	'',
	'## Iteration Log',
	'- it:1 12% map done, data layer next',
	'- it:2 30% schema migrated, tests red',
	'',
].join('\n');

describe('parseGoalPlanDoc', () => {
	it('reads front matter, sections, items and the log', () => {
		const doc = parseGoalPlanDoc(CANONICAL);
		expect(doc.frontMatter).toEqual({
			goalRun: 'run-123',
			status: 'running',
			iteration: 4,
			maxIterations: 20,
			progress: 45,
			updated: '2026-10-16T21:14:00-05:00',
		});
		expect(doc.goal).toBe('Migrate auth to the new data layer.');
		expect(doc.exitCriteria).toBe('All auth tests green.');
		expect(doc.conductorNotes).toBe('Prefer small commits.');
		expect(doc.iterationLog).toEqual([
			'it:1 12% map done, data layer next',
			'it:2 30% schema migrated, tests red',
		]);
		expect(doc.items).toEqual([
			{
				id: 'a1',
				text: 'Map the current auth flow',
				checked: true,
				depth: 0,
				author: 'agent',
				iteration: 1,
			},
			{
				id: 'a2',
				text: 'Migrate the data layer',
				checked: false,
				depth: 0,
				author: 'agent',
				iteration: 2,
			},
			{
				id: 'a3',
				text: 'Write the migration test first',
				checked: false,
				depth: 1,
				author: 'agent',
				iteration: 3,
			},
			{
				id: 'h1',
				text: 'Do not touch the billing module',
				checked: false,
				depth: 0,
				author: 'human',
				iteration: null,
			},
		]);
	});

	it('gives a Plan line with no id the next free h<n> and by:human', () => {
		const text = CANONICAL.replace(
			'## Conductor Notes',
			'- [ ] Typed in the editor\n- [x] Another one\n\n## Conductor Notes'
		).replace('<!-- id:h1 by:human -->', '<!-- id:h4 by:human -->');
		const doc = parseGoalPlanDoc(text);
		const human = doc.items.filter((item) => item.author === 'human');
		expect(human.map((item) => [item.id, item.text, item.checked, item.iteration])).toEqual([
			['h4', 'Do not touch the billing module', false, null],
			['h5', 'Typed in the editor', false, null],
			['h6', 'Another one', true, null],
		]);
	});

	it('reassigns a copy-pasted duplicate id to a new human item', () => {
		const text = CANONICAL.replace(
			'## Conductor Notes',
			'- [ ] Migrate the data layer again <!-- id:a2 by:agent it:2 -->\n\n## Conductor Notes'
		);
		const ids = parseGoalPlanDoc(text).items.map((item) => `${item.id}:${item.author}`);
		expect(ids).toEqual(['a1:agent', 'a2:agent', 'a3:agent', 'h1:human', 'h2:human']);
	});

	it('treats an empty checkbox with no id as text, not an item', () => {
		const text = CANONICAL.replace('## Conductor Notes', '- [ ]\n\n## Conductor Notes');
		const doc = parseGoalPlanDoc(text);
		expect(doc.items).toHaveLength(4);
		expect(doc.preserved.planText).toEqual([{ afterId: 'h1', text: '- [ ]' }]);
	});

	it('ignores checkbox and heading lines inside fenced code', () => {
		const text = CANONICAL.replace(
			'Prefer small commits.',
			'Prefer small commits.\n```\n## Plan\n```'
		).replace('## Conductor Notes', '```md\n- [ ] example only\n```\n\n## Conductor Notes');
		const doc = parseGoalPlanDoc(text);
		expect(doc.items).toHaveLength(4);
		expect(doc.conductorNotes).toBe('Prefer small commits.\n```\n## Plan\n```');
		expect(doc.preserved.planText).toEqual([
			{ afterId: 'h1', text: '```md\n- [ ] example only\n```' },
		]);
	});

	it('falls back to defaults for missing front matter and sections', () => {
		const doc = parseGoalPlanDoc('## Plan\n- [ ] only step\n');
		expect(doc.frontMatter).toEqual({
			goalRun: '',
			status: 'running',
			iteration: 0,
			maxIterations: null,
			progress: 0,
			updated: '',
		});
		expect(doc.goal).toBe('');
		expect(doc.items).toEqual([
			{ id: 'h1', text: 'only step', checked: false, depth: 0, author: 'human', iteration: null },
		]);
	});

	it('reads a human max-iterations edit and treats a non-number as no cap', () => {
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: 30   # bumped'))
				.frontMatter.maxIterations
		).toBe(30);
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: none')).frontMatter
				.maxIterations
		).toBeNull();
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: null')).frontMatter
				.maxIterations
		).toBeNull();
	});
});

describe('renderGoalPlanDoc', () => {
	it('round-trips a canonical document byte for byte', () => {
		expect(renderGoalPlanDoc(parseGoalPlanDoc(CANONICAL))).toBe(CANONICAL);
	});

	it('round-trips a canonical document with unknown sections and free text', () => {
		const text = [
			'---',
			'goal-run: run-9',
			'status: paused',
			'iteration: 0',
			'max-iterations: null',
			'progress: 0',
			'updated: 2026-10-16T00:00:00.000Z',
			'tags: [goal]',
			'---',
			'',
			'# My goal run',
			'',
			'## Links',
			'- https://example.com',
			'',
			'## Goal',
			'Line one.',
			'',
			'### Detail',
			'Line two.',
			'',
			'## Exit Criteria',
			'',
			'## Plan',
			'Intro paragraph before any item.',
			'- [ ] First <!-- id:h1 by:human -->',
			'',
			'A note between items.',
			'',
			'- [x] Second <!-- id:a1 by:agent it:1 -->',
			'',
			'## Scratch',
			'free text',
			'',
			'## Conductor Notes',
			'',
			'## Iteration Log',
			'',
		].join('\n');
		const doc = parseGoalPlanDoc(text);
		expect(doc.preserved.frontMatterLines).toEqual(['tags: [goal]']);
		expect(doc.preserved.preamble).toBe('# My goal run');
		expect(doc.preserved.sections).toEqual([
			{ heading: '## Links', body: '- https://example.com', after: null },
			{ heading: '## Scratch', body: 'free text', after: 'plan' },
		]);
		expect(doc.goal).toBe('Line one.\n\n### Detail\nLine two.');
		expect(renderGoalPlanDoc(doc)).toBe(text);
	});

	it('normalizes non-canonical input without losing content', () => {
		const messy = CANONICAL.replace(/\n/g, '\r\n')
			.replace('- [x] Map', '* [X] Map')
			.replace('## Goal\r\n', '## Goal\r\n\r\n\r\n');
		const rendered = renderGoalPlanDoc(parseGoalPlanDoc(messy));
		expect(rendered).toBe(CANONICAL);
	});

	it('keeps free text anchored to an item that is gone', () => {
		const doc = parseGoalPlanDoc(
			CANONICAL.replace('## Conductor Notes', 'after billing\n\n## Conductor Notes')
		);
		doc.items = doc.items.filter((item) => item.id !== 'h1');
		expect(renderGoalPlanDoc(doc)).toContain(
			'  - [ ] Write the migration test first <!-- id:a3 by:agent it:3 -->\nafter billing\n\n## Conductor Notes'
		);
	});

	it('writes a human item typed without an id back with its new id', () => {
		const text = CANONICAL.replace('## Conductor Notes', '- [ ] New step\n\n## Conductor Notes');
		expect(renderGoalPlanDoc(parseGoalPlanDoc(text))).toContain(
			'- [ ] New step <!-- id:h2 by:human -->'
		);
	});
});

describe('createGoalPlanDoc', () => {
	it('builds a fresh run doc from the config', () => {
		const doc = createGoalPlanDoc(
			{ goal: '  Ship it\n## Sub\nmore  ', exitCriteria: 'Tests pass', maxIterations: 12 },
			'run-1',
			new Date('2026-10-16T12:00:00.000Z')
		);
		expect(doc.frontMatter).toEqual({
			goalRun: 'run-1',
			status: 'running',
			iteration: 0,
			maxIterations: 12,
			progress: 0,
			updated: '2026-10-16T12:00:00.000Z',
		});
		expect(doc.goal).toBe('Ship it\n### Sub\nmore');
		expect(doc.items).toEqual([]);
		const rendered = renderGoalPlanDoc(doc);
		expect(renderGoalPlanDoc(parseGoalPlanDoc(rendered))).toBe(rendered);
		expect(parseGoalPlanDoc(rendered).goal).toBe('Ship it\n### Sub\nmore');
	});
});
