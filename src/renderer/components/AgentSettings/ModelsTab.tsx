/**
 * ModelsTab - where the agent's model runs, and what its requests pass
 * through on the way.
 *
 * Both sections are slots the modal fills: `runOn` (the model target picker,
 * empty until the Run on phase) and `gateway` (`GatewayUrlField`, plus the
 * Maestro token proxy mode where the modal offers it). A modal with neither
 * gets a quiet empty state rather than a blank panel.
 */

import type { ReactNode } from 'react';
import { BrainCircuit } from 'lucide-react';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface ModelsTabProps extends AgentSettingsPanelBaseProps {
	runOn?: ReactNode;
	gateway?: ReactNode;
}

export function ModelsTab({ theme, idPrefix, runOn, gateway }: ModelsTabProps) {
	const empty = !runOn && !gateway;
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="models"
			intro="Where this agent's model runs, and what its requests pass through."
		>
			{runOn}
			{gateway}
			{empty && (
				<EmptyStatePlaceholder
					theme={theme}
					icon={<BrainCircuit className="w-10 h-10" />}
					title="Nothing to set here yet."
				/>
			)}
		</AgentSettingsPanel>
	);
}
