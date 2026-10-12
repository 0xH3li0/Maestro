/**
 * How the Library lists models: grouped by what each one is for.
 *
 * A text model is listed once, under one role. Housekeeping is what every text
 * model can do, so a model that also has a more specific role (it passed the
 * agent qualification, it reads images, it is a fast judge) is listed under the
 * first of those in `LOCAL_MODEL_ROLES` order, and its other roles are badges on
 * its row. A model the user added has no role and gets its own group. Every
 * other kind (embeddings, speech, classifiers) is a group by kind.
 *
 * Settings > Models > Library and `maestro-cli models list` both group through
 * this module, so the two cannot sort or name a model differently.
 */

import { getAgentDisplayName } from '../agentMetadata';
import { LOCAL_MODEL_KIND_LABELS, LOCAL_MODEL_KIND_ORDER } from './model-catalog';
import {
	LOCAL_MODEL_ROLES,
	type LocalModelEntry,
	type LocalModelKind,
	type LocalModelRole,
} from './types';

/** A group in the Library: a text model's role, the user's own models, or a non-text kind. */
export type LocalModelLibraryGroupId =
	| LocalModelRole
	| 'user'
	| Exclude<LocalModelKind, 'text-gen'>;

/** What each role is called on a group heading and a row badge. */
export const LOCAL_MODEL_ROLE_LABELS: Readonly<Record<LocalModelRole, string>> = Object.freeze({
	agent: 'Runs agents',
	housekeeping: 'Housekeeping',
	judge: 'Judge',
	vision: 'Vision',
});

const ROLE_DESCRIPTIONS: Readonly<Record<LocalModelRole, string>> = Object.freeze({
	agent:
		'Each one passed the agent qualification: it fixed a bug in a scratch repository through the harness its badge names.',
	housekeeping: 'Tab names, summaries, shell commands and pull request drafts.',
	judge: 'Fast yes or no decisions, such as the Cue gate.',
	vision: 'Read screenshots and images.',
});

export interface LocalModelLibraryGroup {
	readonly id: LocalModelLibraryGroupId;
	readonly label: string;
	/** One sentence under the heading. Absent for a kind group, whose line names the tasks that use it. */
	readonly description?: string;
	/** The model kind, for a group that is one. */
	readonly kind?: LocalModelKind;
}

/** Every Library group, in the order they are listed. */
export const LOCAL_MODEL_LIBRARY_GROUPS: readonly LocalModelLibraryGroup[] = Object.freeze([
	...LOCAL_MODEL_ROLES.map((role) =>
		Object.freeze({
			id: role,
			label: LOCAL_MODEL_ROLE_LABELS[role],
			description: ROLE_DESCRIPTIONS[role],
		})
	),
	Object.freeze({
		id: 'user' as const,
		label: 'Added from Hugging Face',
		description:
			'Models you added. Each is pinned to a revision and checked against the hash Hugging Face reports, but Maestro has not tested it.',
	}),
	...LOCAL_MODEL_KIND_ORDER.filter(
		(kind): kind is Exclude<LocalModelKind, 'text-gen'> => kind !== 'text-gen'
	).map((kind) => Object.freeze({ id: kind, label: LOCAL_MODEL_KIND_LABELS[kind], kind })),
]);

/** The one group a model is listed under. */
export function localModelLibraryGroup(entry: LocalModelEntry): LocalModelLibraryGroupId {
	if (entry.kind !== 'text-gen') return entry.kind;
	if (entry.userAdded) return 'user';
	const roles = entry.roles ?? [];
	return (
		LOCAL_MODEL_ROLES.find((role) => role !== 'housekeeping' && roles.includes(role)) ??
		'housekeeping'
	);
}

/**
 * Group items for the Library in {@link LOCAL_MODEL_LIBRARY_GROUPS} order,
 * keeping each group in the order given. `entryOf` reads the catalog entry off
 * whatever the caller holds. Groups with no item are left out.
 */
export function groupLocalModelsForLibrary<T>(
	items: readonly T[],
	entryOf: (item: T) => LocalModelEntry
): { group: LocalModelLibraryGroup; items: T[] }[] {
	return LOCAL_MODEL_LIBRARY_GROUPS.map((group) => ({
		group,
		items: items.filter((item) => localModelLibraryGroup(entryOf(item)) === group.id),
	})).filter((entry) => entry.items.length > 0);
}

/**
 * The badges a row carries: every role the model has, in Library order, with
 * the agent badge naming the harnesses it qualified with ("Runs agents: Claude
 * Code, Codex"). Empty for a model with no role.
 */
export function localModelRoleBadges(entry: LocalModelEntry): string[] {
	const roles = entry.roles ?? [];
	return LOCAL_MODEL_ROLES.filter((role) => roles.includes(role)).map((role) => {
		const harnesses = role === 'agent' ? (entry.agentHarnesses ?? []) : [];
		return harnesses.length > 0
			? `${LOCAL_MODEL_ROLE_LABELS.agent}: ${harnesses.map(getAgentDisplayName).join(', ')}`
			: LOCAL_MODEL_ROLE_LABELS[role];
	});
}

/**
 * Models too large to offer for download on a desktop. They are reached through
 * their provider's API, with the user's own key, from Sources. Checked on
 * 2026-10-11: the smallest of them is 155 GB at 4-bit.
 */
export const CLOUD_ONLY_MODELS: readonly string[] = Object.freeze([
	'DeepSeek V4',
	'Kimi K3',
	'Kimi K2.7 Code',
	'GLM-5.3',
]);

/** The Library's "Cloud only" note, as one sentence. */
export const CLOUD_ONLY_NOTE = `${CLOUD_ONLY_MODELS.slice(0, -1).join(', ')} and ${CLOUD_ONLY_MODELS[CLOUD_ONLY_MODELS.length - 1]} are too large to run on a desktop. Use them through their provider's API, with your own key.`;
