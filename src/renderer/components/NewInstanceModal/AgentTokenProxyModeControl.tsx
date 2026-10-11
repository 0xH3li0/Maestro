/**
 * AgentTokenProxyModeControl - Edit Agent's Maestro token proxy mode, on the
 * Models tab beside the gateway URL.
 *
 * Unlike the rest of the dialog it applies at once, like the chain of thought
 * export: choosing a mode IS choosing the agent's gateway, and the write goes
 * through `setAgentTokenProxyMode` (the same one the Local Models gateway table
 * uses), which picks the proxy route and flushes to main. The dialog's gateway
 * draft follows the result, so Save writes the same URL back and the mode is
 * kept.
 *
 * The mode shown is read against the DRAFT: a URL typed over the proxy's reads
 * Off, which is what Save would make it. The proxy's port is read only while
 * this is mounted, that is, while the Models tab is open.
 */

import { useCallback } from 'react';
import {
	resolveTokenProxyMode,
	TOKEN_PROXY_NAME,
	type TokenProxyMode,
} from '../../../shared/local-models/token-proxy';
import { useTokenProxyModeChoice } from '../../hooks/localModels/useTokenProxyModeChoice';
import { useTokenProxyReport } from '../../hooks/localModels/useTokenProxyReport';
import type { Session, Theme } from '../../types';
import { TokenProxyModeField, tokenProxyModeBlocker } from '../shared/TokenProxyModeField';

export interface AgentTokenProxyModeControlProps {
	theme: Theme;
	agentId: string;
	agentName: string;
	toolType: string;
	/** The dialog's gateway URL draft. */
	gatewayUrl: string;
	/** The mode stored on the agent now. */
	storedMode: Session['tokenProxyMode'];
	/** Name of the SSH remote the form has chosen, when it has chosen one. */
	sshRemoteName?: string;
	/** Why the choice must wait, e.g. an unsaved provider change. */
	pendingReason?: string;
	/** The agent's gateway after a mode was stored. */
	onGatewayUrlChange: (gatewayUrl: string) => void;
}

export function AgentTokenProxyModeControl({
	theme,
	agentId,
	agentName,
	toolType,
	gatewayUrl,
	storedMode,
	sshRemoteName,
	pendingReason,
	onGatewayUrlChange,
}: AgentTokenProxyModeControlProps) {
	const proxy = useTokenProxyReport();
	const onChosen = useCallback(
		(_mode: TokenProxyMode, next: string | undefined) => onGatewayUrlChange(next ?? ''),
		[onGatewayUrlChange]
	);
	const choice = useTokenProxyModeChoice(agentId, { onChosen, onSettled: proxy.refresh });
	const mode = resolveTokenProxyMode({
		gatewayUrl,
		storedMode,
		port: proxy.report?.status.port ?? null,
	});

	return (
		<div data-testid="edit-agent-proxy-mode-control">
			<TokenProxyModeField
				theme={theme}
				label="Maestro Token Proxy"
				value={mode}
				onChange={choice.choose}
				disabledReason={tokenProxyModeBlocker(toolType, sshRemoteName) ?? pendingReason}
				busy={choice.busy || (proxy.loading && proxy.report === null)}
				error={choice.error}
				ariaLabel={`${TOKEN_PROXY_NAME} mode for ${agentName}`}
				testId="edit-agent-proxy-mode"
			/>
			<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
				Applies as soon as you choose. Passthrough and Compress set the gateway below to the proxy;
				Off clears it.
			</p>
		</div>
	);
}
