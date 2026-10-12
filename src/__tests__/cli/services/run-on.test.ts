/**
 * @file run-on.test.ts
 *
 * Run on for the agents `maestro-cli` launches in its own process. What is
 * pinned: an agent on its provider's model costs one parse (nothing is read,
 * imported or asked); a saved source is read from the settings file and asked
 * directly, with no running app; the Maestro model server is asked of the
 * running app; and with the app closed the launch is refused by name, never run
 * on the provider's model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storage = vi.hoisted(() => ({
	readLocalModelEndpoints: vi.fn(),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(),
	readSshRemotes: vi.fn(() => []),
}));
vi.mock('../../../cli/services/storage', () => storage);

const bridge = vi.hoisted(() => ({ sendCommand: vi.fn(), connectError: null as Error | null }));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(async (action: (client: unknown) => Promise<unknown>) => {
		if (bridge.connectError) throw bridge.connectError;
		return action({ sendCommand: bridge.sendCommand });
	}),
}));

const endpointClient = vi.hoisted(() => ({ listEndpointModels: vi.fn() }));
vi.mock('../../../main/local-models/endpoint-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/endpoint-client')>()),
	listEndpointModels: endpointClient.listEndpointModels,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { configureCliRunOn, prepareCliRunOn } from '../../../cli/services/run-on';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { isAgentRunOnConfigured, resetAgentRunOnForTests } from '../../../main/local-models/run-on';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';

const WORKSTATION = {
	id: 'ep-ws',
	name: 'Workstation',
	kind: 'openai-compatible' as const,
	baseUrl: 'https://models.example.com',
	apiKeyEnvVar: 'WORKSTATION_KEY',
	enabled: true,
};
const BIG = { type: 'source', endpointId: WORKSTATION.id, model: 'big-model' };
const ON_SERVER = { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: 'gpt-oss-20b' };

beforeEach(() => {
	vi.clearAllMocks();
	bridge.connectError = null;
	storage.readLocalModelEndpoints.mockReturnValue([WORKSTATION]);
	storage.readSettingValue.mockImplementation((key: string) =>
		key === 'shellEnvVars' ? { WORKSTATION_KEY: 'sk-workstation' } : undefined
	);
	storage.readSshRemotes.mockReturnValue([]);
	endpointClient.listEndpointModels.mockResolvedValue([{ id: 'big-model' }]);
});

afterEach(() => {
	resetAgentRunOnForTests();
});

describe('prepareCliRunOn: an agent on its provider', () => {
	it.each([[undefined], [{ type: 'provider' }]])(
		'answers none for %j without reading a store or wiring anything',
		async (target) => {
			expect(await prepareCliRunOn({ toolType: 'claude-code', target })).toEqual({ kind: 'none' });
			expect(isAgentRunOnConfigured()).toBe(false);
			expect(storage.readLocalModelEndpoints).not.toHaveBeenCalled();
			expect(storage.readSshRemotes).not.toHaveBeenCalled();
			expect(withMaestroClient).not.toHaveBeenCalled();
		}
	);
});

describe('prepareCliRunOn: a saved source', () => {
	it('reads the source and its key from the settings file and asks it, with no running app', async () => {
		bridge.connectError = new Error('Maestro desktop app is not running');

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		expect(prepared).toEqual({
			kind: 'ready',
			runOn: { toolType: 'claude-code', target: BIG, endpoint: WORKSTATION, key: 'sk-workstation' },
			model: 'big-model',
			label: 'big-model on Workstation',
		});
		expect(endpointClient.listEndpointModels).toHaveBeenCalledWith(WORKSTATION, {
			shellEnvVars: { WORKSTATION_KEY: 'sk-workstation' },
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('refuses a model the source does not serve', async () => {
		endpointClient.listEndpointModels.mockResolvedValue([{ id: 'another' }]);

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-model-not-served' });
	});

	it('tolerates a settings file with no shell variables', async () => {
		storage.readSettingValue.mockReturnValue(undefined);
		storage.readLocalModelEndpoints.mockReturnValue([{ ...WORKSTATION, apiKeyEnvVar: undefined }]);

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.key).toBeUndefined();
	});

	it('refuses a loopback source for an SSH remote read from the remotes file', async () => {
		storage.readLocalModelEndpoints.mockReturnValue([
			{ ...WORKSTATION, baseUrl: 'http://127.0.0.1:11434', apiKeyEnvVar: undefined },
		]);
		storage.readSshRemotes.mockReturnValue([
			{
				id: 'r1',
				name: 'Build Box',
				host: 'build.example.com',
				port: 22,
				username: 'dev',
				privateKeyPath: '',
				enabled: true,
			},
		]);

		const prepared = await prepareCliRunOn({
			toolType: 'claude-code',
			target: BIG,
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('"Build Box"');
		expect(endpointClient.listEndpointModels).not.toHaveBeenCalled();
	});
});

describe('prepareCliRunOn: the Maestro model server', () => {
	it('asks the running app to make the server ready, and takes its address and key', async () => {
		bridge.sendCommand.mockResolvedValue({
			success: true,
			baseUrl: 'http://127.0.0.1:52100',
			key: 'sk-server',
		});

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(bridge.sendCommand).toHaveBeenCalledWith(
			{ type: 'local_models_server_ensure', model: 'gpt-oss-20b' },
			'local_models_server_ensure_result',
			expect.any(Number)
		);
		// A large model can take ten minutes to load; the wait covers it.
		expect(bridge.sendCommand.mock.calls[0][2]).toBeGreaterThanOrEqual(10 * 60 * 1000);
		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.endpoint).toMatchObject({
			id: MODEL_SERVER_ENDPOINT_ID,
			baseUrl: 'http://127.0.0.1:52100',
		});
		expect(prepared.runOn.key).toBe('sk-server');
	});

	it("refuses by name when the app is not running, and never falls back to the provider's model", async () => {
		bridge.connectError = new Error('Maestro desktop app is not running');

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-server-failed' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('runs inside the Maestro app');
		expect(prepared.message).toContain('Maestro desktop app is not running');
		expect(prepared.message).toContain('set Run on to Provider');
	});

	it("refuses with the app's reason when the server cannot serve the model", async () => {
		bridge.sendCommand.mockResolvedValue({
			success: false,
			error: 'gpt-oss 20B is not downloaded.',
		});

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('gpt-oss 20B is not downloaded');
	});

	it('refuses an answer that carries no address or key', async () => {
		bridge.sendCommand.mockResolvedValue({ success: true, baseUrl: 'http://127.0.0.1:52100' });

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-server-failed' });
	});
});

describe('configureCliRunOn', () => {
	it('wires the stores once, and leaves an earlier wiring alone', async () => {
		await configureCliRunOn();
		expect(isAgentRunOnConfigured()).toBe(true);

		await configureCliRunOn();
		// Still nothing read: wiring is not a lookup.
		expect(storage.readLocalModelEndpoints).not.toHaveBeenCalled();
	});
});
