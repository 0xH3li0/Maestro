/**
 * Cue prompt-injection screen: score one untrusted value with the
 * `injection-screen` Local Models assignment.
 *
 * One function, {@link scoreCueInjectionText}, handed to the Cue engine as its
 * scorer (`CueEngineDeps.scoreInjection`). The engine never imports this
 * module: the standalone runner (`maestro-cli cue engine`) builds an engine
 * with no scorer, because that process does not load the model stack.
 *
 * It only ever returns a score or the reason there is none. Whether a run is
 * blocked is the dispatch service's call (`resolveCueInjectionDecision`), so
 * the failure policy lives in one place and this module cannot fail a run open
 * or closed by accident.
 *
 * The scoring itself (`off` apart from `unavailable`, the whole value read,
 * System One before the classifier) is the neutral screen in
 * `injection-screen.ts`, which Sketch Book calls too.
 */

import type {
	CueInjectionScore,
	CueInjectionScoreRequest,
} from '../../shared/cue/injection-screen';
import { INJECTION_SCREEN_TIMEOUT_MS, scoreInjectionText } from './injection-screen';

/**
 * How long one value may take on the classifier path. Long enough for a cold
 * classifier to load and read a 10,000 character body; short enough that an
 * event is not held for minutes. A timeout is `unavailable`, so the policy
 * decides.
 */
export const CUE_INJECTION_SCREEN_TIMEOUT_MS = INJECTION_SCREEN_TIMEOUT_MS;

/**
 * Score one untrusted value.
 *
 * A thin wrapper over {@link scoreInjectionText}: no signal (the classifier
 * keeps its own deadline, the System One path its engine's budget) and no
 * source check, which is exactly how Cue has always screened.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runClassifierTask`). The dispatch
 * service treats a throw as `unavailable` too, so even that cannot strand an
 * event.
 */
export async function scoreCueInjectionText(
	request: CueInjectionScoreRequest
): Promise<CueInjectionScore> {
	return scoreInjectionText({
		text: request.text,
		purpose: 'cue',
		label: `${request.subscriptionName}.${request.variable}`,
		...(request.agentId ? { agentId: request.agentId } : {}),
	});
}
