/**
 * How a Maestro system prompt reaches a spawned agent.
 *
 * Shared by the desktop `process:spawn` handler, Cue runs, and Group Chat (and
 * cross-agent consults, which spawn through Group Chat's helper), so every
 * main-process spawn delivers it the same way.
 *
 * WHICH way is decided by `resolveSystemPromptDelivery`
 * (`src/shared/maestro-lib/launch/prompt-delivery.ts`), the same pure rule the
 * CLI spawner asks, so the two cannot drift on flag vs temp file vs embed vs
 * resume skip. This module is the main-process REALIZATION of that decision:
 * the args, the embedded prompt, the Windows temp file and its cleanup, and
 * the logging.
 *
 * The CLI (`src/cli/services/agent-spawner.ts`) realizes the same decision
 * itself: it cannot import main modules, and it cleans its temp file up when
 * the child exits rather than on a timer.
 */

import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isWindows } from '../../shared/platformDetection';
import { embedSystemPromptInPrompt } from '../../shared/embeddedSystemPrompt';
import { resolveSystemPromptDelivery } from '../../shared/maestro-lib/launch/prompt-delivery';
import { logger } from './logger';
import { captureException } from './sentry';

/** How long a Windows temp prompt file lives; the agent reads it at startup. */
export const SYSTEM_PROMPT_TEMP_FILE_TTL_MS = 30_000;

/**
 * What happened to the system prompt.
 * - `file`: `--append-system-prompt-file <tmp>` (Windows local)
 * - `cli-arg`: `--append-system-prompt <text>`
 * - `embedded`: wrapped into the user prompt
 * - `skipped-resume`: not re-sent; already in the resumed transcript
 * - `sole-prompt`: no user prompt, so the system prompt was sent as the prompt
 */
export type SystemPromptDelivery =
	| 'file'
	| 'cli-arg'
	| 'embedded'
	| 'skipped-resume'
	| 'sole-prompt';

export interface SystemPromptDeliveryInput {
	/** Agent args so far; the flag (when used) is appended. */
	args: string[];
	/** The user prompt, if any. */
	prompt: string | undefined;
	/** The assembled Maestro system prompt. Nothing happens when empty. */
	systemPrompt: string | undefined;
	/** `capabilities.supportsAppendSystemPrompt` for this agent. */
	supportsAppendSystemPrompt: boolean;
	/** True when this spawn resumes an existing provider session. */
	isResume: boolean;
	/** True when the spawn is wrapped for an SSH remote (never uses a temp file). */
	isSshSession: boolean;
	/** Used in the temp file name so concurrent spawns never collide. */
	sessionId: string;
	/** For debug logs only. */
	agentId?: string;
	/** Logger context of the caller. */
	logContext?: string;
}

export interface SystemPromptDeliveryResult {
	args: string[];
	prompt: string | undefined;
	/** Set when the prompt went to a Windows temp file (cleaned up after the TTL). */
	tempFile?: string;
	/** Undefined when there was no system prompt to deliver. */
	delivery?: SystemPromptDelivery;
}

/**
 * Temp file name for a Windows system prompt. The session id can carry a
 * user-typed agent name (Group Chat participant ids do: `feature/auth`, `a|b`,
 * `what?`), which Windows rejects in a file name, so it is reduced to a safe,
 * capped slug. The random suffix keeps two spawns in the same millisecond apart.
 */
export function systemPromptTempFileName(sessionId: string): string {
	const slug = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
	return `maestro-sysprompt-${slug}-${Date.now()}-${suffix}.txt`;
}

/**
 * Apply the system prompt to a spawn's args/prompt. Returns new values; the
 * inputs are not mutated.
 */
