/**
 * Tests for `cross-agent:consultBudget`, the read the renderer's system prompt
 * builder makes so a tab's prompt can state what is left of the consultation
 * budget.
 *
 * Contracts defended:
 * - The limit is the setting read through the normalizer (`0` is a real value).
 * - A chain that arrived as data is narrowed before it is used; anything that
 *   is not a chain reads as a root turn, which is what `process:spawn` does
 *   with the same value.
 * - An unreadable counter answers `null`, never a guessed figure.
 *
 * The counter itself is mocked: its default directory is the LIVE one in an
 * agent's shell (`MAESTRO_USER_DATA`), and this handler takes no directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/cross-agent/cross-agent-router', () => ({
	startCrossAgentRequest: vi.fn(),
	cancelCrossAgentRequestsForSource: vi.fn(() => 0),
}));

vi.mock('../../../../main/peer-consults/consult-budget', () => ({
	readConsultBudgetStatus: vi.fn(),
}));

import { registerCrossAgentHandlers } from '../../../../main/ipc/handlers/cross-agent';
import { readConsultBudgetStatus } from '../../../../main/peer-consults/consult-budget';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

describe('cross-agent:consultBudget', () => {
	let settings: Record<string, unknown>;
	let consultBudget: Handler;

	beforeEach(() => {
		vi.clearAllMocks();
		settings = {};
		vi.mocked(readConsultBudgetStatus).mockImplementation(({ chain, limit }) => ({
			limit,
			spent: chain ? 7 : 0,
		}));

		registerCrossAgentHandlers({
			getProcessManager: () => null,
			getAgentDetector: () => null,
			sessionsStore: { get: vi.fn(() => []) } as never,
			agentConfigsStore: { get: vi.fn(() => ({})) } as never,
			settingsStore: { get: vi.fn((key: string) => settings[key]) } as never,
			sshStore: null,
			safeSend: vi.fn(),
		});

		const registration = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === 'cross-agent:consultBudget');
		expect(registration).toBeDefined();
		consultBudget = registration?.[1] as unknown as Handler;
	});

	it('answers a root turn (no chain) with the default budget and nothing spent', async () => {
		expect(await consultBudget({}, {})).toEqual({ limit: 25, spent: 0 });
		expect(await consultBudget({}, undefined)).toEqual({ limit: 25, spent: 0 });
		expect(readConsultBudgetStatus).toHaveBeenCalledWith({ chain: undefined, limit: 25 });
	});

	it('reads the chain of a delegated turn', async () => {
		const consultChain = { chainId: 'chain-a', depth: 2 };

		expect(await consultBudget({}, { consultChain })).toEqual({ limit: 25, spent: 7 });
		expect(readConsultBudgetStatus).toHaveBeenCalledWith({ chain: consultChain, limit: 25 });
	});

	it('reads the limit through the normalizer, so 0 stays 0 and junk is the default', async () => {
		settings.maxConsultationsPerTurn = 0;
		expect(await consultBudget({}, {})).toEqual({ limit: 0, spent: 0 });

		settings.maxConsultationsPerTurn = 12;
		expect(await consultBudget({}, {})).toEqual({ limit: 12, spent: 0 });

		settings.maxConsultationsPerTurn = 'lots';
		expect(await consultBudget({}, {})).toEqual({ limit: 25, spent: 0 });
	});

	it('reads anything that is not a chain as a root turn, the way the spawn does', async () => {
		for (const consultChain of ['chain-a', { chainId: '../escape', depth: 1 }, 42, null]) {
			expect(await consultBudget({}, { consultChain })).toEqual({ limit: 25, spent: 0 });
		}
	});

	it('answers null when the counter cannot be read', async () => {
		vi.mocked(readConsultBudgetStatus).mockReturnValue(undefined);

		expect(await consultBudget({}, { consultChain: { chainId: 'chain-a', depth: 1 } })).toBeNull();
	});
});
