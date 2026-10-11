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
 *
 * The tab owns the ONE `useLocalModels()` and `useLocalModelEndpoints()`
 * instance and hands it to each section, so a download started in Models or a
 * model list refreshed in Endpoints is what the Assignments picker offers, and
 * an enabled endpoint is listed once rather than once per section.
 */

import { HardDrive, ListChecks, Server } from 'lucide-react';
import { useLocalModelEndpoints, useLocalModels } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { LocalModelsAssignmentsSection } from './LocalModelsAssignmentsSection';
import { LocalModelsEndpointsSection } from './LocalModelsEndpointsSection';
import { LocalModelsModelsSection } from './LocalModelsModelsSection';

export interface LocalModelsTabProps {
	theme: Theme;
}

export function LocalModelsTab({ theme }: LocalModelsTabProps) {
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	return (
		<div className="space-y-5" data-testid="local-models-tab">
			<div data-setting-id="local-models-models">
				<SettingsSectionHeading
					icon={HardDrive}
					description="Models that run on this machine. Nothing downloads until you ask for it."
				>
					Models
				</SettingsSectionHeading>
				<LocalModelsModelsSection theme={theme} models={models} />
			</div>

			<div data-setting-id="local-models-endpoints">
				<SettingsSectionHeading
					icon={Server}
					description="Model servers Maestro can call, such as Ollama, LM Studio, or any OpenAI-compatible URL."
				>
					Endpoints
				</SettingsSectionHeading>
				<LocalModelsEndpointsSection theme={theme} state={endpoints} />
			</div>

			<div data-setting-id="local-models-assignments">
				<SettingsSectionHeading
					icon={ListChecks}
					description="Choose which model runs each task. A task left Off keeps its existing behavior."
				>
					Assignments
				</SettingsSectionHeading>
				<LocalModelsAssignmentsSection theme={theme} models={models} endpoints={endpoints} />
			</div>
		</div>
	);
}
