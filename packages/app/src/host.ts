/**
 * @fileoverview The one place this package knows it is talking to Tauri.
 *
 * Everything above this file speaks in capabilities. Everything below it is
 * `@tauri-apps/api`, which is the host's own public transport: the same
 * `invoke` and `listen` Epicenter's generated bindings use. This package does
 * not reimplement either against `window.__TAURI_INTERNALS__`, because a
 * private global is a worse contract than a published one and would go stale
 * silently.
 *
 * It does *read* that global, for exactly one purpose. `invoke` dereferences
 * `window.__TAURI_INTERNALS__` when called, so its presence is precisely the
 * question "would this call reach a host". Asking it first is what turns a
 * plain browser tab from a thrown `TypeError` into a typed
 * `HostUnavailable`. The read is lazy, so a module imported before the host
 * finishes injecting the global is not permanently poisoned.
 *
 * # Three kinds of no
 *
 * A host that declines can decline in three ways, and they are told apart by
 * the shape of what comes back rather than by matching on message text:
 *
 * - **A plain string.** Tauri's access-control layer rejects with a string
 *   (`InvokeError` wrapping a JSON string) when a window may not call a
 *   command. None of the commands this package invokes report a failure that
 *   way: theirs are tagged objects. So a string means the call was never
 *   routed, which is `CapabilityUnavailable`.
 * - **A tagged object.** The command ran and reported a typed failure. It is
 *   handed back to the capability that asked for it, which knows which of its
 *   own names it maps to.
 * - **Anything else**, including an `Error` instance. Something broke that is
 *   not part of the contract. It travels as an opaque cause and each capability
 *   folds it into its own `*Failed` variant, never into an "unavailable".
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type HostError, HostErrors } from './errors.js';

/**
 * A rejection the host produced that this layer will not interpret: either a
 * typed failure from the command itself or something unrecognized. The
 * capability that made the call owns the mapping, because only it knows which
 * failures its own operation can produce.
 *
 * @internal Never escapes the package: every call site maps it.
 */
export type HostRejection = { readonly domain: unknown };

/** @internal */
export function isHostRejection(
	error: HostError | HostRejection,
): error is HostRejection {
	return 'domain' in error;
}

/**
 * Whether an Epicenter host is reachable from here.
 *
 * @internal
 */
function hostIsReachable(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof Reflect.get(window, '__TAURI_INTERNALS__') === 'object'
	);
}

/**
 * Invoke a host command.
 *
 * @internal
 */
export async function callHost<T>(
	operation: string,
	command: string,
	args?: Record<string, unknown>,
): Promise<Result<T, HostError | HostRejection>> {
	if (!hostIsReachable()) return HostErrors.HostUnavailable({ operation });
	try {
		return Ok(await invoke<T>(command, args));
	} catch (rejection) {
		return classify(operation, rejection);
	}
}

/**
 * Subscribe to a host event, and hand back the call that ends the subscription.
 *
 * @internal
 */
export async function observeHost<TPayload>(
	operation: string,
	event: string,
	handler: (payload: TPayload) => void,
): Promise<Result<() => void, HostError | HostRejection>> {
	if (!hostIsReachable()) return HostErrors.HostUnavailable({ operation });
	try {
		const unlisten = await listen<TPayload>(event, ({ payload }) =>
			handler(payload),
		);
		// Unsubscribing is fire-and-forget by design: the caller is releasing
		// something, and there is nothing it could do about a failure to stop
		// listening except leak the handler it already stopped caring about.
		return Ok(() => {
			void Promise.resolve(unlisten()).catch(() => {});
		});
	} catch (rejection) {
		return classify(operation, rejection);
	}
}

/**
 * Fire a host command whose outcome nobody reads.
 *
 * Used only where the operation is defined to have no outcome. It swallows
 * every failure, including the absence of a host, so it can never produce an
 * unhandled rejection in a browser tab.
 *
 * @internal
 */
export function nudgeHost(command: string, args?: Record<string, unknown>) {
	if (!hostIsReachable()) return;
	try {
		void invoke(command, args).catch(() => {});
	} catch {
		// Nothing to report to: this call has no outcome by contract.
	}
}

function classify(
	operation: string,
	rejection: unknown,
): Err<HostError | HostRejection> {
	// Checked before the tagged-object test on purpose: an `Error` carries a
	// `name` too, and treating `TypeError` as a command's typed failure would be
	// exactly the "unknown bug becomes ordinary unavailability" mistake.
	if (rejection instanceof Error) return Err({ domain: rejection });
	if (typeof rejection === 'string') {
		return HostErrors.CapabilityUnavailable({ operation, cause: rejection });
	}
	return Err({ domain: rejection });
}

/**
 * Read a rejection as a tagged host failure, or `undefined` when it is not one.
 *
 * @internal
 */
export function taggedName(domain: unknown): string | undefined {
	if (typeof domain !== 'object' || domain === null) return undefined;
	const name = Reflect.get(domain, 'name');
	return typeof name === 'string' ? name : undefined;
}

/**
 * The human-readable half of a tagged host failure, for callers that quote it.
 *
 * @internal
 */
export function taggedMessage(domain: unknown): string {
	if (typeof domain !== 'object' || domain === null) return String(domain);
	const message = Reflect.get(domain, 'message');
	return typeof message === 'string' ? message : String(domain);
}