export async function applySystemPromptDelivery(
	input: SystemPromptDeliveryInput
): Promise<SystemPromptDeliveryResult> {
	const { args, prompt, systemPrompt, sessionId, agentId } = input;
	const logContext = input.logContext ?? '[SystemPromptDelivery]';
	const decision = resolveSystemPromptDelivery({
		systemPrompt,
		supportsAppendSystemPrompt: input.supportsAppendSystemPrompt,
		isWindowsHost: isWindows(),
		sshRemote: input.isSshSession,
		isResume: input.isResume,
		hasUserPrompt: !!prompt,
	});
	if (!systemPrompt || decision.via === 'none') return { args, prompt };

	const inline = (): SystemPromptDeliveryResult => ({
		args: [...args, '--append-system-prompt', systemPrompt],
		prompt,
		delivery: 'cli-arg',
	});

	switch (decision.via) {
		case 'file': {
			// Windows local: write to temp file to avoid CLI length limits
			const tempFile = path.join(os.tmpdir(), systemPromptTempFileName(sessionId));
			try {
				// Owner-only: the prompt carries the user's own context.
				await fsp.writeFile(tempFile, systemPrompt, { encoding: 'utf-8', mode: 0o600 });
			} catch (writeErr) {
				// A failed write must not cost the agent its spawn. Inline is what every
				// non-Windows spawn does; only a very long prompt risks the CLI limit.
				logger.warn(
					'System prompt temp file write failed; falling back to inline --append-system-prompt',
					logContext,
					{
						agentId,
						tempFile,
						error: writeErr instanceof Error ? writeErr.message : String(writeErr),
					}
				);
				return inline();
			}
			// Schedule cleanup early so the file is removed even if spawn fails.
			// Fire-and-forget unlink mirrors process-manager/utils/imageUtils.cleanupTempFiles:
			// silence ENOENT (file already gone), capture other codes via Sentry.
			setTimeout(() => {
				fsp.unlink(tempFile).catch((cleanupErr: unknown) => {
					if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
						captureException(
							cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)),
							{
								context: 'systemPromptTempFile cleanup (safety)',
								file: tempFile,
							}
						);
					}
				});
			}, SYSTEM_PROMPT_TEMP_FILE_TTL_MS);
			logger.debug(
				'Using --append-system-prompt-file for system prompt delivery (Windows)',
				logContext,
				{ agentId, systemPromptLength: systemPrompt.length, tempFile }
			);
			return {
				args: [...args, '--append-system-prompt-file', tempFile],
				prompt,
				tempFile,
				delivery: 'file',
			};
		}
		case 'flag':
			// Non-Windows or SSH: pass inline (no command-line length concern)
			logger.debug('Using --append-system-prompt for system prompt delivery', logContext, {
				agentId,
				systemPromptLength: systemPrompt.length,
			});
			return inline();
		case 'skip-on-resume':
			// The system prompt was embedded in the first user turn at initial spawn
			// and is preserved in the agent's session transcript.
			logger.debug(
				'Skipping system prompt re-injection on resume (already in transcript)',
				logContext,
				{
					agentId,
					systemPromptLength: systemPrompt.length,
				}
			);
			return { args, prompt, delivery: 'skipped-resume' };
		case 'embed':
			// The envelope is built by the shared helper because the transcript
			// renderer has to take it back apart again when a tab is hydrated from
			// disk (see src/shared/embeddedSystemPrompt.ts).
			logger.debug('Embedding system prompt in user message (fallback)', logContext, {
				agentId,
				systemPromptLength: systemPrompt.length,
			});
			return {
				args,
				prompt: embedSystemPromptInPrompt(systemPrompt, prompt ?? ''),
				delivery: 'embedded',
			};
		case 'as-prompt':
			logger.warn(
				'appendSystemPrompt provided without a user prompt; using as sole prompt',
				logContext,
				{
					agentId,
					systemPromptLength: systemPrompt.length,
				}
			);
			return { args, prompt: systemPrompt, delivery: 'sole-prompt' };
	}
}

/**
 * Copy of `args` with the inline system prompt replaced by its length, for
 * logging. The prompt can be large and carries user-specific context.
 */
export function redactSystemPromptArg(args: string[]): string[] {
	const idx = args.indexOf('--append-system-prompt');
	if (idx === -1) return args;
	return [
		...args.slice(0, idx + 1),
		`<${args[idx + 1]?.length ?? 0} chars>`,
		...args.slice(idx + 2),
	];
}
