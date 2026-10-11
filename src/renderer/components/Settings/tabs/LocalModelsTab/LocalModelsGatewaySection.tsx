/**
 * LocalModelsGatewaySection - the Gateway section of the Local Models tab: a
 * table of agents, each with the gateway its provider traffic goes through.
 *
 * A gateway is an HTTP proxy (Headroom, LiteLLM, or one of your own) set as
 * the provider's base-URL variable when the agent starts. The same value is
 * editable in the agent's own settings; both write through
 * `setAgentGatewayUrl`, which validates the URL and flushes it to the main
 * process, where the desktop spawn reads it.
 *
 * Nothing here decides what a gateway does to a launch. Each row asks
 * `resolveAgentGateway` (through `<GatewayUrlField>`), the function the launch
 * plan runs, so the table cannot describe a launch that will not happen.
 *
 * A row with a gateway can also show the agent's effective environment
 * (`<EnvVarList>` over `resolveAgentEnvironment`), where the base-URL variable
 * is badged "Local Models gateway", or badged with the layer that beat it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { resolveAgentEnvironment } from '../../../../../shared/agentEnvironment';
import { getAgentDisplayName } from '../../../../../shared/agentMetadata';
import { gatewayEnvVarsFor } from '../../../../../shared/local-models/gateway';
import { effectiveAgentCustomEnvVars } from '../../../../../shared/providerProfiles';
import {
	useAgentLevelEnvVars,
	useSshRemoteNames,
} from '../../../../hooks/stats/useProviderProfiles';
import { setAgentGatewayUrl } from '../../../../services/agentGateway';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Session, Theme } from '../../../../types';
import { GatewayUrlField } from '../../../shared/GatewayUrlField';
import { EnvVarList } from '../../../ui/EnvVarList';
import { SectionCard } from '../DisplayTab/components/SectionCard';

export interface LocalModelsGatewaySectionProps {
	theme: Theme;
}

/** The SSH remote an agent runs on, or undefined for a local agent. */
function agentRemoteId(session: Session): string | undefined {
	const ssh = session.sessionSshRemoteConfig;
	return ssh?.enabled && ssh.remoteId ? ssh.remoteId : undefined;
}

export function LocalModelsGatewaySection({ theme }: LocalModelsGatewaySectionProps) {
	const sessions = useSessionStore((s) => s.sessions);
	// A terminal is a shell, not an agent: it has no provider traffic to route.
	const agents = useMemo(
		() =>
			sessions
				.filter((s) => s.toolType !== 'terminal')
				.sort((a, b) => a.name.localeCompare(b.name)),
		[sessions]
	);
	const toolTypes = useMemo(() => [...new Set(agents.map((s) => s.toolType))].sort(), [agents]);
	const { envByToolType } = useAgentLevelEnvVars(toolTypes);
	const remoteNames = useSshRemoteNames(agents.some((s) => agentRemoteId(s) !== undefined));

	return (
		<div className="space-y-3" data-testid="local-models-gateway-section">
			<SectionCard theme={theme} className="space-y-3">
				<p className="text-xs opacity-70 select-text">
					A gateway is an HTTP proxy, such as Headroom or LiteLLM, that an agent's requests go
					through on the way to its provider. Maestro sets it as the provider's base-URL variable
					when the agent starts. A variable you set in the agent's own environment wins over the
					gateway. If a gateway cannot be used, the agent does not start and says why: it is never
					sent to another endpoint.
				</p>
				<p className="text-xs opacity-70 select-text">
					An agent on a subscription login (Claude or Codex) saves quota, not dollars. Sending its
					traffic through a proxy is your choice for each agent, and you are responsible for your
					provider's terms.
				</p>
				{agents.length === 0 ? (
					<p className="text-xs opacity-70" data-testid="local-models-gateway-empty">
						No agents yet.
					</p>
				) : (
					<table className="w-full text-xs" data-testid="local-models-gateway-table">
						<thead>
							<tr>
								<th className="text-left font-medium opacity-70 pb-2 pr-3">Agent</th>
								<th className="text-left font-medium opacity-70 pb-2 pr-3">Provider</th>
								<th className="text-left font-medium opacity-70 pb-2 w-1/2">Gateway URL</th>
							</tr>
						</thead>
						<tbody>
							{agents.map((agent) => {
								const remoteId = agentRemoteId(agent);
								return (
									<GatewayRow
										key={agent.id}
										theme={theme}
										agent={agent}
										providerEnvVars={envByToolType[agent.toolType]}
										// The id stands in until the name loads: the row must
										// know the agent is remote either way.
										sshRemoteName={remoteId ? (remoteNames[remoteId] ?? remoteId) : undefined}
									/>
								);
							})}
						</tbody>
					</table>
				)}
			</SectionCard>
		</div>
	);
}

