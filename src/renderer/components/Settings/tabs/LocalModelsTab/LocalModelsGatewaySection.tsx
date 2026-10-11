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
 *
 * The "Maestro proxy" column is the per-agent mode of Maestro's own proxy:
 * Off, Passthrough or Compress. Choosing a mode IS choosing the gateway
 * (`setAgentTokenProxyMode` points the agent at the proxy, or clears it), so
 * the URL field beside it follows. What the proxy carried and shortened is
 * drawn under the table by `<LocalModelsProxyUsage>`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { resolveAgentEnvironment } from '../../../../../shared/agentEnvironment';
import { getAgentDisplayName } from '../../../../../shared/agentMetadata';
import { agentGatewaySupport, gatewayEnvVarsFor } from '../../../../../shared/local-models/gateway';
import {
	asTokenProxyMode,
	resolveTokenProxyMode,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_MODE_DESCRIPTIONS,
	TOKEN_PROXY_MODES,
	TOKEN_PROXY_NAME,
	type TokenProxyMode,
} from '../../../../../shared/local-models/token-proxy';
import { effectiveAgentCustomEnvVars } from '../../../../../shared/providerProfiles';
import {
	useAgentLevelEnvVars,
	useSshRemoteNames,
} from '../../../../hooks/stats/useProviderProfiles';
import { useTokenProxyReport } from '../../../../hooks/localModels/useTokenProxyReport';
import { setAgentGatewayUrl, setAgentTokenProxyMode } from '../../../../services/agentGateway';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Session, Theme } from '../../../../types';
import { GatewayUrlField } from '../../../shared/GatewayUrlField';
import { EnvVarList } from '../../../ui/EnvVarList';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { LocalModelsProxyUsage } from './LocalModelsProxyUsage';

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
	const proxy = useTokenProxyReport();
	const proxyPort = proxy.report?.status.port ?? null;
	const agentNames = useMemo(
		() => Object.fromEntries(sessions.map((s) => [s.id, s.name])),
		[sessions]
	);

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
				<p className="text-xs opacity-70 select-text">
					Maestro has a proxy of its own. Passthrough forwards every request unchanged and counts
					it. Compress also shortens large tool results (file reads, command output) in the requests
					an agent sends, keeps every original on this machine, and marks each block it changed.
					Choosing either one sets the agent's gateway to the proxy; Off clears it.
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
								<th className="text-left font-medium opacity-70 pb-2 pr-3">Maestro proxy</th>
								<th className="text-left font-medium opacity-70 pb-2 w-2/5">Gateway URL</th>
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
										proxyPort={proxyPort}
										onProxyModeChanged={proxy.refresh}
									/>
								);
							})}
						</tbody>
					</table>
				)}
			</SectionCard>
			<LocalModelsProxyUsage
				theme={theme}
				report={proxy.report}
				loading={proxy.loading}
				error={proxy.error}
				onRefresh={proxy.refresh}
				agentNames={agentNames}
			/>
		</div>
	);
}

/**
 * Why an agent cannot use the Maestro proxy, or undefined when it can. The
 * same two refusals `setAgentTokenProxyMode` makes, said before the click.
 */
export function tokenProxyModeBlocker(
	toolType: string,
	sshRemoteName: string | undefined
): string | undefined {
	const support = agentGatewaySupport(toolType);
	if (!support.supported) return support.reason;
	if (sshRemoteName) {
		return `The ${TOKEN_PROXY_NAME} listens on this machine, which SSH remote "${sshRemoteName}" cannot reach.`;
	}
	return undefined;
}

interface GatewayRowProps {
	theme: Theme;
	agent: Session;
	/** Settings -> Agents vars for this agent's provider, once loaded. */
	providerEnvVars?: Record<string, string>;
	sshRemoteName?: string;
	/** The Maestro proxy's port, or null when none has been chosen yet. */
	proxyPort: number | null;
	/** The proxy's picture changed: an agent joined or left it. */
	onProxyModeChanged: () => void;
}

function GatewayRow({
	theme,
	agent,
	providerEnvVars,
	sshRemoteName,
	proxyPort,
	onProxyModeChanged,
}: GatewayRowProps) {
	const stored = agent.gatewayUrl ?? '';
	const [draft, setDraft] = useState(stored);
	const [error, setError] = useState<string | undefined>();
	const [modeError, setModeError] = useState<string | undefined>();
	const [modeBusy, setModeBusy] = useState(false);
	const proxyMode = resolveTokenProxyMode({
		gatewayUrl: stored,
		storedMode: agent.tokenProxyMode,
		port: proxyPort,
	});
	const modeBlocker = tokenProxyModeBlocker(agent.toolType, sshRemoteName);

	const chooseMode = useCallback(
		(value: string) => {
			const mode: TokenProxyMode | undefined = asTokenProxyMode(value);
			if (!mode) return;
			setModeBusy(true);
			setModeError(undefined);
			void setAgentTokenProxyMode(agent.id, mode)
				.then((result) => {
					if (!result.ok) setModeError(result.error);
				})
				.catch((err: unknown) => {
					setModeError(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					setModeBusy(false);
					onProxyModeChanged();
				});
		},
		[agent.id, onProxyModeChanged]
	);
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
			<td className="align-top py-1.5 pr-3">
				<select
					value={proxyMode}
					onChange={(e) => chooseMode(e.target.value)}
					disabled={modeBlocker !== undefined || modeBusy}
					title={modeBlocker}
					aria-label={`${TOKEN_PROXY_NAME} mode for ${agent.name}`}
					className="p-1.5 rounded border bg-transparent outline-none text-xs disabled:opacity-40"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid={`gateway-proxy-mode-${agent.id}`}
				>
					{TOKEN_PROXY_MODES.map((mode) => (
						<option key={mode} value={mode}>
							{TOKEN_PROXY_MODE_LABELS[mode]}
						</option>
					))}
				</select>
				{proxyMode !== 'off' && (
					// What the chosen mode does and costs, where the choice is made: the
					// two compress modes differ in what the MODEL sees, which a one-word
					// label cannot carry.
					<p
						className="mt-1 text-xs opacity-70 max-w-xs"
						data-testid={`gateway-proxy-mode-note-${agent.id}`}
					>
						{TOKEN_PROXY_MODE_DESCRIPTIONS[proxyMode]}
					</p>
				)}
				{modeError && (
					<p
						className="mt-1 text-xs select-text"
						style={{ color: theme.colors.error }}
						data-testid={`gateway-proxy-mode-error-${agent.id}`}
					>
						{modeError}
					</p>
				)}
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
