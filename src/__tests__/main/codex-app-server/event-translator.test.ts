import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	CodexAppServerEventTranslator,
	type CodexExecLine,
	type CodexAppServerUserMessage,
	type CodexTranslatedRequestMethod,
} from '../../../main/codex-app-server/event-translator';
import type { CodexAppServerMessage } from '../../../main/codex-app-server/protocol';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'codex-app-server');

interface FixtureLine {
	dir: 'send' | 'recv';
	msg: CodexAppServerMessage;
}

function loadFixture(name: string): FixtureLine[] {
	return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureLine);
}

const TRANSLATED_RESPONSES = new Set<string>(['thread/start', 'thread/resume', 'turn/start']);

/**
 * Replay a fixture the way the spawner will: notifications go to `translate()`,
 * successful responses to the requests whose result the translator needs go to
 * `translateResponse()`, and server requests are left for the spawner to answer.
 */
function replay(name: string) {
	const translator = new CodexAppServerEventTranslator();
	const userMessages: CodexAppServerUserMessage[] = [];
	translator.onUserMessage((message) => userMessages.push(message));
	const methodsById = new Map<number | string, string>();
	const lines: CodexExecLine[] = [];
	const fixture = loadFixture(name);

	for (const { dir, msg } of fixture) {
		if (dir === 'send') {
			if (msg.method && msg.id !== undefined) methodsById.set(msg.id, msg.method);
			continue;
		}
		if (msg.method && msg.id === undefined) {
			lines.push(...translator.translate({ ...msg, method: msg.method, id: undefined }));
		} else if (msg.id !== undefined && !msg.method && msg.result !== undefined) {
			const method = methodsById.get(msg.id);
			if (method && TRANSLATED_RESPONSES.has(method)) {
				lines.push(
					...translator.translateResponse(method as CodexTranslatedRequestMethod, msg.result)
				);
			}
		}
	}
	return { translator, lines, userMessages, fixture };
}

/** `type` plus the item's type and status, the shape a fixture's sequence is asserted on. */
function signature(line: CodexExecLine): string {
	const item = line.item as { type?: string; status?: string } | undefined;
	if (!item) return line.type;
	return [line.type, item.type, item.status].filter(Boolean).join(':');
}

/** Every `item/completed` item of the given type in a fixture, in order. */
function fixtureItems(fixture: FixtureLine[], type: string): Array<Record<string, unknown>> {
	return fixture
		.filter(({ dir, msg }) => dir === 'recv' && msg.method === 'item/completed')
		.map(({ msg }) => (msg.params as { item: Record<string, unknown> }).item)
		.filter((item) => item.type === type);
}

/** The thread total on the last `thread/tokenUsage/updated` of a fixture. */
function lastTotal(fixture: FixtureLine[], index = -1): Record<string, number> {
	const updates = fixture.filter(
		({ dir, msg }) => dir === 'recv' && msg.method === 'thread/tokenUsage/updated'
	);
	const update = updates.at(index)!.msg.params as {
		tokenUsage: { total: Record<string, number> };
	};
	return update.tokenUsage.total;
}

