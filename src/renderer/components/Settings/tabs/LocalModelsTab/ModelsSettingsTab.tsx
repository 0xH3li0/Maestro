/**
 * ModelsSettingsTab - the Models settings tab: everything model-related, behind
 * one strip of five inner tabs.
 *
 * - Library: models installed on this machine, the engines they run on, their
 *   disk use, and the Maestro model server that serves them over HTTP.
 * - Sources: where models come from besides the Library (model servers and
 *   user endpoints).
 * - System One: the engine that answers typed questions (Jev, OpenJev, or a
 *   local judge) with its key and Test, then the tasks whose output is a
 *   judgment (a decision, label, score, vector or transcript), with their
 *   assignments and fail policies.
 * - System Two: the tasks whose output is text for someone to read or run,
 *   with their assignments, the Utility Agent, and the harness tier defaults
 *   (which model a low, medium or high task launches on).
 * - Gateway: the proxy each agent's own provider traffic goes through, and
 *   what the Maestro token proxy carried.
 *
 * Which system a task belongs to is `LocalModelTaskDefinition.system`, read
 * through `tasksForSystem`; nothing here sorts tasks by hand. The panel ids and
 * labels are `MODELS_SETTINGS_PANELS` in `shared/local-models/settings-location`,
 * the same words every "assign it in ..." message uses.
 *
 * It is a CORE tab, not an Encore Feature, and it starts empty: opening it
 * reads what is on disk and downloads nothing. Every download, detection, and
 * test is an explicit click inside a section.
 *
 * The tab owns the ONE `useLocalModels()`, `useLocalModelEndpoints()` and
 * `useSystemOne()` instance and hands it to each panel, so a download started
 * in Library or a model list refreshed in Sources is what the assignment
 * pickers offer, and the engine card and the fail policy column read one report.
 */

import { useEffect } from 'react';
import {
	Brain,
	HardDrive,
	Layers,
	Router,
	Server,
	SlidersHorizontal,
	Sparkles,
	type LucideIcon,
} from 'lucide-react';
import {
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
	type ModelsSettingsPanel,
} from '../../../../../shared/local-models/settings-location';
import {
	useLocalModelEndpoints,
	useLocalModels,
	useLocalRuntimes,
	useSystemOne,
} from '../../../../hooks/localModels';
import { usePersistedChoice } from '../../../../hooks/ui/usePersistedChoice';
import type { Theme } from '../../../../types';
import { ModalTabStrip, tabPanelProps, type ModalTab } from '../../../ui/ModalTabStrip';
import type { SubTabRequest } from '../../searchableSettings';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { LocalModelsAssignmentsSection } from './LocalModelsAssignmentsSection';
import { LocalModelsDownloadSourceCard } from './LocalModelsDownloadSourceCard';
import { LocalModelsEndpointsSection } from './LocalModelsEndpointsSection';
import { LocalModelsGatewaySection } from './LocalModelsGatewaySection';
import { LocalModelsModelsSection } from './LocalModelsModelsSection';
import { LocalModelsServerSection } from './LocalModelsServerSection';
import { SystemOneEngineSection } from './SystemOneEngineCard';
import { SystemOneLedgerSection } from './SystemOneLedgerSection';
import { TierDefaultsSection } from './TierDefaultsSection';
import { UtilityAgentSettings } from './UtilityAgentSettings';

/** localStorage key for the last inner tab the user opened. */
export const MODELS_SETTINGS_PANEL_STORAGE_KEY = 'settings.models.panel';

const PANEL_ICONS: Record<ModelsSettingsPanel, LucideIcon> = {
	library: HardDrive,
	sources: Server,
	'system-one': Brain,
	'system-two': Sparkles,
	gateway: Router,
};

const PANEL_TABS: ModalTab<ModelsSettingsPanel>[] = MODELS_SETTINGS_PANELS.map((id) => ({
	id,
	label: MODELS_SETTINGS_PANEL_LABELS[id],
	icon: PANEL_ICONS[id],
}));

const ID_PREFIX = 'settings-models';

export interface ModelsSettingsTabProps {
	theme: Theme;
	/** A jump to an inner tab (a deep link or a search result). Ids that name no panel are ignored. */
	panelRequest?: SubTabRequest;
	/** Called once `panelRequest` has been applied, so the owner can drop it. */
	onPanelRequestHandled?: () => void;
}

