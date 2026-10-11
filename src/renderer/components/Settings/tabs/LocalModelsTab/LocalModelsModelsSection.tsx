/**
 * LocalModelsModelsSection - the Models section of the Local Models tab.
 *
 * Every catalog model, installed or not, grouped by kind, each on the shared
 * `LocalModelRow` that Voice Setup also draws. The disk total sits on top so
 * the cost of what is installed is read before the list of what could be.
 *
 * Mounting reads the listing and the footprint and nothing else: a download
 * starts only from the row's Download button, which also fetches the engine
 * the model runs on when that is missing (the button states both sizes). The
 * Engines card between the totals and the list shows those engines on their
 * own, for the cases a model download does not cover.
 *
 * "In use by" is answered from two sources. Tasks come from the effective
 * `localModelAssignments` (defaults included), and voice from its own
 * capability table, because voice picks its models through its provider
 * settings rather than through an assignment. Removing a model a task is
 * assigned to warns first and names those tasks: the removal turns each of them
 * unavailable, and the user should choose that knowingly.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import {
	LOCAL_MODEL_KIND_LABELS,
	groupByLocalModelKind,
} from '../../../../../shared/local-models/model-catalog';
import { tasksNeedingKind, tasksUsingLocalModel } from '../../../../../shared/local-models/tasks';
import { voiceModelUsageLabel } from '../../../../../shared/acappella/voice-models';
import { formatSize } from '../../../../../shared/formatters';
import type { LocalModelsState, LocalRuntimesState } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { StatCardGrid, type StatCardDatum } from '../../../widgets';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { LocalModelRow } from './LocalModelRow';
import { LocalModelsEnginesCard } from './LocalModelsEnginesCard';
import { RemoveInUseWarning } from './RemoveInUseWarning';

export interface LocalModelsModelsSectionProps {
	theme: Theme;
	/** The tab's one `useLocalModels()` instance, shared with Assignments. */
	models: LocalModelsState;
	/** The tab's one `useLocalRuntimes()` instance: the engines the models run on. */
	runtimes: LocalRuntimesState;
}

export function LocalModelsModelsSection({
	theme,
	models,
	runtimes,
}: LocalModelsModelsSectionProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	// The model whose removal is waiting on the in-use warning, if any.
	const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

	const groups = useMemo(
		() => groupByLocalModelKind(models.listings, (listing) => listing.entry.kind),
		[models.listings]
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

	const handleRemove = useCallback(
		(modelId: string) => {
			if ((tasksByModel[modelId] ?? []).length > 0) {
				setConfirmingRemove(modelId);
				return;
			}
			void models.remove(modelId);
		},
		[models, tasksByModel]
	);

	const confirmRemove = useCallback(
		(modelId: string) => {
			setConfirmingRemove(null);
			void models.remove(modelId);
		},
		[models]
	);

	return (
		<div className="select-none space-y-3" data-testid="local-models-models-section">
			<SectionCard theme={theme}>
				<StatCardGrid theme={theme} cards={cards} />
				{models.error && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.error }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>{models.error}</span>
					</div>
				)}
			</SectionCard>

			<LocalModelsEnginesCard theme={theme} runtimes={runtimes} />

			{groups.map(({ kind, items: entries }) => {
				const usedBy = tasksNeedingKind(kind).map((task) => task.label);
				if (entries.some((listing) => voiceModelUsageLabel(listing.entry.id))) {
					usedBy.push('Voice');
				}
				return (
					<SectionCard key={kind} theme={theme}>
						<div data-testid={`local-models-kind-${kind}`}>
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								{LOCAL_MODEL_KIND_LABELS[kind]}
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								{usedBy.length > 0
									? `Can be used by ${usedBy.join(', ')}.`
									: 'Nothing uses this kind of model yet.'}
							</p>
						</div>
						{entries.map((listing) => {
							const id = listing.entry.id;
							const taskLabels = tasksByModel[id] ?? [];
							const voiceLabel = voiceModelUsageLabel(id);
							const rowUsedBy = voiceLabel ? [...taskLabels, voiceLabel] : taskLabels;
							return (
								<div key={id} className="space-y-2">
									{confirmingRemove === id && (
										<RemoveInUseWarning
											theme={theme}
											subjectName={listing.entry.displayName}
											taskLabels={taskLabels}
											recovery="download it again"
											onConfirm={() => confirmRemove(id)}
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
										onDownload={handleDownload}
										onPause={(modelId) => void models.pause(modelId)}
										onResume={(modelId) => void models.resume(modelId)}
										onCancel={(modelId) => void models.cancel(modelId)}
										onVerify={(modelId) => void models.verify(modelId)}
										onRemove={handleRemove}
									/>
								</div>
							);
						})}
					</SectionCard>
				);
			})}
		</div>
	);
}
