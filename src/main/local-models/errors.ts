/**
 * Classified Local Models failures.
 *
 * Every consumer of the core (A Cappella today; tab naming, AI command mode,
 * semantic search and the Cue gate later) has its own error vocabulary and its
 * own way of telling a person what went wrong. The core cannot speak any of
 * them, so it speaks one of its own: a stable `code` a consumer can switch on
 * and a `recovery` sentence written for a person. A consumer maps this onto its
 * own error at its boundary (A Cappella turns it into a `VoiceProviderError`).
 *
 * What is NOT in here: bugs. An unknown model id handed to the store is a
 * programming error and stays a plain `Error`, so it reaches Sentry as one.
 */

/**
 * Why a local model could not be used.
 *
 *   - `runtime-unavailable` - the native runtime the model needs will not load
 *                             here: not downloaded, no build for this platform,
 *                             or the dlopen failed.
 */
export type LocalModelErrorCode = 'runtime-unavailable';

export interface LocalModelErrorOptions {
	code: LocalModelErrorCode;
	/** What the user can do about it. One sentence, safe to display. */
	recovery: string;
	/** Who asked, so a consumer can name the engine that failed. */
	consumerId: string;
	/** The underlying failure, kept for Sentry breadcrumbs. Never shown verbatim. */
	cause?: unknown;
}

/** A failure the core predicted. The message is written for a person. */
export class LocalModelError extends Error {
	readonly code: LocalModelErrorCode;
	readonly recovery: string;
	readonly consumerId: string;

	constructor(message: string, options: LocalModelErrorOptions) {
		super(message);
		this.name = 'LocalModelError';
		// Assigned rather than passed to `super`: the main bundle's lib target
		// predates the ErrorOptions overload.
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.code = options.code;
		this.recovery = options.recovery;
		this.consumerId = options.consumerId;
	}
}

export function isLocalModelError(error: unknown): error is LocalModelError {
	return error instanceof LocalModelError;
}
