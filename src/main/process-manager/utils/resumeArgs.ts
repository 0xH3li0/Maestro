// src/main/process-manager/utils/resumeArgs.ts

/**
 * Whether an agent's CLI args resume an earlier provider session, which sets
 * `MAESTRO_SESSION_RESUMED` in the child's environment. Shared by every
 * pipe-backed spawner so the same args produce the same environment whichever
 * transport carries the turn.
 */
export function argsResumeSession(args: string[]): boolean {
	return (
		args.some((arg) => arg === '--resume' || arg.startsWith('--resume=')) ||
		args.includes('--session')
	);
}
