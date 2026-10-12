/**
 * LocalModelsModelsSection - the Models section of the Models tab.
 *
 * Every model, installed or not, on the shared `LocalModelRow` that Voice Setup
 * also draws. The disk total sits on top so the cost of what is installed is
 * read before the list of what could be.
 *
 * The list is grouped by what a model is for (`groupLocalModelsForLibrary`): a
 * text model under its role, the models the user added in their own group, and
 * every other kind by kind. Each row says what the model is good at and whether
 * it runs on this computer (`modelFit` against the hardware the main process
 * read). A model that is too large is hidden behind a toggle, unless some of it
 * is already on disk: what occupies the disk is never hidden.
 *
 * Mounting reads the listing, the footprint and the hardware, and nothing else:
 * a download starts only from the row's Download button, which also fetches the
 * engine the model runs on when that is missing (the button states both sizes).
 * The Engines card between the totals and the list shows those engines on their
 * own, for the cases a model download does not cover. Adding a model from
 * Hugging Face is `AddHuggingFaceModelCard`, one request per click.
 *
 * "In use by" is answered from two sources. Tasks come from the effective
 * `localModelAssignments` (defaults included), and voice from its own
 * capability table, because voice picks its models through its provider
 * settings rather than through an assignment. Removing a model a task is
 * assigned to warns first and names those tasks: the removal turns each of them
 * unavailable, and the user should choose that knowingly.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, Eye, EyeOff } from 'lucide-react';

import {
	CLOUD_ONLY_NOTE,
	groupLocalModelsForLibrary,
} from '../../../../../shared/local-models/library';
import {
	describeHardwareProfile,
	hardwareFitCaveat,
	modelFit,
	type ModelFit,
} from '../../../../../shared/local-models/model-fit';
import { MODELS_SETTINGS_PANEL_LABELS } from '../../../../../shared/local-models/settings-location';
import { tasksNeedingKind, tasksUsingLocalModel } from '../../../../../shared/local-models/tasks';
import { voiceModelUsageLabel } from '../../../../../shared/acappella/voice-models';
import { formatSize } from '../../../../../shared/formatters';
import {
	useLocalModelsHardware,
	type LocalModelsState,
	type LocalRuntimesState,
} from '../../../../hooks/localModels';
import { usePersistedToggle } from '../../../../hooks/ui/usePersistedToggle';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { ipcErrorMessage } from '../../../../utils/ipcErrorMessage';
import { StatCardGrid, type StatCardDatum } from '../../../widgets';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AddHuggingFaceModelCard } from './AddHuggingFaceModelCard';
import { LocalModelRow, isActive } from './LocalModelRow';
import { LocalModelsEnginesCard } from './LocalModelsEnginesCard';
import { RemoveInUseWarning } from './RemoveInUseWarning';

export interface LocalModelsModelsSectionProps {
	theme: Theme;
	/** The tab's one `useLocalModels()` instance, shared with Assignments. */
	models: LocalModelsState;
	/** The tab's one `useLocalRuntimes()` instance: the engines the models run on. */
	runtimes: LocalRuntimesState;
	/** Opens the Sources inner tab, where a cloud provider's API is added. */
	onOpenSources?: () => void;
}

/** localStorage key for "Show models too large for this machine". */
export const SHOW_TOO_LARGE_MODELS_STORAGE_KEY = 'settings.models.showTooLarge';

/** A removal waiting on the in-use warning: the files alone, or the Library entry too. */
interface PendingRemoval {
	id: string;
	fromLibrary: boolean;
}