export function ModelsSettingsTab({
	theme,
	panelRequest,
	onPanelRequestHandled,
}: ModelsSettingsTabProps) {
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	const runtimes = useLocalRuntimes();
	const systemOne = useSystemOne();
	const { value: panel, setValue: setPanel } = usePersistedChoice<ModelsSettingsPanel>(
		MODELS_SETTINGS_PANEL_STORAGE_KEY,
		MODELS_SETTINGS_PANELS,
		'library'
	);

	useEffect(() => {
		if (!panelRequest) return;
		const requested = MODELS_SETTINGS_PANELS.find((id) => id === panelRequest.subTab);
		if (requested) setPanel(requested);
		onPanelRequestHandled?.();
	}, [panelRequest, setPanel, onPanelRequestHandled]);

	return (
		<div className="space-y-5" data-testid="models-settings-tab">
			<ModalTabStrip
				theme={theme}
				tabs={PANEL_TABS}
				activeTab={panel}
				onChange={setPanel}
				label="Models settings"
				idPrefix={ID_PREFIX}
			/>

			<div {...tabPanelProps(ID_PREFIX, panel)} className="space-y-5">
				{panel === 'library' && (
					<div data-setting-id="local-models-models">
						<SettingsSectionHeading
							icon={HardDrive}
							description="Models downloaded to this machine, the engines they run on, and the disk they use. Nothing downloads until you ask for it."
						>
							{MODELS_SETTINGS_PANEL_LABELS.library}
						</SettingsSectionHeading>
						<LocalModelsModelsSection
							theme={theme}
							models={models}
							runtimes={runtimes}
							onOpenSources={() => setPanel('sources')}
						/>
					</div>
				)}

				{panel === 'library' && <LocalModelsServerSection theme={theme} />}

				{panel === 'library' && (
					<div data-setting-id="local-models-download-source">
						<SettingsSectionHeading
							icon={SlidersHorizontal}
							description="Where model files are downloaded from, for networks that block Hugging Face."
						>
							Advanced
						</SettingsSectionHeading>
						<LocalModelsDownloadSourceCard theme={theme} />
					</div>
				)}

				{panel === 'sources' && (
					<div data-setting-id="local-models-endpoints">
						<SettingsSectionHeading
							icon={Server}
							description="Where models come from besides the Library: model servers Maestro can call, such as Ollama, LM Studio, or any OpenAI-compatible URL."
						>
							{MODELS_SETTINGS_PANEL_LABELS.sources}
						</SettingsSectionHeading>
						<LocalModelsEndpointsSection theme={theme} state={endpoints} />
					</div>
				)}

				{panel === 'system-one' && <SystemOneEngineSection theme={theme} systemOne={systemOne} />}

				{panel === 'system-one' && (
					<div data-setting-id="local-models-system-one">
						<SettingsSectionHeading
							icon={Brain}
							description="Fast judgments. A task here returns a decision, label, score, vector, or transcript, never text for someone to read. A task left Off keeps its existing behavior."
						>
							{MODELS_SETTINGS_PANEL_LABELS['system-one']}
						</SettingsSectionHeading>
						<LocalModelsAssignmentsSection
							theme={theme}
							system="one"
							models={models}
							endpoints={endpoints}
							// The column is there from the first paint (a settings search can
							// land on it); its values wait for the report, so a row never shows
							// a default in place of the user's choice.
							failPolicies={{
								rows: systemOne.report?.failPolicies ?? [],
								disabled: systemOne.busy !== null,
								onChange: (taskId, policy) =>
									void systemOne.set({ failPolicy: { taskId, policy } }),
							}}
							// Until the report arrives no engine is known, so System One is
							// not offered as a source; a task already on it still shows it.
							systemOneEngine={
								systemOne.report
									? {
											engine: systemOne.report.settings.engine,
											problem: systemOne.report.problem,
										}
									: undefined
							}
						/>
					</div>
				)}

				{panel === 'system-one' && <SystemOneLedgerSection theme={theme} systemOne={systemOne} />}

				{panel === 'system-two' && (
					<>
						<div data-setting-id="local-models-system-two">
							<SettingsSectionHeading
								icon={Sparkles}
								description="Generation. A task here writes text for someone to read or run. A task left Off keeps its existing behavior."
							>
								{MODELS_SETTINGS_PANEL_LABELS['system-two']}
							</SettingsSectionHeading>
							<LocalModelsAssignmentsSection
								theme={theme}
								system="two"
								models={models}
								endpoints={endpoints}
							/>
						</div>
						<UtilityAgentSettings theme={theme} />
						<div data-setting-id="models-tier-defaults">
							<SettingsSectionHeading
								icon={Layers}
								description="Which model a low, medium or high task launches on, per harness. Auto Run and Cue tasks ask for a tier; an agent can override a tier in its own settings."
							>
								Tier defaults
							</SettingsSectionHeading>
							<TierDefaultsSection theme={theme} endpoints={endpoints.endpoints} />
						</div>
					</>
				)}

				{panel === 'gateway' && (
					<div data-setting-id="local-models-gateway">
						<SettingsSectionHeading
							icon={Router}
							description="Send an agent's provider traffic through a proxy: Headroom, LiteLLM, or Maestro's own token proxy, and see what it carried."
						>
							{MODELS_SETTINGS_PANEL_LABELS.gateway}
						</SettingsSectionHeading>
						<LocalModelsGatewaySection theme={theme} />
					</div>
				)}
			</div>
		</div>
	);
}
