/**
 * @file quickChat.test.ts
 * @description The Quick Chat contract: settings resolution and the log -> message transform.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_QUICK_CHAT_SETTINGS,
	describeQuickChatRoute,
	QUICK_CHAT_MAX_MESSAGES,
	QUICK_CHAT_MIN_EXPANDED_HEIGHT,
	QUICK_CHAT_MIN_WIDTH,
	logsToQuickChatMessages,
	parseQuickChatFontScaleRequest,
	parseQuickChatTabChoice,
	resolveQuickChatSettings,
	validateQuickChatBoundsRequest,
} from '../../shared/quickChat';

const log = (id: string, source: string, text: string) => ({ id, timestamp: 1, source, text });

describe('resolveQuickChatSettings', () => {
	it('returns the defaults when nothing is persisted', () => {
		expect(resolveQuickChatSettings(undefined)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings(null)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings('garbage')).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
	});

	it('defaults the hotkey to Option/Alt+Space', () => {
		expect(resolveQuickChatSettings(undefined).hotkey).toEqual(['Alt', 'Space']);
	});

	it('keeps saved values and fills a partial object from the defaults', () => {
		expect(resolveQuickChatSettings({ agentId: 'a1', persistent: true })).toEqual({
			...DEFAULT_QUICK_CHAT_SETTINGS,
			agentId: 'a1',
			persistent: true,
		});
	});

	it('keeps an empty hotkey, which is how the user turns it off', () => {
		expect(resolveQuickChatSettings({ hotkey: [] }).hotkey).toEqual([]);
	});

	it('ignores values of the wrong type', () => {
		expect(
			resolveQuickChatSettings({
				hotkey: 'Alt+Space',
				agentId: 7,
				persistent: 'yes',
				ephemeralHistory: null,
			})
		).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings({ hotkey: ['Alt', 3, 'K'] }).hotkey).toEqual(['Alt', 'K']);
	});

	it('keeps a saved thinking mode, defaults it to off, and drops an unknown one', () => {
		expect(resolveQuickChatSettings(undefined).thinking).toBe('off');
		expect(resolveQuickChatSettings({ thinking: 'sticky' }).thinking).toBe('sticky');
		expect(resolveQuickChatSettings({ thinking: 'loud' }).thinking).toBe('off');
	});

	it('never hands back the shared default array', () => {
		const resolved = resolveQuickChatSettings(undefined);
		resolved.hotkey.push('X');
		expect(DEFAULT_QUICK_CHAT_SETTINGS.hotkey).toEqual(['Alt', 'Space']);
	});
});

describe('logsToQuickChatMessages', () => {
	it('maps user, agent output, and errors, and drops process detail', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'hello'),
			log('2', 'thinking', 'hmm'),
			log('3', 'tool', 'Read file'),
			log('4', 'stdout', 'hi there'),
			log('5', 'system', 'session started'),
			log('6', 'error', 'rate limited'),
		]);
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['user', 'hello'],
			['assistant', 'hi there'],
			['error', 'rate limited'],
		]);
	});

	it('joins consecutive output chunks into one reply', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'q'),
			log('2', 'stdout', 'Fuhged'),
			log('3', 'thinking', 'still going'),
			log('4', 'stdout', 'daboudit'),
		]);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ id: '2', role: 'assistant', text: 'Fuhgeddaboudit' });
	});

	it('does not mutate the source log', () => {
		const logs = [log('1', 'stdout', 'a'), log('2', 'ai', 'b')];
		logsToQuickChatMessages(logs);
		expect(logs[0].text).toBe('a');
	});

	it('skips blank entries', () => {
		expect(logsToQuickChatMessages([log('1', 'stdout', '  \n')])).toEqual([]);
	});

	it('keeps only the newest messages', () => {
		const logs = Array.from({ length: QUICK_CHAT_MAX_MESSAGES + 5 }, (_, i) =>
			log(String(i), i % 2 === 0 ? 'user' : 'stdout', `m${i}`)
		);
		const messages = logsToQuickChatMessages(logs);
		expect(messages).toHaveLength(QUICK_CHAT_MAX_MESSAGES);
		expect(messages[messages.length - 1].text).toBe(`m${QUICK_CHAT_MAX_MESSAGES + 4}`);
	});
});

describe('validateQuickChatBoundsRequest', () => {
	it('accepts a size, a spot, or both', () => {
		expect(validateQuickChatBoundsRequest({ width: 600 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ height: 500 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ x: -1200, y: 40 })).toBeNull();
		expect(validateQuickChatBoundsRequest({ x: 0, y: 0, width: 700, height: 600 })).toBeNull();
	});

	it('refuses an empty request', () => {
		expect(validateQuickChatBoundsRequest({})).toMatch(/at least one/);
	});

	it('refuses half a position', () => {
		expect(validateQuickChatBoundsRequest({ x: 10 })).toMatch(/together/);
		expect(validateQuickChatBoundsRequest({ y: 10, width: 600 })).toMatch(/together/);
	});

	it('refuses a non-number', () => {
		expect(validateQuickChatBoundsRequest({ width: Number('wide') })).toMatch(/numbers/);
		expect(validateQuickChatBoundsRequest({ x: 1, y: Infinity })).toMatch(/numbers/);
	});

	it('refuses a size below what a drag allows', () => {
		expect(validateQuickChatBoundsRequest({ width: QUICK_CHAT_MIN_WIDTH - 1 })).toMatch(/Width/);
		expect(validateQuickChatBoundsRequest({ height: QUICK_CHAT_MIN_EXPANDED_HEIGHT - 1 })).toMatch(
			/Height/
		);
	});
});

describe('parseQuickChatFontScaleRequest', () => {
	it('accepts a step, an exact scale, or a reset', () => {
		expect(parseQuickChatFontScaleRequest({ step: 1 })).toEqual({ step: 1 });
		expect(parseQuickChatFontScaleRequest({ step: -1 })).toEqual({ step: -1 });
		expect(parseQuickChatFontScaleRequest({ scale: 1.4 })).toEqual({ scale: 1.4 });
		expect(parseQuickChatFontScaleRequest({ reset: true })).toEqual({ reset: true });
	});

	it('rejects anything else off the wire', () => {
		for (const raw of [null, 'in', {}, { step: 2 }, { scale: 0 }, { scale: NaN }, { reset: 1 }]) {
			expect(parseQuickChatFontScaleRequest(raw)).toBeNull();
		}
	});
});

describe('describeQuickChatRoute', () => {
	const route = {
		status: 'done' as const,
		tabId: 't1',
		tabName: 'CI Build',
		origin: 'open' as const,
		tabOpen: true,
		since: null,
	};

	it('says where a message went and how the tab came to be', () => {
		expect(describeQuickChatRoute(route)).toBe('sent to open tab "CI Build"');
		expect(describeQuickChatRoute({ ...route, origin: 'reopened', status: 'running' })).toBe(
			'running in reopened tab "CI Build"'
		);
		expect(describeQuickChatRoute({ ...route, origin: 'new', status: 'queued' })).toBe(
			'queued for new tab "CI Build"'
		);
		expect(describeQuickChatRoute({ ...route, status: 'cancelled' })).toBe(
			'cancelled, was for open tab "CI Build"'
		);
	});

	it('covers a message with no tab yet, or none at all', () => {
		const none = { ...route, tabId: null, tabName: null, origin: null };
		expect(describeQuickChatRoute({ ...none, status: 'searching' })).toBe('searching for a tab');
		expect(describeQuickChatRoute({ ...none, status: 'failed' })).toBe('failed');
		expect(describeQuickChatRoute({ ...none, status: 'cancelled' })).toBe('cancelled');
	});
});

describe('logsToQuickChatMessages thinking', () => {
	const reply = [
		log('t1', 'thinking', 'Reading '),
		log('t2', 'thinking', 'the file.'),
		log('o1', 'stdout', 'Here is the answer.'),
		log('t3', 'thinking', 'Checking once more.'),
	];

	it('leaves thinking out by default and when off', () => {
		expect(logsToQuickChatMessages(reply).map((m) => m.role)).toEqual(['assistant']);
		expect(logsToQuickChatMessages(reply, { thinking: 'off', running: true })).toHaveLength(1);
	});

	it('keeps all of it in place when sticky, merging streamed pieces', () => {
		const messages = logsToQuickChatMessages(reply, { thinking: 'sticky' });
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['thinking', 'Reading the file.'],
			['assistant', 'Here is the answer.'],
			['thinking', 'Checking once more.'],
		]);
	});

	it('when on, shows only the reasoning since the last answer, while the reply runs', () => {
		const running = logsToQuickChatMessages(reply, { thinking: 'on', running: true });
		expect(running.map((m) => [m.role, m.text])).toEqual([
			['assistant', 'Here is the answer.'],
			['thinking', 'Checking once more.'],
		]);
		const done = logsToQuickChatMessages(reply, { thinking: 'on', running: false });
		expect(done.map((m) => m.role)).toEqual(['assistant']);
	});

	it('when on, shows reasoning before any answer has arrived', () => {
		const messages = logsToQuickChatMessages(reply.slice(0, 2), { thinking: 'on', running: true });
		expect(messages.map((m) => m.role)).toEqual(['thinking']);
	});
});

describe('parseQuickChatTabChoice', () => {
	it('reads new, auto (any case), and anything else as a tab id', () => {
		expect(parseQuickChatTabChoice('new')).toEqual({ kind: 'new' });
		expect(parseQuickChatTabChoice(' AUTO ')).toEqual({ kind: 'auto' });
		expect(parseQuickChatTabChoice('tab-123')).toEqual({ kind: 'tab', tabId: 'tab-123' });
	});

	it('returns null for nothing', () => {
		expect(parseQuickChatTabChoice('')).toBeNull();
		expect(parseQuickChatTabChoice('  ')).toBeNull();
		expect(parseQuickChatTabChoice(undefined)).toBeNull();
	});
});