export function LocalModelsModelsSection({
	theme,
	models,
	runtimes,
	onOpenSources,
}: LocalModelsModelsSectionProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const hardware = useLocalModelsHardware();
	const showTooLarge = usePersistedToggle(SHOW_TOO_LARGE_MODELS_STORAGE_KEY, false);
	// The model whose removal is waiting on the in-use warning, if any.
	const [confirmingRemove, setConfirmingRemove] = useState<PendingRemoval | null>(null);
	const [libraryError, setLibraryError] = useState<string | null>(null);

	// Whether each model runs on this computer. Empty until the hardware is read,
	// so nothing is labeled, or hidden, on a guess.
	const fitByModel = useMemo(() => {
		const byModel: Record<string, ModelFit> = {};
		if (!hardware.profile) return byModel;
		for (const listing of models.listings) {
			byModel[listing.entry.id] = modelFit(listing.entry, hardware.profile);
		}
		return byModel;
	}, [hardware.profile, models.listings]);

	// A model too large for this computer is hidden unless the user asked to see
	// those, or some of it is on disk or on its way there: disk in use, and a
	// download in flight, are never hidden.
	const tooLargeIds = useMemo(() => {
		const ids = new Set<string>();
		for (const listing of models.listings) {
			const id = listing.entry.id;
			const progress = models.progress[id];
			const busy = isActive(progress) || progress?.phase === 'paused';
			if (fitByModel[id]?.fit === 'too-large' && listing.status.bytesOnDisk === 0 && !busy) {
				ids.add(id);
			}
		}
		return ids;
	}, [fitByModel, models.listings, models.progress]);

	const groups = useMemo(
		() =>
			groupLocalModelsForLibrary(
				showTooLarge.value
					? models.listings
					: models.listings.filter((listing) => !tooLargeIds.has(listing.entry.id)),
				(listing) => listing.entry
			),
		[models.listings, showTooLarge.value, tooLargeIds]
	);

	const tasksByModel = useMemo(() => {
		const byModel: Record<string, string[]> = {};
		for (const listing of models.listings) {
			byModel[listing.entry.id] = tasksUsingLocalModel(assignments, listing.entry.id).map(
				(task) => task.label
			);
		}
		return byModel;
	}, [assignments, models.listings]);

	const cards = useMemo<StatCardDatum[]>(() => {
		const footprintBytes = models.footprint?.bytes ?? 0;
		const installedCount = models.listings.filter(
			(listing) => listing.status.status === 'installed'
		).length;
		const corruptCount = models.listings.filter(
			(listing) => listing.status.status === 'corrupt'
		).length;
		return [
			{ label: 'On disk', value: footprintBytes, displayValue: formatSize(footprintBytes) },
			{ label: 'Installed', value: installedCount },
			{
				label: 'Needs attention',
				value: corruptCount,
				color: corruptCount > 0 ? theme.colors.warning : undefined,
			},
		];
	}, [models.footprint, models.listings, theme.colors.warning]);

	// Bytes of engine each runtime still needs, so a model row can state what its
	// Download button fetches. Zero once the engine is installed and current, and
	// zero where no build exists (the Engines card says that; the row cannot fix it).
	const engineBytesByRuntime = useMemo(() => {
		const bytes: Record<string, number> = {};
		for (const runtime of runtimes.listings) {
			const needed = runtime.downloadable && (!runtime.installed || runtime.stale);
			bytes[runtime.id] = needed ? runtime.bytes : 0;
		}
		return bytes;
	}, [runtimes.listings]);

	const { download: downloadModel } = models;
	const { refresh: refreshRuntimes } = runtimes;
	const handleDownload = useCallback(
		(modelId: string) => {
			// The download installs the engine too (main does both), so the engine
			// listing is re-read when it settles.
			void downloadModel(modelId).then(() => refreshRuntimes());
		},
		[downloadModel, refreshRuntimes]
	);

	const { remove: removeModel, refresh: refreshModels } = models;
	const runRemoval = useCallback(
		async ({ id, fromLibrary }: PendingRemoval) => {
			setLibraryError(null);
			if (!fromLibrary) {
				await removeModel(id);
				return;
			}
			try {
				const result = await window.maestro.localModels.huggingFace.remove(id);
				if (!result.ok) setLibraryError(result.message);
			} catch (error) {
				setLibraryError(ipcErrorMessage(error));
			}
			await refreshModels();
		},
		[removeModel, refreshModels]
	);

	const requestRemoval = useCallback(
		(removal: PendingRemoval) => {
			if ((tasksByModel[removal.id] ?? []).length > 0) {
				setConfirmingRemove(removal);
				return;
			}
			void runRemoval(removal);
		},
		[runRemoval, tasksByModel]
	);

	const handleRemove = useCallback(
		(modelId: string) => requestRemoval({ id: modelId, fromLibrary: false }),
		[requestRemoval]
	);
	const handleRemoveFromLibrary = useCallback(
		(modelId: string) => requestRemoval({ id: modelId, fromLibrary: true }),
		[requestRemoval]
	);

	const confirmRemove = useCallback(
		(removal: PendingRemoval) => {
			setConfirmingRemove(null);
			void runRemoval(removal);
		},
		[runRemoval]
	);

	const fitCaveat = hardware.profile ? hardwareFitCaveat(hardware.profile) : null;
	const error = models.error ?? libraryError ?? hardware.error;

	return (
		<div className="select-none space-y-3" data-testid="local-models-models-section">
			<SectionCard theme={theme}>
				<StatCardGrid theme={theme} cards={cards} />
				{hardware.profile && (
					<p className="text-xs opacity-70 select-text" data-testid="local-models-hardware">
						This computer: {describeHardwareProfile(hardware.profile)}. Each model says whether it
						fits.
					</p>
				)}
				{fitCaveat && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.warning }}
						data-testid="local-models-fit-caveat"
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>{fitCaveat}</span>
					</div>
				)}
				{error && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.error }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>{error}</span>
					</div>
				)}
			</SectionCard>

			<LocalModelsEnginesCard theme={theme} runtimes={runtimes} />

			{groups.map(({ group, items: entries }) => {
				// A kind group names the tasks that can use it; a role group says what
				// the role is. A text model's tasks are the role's own sentence.
				let summary = group.description;
				if (group.kind) {
					const usedBy = tasksNeedingKind(group.kind).map((task) => task.label);
					if (entries.some((listing) => voiceModelUsageLabel(listing.entry.id))) {
						usedBy.push('Voice');
					}
					summary =
						usedBy.length > 0
							? `Can be used by ${usedBy.join(', ')}.`
							: 'Nothing uses this kind of model yet.';
				}
				return (
					<SectionCard key={group.id} theme={theme}>
						<div data-testid={`local-models-group-${group.id}`}>
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								{group.label}
							</div>
							<p className="text-xs opacity-70 mt-0.5">{summary}</p>
						</div>
						{entries.map((listing) => {
							const id = listing.entry.id;
							const taskLabels = tasksByModel[id] ?? [];
							const voiceLabel = voiceModelUsageLabel(id);
							const rowUsedBy = voiceLabel ? [...taskLabels, voiceLabel] : taskLabels;
							return (
								<div key={id} className="space-y-2">
									{confirmingRemove?.id === id && (
										<RemoveInUseWarning
											theme={theme}
											subjectName={listing.entry.displayName}
											taskLabels={taskLabels}
											recovery={confirmingRemove.fromLibrary ? 'add it again' : 'download it again'}
											onConfirm={() => confirmRemove(confirmingRemove)}
											onKeep={() => setConfirmingRemove(null)}
										/>
									)}
									<LocalModelRow
										theme={theme}
										listing={listing}
										progress={models.progress[id]}
										verifyResult={models.verifyResults[id]}
										usedBy={rowUsedBy}
										engineBytes={engineBytesByRuntime[listing.entry.runtime] ?? 0}
										showRoles
										fit={fitByModel[id]}
										onDownload={handleDownload}
										onPause={(modelId) => void models.pause(modelId)}
										onResume={(modelId) => void models.resume(modelId)}
										onCancel={(modelId) => void models.cancel(modelId)}
										onVerify={(modelId) => void models.verify(modelId)}
										onRemove={handleRemove}
										onRemoveFromLibrary={handleRemoveFromLibrary}
									/>
								</div>
							);
						})}
					</SectionCard>
				);
			})}

			{tooLargeIds.size > 0 && (
				<button
					type="button"
					onClick={showTooLarge.toggle}
					aria-pressed={showTooLarge.value}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="local-models-show-too-large"
				>
					{showTooLarge.value ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
					{showTooLarge.value ? 'Hide' : 'Show'} models too large for this machine (
					{tooLargeIds.size})
				</button>
			)}

			<AddHuggingFaceModelCard
				theme={theme}
				hardware={hardware.profile}
				onAdded={() => void models.refresh()}
			/>

			<SectionCard theme={theme}>
				<div data-testid="local-models-cloud-only">
					<div
						className="font-medium flex items-center gap-1.5"
						style={{ color: theme.colors.textMain }}
					>
						<Cloud className="w-3.5 h-3.5" />
						Cloud only
					</div>
					<p className="text-xs opacity-70 mt-0.5 select-text">{CLOUD_ONLY_NOTE}</p>
				</div>
				{onOpenSources && (
					<div>
						<button
							type="button"
							onClick={onOpenSources}
							className="px-2 py-1 rounded border text-xs"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="local-models-open-sources"
						>
							Open {MODELS_SETTINGS_PANEL_LABELS.sources}
						</button>
					</div>
				)}
			</SectionCard>
		</div>
	);
}
