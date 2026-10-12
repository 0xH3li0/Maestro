/**
 * @file quick-chat.test.ts
 * @description `maestro-cli quick-chat font`: the words and sizes it accepts,
 * and the message it hands the desktop.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({ resolveAgentId: vi.fn((id: string) => id) }));

import { parseQuickChatFontArg, quickChat } from '../../../cli/commands/quick-chat';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { EMPTY_QUICK_CHAT_SNAPSHOT } from '../../../shared/quickChat';

describe('parseQuickChatFontArg', () => {
	it.each([
		['in', { step: 1 }],
		['bigger', { step: 1 }],
		['+', { step: 1 }],
		['out', { step: -1 }],
		['smaller', { step: -1 }],
		['reset', { reset: true }],
		['120%', { scale: 1.2 }],
		['120', { scale: 1.2 }],
		['1.2', { scale: 1.2 }],
		['  OUT ', { step: -1 }],
	])('%s', (arg, expected) => {
		expect(parseQuickChatFontArg(arg)).toEqual(expected);
	});

	it.each(['bigg', '', 'abc%', '0', '-5'])('rejects %j', (arg) => {
		expect(() => parseQuickChatFontArg(arg)).toThrow(/Unknown text size/);
	});

	it('rejects a size outside 70%-200%', () => {
		expect(() => parseQuickChatFontArg('500%')).toThrow(/between 70% and 200%/);
		expect(() => parseQuickChatFontArg('0.5')).toThrow(/between 70% and 200%/);
	});
});

describe('quickChat font', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: { fontScale: 1.2, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT },
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('sends the parsed request and prints the new size', async () => {
		await quickChat('font', { state: 'in' }, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'font', fontScale: { step: 1 } },
			'quick_chat_result'
		);
		expect(log).toHaveBeenCalledWith('Text size: 120%');
	});

	it('with no size, only reads it', async () => {
		await quickChat('font', {}, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'font' },
			'quick_chat_result'
		);
	});
});
