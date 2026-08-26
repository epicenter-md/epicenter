/**
 * Autumn SDK adapter: the only file in `billing/` that imports `autumn-js`.
 *
 * The service still speaks Autumn's domain shape (`check`, balances,
 * subscriptions, plans). This file owns the SDK import, client defaults,
 * and provider error translation:
 *
 *   createAutumnClient(env)   build the per-request client with the
 *                             fail-closed invariant baked in.
 *   mapAutumnError(error)     log the full provider failure for operators, then
 *                             translate it into the opaque `BillingError`.
 *   isProviderError(error)    narrow a throw to a provider failure (vs a bug),
 *                             so route `onError` can rethrow real 500s.
 *   tryAutumn(fn)             run a provider call and return a `Result`.
 *                             Provider failures become `BillingError`; real
 *                             bugs keep throwing.
 *
 * Provider failures arrive as two sibling class families (verified against
 * autumn-js@1.2.34): `AutumnError` for an HTTP non-2xx response, and the
 * `HTTPClientError` family (`ConnectionError`, `RequestTimeoutError`, ...) for a
 * network/transport failure. They share only the JS `Error` base, so a single
 * `instanceof AutumnError` check MISSES every network failure: hence
 * `isProviderError` checks both.
 */

import { Autumn, AutumnError, HTTPClientError } from 'autumn-js';
import { createLogger } from 'wellcrafted/logger';
import { type Result, tryAsync } from 'wellcrafted/result';
import { BillingError } from './errors.js';

const log = createLogger('billing/autumn');

/**
 * Build a per-request Autumn client.
 *
 * The SDK defaults `failOpen: true`, meaning a vendor outage causes `check()`
 * to silently allow the request. That is the wrong default for paid features:
 * if we cannot verify entitlement, we must reject. `failOpen: false` makes
 * every billing check fail CLOSED (it throws instead of returning a dummy
 * `allowed: true`), and `balances.finalize` / `billing.attach` were never in
 * the fail-open set regardless. This is the single owner of that invariant.
 */
export function createAutumnClient(env: { AUTUMN_SECRET_KEY: string }): Autumn {
	return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY, failOpen: false });
}

/**
 * Record the full provider failure for operators, then map it to the opaque
 * `BillingError` for the wire.
 *
 * This is the single chokepoint where every provider failure is observed: it is
 * called by `tryAutumn` (guard + reservation paths) and by the route `onError`
 * after `isProviderError` has already separated provider failures from local
 * bugs.
 * The original error carries the only diagnostic detail we keep (status, body,
 * class, cause); the wire error is a fixed user-facing message. A 4xx means
 * Autumn rejected OUR request (most likely a bug in our call), so it logs at
 * `error`; a 5xx or a network/transport failure is a transient provider outage,
 * so `warn`.
 *
 * Returns the wellcrafted `Err` envelope (what the `defineErrors` factory
 * produces), so it drops straight into a `tryAsync` `catch` or a `c.json`.
 */
export function mapAutumnError(error: AutumnError | HTTPClientError) {
	if (error instanceof AutumnError && error.statusCode < 500) {
		log.error(error);
	} else {
		log.warn(error);
	}
	return BillingError.ProviderRequestFailed();
}

/** Provider 404: the target does not exist. Deletion flows treat it as done. */
export function isNotFoundError(error: unknown): boolean {
	return error instanceof AutumnError && error.statusCode === 404;
}

/**
 * Narrow a throw to a provider failure (HTTP non-2xx OR network/transport),
 * versus a programming bug in our own handler code. Route `onError` uses this
 * to translate provider failures into the billing envelope while rethrowing
 * everything else to a real 500: a `TypeError` in our mapping code should be a
 * 500, not a misleading "provider unreachable" 503.
 */
export function isProviderError(
	error: unknown,
): error is AutumnError | HTTPClientError {
	return error instanceof AutumnError || error instanceof HTTPClientError;
}

/**
 * Run a provider call and return a `Result`. Provider throws (the fail-closed
 * path under `failOpen: false`) become `BillingError`; non-provider throws are
 * rethrown so local bugs do not masquerade as "billing unavailable."
 */
export function tryAutumn<T>(
	fn: () => Promise<T>,
): Promise<Result<T, BillingError>> {
	return tryAsync({
		try: fn,
		catch: (error) => {
			if (!isProviderError(error)) throw error;
			return mapAutumnError(error);
		},
	});
}
