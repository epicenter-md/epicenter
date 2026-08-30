/**
 * `rateLimit`: a fixed-window burn-rate cap for the inference policies seam.
 *
 * The OpenAI-compatible gateway (`mountInferenceApp`) proxies to a provider with
 * the deployment's HOUSE key, so every accepted request spends the operator's
 * money. `policies` is where a deployment gates that spend: the cloud passes its
 * Autumn credit charge, and a self-hosted instance can pass this to cap the burn
 * rate so a leaked or overused bearer cannot run the provider bill up unbounded.
 * It is the in-process backstop; the real ceiling is the hard spend limit the
 * operator sets on the provider key itself (see apps/self-host/README.md).
 *
 * One counter per principal partition, keyed off `c.var.principal.id` (set by
 * the upstream auth middleware). On the single-partition instance that is one
 * global bucket; on a hosted deployment it is per principal.
 *
 * The window lives in process memory: EXACT on the blessed single-node Bun
 * instance, and per-isolate (so approximate) on Cloudflare, which is the same
 * single-node accuracy tradeoff the instance accepts everywhere. It is sized for
 * the small trusted group the instance targets, not multi-tenant scale; durable,
 * shared limiting at scale is Cloud's concern (Autumn), not this primitive.
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
			// Sweep the elapsed windows while we are here. Entries were only ever
			// overwritten, never removed, so the map grew with every principal the
			// isolate had ever seen and nothing reclaimed one that stopped calling.
			// Amortised against the request that starts a window, so a steady
			// caller pays nothing and the map stays proportional to who is ACTIVE.
			for (const [seen, elapsed] of windows) {
				if (now >= elapsed.resetAt) windows.delete(seen);
			}
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
