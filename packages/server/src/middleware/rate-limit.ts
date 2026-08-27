/**
 * `rateLimit`: a fixed-window burn-rate cap for the inference policies seam.
 *
 * The OpenAI-compatible gateway (`mountInferenceApp`) proxies to a provider with
 * the deployment's HOUSE key, so every accepted request spends Epicenter's money.
 * `policies` is where a deployment gates that spend, and Cloud passes this
 * alongside its Autumn credit charge. The credit balance is the primary gate, but
 * chat settles AFTER the call with `overageBehavior: "overflow"`, so N concurrent
 * calls at exhaustion each run before any settles. This cap is what makes that
 * overshoot bounded: bad debt is per-call cost times this limit, one-time, per
 * principal.
 *
 * A self-hosted instance does not use it, because an instance does not do
 * inference at all (ADR-0264): it holds no house key and mounts no gateway.
 *
 * One counter per principal partition, keyed off `c.var.principal.id` (set by
 * the upstream auth middleware), so on Cloud it is per paying principal.
 *
 * The window lives in process memory, so it is per-isolate and therefore
 * APPROXIMATE on Cloudflare: a caller spread across isolates gets more than the
 * nominal limit. That is acceptable for what it is used for, bounding a one-time
 * overshoot at balance exhaustion, and it is deliberately NOT a sustained-abuse
 * defense. Durable, shared limiting is a separate problem; do not read this as
 * solving it.
 *
 * A denied request answers `429` in the gateway's OpenAI error envelope
 * (`{ error: { message, code } }`) with a `Retry-After` header, so the inference
 * client's reducer keeps its branchable `error.code`.
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

/** Build the OpenAI error envelope the gateway answers a throttled request with. */
function openAiError(
	message: string,
	code: string,
): { error: { message: string; code: string } } {
	return { error: { message, code } };
}

export function rateLimit<E extends Env = Env>(opts: {
	/** Max requests allowed per principal partition within one window. */
	requests: number;
	/** Window length in seconds; the count resets when it elapses. */
	windowSeconds: number;
}): MiddlewareHandler<E> {
	const windowMs = opts.windowSeconds * 1000;
	const windows = new Map<string, { count: number; resetAt: number }>();
	return createMiddleware<E>(async (c, next) => {
		const key = c.var.principal.id;
		const now = Date.now();
		const window = windows.get(key);

		// First request, or the previous window elapsed: start a fresh window.
		if (!window || now >= window.resetAt) {
			windows.set(key, { count: 1, resetAt: now + windowMs });
			return next();
		}

		if (window.count >= opts.requests) {
			c.header('retry-after', String(Math.ceil((window.resetAt - now) / 1000)));
			return c.json(
				openAiError(
					'Rate limit exceeded. Try again shortly.',
					'rate_limit_exceeded',
				),
				429,
			);
		}

		window.count += 1;
		return next();
	});
}
