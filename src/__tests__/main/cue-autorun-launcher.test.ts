/**
 * Tests for the desktop launcher behind Cue's `action: autorun`.
 *
 * A scheduled Auto Run fires with nobody watching, so every way the launch can
 * fail to reach the renderer has to come back as `{ success: false }` rather
 * than as an exception or a silent success: the executor turns this result
 * into the run status that decides whether the schedule is kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const requestFromRendererMock = vi.fn();
const isWebContentsAvailableMock = vi.fn();

vi.mock('../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: (...args: unknown[]) => requestFromRendererMock(...args),
}));
vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (...args: unknown[]) => isWebContentsAvailableMock(...args),
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { CUE_AUTORUN_LAUNCH_TIMEOUT_MS, launchCueAutoRun } from '../../main/cue-autorun-launcher';
import { logger } from '../../main/utils/logger';

const mainWindow = {} as BrowserWindow;
const params = {
	sessionId: 'session-1',
	documents: [{ filename: '/proj/Auto Run Docs/a.md', resetOnCompletion: true }],
	prompt: 'Work the tasks',
	loopEnabled: true,
	maxLoops: 2,
};

describe('launchCueAutoRun', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWebContentsAvailableMock.mockReturnValue(true);
		requestFromRendererMock.mockResolvedValue({ success: true });
	});

	it('fails without asking when there is no desktop window', async () => {
		const result = await launchCueAutoRun(null, params);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/desktop window not available/);
		expect(requestFromRendererMock).not.toHaveBeenCalled();
	});

	it('fails without asking when the renderer is gone', async () => {
		isWebContentsAvailableMock.mockReturnValue(false);

		const result = await launchCueAutoRun(mainWindow, params);

		expect(result).toEqual({ success: false, error: 'renderer webContents not available' });
		expect(requestFromRendererMock).not.toHaveBeenCalled();
	});

	it('asks the renderer to launch on the configure-auto-run channel', async () => {
		const result = await launchCueAutoRun(mainWindow, params);

		expect(result).toEqual({ success: true });
		const [win, channel, options] = requestFromRendererMock.mock.calls[0];
		expect(win).toBe(mainWindow);
		expect(channel).toBe('remote:configureAutoRun');
		expect(options.timeoutMs).toBe(CUE_AUTORUN_LAUNCH_TIMEOUT_MS);
		expect(options.args).toEqual([
			'session-1',
			{
				documents: params.documents,
				prompt: 'Work the tasks',
				loopEnabled: true,
				maxLoops: 2,
				launch: true,
			},
		]);
	});

	it('forwards the run options only when they are set', async () => {
		await launchCueAutoRun(mainWindow, {
			...params,
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
		});

		expect(requestFromRendererMock.mock.calls[0][2].args[1]).toMatchObject({
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
		});
	});

	it("passes the renderer's own rejection through", async () => {
		requestFromRendererMock.mockResolvedValue({ success: false, error: 'No Auto Run folder' });

		expect(await launchCueAutoRun(mainWindow, params)).toEqual({
			success: false,
			error: 'No Auto Run folder',
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('treats an empty reply as a failure', async () => {
		await launchCueAutoRun(mainWindow, params);
		const { parse } = requestFromRendererMock.mock.calls[0][2];

		expect(parse(undefined)).toEqual({ success: false, error: 'renderer returned no result' });
		expect(parse({ success: true })).toEqual({ success: true });
	});

	// The fallback is what the round trip resolves with when the renderer never
	// answers, so resolving with it is how a timeout looks from here.
	it('reports a renderer that never answers as a failed launch', async () => {
		requestFromRendererMock.mockImplementation(
			async (_win: unknown, _channel: unknown, options: { fallback: unknown }) => options.fallback
		);

		const result = await launchCueAutoRun(mainWindow, params);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/did not accept the launch within 30s/);
		expect(logger.warn).toHaveBeenCalled();
	});
});
