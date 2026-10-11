/**
 * LocalModelsTab - the core Local Models settings tab.
 *
 * Three sections, each owning one half of "what runs where":
 * - Models: what is installed on this machine (and what the catalog offers).
 * - Endpoints: model servers Maestro can call instead of loading a model itself.
 * - Assignments: which source runs each housekeeping task in `LOCAL_MODEL_TASKS`.
 *
 * It is a CORE tab, not an Encore Feature, and it starts empty: opening it
 * reads what is on disk and downloads nothing. Every download, detection, and test
 * is an explicit click inside a section.
 */

import { HardDrive, ListChecks, Server } from 'lucide-react';
import type { Theme } from '../../../../types';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { LocalModelsEndpointsSection } from './LocalModelsEndpointsSection';
import { LocalModelsModelsSection } from './LocalModelsModelsSection';

export interface LocalModelsTabProps {
	theme: Theme;
}

export function LocalModelsTab({ theme }: LocalModelsTabProps) {
	return (
		<div className="space-y-5" data-testid="local-models-tab">
			<div data-setting-id="local-models-models">
				<SettingsSectionHeading
					icon={HardDrive}
					description="Models that run on this machine. Nothing downloads until you ask for it."
				>
					Models
				</SettingsSectionHeading>
				<LocalModelsModelsSection theme={theme} />
			</div>

			<div data-setting-id="local-models-endpoints">
				<SettingsSectionHeading
					icon={Server}
					description="Model servers Maestro can call, such as Ollama, LM Studio, or any OpenAI-compatible URL."
				>
					Endpoints
				</SettingsSectionHeading>
				<LocalModelsEndpointsSection theme={theme} />
			</div>

			<div data-setting-id="local-models-assignments">
				<SettingsSectionHeading
					icon={ListChecks}
					description="Choose which model runs each task. A task left Off keeps its existing behavior."
				>
					Assignments
				</SettingsSectionHeading>
			</div>
		</div>
	);
}
