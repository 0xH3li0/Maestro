import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as runIdentity from '../../../main/plugins/plugin-tool-run-identity';
import { autoTurnReport } from '../../../shared/autoTurn';
import type { SessionInfo } from '../../../shared/types';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';

const agent = {
	id: 'agent-a',
	name: 'A',
	toolType: 'codex',
	cwd: '/project',
	projectRoot: '/project',
} as SessionInfo;

describe('plugin headless agent runner', () => {
	it('returns only receipts tied to its issued proof, independent of final prose', async () => {
		const identity = new runIdentity.PluginToolRunIdentity();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn: async (_type, _cwd, prompt, _session, options) => {
				const token = fs.readFileSync(options!.pluginRunProofFile!, 'utf8');
				if (prompt === 'real send') {
					identity.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['123'] });
				}
				if (prompt.startsWith('overflow')) {
					for (let index = 0; index < 17; index++) {
						identity.recordReceipt(token, 'sh.maestro.relay/send', {
							messageIds: [String(100 + index)],
						});
					}
				}
				if (prompt === 'overflow failed') {
					return { success: false, error: 'Provider tool loop stopped unexpectedly' };
				}
				return { success: true, response: '{"messageIds":["999"]}' };
			},
			prepareSystemPrompt: async () => undefined,
			issueRunToken: (id, ttl, toolId) => identity.issue(id, ttl, toolId),
			getRunReceipts: (token) => identity.getReceipts(token),
			hasRunReceiptOverflow: (token) => identity.hasReceiptOverflowed(token),
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		const delivered = await run(
			'agent-a',
			'real send',
			undefined,
			undefined,
			'user',
			undefined,
			'sh.maestro.relay/send'
		);
		expect(delivered.toolReceipts).toEqual([
			{
				runId: expect.stringMatching(/^[0-9a-f]{32}$/),
				agentId: 'agent-a',
				toolId: 'sh.maestro.relay/send',
				messageIds: ['123'],
			},
		]);
		const claimedOnly = await run(
			'agent-a',
			'model only',
			undefined,
			undefined,
			'user',
			undefined,
			'sh.maestro.relay/send'
		);
		expect(claimedOnly.toolReceipts).toEqual([]);
		for (const prompt of ['overflow', 'overflow failed']) {
			const overflow = await run(
				'agent-a',
				prompt,
				undefined,
				undefined,
				'user',
				undefined,
				'sh.maestro.relay/send'
			);
			expect(overflow).toMatchObject({
				success: false,
				response: null,
				error: expect.stringContaining(
					'Plugin tool receipt limit exceeded; inspect recorded receipts before retrying'
				),
			});
			expect(overflow.toolReceipts).toHaveLength(16);
			expect(overflow.toolReceipts?.[0].messageIds).toEqual(['100']);
			expect(overflow.toolReceipts?.[15].messageIds).toEqual(['115']);
			if (prompt === 'overflow failed') {
				expect(overflow.error).toContain('provider error: Provider tool loop stopped unexpectedly');
			}
		}
	});

	it.each(['opencode', 'codex'] as const)(
		'refuses a receipt request for %s without verified injection or an overflow guard',
		async (toolType) => {
			const spawn = vi.fn();
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => ({ ...agent, toolType }),
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				getRunReceipts: () => [],
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			expect(
				await run(
					'agent-a',
					'report',
					undefined,
					undefined,
					'user',
					undefined,
					'sh.maestro.relay/send'
				)
			).toMatchObject({ success: false, error: 'Authenticated plugin tool receipt unavailable' });
			expect(spawn).not.toHaveBeenCalled();
		}
	);

	it('keeps Relay as host attribution while marking its provider process unattended', async () => {
		const spawn = vi.fn(async () => ({
			success: true,
			response: 'done',
			agentSessionId: 'relay-1',
		}));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		await run('agent-a', 'hello', undefined, undefined, 'relay');
		expect(spawn).toHaveBeenCalledWith(
			'codex',
			'/project',
			'hello',
			undefined,
			expect.objectContaining({ querySource: 'auto' })
		);
	});
	it('reports no successful response when a provider exits without final text', async () => {
		const onProgress = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => false,
			spawn: async () => ({ success: true, response: '   ', agentSessionId: 'provider-empty' }),
			prepareSystemPrompt: async () => undefined,
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello', undefined, undefined, 'auto', onProgress)).toMatchObject({
			success: false,
			response: null,
		});
		expect(onProgress).not.toHaveBeenCalled();
	});

	it('keeps two concurrent threads separate, resumes the requested provider session and revokes proofs', async () => {
		const issueRunToken = vi.fn((_id: string) => `proof-${issueRunToken.mock.calls.length}`);
		const revokeRunToken = vi.fn();
		const resolvers: Array<
			(value: { success: true; response: string; agentSessionId: string }) => void
		> = [];
		const spawn = vi.fn(
			() =>
				new Promise<{ success: true; response: string; agentSessionId: string }>((resolve) =>
					resolvers.push(resolve)
				)
		);
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => 'Maestro context',
			issueRunToken,
			revokeRunToken,
			cliScriptPath: () => '/maestro-cli.js',
			audit: vi.fn(),
		});
		const one = run('agent-a', 'thread one');
		const two = run('agent-a', 'thread two');
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
		expect(spawn.mock.calls[0][3]).toBeUndefined();
		expect(spawn.mock.calls[1][3]).toBeUndefined();
		const firstProofFile = spawn.mock.calls[0][4].pluginRunProofFile;
		const secondProofFile = spawn.mock.calls[1][4].pluginRunProofFile;
		expect(firstProofFile).not.toBe(secondProofFile);
		expect(fs.readFileSync(firstProofFile, 'utf8')).toBe('proof-1');
		expect(fs.readFileSync(secondProofFile, 'utf8')).toBe('proof-2');
		resolvers[1]({ success: true, response: 'answer two', agentSessionId: 'provider-two' });
		resolvers[0]({ success: true, response: 'answer one', agentSessionId: 'provider-one' });
		expect(await one).toMatchObject({ response: 'answer one', sessionId: 'provider-one' });
		expect(await two).toMatchObject({ response: 'answer two', sessionId: 'provider-two' });
		const follow = run('agent-a', 'follow', 'provider-one');
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
		expect(spawn.mock.calls[2][3]).toBe('provider-one');
		resolvers[2]({ success: true, response: 'continued', agentSessionId: 'provider-one' });
		expect(await follow).toMatchObject({ response: 'continued', sessionId: 'provider-one' });
		expect(revokeRunToken).toHaveBeenCalledTimes(3);
		expect(fs.existsSync(firstProofFile)).toBe(false);
		expect(fs.existsSync(secondProofFile)).toBe(false);
	});

	it('keeps authenticated tool delivery available through the full 60-minute run', async () => {
		vi.useFakeTimers();
		const identity = new runIdentity.PluginToolRunIdentity();
		const issueRunToken = vi.fn((id: string, ttl: number, toolId?: string) =>
			identity.issue(id, ttl, toolId)
		);
		let proofFile: string | undefined;
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn: async (_type, _cwd, _prompt, _session, options) => {
				expect(options!.timeoutMs).toBe(60 * 60_000);
				proofFile = options!.pluginRunProofFile!;
				// Cross the old process/CLI deadlines and approach the new deadline.
				vi.advanceTimersByTime(60 * 60_000 - 1);
				expect(fs.existsSync(proofFile)).toBe(true);
				const token = fs.readFileSync(proofFile, 'utf8');
				expect(identity.resolve(token)).toEqual({ callerAgentId: 'agent-a' });
				identity.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['123'] });
				return { success: true, response: 'delivered' };
			},
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			getRunReceipts: (token) => identity.getReceipts(token),
			hasRunReceiptOverflow: (token) => identity.hasReceiptOverflowed(token),
			revokeRunToken: (token) => identity.revoke(token),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		try {
			expect(
				await run(
					'agent-a',
					'report',
					undefined,
					undefined,
					'relay',
					undefined,
					'sh.maestro.relay/send'
				)
			).toMatchObject({
				success: true,
				toolReceipts: [{ agentId: 'agent-a', messageIds: ['123'] }],
			});
			expect(issueRunToken).toHaveBeenCalledWith('agent-a', 61 * 60_000, 'sh.maestro.relay/send');
			expect(identity.resolve(issueRunToken.mock.results[0].value)).toEqual({
				callerAgentId: null,
			});
			expect(fs.existsSync(proofFile!)).toBe(false);
		} finally {
			if (proofFile && fs.existsSync(proofFile)) runIdentity.removePluginRunProofFile(proofFile);
			vi.useRealTimers();
		}
	});

	it('preserves the startup recovery error and revokes proof on provider failure', async () => {
		const revokeRunToken = vi.fn();
		const error = 'Codex startup/authentication timed out; check the credential store and retry.';
		const spawn = vi.fn(async () => ({ success: false, error }));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: true }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken: () => 'proof',
			revokeRunToken,
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello')).toEqual({
			success: false,
			response: null,
			sessionId: null,
			usageStats: undefined,
			error,
		});
		expect(spawn.mock.calls[0][4].timeoutMs).toBe(60 * 60_000);
		expect(revokeRunToken).toHaveBeenCalledWith('proof');
	});

	it('revokes the token even when proof-file cleanup fails', async () => {
		const revokeRunToken = vi.fn();
		const createProof = vi.spyOn(runIdentity, 'createPluginRunProofFile').mockReturnValue('/proof');
		const removeProof = vi.spyOn(runIdentity, 'removePluginRunProofFile').mockImplementation(() => {
			expect(revokeRunToken).toHaveBeenCalledWith('proof');
			throw new Error('cleanup denied');
		});
		try {
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => agent,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => true,
				spawn: async () => ({ success: true, response: 'answer' }),
				prepareSystemPrompt: async () => undefined,
				issueRunToken: () => 'proof',
				revokeRunToken,
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
			});
			await expect(run('agent-a', 'hello')).resolves.toMatchObject({
				success: true,
				response: 'answer',
			});
			expect(revokeRunToken).toHaveBeenCalledOnce();
		} finally {
			createProof.mockRestore();
			removeProof.mockRestore();
		}
	});

	it('fails clearly before minting a proof when the configured provider is absent', async () => {
		const issueRunToken = vi.fn();
		const spawn = vi.fn();
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => agent,
			detectAgent: async () => ({ available: false }),
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		const result = await run('agent-a', 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Agent CLI unavailable/);
		expect(issueRunToken).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it('does not require a local provider binary for an SSH agent', async () => {
		const remoteAgent = {
			...agent,
			sessionSshRemoteConfig: { enabled: true },
		} as SessionInfo;
		const detectAgent = vi.fn(async () => ({ available: false }));
		const issueRunToken = vi.fn();
		const spawn = vi.fn(async () => ({
			success: true,
			response: 'remote answer',
			agentSessionId: 'remote-session',
		}));
		const run = createPluginHeadlessAgentRunner({
			getAgent: () => remoteAgent,
			detectAgent,
			hasPluginTools: () => true,
			spawn,
			prepareSystemPrompt: async () => undefined,
			issueRunToken,
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/cli.js',
			audit: vi.fn(),
		});
		expect(await run('agent-a', 'hello')).toMatchObject({
			success: true,
			response: 'remote answer',
			sessionId: 'remote-session',
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(issueRunToken).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledOnce();
	});

	// A send to an agent set to the Auto model: the turn is routed here, in the
	// process that owns the router, and the harness is never handed the word.
	describe('an agent on the Auto model', () => {
		const autoAgent = {
			...agent,
			toolType: 'claude-code',
			customModel: 'auto',
			customEffort: 'high',
		};
		const local = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };

		function harness(
			turn: Record<string, unknown>,
			overrides: Partial<Parameters<typeof createPluginHeadlessAgentRunner>[0]> = {}
		) {
			const spawn = vi.fn(async () => ({
				success: true,
				response: 'done',
				agentSessionId: 'sess-new',
			}));
			// A resolved Auto turn always carries its stamp: the reply reports it.
			const resolveAutoTurn = vi.fn(async () => ({
				notes: [],
				warnings: [],
				stamp: { status: 'routed' },
				...turn,
			}));
			const noteAutoSessionLaunch = vi.fn();
			const run = createPluginHeadlessAgentRunner({
				getAgent: () => autoAgent as SessionInfo,
				detectAgent: async () => ({ available: true }),
				hasPluginTools: () => false,
				spawn: spawn as never,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: () => 'token',
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/cli.js',
				audit: vi.fn(),
				resolveAutoTurn: resolveAutoTurn as never,
				noteAutoSessionLaunch,
				...overrides,
			});
			return { run, spawn, resolveAutoTurn, noteAutoSessionLaunch };
		}
		const spawnOptions = (spawn: ReturnType<typeof vi.fn>) => spawn.mock.calls[0][4];

		it('asks for the turn to be routed and launches on the model and effort it resolves to', async () => {
			const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku', effort: 'low' });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.success).toBe(true);
			expect(resolveAutoTurn).toHaveBeenCalledWith({
				agent: autoAgent,
				prompt: 'rename the helper',
			});
			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
			expect('runOn' in spawnOptions(spawn)).toBe(false);
		});

		it('never passes the word auto: no decision is no model at all', async () => {
			const { run, spawn } = harness({ model: undefined, effort: 'high' });

			await run('agent-a', 'rename the helper');

			expect(spawnOptions(spawn).customModel).toBeUndefined();
			expect(spawnOptions(spawn).customEffort).toBe('high');
		});

		it('launches on the place the tier names', async () => {
			const { run, spawn } = harness({ model: 'qwen3.5-4b', runOn: local });

			await run('agent-a', 'rename the helper');

			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'qwen3.5-4b', runOn: local });
		});

		it('names the provider session a send resumes, so the session can keep its model', async () => {
			const stop = new AbortController();
			const { run, resolveAutoTurn } = harness({ model: 'haiku' });

			await run('agent-a', 'and the tests', 'sess-1', stop.signal);

			expect(resolveAutoTurn).toHaveBeenCalledWith({
				agent: autoAgent,
				prompt: 'and the tests',
				providerSessionId: 'sess-1',
				signal: stop.signal,
			});
		});

		it('records what the session ran on once the provider has named it', async () => {
			const turn = { model: 'haiku', effort: 'low' };
			const { run, noteAutoSessionLaunch } = harness(turn);

			await run('agent-a', 'rename the helper');

			expect(noteAutoSessionLaunch).toHaveBeenCalledWith(
				'claude-code',
				'sess-new',
				expect.objectContaining(turn)
			);
		});

		it('fails the send by name, and spawns nothing, when the tier target cannot be used', async () => {
			const { run, spawn, noteAutoSessionLaunch } = harness({
				refusal: {
					code: 'tier-unsupported-source',
					message: 'This agent\'s "low" tier target cannot run.',
				},
			});

			const reply = await run('agent-a', 'rename the helper');

			expect(reply).toEqual({
				success: false,
				response: null,
				sessionId: null,
				error: 'This agent\'s "low" tier target cannot run.',
			});
			expect(spawn).not.toHaveBeenCalled();
			expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
		});

		it('routes nothing for an agent on a named model', async () => {
			const named = { ...autoAgent, customModel: 'opus' };
			const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
				{ model: 'haiku' },
				{ getAgent: () => named as SessionInfo }
			);

			await run('agent-a', 'rename the helper');

			expect(resolveAutoTurn).not.toHaveBeenCalled();
			expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
			expect(spawnOptions(spawn)).toMatchObject({ customModel: 'opus', customEffort: 'high' });
		});

		it('reports what Auto did with the turn: how its pill reads, and who decided', async () => {
			const stamp = {
				status: 'routed' as const,
				route: {
					tier: 'low' as const,
					effort: 'low' as const,
					engine: 'Embedding router',
					calibrated: false,
				},
			};
			const { run } = harness({ model: 'haiku', effort: 'low', stamp });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.auto).toEqual(autoTurnReport({ model: 'haiku', stamp }));
			expect(reply.auto).toEqual({
				label: 'Auto → low · haiku',
				detail: expect.stringContaining('Embedding router chose tier low, effort low.'),
			});
		});

		it('reports a turn the router did not decide, which still runs', async () => {
			const stamp = {
				status: 'router-off' as const,
				route: { skipped: 'off' as const, detail: 'The model-routing task is off.' },
			};
			const { run, spawn } = harness({ model: undefined, effort: 'high', stamp });

			const reply = await run('agent-a', 'rename the helper');

			expect(reply.success).toBe(true);
			expect(spawn).toHaveBeenCalledOnce();
			expect(reply.auto).toEqual({
				label: 'Auto (router off)',
				detail: expect.stringContaining('The model-routing task is off.'),
			});
		});

		// `turn.model` is this one turn's model (`maestro-cli send --model`), in
		// place of the agent's own. The eighth argument.
		describe('with a model for this one turn', () => {
			const named = { ...autoAgent, customModel: 'opus' };
			const send = (run: ReturnType<typeof harness>['run'], turn?: { model?: string }) =>
				run(
					'agent-a',
					'rename the helper',
					undefined,
					undefined,
					'user',
					undefined,
					undefined,
					turn
				);

			it("spawns on the named model in place of the agent's own, and asks no router", async () => {
				const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
					{ model: 'haiku' },
					{ getAgent: () => named as SessionInfo }
				);

				const reply = await send(run, { model: 'sonnet' });

				expect(resolveAutoTurn).not.toHaveBeenCalled();
				expect(noteAutoSessionLaunch).not.toHaveBeenCalled();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'sonnet', customEffort: 'high' });
				expect(reply.success).toBe(true);
				expect(reply).not.toHaveProperty('auto');
			});

			it('keeps the named model for this turn even when the agent is set to Auto', async () => {
				const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku' });

				const reply = await send(run, { model: 'sonnet' });

				expect(resolveAutoTurn).not.toHaveBeenCalled();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'sonnet' });
				expect(reply).not.toHaveProperty('auto');
			});

			it('routes an auto turn for an agent on a named model, and reports it', async () => {
				const { run, spawn, resolveAutoTurn, noteAutoSessionLaunch } = harness(
					{ model: 'haiku', effort: 'low' },
					{ getAgent: () => named as SessionInfo }
				);

				const reply = await send(run, { model: 'auto' });

				expect(resolveAutoTurn).toHaveBeenCalledWith({
					agent: named,
					prompt: 'rename the helper',
				});
				// The harness is handed the routed model, never the word and never the agent's own.
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
				expect(noteAutoSessionLaunch).toHaveBeenCalledWith(
					'claude-code',
					'sess-new',
					expect.objectContaining({ model: 'haiku' })
				);
				expect(reply.auto).toEqual({
					label: expect.stringMatching(/^Auto/),
					detail: expect.stringMatching(/^Auto/),
				});
				expect(reply.auto?.label).toContain('haiku');
			});

			it.each([[undefined], [{}]])(
				"runs on the agent's own model when no turn model is given (%j)",
				async (turn) => {
					const { run, spawn, resolveAutoTurn } = harness(
						{ model: 'haiku' },
						{ getAgent: () => named as SessionInfo }
					);

					const reply = await send(run, turn);

					expect(resolveAutoTurn).not.toHaveBeenCalled();
					expect(spawnOptions(spawn)).toMatchObject({ customModel: 'opus', customEffort: 'high' });
					expect(reply).not.toHaveProperty('auto');
				}
			);

			it('still routes an agent set to Auto when no turn model is given', async () => {
				const { run, spawn, resolveAutoTurn } = harness({ model: 'haiku' });

				const reply = await send(run, undefined);

				expect(resolveAutoTurn).toHaveBeenCalledOnce();
				expect(spawnOptions(spawn)).toMatchObject({ customModel: 'haiku' });
				expect(reply.auto).toBeDefined();
			});
		});
	});
});
