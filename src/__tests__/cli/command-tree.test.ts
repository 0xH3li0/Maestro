/**
 * @file command-tree.test.ts
 * @description Walks the registered Commander tree of `maestro-cli`, so a verb
 * cannot ship without help. Every command has a description; every command that
 * runs something has at least one example; every example names a real command
 * and only flags that command declares; `--help` and `reference` print them.
 *
 * The tree is the live one from `src/cli/index.ts` (the entry point does not
 * parse when it is imported under a test runner), so there is no second list of
 * verbs to keep here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Command } from 'commander';

import { program } from '../../cli/index';
import {
	COMMAND_EXAMPLES,
	commandPath,
	examplesFor,
	formatExamplesHelp,
} from '../../cli/command-examples';
import { reference } from '../../cli/commands/reference';

interface WalkedCommand {
	path: string;
	command: Command;
	/** The command does something itself: it has no subcommands, or it has an action too. */
	runnable: boolean;
}

/** Commander keeps the action handler private; a group with one is runnable as well. */
function hasAction(cmd: Command): boolean {
	return typeof (cmd as unknown as { _actionHandler?: unknown })._actionHandler === 'function';
}

function walk(cmd: Command, out: WalkedCommand[] = []): WalkedCommand[] {
	for (const sub of cmd.commands as Command[]) {
		out.push({
			path: commandPath(sub),
			command: sub,
			runnable: sub.commands.length === 0 || hasAction(sub),
		});
		walk(sub, out);
	}
	return out;
}

/** Split one example line into shell words, keeping a quoted value whole. */
function shellWords(line: string): string[] {
	const words: string[] = [];
	let current = '';
	let quote: string | null = null;
	let inWord = false;
	for (const char of line) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) words.push(current);
			current = '';
			inWord = false;
		} else {
			current += char;
			inWord = true;
		}
	}
	if (inWord) words.push(current);
	return words;
}

const SHELL_OPERATORS = new Set(['|', '>', '>>', '&&', ';']);

/** The `maestro-cli ...` words of an example, without a pipe in front or a redirect behind. */
function invocationWords(example: string): string[] {
	const words = shellWords(example);
	const start = words.indexOf('maestro-cli');
	if (start === -1) return [];
	const rest = words.slice(start + 1);
	const end = rest.findIndex((word) => SHELL_OPERATORS.has(word));
	return end === -1 ? rest : rest.slice(0, end);
}

/** Descend through the subcommand names of an example; what is left are its arguments. */
function resolveInvocation(words: string[]): { command: Command; rest: string[] } {
	let command = program;
	let index = 0;
	while (index < words.length) {
		const next = (command.commands as Command[]).find(
			(sub) => sub.name() === words[index] || sub.aliases().includes(words[index])
		);
		if (!next) break;
		command = next;
		index += 1;
	}
	return { command, rest: words.slice(index) };
}

const walked = walk(program);
const paths = new Set(walked.map((entry) => entry.path));

describe('maestro-cli command tree', () => {
	it('registers commands to walk', () => {
		expect(walked.length).toBeGreaterThan(100);
		expect(paths.has('models server start')).toBe(true);
		expect(paths.has('voice wake record')).toBe(true);
	});

	it('gives every command a description', () => {
		const missing = walked
			.filter((entry) => !entry.command.description().trim())
			.map((entry) => entry.path);

		expect(missing).toEqual([]);
	});

	it('gives every command that runs something at least one example', () => {
		const missing = walked
			.filter((entry) => entry.runnable && examplesFor(entry.path).length === 0)
			.map((entry) => entry.path);

		expect(missing).toEqual([]);
	});

	it('has no example for a command that does not exist', () => {
		const orphans = Object.keys(COMMAND_EXAMPLES).filter((key) => !paths.has(key));

		expect(orphans).toEqual([]);
	});

	it('writes each example as a maestro-cli invocation', () => {
		const bad: string[] = [];
		for (const [path, examples] of Object.entries(COMMAND_EXAMPLES)) {
			for (const example of examples) {
				if (invocationWords(example).length === 0) bad.push(`${path}: ${example}`);
				if (/[–—]/.test(example)) bad.push(`${path}: dash in ${example}`);
			}
		}

		expect(bad).toEqual([]);
	});

	it('resolves each example to the command it is registered under', () => {
		const wrong: string[] = [];
		for (const [path, examples] of Object.entries(COMMAND_EXAMPLES)) {
			for (const example of examples) {
				const { command } = resolveInvocation(invocationWords(example));
				if (commandPath(command) !== path) {
					wrong.push(`${path}: resolves to "${commandPath(command)}" in ${example}`);
				}
			}
		}

		expect(wrong).toEqual([]);
	});

	it('uses only flags the command declares', () => {
		const unknown: string[] = [];
		for (const [path, examples] of Object.entries(COMMAND_EXAMPLES)) {
			for (const example of examples) {
				const { command, rest } = resolveInvocation(invocationWords(example));
				const declared = new Set<string>(['-h', '--help']);
				for (const option of command.options) {
					if (option.long) declared.add(option.long);
					if (option.short) declared.add(option.short);
				}
				for (const word of rest) {
					if (!word.startsWith('-') || word === '-') continue;
					const flag = word.split('=')[0];
					if (!declared.has(flag)) unknown.push(`${path}: ${flag} in ${example}`);
				}
			}
		}

		expect(unknown).toEqual([]);
	});
});

describe('--help', () => {
	it('prints the examples after the options', () => {
		const command = walked.find((entry) => entry.path === 'models server set')!.command;
		let printed = '';
		command.configureOutput({
			writeOut: (text) => {
				printed += text;
			},
		});

		command.outputHelp();

		expect(printed).toContain('Examples:');
		for (const example of examplesFor('models server set')) {
			expect(printed).toContain(example);
		}
		expect(printed.indexOf('Options:')).toBeLessThan(printed.indexOf('Examples:'));
	});

	it('indents each example under an Examples heading', () => {
		expect(formatExamplesHelp(['maestro-cli a', 'maestro-cli b'])).toBe(
			'\nExamples:\n  maestro-cli a\n  maestro-cli b\n'
		);
	});
});

describe('maestro-cli reference', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function capture(format: string): string {
		let out = '';
		vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
			out += `${String(line)}\n`;
		});
		reference(program, { format });
		return out;
	}

	it('lists the examples of every command in the JSON form', () => {
		interface Info {
			path: string;
			examples: string[];
			subcommands: Info[];
		}
		const flat = (nodes: Info[]): Info[] => nodes.flatMap((n) => [n, ...flat(n.subcommands)]);
		const infos = flat(JSON.parse(capture('json')) as Info[]);
		const byPath = new Map(infos.map((info) => [info.path, info]));

		for (const [path, examples] of Object.entries(COMMAND_EXAMPLES)) {
			expect(byPath.get(`maestro-cli ${path}`)?.examples).toEqual(examples);
		}
	});

	it('prints the examples of a command in the Markdown form', () => {
		const markdown = capture('md');
		const section = markdown
			.split('## `')
			.find((part) => part.startsWith('maestro-cli voice wake add'))!;

		expect(section).toContain('```bash');
		for (const example of examplesFor('voice wake add')) {
			expect(section).toContain(example);
		}
	});
});
