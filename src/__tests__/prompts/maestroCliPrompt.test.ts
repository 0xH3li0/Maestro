/**
 * Content checks for src/prompts/_maestro-cli.md, the CLI reference agents read
 * at runtime (and what `maestro-cli prompts get _maestro-cli` serves).
 *
 * The peer paragraph points an agent at the roster block in its own system
 * prompt. If the heading or the rules it names drift from
 * src/shared/peerAgents.ts, the agent is told to look for a section that is not
 * there, so the words it relies on are pinned here.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const prompt = readFileSync(path.join(__dirname, '../../prompts/_maestro-cli.md'), 'utf-8');
const peerParagraph = prompt.split('\n').find((line) => line.startsWith('**Peer agents.**'));

describe('_maestro-cli.md peer agents', () => {
	test('has a peer paragraph beside the ask / dispatch guidance', () => {
		expect(peerParagraph).toBeDefined();
		const askAt = prompt.indexOf('**Asking another agent vs handing it work.**');
		expect(askAt).toBeGreaterThanOrEqual(0);
		expect(prompt.indexOf('**Peer agents.**')).toBeGreaterThan(askAt);
	});

	test('names the roster section, the two grants, the budget and the out-of-bounds rule', () => {
		expect(peerParagraph).toContain('`## Peer Agents`');
		expect(peerParagraph).toContain('`ask`');
		expect(peerParagraph).toContain('`dispatch`');
		expect(peerParagraph).toContain('`Consult only`');
		expect(peerParagraph).toMatch(/Notes column/);
		expect(peerParagraph).toMatch(/budget/);
		expect(peerParagraph).toMatch(/out of bounds/);
	});

	test('lists the two group verbs with the agent management verbs', () => {
		const line = prompt.split('\n').find((l) => l.startsWith('- **create-agent / update-agent'));
		expect(line).toBeDefined();
		expect(line).toContain('group-settings');
		expect(line).toContain('update-group-settings');
	});

	// An agent cannot use a verb it was never told about.
	test('lists the read verb for the whole graph, and says it does not write', () => {
		const line = prompt.split('\n').find((l) => l.startsWith('- **delegation graph**'));
		expect(line).toBeDefined();
		expect(line).toContain('`--group <id>`');
		expect(line).toContain('`--json`');
		expect(line).toMatch(/Read only/);
		expect(line).toContain('`update-agent --peer`');
	});

	test('uses no em or en dash', () => {
		const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
		expect(dashes.test(peerParagraph ?? '')).toBe(false);
	});
});
