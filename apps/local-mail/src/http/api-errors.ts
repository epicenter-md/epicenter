import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for Local Mail's HTTP surface.
 *
 * Every non-2xx response from the Hono app ({@link api.ts}) comes from one of
 * these variants, and so does every non-2xx a host emits in front of it: the
 * SPA has one error path, so anything it must read speaks this vocabulary. The
 * wire shape is `wellcrafted`'s
 * envelope `{ data: null, error: { name, message, status } }` and each variant
 * bakes in its own HTTP `status`. Emit as `c.json(err, err.error.status)`; the
 * `c-json-errors` biome gate is satisfied because a factory result is not an
 * inline object literal.
 *
 * The one consumer is the same-origin SPA, which surfaces `error.message` in a
 * toast; it does not branch on `error.name`. The variants exist to keep the
 * error surface centralized and typed, not because a remote client reads them.
 *
 * @example
 * ```ts
 * import { ApiError } from './api-errors.ts';
 * const err = ApiError.MessageNotFound();
 * return c.json(err, err.error.status); // 404
 * ```
 */
export const ApiError = defineErrors({
	/** The `:account` path segment names no account the host loaded at launch.
	 * The app enumerates connected accounts once at start, so an account
	 * connected after launch is unknown until the next restart. */
	AccountNotFound: () => ({
		message: 'Unknown account. Reload after connecting it.',
		status: 404 as const,
	}),
	/** No mirror row for the requested message id. */
	MessageNotFound: () => ({
		message: 'Message not found.',
		status: 404 as const,
	}),
	/** A message write (label modify or trash/untrash) was refused before Gmail
	 * (read-only mode, unknown label) or failed systemically. */
	ModifyFailed: ({ message }: { message: string }) => ({
		message,
		status: 400 as const,
	}),
	/** No route matched under the mounted mail surface. */
	NotFound: () => ({
		message: 'Not found.',
		status: 404 as const,
	}),
	/** Gmail's consent flow could not start: no application credentials, or the
	 * loopback listener could not bind. Distinct from the person declining
	 * consent, which happens later and is reported through the engine's log. */
	ConnectFailed: ({ message }: { message: string }) => ({
		message,
		status: 400 as const,
	}),
	/** This surface was mounted over a fixed set of accounts with no way to add
	 * one. Not reachable from the Epicenter host, whose engine always supplies
	 * `connect`; it exists so the route is total rather than optional. */
	ConnectUnavailable: () => ({
		message: 'This mail surface cannot connect new accounts.',
		status: 501 as const,
	}),
	/** The host mounted these routes but has no engine behind them, because no
	 * Gmail account is connected on this device. Emitted by the host in front of
	 * the mail app, never by the app itself (ADR-0191): the app only exists when
	 * an account opened; this state needs `local-mail connect`. */
	MailUnavailable: () => ({
		message:
			'No Gmail account is connected on this device. Run "local-mail connect" to add one.',
		status: 503 as const,
	}),
});

/** Discriminated union of all `/api` error payloads, keyed by `name`. */
export type ApiError = InferErrors<typeof ApiError>;
