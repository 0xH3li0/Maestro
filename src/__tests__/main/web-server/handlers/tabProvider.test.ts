import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTabProvider } from '../../../../main/web-server/handlers/messageHandlers/tabs';
import { setBridgeGuardContextProvider } from '../../../../main/web-server/handlers/bridgePathGuard';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';

afterEach(() => setBridgeGuardContextProvider(null));

function setup(enabled = true) {
	setBridgeGuardContextProvider(() => ({
		userDataDir: null,
		platform: 'darwin',
		encoreFeatures: { ensemble: enabled },
	}));
	const send = vi.fn();
	const updateSessionConfig = vi
		.fn()
		.mockResolvedValue({ success: true, tab: { provider: 'codex', agentProvider: 'claude-code' } });
	const ctx = { send, callbacks: { updateSessionConfig } } as unknown as MessageHandlerContext;
	return { send, updateSessionConfig, ctx };
}

describe('tab provider bridge', () => {
	it('forwards one atomic selection to the authoritative renderer callback and returns its state', async () => {
		const { ctx, send, updateSessionConfig } = setup();
		await handleTabProvider(ctx, {} as never, {
			type: 'tab_provider',
			sessionId: 'agent',
			tabId: 'tab',
			provider: 'codex',
			model: 'auto',
			effort: 'high',
			requestId: 'request',
		});
		expect(updateSessionConfig).toHaveBeenCalledWith('agent', {
			tabId: 'tab',
			tabProviderSelection: { provider: 'codex', model: 'auto', effort: 'high' },
		});
		expect(send).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				type: 'tab_provider_result',
				success: true,
				requestId: 'request',
				tab: { provider: 'codex', agentProvider: 'claude-code' },
			})
		);
	});
	it('rejects reads and writes while Ensemble is off', async () => {
		const { ctx, send, updateSessionConfig } = setup(false);
		for (const extra of [{}, { provider: 'codex' }]) {
			await handleTabProvider(ctx, {} as never, {
				type: 'tab_provider',
				sessionId: 'agent',
				tabId: 'tab',
				...extra,
			});
		}
		expect(updateSessionConfig).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				success: false,
				error: expect.stringContaining('Ensemble is disabled'),
			})
		);
	});
	it('refuses old callback implementations rather than claiming a partial edit succeeded', async () => {
		const { ctx, send, updateSessionConfig } = setup();
		updateSessionConfig.mockResolvedValue({ success: true });
		await handleTabProvider(ctx, {} as never, {
			type: 'tab_provider',
			sessionId: 'agent',
			tabId: 'tab',
			provider: 'codex',
		});
		expect(send).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ success: false, error: expect.stringContaining('upgrade') })
		);
	});
});
