/**
 * @file session-command.test.ts
 * @description The shared failure reporters every bridge verb ends in:
 * `failCommand` prints the error in the verb's output mode and exits with the
 * code it is given, and `failFromError` picks that code from the failure.
 * `sendBridgeCommand` reports an app refusal through `failCommand`, with any
 * extra JSON fields the verb maps the error to.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
import {
	MAESTRO_NOT_RUNNING_CODE,
	MAESTRO_NOT_RUNNING_MESSAGE,
} from '../../../cli/services/maestro-not-running';
import { ExitCode } from '../../../cli/exit-codes';
import {
	CommandTimeoutError,
	MaestroNotRunningError,
	UnsupportedCommandError,
} from '../../../cli/services/maestro-bridge-errors';
import {
	failCommand,
	failFromError,
	sendBridgeCommand,
} from '../../../cli/services/session-command';
import { withMaestroClient } from '../../../cli/services/maestro-client';

describe('failCommand and failFromError', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints the error on stderr for a person and exits with the general failure', () => {
		expect(() => failCommand('Nope', false)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(errorSpy.mock.calls[0][0]).toContain('Nope');
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('prints one JSON object on stdout under --json', () => {
		expect(() => failCommand('Nope', true, ExitCode.InvalidUsage)).toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ success: false, error: 'Nope' });
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('adds extra fields to the JSON error', () => {
		expect(() =>
			failCommand('Nope', true, ExitCode.GeneralError, { code: 'NOPE_DISABLED' })
		).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			error: 'Nope',
			code: 'NOPE_DISABLED',
		});
	});

	it('uses the same not-running class through both CLI error modules', () => {
		expect(() => failFromError(new MaestroNotRunningError('connect-failed'), true)).toThrow(
			`exit:${ExitCode.NotRunning}`
		);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			error: MAESTRO_NOT_RUNNING_MESSAGE,
			code: MAESTRO_NOT_RUNNING_CODE,
		});
	});

	it('exits with the code the failure names', () => {
		expect(() => failFromError(new MaestroNotRunningError('no-discovery-file'), true)).toThrow(
			`exit:${ExitCode.NotRunning}`
		);
		expect(() => failFromError(new UnsupportedCommandError('x'), true)).toThrow(
			`exit:${ExitCode.Unsupported}`
		);
		expect(() => failFromError(new CommandTimeoutError('x_result'), true)).toThrow(
			`exit:${ExitCode.Timeout}`
		);
		expect(() => failFromError(new Error('plain'), true)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(() => failFromError('a string', true)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: false,
			error: 'a string',
		});
	});
});

describe('sendBridgeCommand', () => {
	let logSpy: MockInstance;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const reply = (value: Record<string, unknown>) =>
		vi
			.mocked(withMaestroClient)
			.mockImplementation(async (action) =>
				action({ sendCommand: vi.fn().mockResolvedValue(value) } as never)
			);

	it('returns a reply that succeeded', async () => {
		reply({ success: true, value: 1 });
		await expect(sendBridgeCommand({ type: 'x' }, 'x_result', true)).resolves.toEqual({
			success: true,
			value: 1,
		});
	});

	it('maps a refusal to extra JSON fields when the verb asks', async () => {
		reply({ success: false, error: 'Off.' });
		const fields = vi.fn((error: string) => (error === 'Off.' ? { code: 'OFF' } : undefined));
		await expect(sendBridgeCommand({ type: 'x' }, 'x_result', true, 5_000, fields)).rejects.toThrow(
			`exit:${ExitCode.GeneralError}`
		);
		expect(fields).toHaveBeenCalledWith('Off.');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			error: 'Off.',
			code: 'OFF',
		});
	});
});
