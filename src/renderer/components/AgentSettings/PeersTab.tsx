/**
 * PeersTab - Peer Agents. A placeholder until the Peer Agents section lands
 * (MODELS-14 replaces the body).
 */

import { Users } from 'lucide-react';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export type PeersTabProps = AgentSettingsPanelBaseProps;

export function PeersTab({ theme, idPrefix }: PeersTabProps) {
	return (
		<AgentSettingsPanel theme={theme} idPrefix={idPrefix} tab="peers">
			<EmptyStatePlaceholder
				theme={theme}
				icon={<Users className="w-10 h-10" />}
				title="Peer Agents are set up here."
			/>
		</AgentSettingsPanel>
	);
}
