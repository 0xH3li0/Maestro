/**
 * Where a Local Models call runs: a catalog model on this machine, or a model
 * on one of the user's saved endpoints. Every service (text generation,
 * embeddings, classifiers) takes the same shape, so the task router turns an
 * assignment into a source once for all of them.
 */

import type { LocalModelAssignment, LocalModelAssignments } from '../../shared/local-models/tasks';
import { getSettingsStore } from '../stores/getters';

export type LocalModelSource =
	| { type: 'local'; modelId: string }
	| { type: 'endpoint'; endpointId: string; model: string };

/** The source an assignment runs on, or null for `off` and `utility-agent`. */
export function sourceForAssignment(assignment: LocalModelAssignment): LocalModelSource | null {
	if (assignment.type === 'local') return { type: 'local', modelId: assignment.modelId };
	if (assignment.type === 'endpoint') {
		return { type: 'endpoint', endpointId: assignment.endpointId, model: assignment.model };
	}
	return null;
}

/**
 * The persisted `localModelAssignments` setting, unparsed. The task router and
 * task readiness both resolve it through `resolveLocalModelAssignment`, so they
 * cannot disagree about which source a task is on.
 */
export function readLocalModelAssignments(): LocalModelAssignments | undefined {
	return getSettingsStore().get('localModelAssignments', {}) as LocalModelAssignments | undefined;
}
