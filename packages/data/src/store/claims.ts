/**
 * Which durable documents this process currently holds open.
 *
 * Two opens of one document would be two `Y.Doc`s of it that cannot see each
 * other's writes, converging through storage under last-writer-wins: work
 * disappears, converged, with no error and nothing to retry. Refusing the
 * second open makes that unreachable rather than something a caller must avoid,
 * which is the move ADR-0216 made against the chosen-id door.
 *
 * The key is the durable document's own address, which is what makes the guard
 * exact. On Bun that is the databaseId, because an application folder holds one
 * document; in a browser it is the ownership path
 * `epicenter/<databaseId>/device` or
 * `epicenter/<databaseId>/account/<base URL>/<principal id>` (ADR-0261), so an
 * application's device document and one account's replica may be
 * open at once, two accounts' replicas may be open at once, and a second open
 * of any one of them is still refused.
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

const openAddresses = new Set<string>();

/** Claim a durable document for this process, or report that it is already held. */
export function claimDocument(address: string): Result<void, StoreError> {
	if (openAddresses.has(address)) {
		return StoreError.AlreadyOpen({ address });
	}
	openAddresses.add(address);
	return Ok(undefined);
}

/** Release an address. Idempotent, because disposal is. */
export function releaseDocument(address: string): void {
	openAddresses.delete(address);
}
