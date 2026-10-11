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

/**
 * Why a call to a user-run model server failed.
 *
 *   - `missing-key` - the endpoint names an API key variable that is not set in
 *                     Settings -> Environment, so the request was never sent.
 *   - `auth`        - the server answered 401 or 403.
 *   - `not-found`   - the server answered 404: the path does not exist there
 *                     (wrong kind, wrong base URL) or the model is unknown.
 *   - `http`        - any other non-2xx answer.
 *   - `timeout`     - no response headers inside the request budget.
 *   - `network`     - the server could not be reached at all.
 *   - `cancelled`   - the caller aborted. Not a fault; never shown as one.
 *   - `malformed`   - a 2xx answer whose body was not the shape this kind serves.
 *   - `no-models`   - the server answered, but serves no model to test against.
 *   - `invalid`     - the endpoint record or id handed in is not usable (an
 *                     unknown id, a record that fails validation), so nothing
 *                     was sent.
 */
export type LocalModelEndpointErrorKind =
	| 'missing-key'
	| 'auth'
	| 'not-found'
	| 'http'
	| 'timeout'
	| 'network'
	| 'cancelled'
	| 'malformed'
	| 'no-models'
	| 'invalid';

export interface LocalModelEndpointErrorOptions {
	kind: LocalModelEndpointErrorKind;
	endpointId: string;
	endpointName: string;
	/** The URL that was requested. Carries no credentials: those are refused at save time. */
	url: string;
	httpStatus?: number;
	cause?: unknown;
}

/**
 * A failure talking to a configured endpoint. The message names the endpoint
 * and, for an HTTP failure, the status, so a person can tell "Ollama is not
 * running" from "LiteLLM rejected the key" without opening a log.
 */
export class LocalModelEndpointError extends Error {
	readonly kind: LocalModelEndpointErrorKind;
	readonly endpointId: string;
	readonly endpointName: string;
	readonly url: string;
	readonly httpStatus?: number;

	constructor(message: string, options: LocalModelEndpointErrorOptions) {
		super(message);
		this.name = 'LocalModelEndpointError';
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.kind = options.kind;
		this.endpointId = options.endpointId;
		this.endpointName = options.endpointName;
		this.url = options.url;
		this.httpStatus = options.httpStatus;
	}
}

export function isLocalModelEndpointError(error: unknown): error is LocalModelEndpointError {
	return error instanceof LocalModelEndpointError;
}
