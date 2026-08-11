/**
 * Which durable documents this process currently holds open.
 *
 * Two opens of one document would be two `Y.Doc`s of it that cannot see each
 * other's writes, converging through storage under last-writer-wins: work
 * disappears, converged, with no error and nothing to retry. Refusing the
 * second open makes that unreachable rather than something a caller must avoid,
 * which is the move ADR-0216 made against the chosen-id door.
 *
 * The key is the durable document's identity, which is what makes the guard
 * exact. On Bun that is the namespace, because an application folder holds one
 * document; in a browser it is `<namespace>#<document role>` (ADR-0233), so an
 * application's private and workspace documents may be open at once while a
 * second open of either is still refused.
 *
 * A lifecycle here is legitimate under ADR-0203 rather than a platform forming:
 * one file and one document with two claimants is genuinely contended. It holds
 * strings rather than handles, it is process-local, and disposing a store
 * releases its entry.
 *
 * It lives beside the openers rather than inside one because both of them need
 * it and neither owns it.
 */
import { Ok, type Result } from 'wellcrafted/result';

import { StoreError } from './store.js';

const openNamespaces = new Set<string>();

/** Claim a durable document for this process, or report that it is already held. */
export function claimNamespace(namespace: string): Result<void, StoreError> {
	if (openNamespaces.has(namespace)) {
		return StoreError.AlreadyOpen({ namespace });
	}
	openNamespaces.add(namespace);
	return Ok(undefined);
}

/** Release a namespace. Idempotent, because disposal is. */
export function releaseNamespace(namespace: string): void {
	openNamespaces.delete(namespace);
}
