/** One host-owned, headless provider turn, shared by plugin send and CLI send. */
import type { SessionInfo } from '../../shared/types';
import type { AgentResult, SpawnAgentOptions } from '../../cli/services/agent-spawner';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { createPluginRunProofFile, removePluginRunProofFile } from './plugin-tool-run-identity';
import type { PluginToolReceipt } from './plugin-tool-run-identity';
import { MCP_CONFIG_BY_AGENT } from '../../shared/plugins/mcp-agent-config';
import { isAutoModel } from '../../shared/autoModel';
import type { AutoTurn } from '../../shared/autoTurn';
import type { AgentAutoTurnRequest } from '../local-models/auto-turn';
import { logger } from '../utils/logger';

import {
	HEADLESS_RUN_TIMEOUT_MS,
	HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
} from '../../shared/plugins/headless-agent-timeouts';

export interface PluginHeadlessRunnerDeps {
	getAgent: (agentId: string) => SessionInfo | undefined;
	detectAgent: (type: SessionInfo['toolType']) => Promise<{ available: boolean }>;
	hasPluginTools: () => boolean;
	spawn: (
		type: SessionInfo['toolType'],
		cwd: string,
		prompt: string,
		sessionId?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentResult>;
	prepareSystemPrompt: (agent: SessionInfo) => Promise<string | undefined>;
	issueRunToken: (agentId: string, ttlMs: number, receiptToolId?: string) => string;
	getRunReceipts?: (token: string) => PluginToolReceipt[];
	hasRunReceiptOverflow?: (token: string) => boolean;
	revokeRunToken: (token: string) => void;
	cliScriptPath: () => string;
	audit: (agentId: string, resumed: boolean) => void;
	/**
	 * Decide and resolve a turn for an agent set to the Auto model
	 * (`resolveAgentAutoTurn`). Never rejects on a routing: no decision resolves
	 * to the agent's default.
	 */
	resolveAutoTurn: (request: AgentAutoTurnRequest) => Promise<AutoTurn>;
	/**
	 * Remember what a provider session launched on, so a send that resumes it
	 * keeps its model while the provider's cache is warm (`noteAutoSessionLaunch`).
	 */
	noteAutoSessionLaunch: (
		toolType: SessionInfo['toolType'],
		providerSessionId: string,
		turn: Pick<AutoTurn, 'model' | 'runOn'>
	) => void;
}

export function createPluginHeadlessAgentRunner(
	deps: PluginHeadlessRunnerDeps
): HeadlessAgentRunner {
	return async (
		agentId,
		prompt,
		providerSessionId,
		signal,
		origin = 'auto',
		onProgress,
		receiptToolId
	) => {
		const agent = deps.getAgent(agentId);
		if (!agent) throw new Error(`agents.send: no agent "${agentId}"`);
		const local = !agent.sessionSshRemoteConfig?.enabled;
		if (
			receiptToolId &&
			(!local ||
				!MCP_CONFIG_BY_AGENT[agent.toolType]?.verified ||
				!deps.hasPluginTools() ||
				!deps.getRunReceipts ||
				!deps.hasRunReceiptOverflow)
		) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: 'Authenticated plugin tool receipt unavailable',
			};
		}
		if (local && !(await deps.detectAgent(agent.toolType)).available) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: `Agent CLI unavailable: ${agent.toolType}`,
			};
		}
		const runToken =
			local && deps.hasPluginTools()
				? deps.issueRunToken(agent.id, HEADLESS_RUN_COMPLETION_TIMEOUT_MS, receiptToolId)
				: undefined;
		let pluginRunProofFile: string | undefined;
		try {
			pluginRunProofFile = runToken
				? createPluginRunProofFile(runToken, HEADLESS_RUN_COMPLETION_TIMEOUT_MS)
				: undefined;
			deps.audit(agent.id, !!providerSessionId);
			if (signal?.aborted) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: 'Agent run timed out or was cancelled',
				};
			}
			// An agent set to the Auto model has no model of its own to pass: the
			// router decides this turn's model and effort, and the place when the
			// tier names one. A tier target that cannot be used fails the send by
			// name; the turn is never launched on some other model in its place.
			const autoTurn = isAutoModel(agent.customModel)
				? await deps.resolveAutoTurn({
						agent,
						prompt,
						...(providerSessionId ? { providerSessionId } : {}),
						...(signal ? { signal } : {}),
					})
				: undefined;
			if (autoTurn?.refusal) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: autoTurn.refusal.message,
				};
			}
			for (const line of autoTurn ? [...autoTurn.notes, ...autoTurn.warnings] : []) {
				logger.info(`agents.send -> agent ${agent.id}: ${line}`, '[ModelRouting]');
			}
			const result = await deps.spawn(agent.toolType, agent.cwd, prompt, providerSessionId, {
				customModel: autoTurn ? autoTurn.model : agent.customModel,
				customEffort: autoTurn ? autoTurn.effort : agent.customEffort,
				...(autoTurn?.runOn ? { runOn: autoTurn.runOn } : {}),
				customArgs: agent.customArgs,
				customEnvVars: agent.customEnvVars,
				additionalDirectories: agent.additionalDirectories,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				appendSystemPrompt: await deps.prepareSystemPrompt(agent),
				enableMaestroP: agent.enableMaestroP,
				maestroPMode: agent.maestroPMode,
				maestroPPath: agent.maestroPPath,
				querySource: origin === 'relay' ? 'auto' : origin,
				pluginRunProofFile,
				mcpCliScriptPath: deps.cliScriptPath(),
				timeoutMs: HEADLESS_RUN_TIMEOUT_MS,
				signal,
				onProgress,
			});
			// The session's last activity is now, and a session this turn started
			// has only just been named: record what it ran on for the send that
			// resumes it.
			if (autoTurn && result.agentSessionId) {
				deps.noteAutoSessionLaunch(agent.toolType, result.agentSessionId, autoTurn);
			}
			const receiptsOverflowed =
				!!receiptToolId && !!runToken && deps.hasRunReceiptOverflow!(runToken);
			const success =
				result.success &&
				typeof result.response === 'string' &&
				result.response.trim().length > 0 &&
				!signal?.aborted &&
				!receiptsOverflowed;
			return {
				success,
				response: success ? result.response! : null,
				sessionId: result.agentSessionId ?? null,
				usageStats: result.usageStats,
				...(receiptToolId && runToken ? { toolReceipts: deps.getRunReceipts!(runToken) } : {}),
				...(success
					? {}
					: {
							error: receiptsOverflowed
								? `Plugin tool receipt limit exceeded; inspect recorded receipts before retrying${result.error ? `; provider error: ${result.error}` : ''}`
								: (result.error ?? 'Agent run failed or returned no final text'),
						}),
			};
		} finally {
			// Revoke authority even if removing the on-disk proof fails.
			if (runToken) deps.revokeRunToken(runToken);
			if (pluginRunProofFile) {
				try {
					removePluginRunProofFile(pluginRunProofFile);
				} catch (error) {
					logger.warn('Could not remove plugin run proof file', '[PluginRunIdentity]', {
						error: String(error),
					});
				}
			}
		}
	};
}
