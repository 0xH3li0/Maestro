/**
 * Secret screen: check content for credentials before Maestro publishes it.
 *
 * One function, {@link screenForSecrets}, called by every path that sends
 * content off the machine: gist publishing (`git:createGist`), feedback
 * (`src/main/feedback`), and the support package (`generateDebugPackage`).
 * Each caller refuses on a finding unless the request carried `allowSecrets`,
 * which only a person's "Publish anyway" or the CLI's `--allow-secrets` sets.
 *
 * Two passes:
 *
 * 1. **Patterns, always.** `scanForSecrets` needs no model, so no setting can
 *    turn it off and no model failure can skip it. It also searches for the
 *    values of the secret-named environment variables Maestro is configured
 *    with, which no fixed pattern could know.
 * 2. **The `secret-screen` Local Models assignment, when one is set.** Extra
 *    coverage only. `off` (the default) adds nothing. A model that cannot run
 *    does NOT block and does not hide the pattern result: the reason is logged
 *    and returned as `note`, so the caller can say that only patterns ran.
 *    The verdict names the model and its score, because a classifier answers
 *    for what it was trained on and the user chose which one to assign.
 */

import { scanForSecrets, type SecretFinding, type SecretScanEnv } from '../../shared/secretScan';
import {
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
} from '../../shared/local-models/tasks';
import { getAgentConfigsStore, getSessionsStore, getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import { runClassifierTask } from './task-router';

const LOG_CONTEXT = '[SecretScreen]';

const TASK_ID = 'secret-screen';

/**
 * How long the model pass may take. Publishing waits on it, so it is short: a
 * timeout is reported as a note and the pattern result stands.
 */
export const SECRET_SCREEN_MODEL_TIMEOUT_MS = 30 * 1000;

/** One named piece of what is about to be published. */
export interface SecretScreenPart {
	/** Shown beside a finding: a file name, or a field such as "Summary". */
	source?: string;
	text: string;
}

export interface SecretScreenResult {
	findings: SecretFinding[];
	/** Why the assigned model did not run. Absent when it ran or none is assigned. */
	note?: string;
}

export interface SecretScreenOptions {
	/** Configured variables to match values of. Defaults to {@link knownSecretEnv}. */
	env?: SecretScanEnv;
}

/**
 * Screen content that is about to leave the machine.
 *
 * Never throws: a publishing path must be able to rely on the pattern result
 * whatever state the model stack is in.
 */
export async function screenForSecrets(
	parts: readonly SecretScreenPart[],
	options: SecretScreenOptions = {}
): Promise<SecretScreenResult> {
	const env = options.env ?? knownSecretEnv();
	const present = parts.filter((part) => part.text.trim().length > 0);

	const findings: SecretFinding[] = [];
	for (const part of present) {
		findings.push(...scanForSecrets(part.text, { env, source: part.source }));
	}

	const model = await modelPass(present);
	if (model.finding) findings.push(model.finding);

	if (findings.length > 0) {
		// Kinds and counts only. A preview is masked, but a log is not the place
		// for even the tail of a credential.
		logger.warn('Possible secrets found in content about to be published', LOG_CONTEXT, {
			count: findings.length,
			kinds: [...new Set(findings.map((finding) => finding.kind))],
		});
	}
	return { findings, ...(model.note ? { note: model.note } : {}) };
}

/** The optional model pass. Reports a finding, a note, or neither. */
async function modelPass(
	parts: readonly SecretScreenPart[]
): Promise<{ finding?: SecretFinding; note?: string }> {
	if (parts.length === 0) return {};
	const task = LOCAL_MODEL_TASKS[TASK_ID];
	const unavailable = (reason: string) => ({
		note: `${task.label} model did not run: ${reason} Pattern detection still ran.`,
	});

	try {
		const verdict = await runClassifierTask(TASK_ID, {
			text: parts.map((part) => part.text).join('\n\n'),
			signal: AbortSignal.timeout(SECRET_SCREEN_MODEL_TIMEOUT_MS),
		});
		switch (verdict.status) {
			case 'off':
				return {};
			case 'cancelled':
				logger.warn('Secret screen model timed out', LOG_CONTEXT, { source: verdict.source });
				return unavailable('it took too long to answer.');
			case 'unavailable':
				logger.warn('Secret screen model unavailable', LOG_CONTEXT, {
					source: verdict.source,
					code: verdict.code,
					reason: verdict.reason,
				});
				return unavailable(verdict.reason);
			case 'ok':
				if (!verdict.flagged) return {};
				return {
					finding: {
						kind: 'model-flagged',
						line: 0,
						preview: `${verdict.label} ${verdict.score.toFixed(2)}`,
						name: localModelAssignmentSourceLabel(verdict.source, []) ?? undefined,
					},
				};
		}
	} catch (error) {
		// An unclassified failure inside the model stack. The task router has
		// already reported it; the pattern result must still reach the caller.
		logger.warn('Secret screen model failed', LOG_CONTEXT, { error: String(error) });
		return unavailable('it failed to run.');
	}
}

/**
 * Every environment variable Maestro knows about: its own process environment,
 * Settings -> Environment, each provider's variables, and each agent's own.
 * `scanForSecrets` keeps only the secret-named ones with a value worth
 * matching. Reading a store that is not ready yet costs that layer, not the
 * scan.
 */
export function knownSecretEnv(): Array<[string, string | undefined]> {
	const env: Array<[string, string | undefined]> = Object.entries(process.env);
	const add = (vars: unknown): void => {
		if (!vars || typeof vars !== 'object') return;
		for (const [name, value] of Object.entries(vars)) {
			if (typeof value === 'string' && value) env.push([name, value]);
		}
	};
	const layer = (read: () => void): void => {
		try {
			read();
		} catch {
			// Stores are not initialized (early startup, a unit test).
		}
	};
	layer(() => add(getSettingsStore().get('shellEnvVars')));
	layer(() => {
		for (const config of Object.values(getAgentConfigsStore().get('configs', {}))) {
			add(config?.customEnvVars);
		}
	});
	layer(() => {
		for (const session of getSessionsStore().get('sessions', [])) {
			add((session as { customEnvVars?: unknown }).customEnvVars);
		}
	});
	return env;
}
