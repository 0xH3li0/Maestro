/**
 * Agent error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 */

import type { ProcessManager } from '../process-manager';
import type { AgentError } from '../../shared/types';
import type { ProcessListenerDependencies } from './types';
import { capabilitySnapshots } from '../agents/capability-snapshot';
import { noteEffortRejection, parseEffortRejection } from '../../shared/effortRejection';
import { isLadderEffortValue } from '../../shared/modelTiers';
import { captureMessage } from '../utils/sentry';

/**
 * Sets up the agent-error listener.
 * Handles logging and forwarding of agent errors to renderer.
 *
 * Side effect: when the classified error is `auth_expired`, mirrors the
 * status into the capability snapshot store so the Settings → Agents tab
 * flips to a yellow "Auth required" pill without a separate eager probe.
 *
 * Side effect: when the provider refused the effort level the turn asked for,
 * the refusal is noted so `resolveEffortLevel` stops handing that value out for
 * the rest of this process (see `shared/effortRejection.ts`). Every agent error
 * in the main process passes through here - a tab turn, a naming spawn, a
 * groomer, a Cue run - so this is the one place that sees all of them. A
 * refused LADDER value means the shipped table in `modelTiers.ts` has drifted
 * from the provider's catalogue, which is only fixable in a release, so the
 * first sighting of each is reported to Sentry. A value the user picked
 * themselves is not: that is theirs to change, and it would only be noise.
 */
export function setupErrorListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'logger'>
): void {
	const { safeSend, logger } = deps;

	// Handle agent errors (auth expired, token exhaustion, rate limits, etc.)
	processManager.on('agent-error', (sessionId: string, agentError: AgentError) => {
		logger.info(`Agent error detected: ${agentError.type}`, 'AgentError', {
			sessionId,
			agentId: agentError.agentId,
			errorType: agentError.type,
			message: agentError.message,
			recoverable: agentError.recoverable,
		});
		safeSend('agent:error', sessionId, agentError);

		const effortRejection = parseEffortRejection(agentError.message);
		if (
			effortRejection &&
			agentError.agentId &&
			noteEffortRejection(agentError.agentId, effortRejection)
		) {
			logger.warn(
				`Provider rejected effort "${effortRejection.value}"; turns that map to it now use the agent's own effort`,
				'AgentError',
				{ sessionId, agentId: agentError.agentId, ...effortRejection }
			);
			if (isLadderEffortValue(agentError.agentId, effortRejection.value)) {
				void captureMessage('Provider rejected an effort ladder value', 'warning', {
					agentId: agentError.agentId,
					value: effortRejection.value,
					model: effortRejection.model,
					supported: effortRejection.supported,
					viaSsh: !!agentError.sshRemoteId,
				});
			}
		}

		// Reactive capability classification: an auth-expired event means the
		// binary is present (otherwise we wouldn't have spawned it) but the
		// user needs to re-authenticate. Snapshot stays auth_required until a
		// subsequent successful detect / spawn clears it. When the spawn was
		// SSH-backed, the AgentError payload carries the remote UUID so the
		// per-remote pill flips, not the local one.
		if (agentError.type === 'auth_expired' && agentError.agentId) {
			capabilitySnapshots.markAuthRequired(
				agentError.agentId,
				agentError.message,
				agentError.sshRemoteId
			);
		}
	});
}