describe('CodexAppServerEventTranslator', () => {
	describe('fixture replay', () => {
		it('plain-turn: thread, turn, one agent message, per-turn usage', () => {
			const { translator, lines, userMessages, fixture } = replay('plain-turn');
			const total = lastTotal(fixture);

			expect(lines).toEqual([
				{ type: 'thread.started', thread_id: '01a129a3-ae2d-7a03-a717-b7374d497e31' },
				{ type: 'turn.started' },
				{
					type: 'item.completed',
					item: {
						id: 'msg_074baebd0cfcfca0016acb2bf66d488194ad0bf29a3a33addb',
						type: 'agent_message',
						text: 'OK',
					},
				},
				{
					type: 'turn.completed',
					usage: {
						input_tokens: total.inputTokens,
						cached_input_tokens: total.cachedInputTokens,
						output_tokens: total.outputTokens,
						reasoning_output_tokens: total.reasoningOutputTokens,
					},
				},
			]);
			expect(translator.outcome).toBe('completed');
			expect(translator.threadId).toBe('01a129a3-ae2d-7a03-a717-b7374d497e31');
			expect(translator.activeTurnId).toBeNull();
			expect(userMessages).toEqual([
				{
					turnId: '01a129a3-aefe-7cd2-9c08-1dd7ca193ad1',
					itemId: '01a129a3-b307-78c1-84b3-ebac9091199f',
					text: 'Reply with the word OK',
				},
			]);
		});

		it('tool-turn: every command start and completion, keyed by item id', () => {
			const { lines, fixture } = replay('tool-turn');

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.completed:agent_message',
				'turn.completed',
			]);

			const commands = fixtureItems(fixture, 'commandExecution');
			const completed = lines.filter(
				(line) =>
					line.type === 'item.completed' &&
					(line.item as { type: string }).type === 'command_execution'
			);
			expect(completed.map((line) => line.item)).toEqual(
				commands.map((command) => ({
					id: command.id,
					type: 'command_execution',
					command: command.command,
					aggregated_output: command.aggregatedOutput,
					exit_code: command.exitCode,
					status: 'completed',
				}))
			);
			const started = lines.filter((line) => line.type === 'item.started');
			expect(started.map((line) => (line.item as { id: string }).id)).toEqual(
				commands.map((command) => command.id)
			);
		});

		it('steered-turn: reports the steer as a user message of the running turn', () => {
			const { lines, userMessages } = replay('steered-turn');

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(userMessages).toHaveLength(2);
			expect(userMessages[1]).toEqual({
				turnId: '01a129a3-f358-7f71-9b55-f179dae9133a',
				itemId: '01a129a4-166b-7e02-8455-0b48f7c203c8',
				text: 'Stop now. Do not run any more commands. Reply with the single word PINEAPPLE.',
			});
			expect(userMessages[0].turnId).toBe(userMessages[1].turnId);
			const last = lines.filter((line) => line.type === 'item.completed').at(-1)!;
			expect((last.item as { text: string }).text).toBe('PINEAPPLE');
		});

		it('late-steer: the turn ends normally and the late steer adds nothing', () => {
			const { translator, lines } = replay('late-steer');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(translator.outcome).toBe('completed');
			expect(translator.activeTurnId).toBeNull();
		});

		it('resumed-turn: emits thread.started from the resume response and subtracts the prior total', () => {
			const { translator, lines, fixture } = replay('resumed-turn');
			const baseline = lastTotal(fixture, 0);
			const total = lastTotal(fixture);

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(lines[0]).toEqual({
				type: 'thread.started',
				thread_id: '01a129a3-ae2d-7a03-a717-b7374d497e31',
			});
			// The thread total is NEVER forwarded: the first update carries the
			// previous turn's tokens and must be subtracted out.
			expect(lines.at(-1)).toEqual({
				type: 'turn.completed',
				usage: {
					input_tokens: total.inputTokens - baseline.inputTokens,
					cached_input_tokens: total.cachedInputTokens - baseline.cachedInputTokens,
					output_tokens: total.outputTokens - baseline.outputTokens,
					reasoning_output_tokens: total.reasoningOutputTokens - baseline.reasoningOutputTokens,
				},
			});
			expect((lines.at(-1)!.usage as { input_tokens: number }).input_tokens).toBeLessThan(
				total.inputTokens
			);
			expect(translator.threadId).toBe('01a129a3-ae2d-7a03-a717-b7374d497e31');
		});

		it('interrupted-turn: still reports usage and records the interrupted outcome', () => {
			const { translator, lines, fixture } = replay('interrupted-turn');
			const total = lastTotal(fixture);

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'turn.completed',
			]);
			expect((lines.at(-1)!.usage as { input_tokens: number }).input_tokens).toBe(
				total.inputTokens
			);
			expect(translator.outcome).toBe('interrupted');
		});

		it('read-only-turn: a sandbox denial leaves no tool card, only the messages', () => {
			const { lines } = replay('read-only-turn');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.completed:agent_message',
				'turn.completed',
			]);
		});

		it('approval-request: a declined command completes as failed, empty reasoning is skipped', () => {
			const { lines } = replay('approval-request');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:failed',
				'item.completed:agent_message',
				'turn.completed',
			]);
			const declined = lines.find(
				(line) => line.type === 'item.completed' && (line.item as { status?: string }).status
			)!;
			expect(declined.item).toEqual({
				id: 'exec-878f33c1-8198-4b9f-b28b-f84496f275ea',
				type: 'command_execution',
				command: `/bin/zsh -lc "printf 'hello\\\\n' > out.txt"`,
				exit_code: null,
				status: 'failed',
			});
		});
	});

	describe('end to end through CodexOutputParser', () => {
		it('tool-turn translates into the same final result text the agent message carries', () => {
			const { lines, fixture } = replay('tool-turn');
			const finalAnswer = fixtureItems(fixture, 'agentMessage').find(
				(item) => item.phase === 'final_answer'
			)!;

			const parser = new CodexOutputParser();
			const events = lines.map((line) => parser.parseJsonLine(JSON.stringify(line)));
			const results = events.filter((event) => event && parser.isResultMessage(event));

			expect(results.at(-1)?.text).toBe(finalAnswer.text);
			expect(events[0]).toMatchObject({
				type: 'init',
				sessionId: '01a129a3-bb7d-7971-9636-b3013de8faa0',
			});
			const usage = events.at(-1)?.usage;
			expect(usage?.inputTokens).toBe(lastTotal(fixture).inputTokens);
			const tools = events.filter((event) => event?.type === 'tool_use');
			expect(tools).toHaveLength(6);
			expect(tools.at(-1)).toMatchObject({ toolName: 'shell', toolState: { status: 'completed' } });
		});
	});

	describe('synthetic notifications', () => {
		const started = (translator: CodexAppServerEventTranslator, turnId = 'turn-1') => {
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			translator.translate({ method: 'turn/started', params: { turn: { id: turnId } } });
		};

		it('returns nothing for unknown and noise notifications', () => {
			const translator = new CodexAppServerEventTranslator();
			for (const method of [
				'remoteControl/status/changed',
				'account/rateLimits/updated',
				'mcpServer/startupStatus/updated',
				'warning',
				'item/agentMessage/delta',
				'something/new',
			]) {
				expect(translator.translate({ method, params: {} })).toEqual([]);
			}
		});

		it('emits thread.started once even when the notification follows the response', () => {
			const translator = new CodexAppServerEventTranslator();
			expect(translator.translateResponse('thread/start', { thread: { id: 't' } })).toHaveLength(1);
			expect(
				translator.translate({ method: 'thread/started', params: { thread: { id: 't' } } })
			).toEqual([]);
		});

		it('records the turn id from the turn/start response before turn/started arrives', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('turn/start', { turn: { id: 'turn-early' } });
			expect(translator.activeTurnId).toBe('turn-early');
		});

		it('maps a failed turn to turn.failed with the turn error message', () => {
			const translator = new CodexAppServerEventTranslator();
			started(translator);
			expect(
				translator.translate({
					method: 'turn/completed',
					params: {
						turn: { id: 'turn-1', status: 'failed', error: { message: 'model not found' } },
					},
				})
			).toEqual([{ type: 'turn.failed', error: { message: 'model not found' } }]);
			expect(translator.outcome).toBe('failed');
		});

		it('turns a retrying error into a Reconnecting notice the parser treats as progress', () => {
			const translator = new CodexAppServerEventTranslator();
			const [retry] = translator.translate({
				method: 'error',
				params: { error: { message: 'stream disconnected' }, willRetry: true },
			});
			expect(retry).toEqual({ type: 'error', message: 'Reconnecting... stream disconnected' });
			const parsed = new CodexOutputParser().parseJsonLine(JSON.stringify(retry));
			expect(parsed?.type).not.toBe('error');

			const [fatal] = translator.translate({
				method: 'error',
				params: { error: { message: 'quota exceeded' }, willRetry: false },
			});
			expect(fatal).toEqual({ type: 'error', message: 'quota exceeded' });
		});

		it('only reports user messages that complete inside the active turn', () => {
			const translator = new CodexAppServerEventTranslator();
			const seen: CodexAppServerUserMessage[] = [];
			translator.onUserMessage((message) => seen.push(message));
			const userMessage = (turnId: string, text: string) =>
				translator.translate({
					method: 'item/completed',
					params: {
						turnId,
						item: { type: 'userMessage', id: `u-${text}`, content: [{ type: 'text', text }] },
					},
				});

			userMessage('turn-1', 'before');
			started(translator);
			userMessage('turn-other', 'other');
			userMessage('turn-1', 'during');
			translator.translate({
				method: 'turn/completed',
				params: { turn: { id: 'turn-1', status: 'completed' } },
			});
			userMessage('turn-1', 'after');

			expect(seen).toEqual([{ turnId: 'turn-1', itemId: 'u-during', text: 'during' }]);
		});

		it('joins reasoning summaries and falls back to content', () => {
			const translator = new CodexAppServerEventTranslator();
			const reasoning = (summary: string[], content: string[]) =>
				translator.translate({
					method: 'item/completed',
					params: { item: { type: 'reasoning', id: 'r', summary, content } },
				});
			expect(reasoning(['a', 'b'], ['raw'])).toEqual([
				{ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'a\n\nb' } },
			]);
			expect(reasoning([], ['raw'])).toEqual([
				{ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'raw' } },
			]);
			expect(reasoning([], [])).toEqual([]);
		});

		it('omits usage when the turn never reported any', () => {
			const translator = new CodexAppServerEventTranslator();
			started(translator);
			expect(
				translator.translate({
					method: 'turn/completed',
					params: { turn: { id: 'turn-1', status: 'completed' } },
				})
			).toEqual([{ type: 'turn.completed' }]);
		});
	});
});