interface GatewayRowProps {
	theme: Theme;
	agent: Session;
	/** Settings -> Agents vars for this agent's provider, once loaded. */
	providerEnvVars?: Record<string, string>;
	sshRemoteName?: string;
}

function GatewayRow({ theme, agent, providerEnvVars, sshRemoteName }: GatewayRowProps) {
	const stored = agent.gatewayUrl ?? '';
	const [draft, setDraft] = useState(stored);
	const [error, setError] = useState<string | undefined>();
	const [envOpen, setEnvOpen] = useState(false);
	const globalEnvVars = useSettingsStore((s) => s.shellEnvVars);
	// The agent's own vars replace the provider-level set; the gateway yields to
	// whichever of the two is in force.
	const userEnvVars = useMemo(
		() => effectiveAgentCustomEnvVars(agent.customEnvVars, providerEnvVars),
		[agent.customEnvVars, providerEnvVars]
	);
	// Built only while open: the merge is cheap, but most rows never show it.
	const effectiveEnv = useMemo(
		() =>
			envOpen
				? resolveAgentEnvironment({
						global: globalEnvVars,
						agent: providerEnvVars,
						session: agent.customEnvVars,
						gateway: gatewayEnvVarsFor(agent.toolType, stored),
					})
				: [],
		[envOpen, globalEnvVars, providerEnvVars, agent.customEnvVars, agent.toolType, stored]
	);

	// The stored value can change under the row (Edit Agent, the CLI, another
	// window). Follow it, which also puts the normalized URL back after a save.
	useEffect(() => {
		setDraft(stored);
		setError(undefined);
	}, [stored]);

	const commit = useCallback(() => {
		if (draft.trim() === stored) {
			setError(undefined);
			return;
		}
		void setAgentGatewayUrl(agent.id, draft).then((result) => {
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setError(undefined);
			setDraft(result.gatewayUrl ?? '');
		});
	}, [agent.id, draft, stored]);

	return (
		<tr data-testid="local-models-gateway-row" data-agent-id={agent.id}>
			<td
				className="align-top py-1.5 pr-3 font-medium select-text"
				style={{ color: theme.colors.textMain }}
			>
				{agent.name}
			</td>
			<td className="align-top py-1.5 pr-3 opacity-70">
				{getAgentDisplayName(agent.toolType)}
				{sshRemoteName && <span className="block">on {sshRemoteName}</span>}
			</td>
			<td className="align-top py-1.5">
				<GatewayUrlField
					theme={theme}
					toolType={agent.toolType}
					value={draft}
					onChange={(value) => {
						setDraft(value);
						setError(undefined);
					}}
					onCommit={commit}
					userEnvVars={userEnvVars}
					sshRemoteName={sshRemoteName}
					error={error}
					testId={`gateway-url-${agent.id}`}
				/>
				{stored !== '' && (
					<div className="mt-1">
						<button
							type="button"
							className="text-xs underline"
							style={{ color: theme.colors.textDim }}
							onClick={() => setEnvOpen((open) => !open)}
							aria-expanded={envOpen}
							data-testid={`gateway-env-toggle-${agent.id}`}
						>
							{envOpen ? 'Hide environment' : 'Show environment'}
						</button>
						{envOpen && (
							<div className="mt-1.5">
								<EnvVarList theme={theme} vars={effectiveEnv} testId={`gateway-env-${agent.id}`} />
							</div>
						)}
					</div>
				)}
			</td>
		</tr>
	);
}
