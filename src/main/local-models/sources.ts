/**
 * Where a Local Models call runs: a catalog model on this machine, or a model
 * on one of the user's saved endpoints. Every service (text generation,
 * embeddings, classifiers) takes the same shape, so the task router turns an
 * assignment into a source once for all of them.
 */

import type { LocalModelAssignment } from '../../shared/local-models/tasks';

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
