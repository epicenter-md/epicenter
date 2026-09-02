/// <reference lib="dom" />

/**
 * Opening a person's Epicenter Data, in every runtime.
 *
 * Its own module because both leaves use it, and neither owns it. It lived in
 * `browser.ts` while that was the only caller, which left the desktop leaf
 * importing an opener from a file named for the other runtime: a reader would
 * fairly conclude the desktop build falls back to the browser one, and it does
 * not. There is one opener because there is one answer.
 *
 * **The store is client-owned everywhere.** The host serves bundles and brokers
 * credentials and owns no application data (ADR-0226, ADR-0227). The desktop
 * leaf adds nothing before this call and nothing after it: a deployed app is a
 * trusted app (ADR-0334), so both leaves reach the same store the same way.
 */

import type { ReplicaData } from '@epicenter/data';
import {
	type DatabaseAccount,
	openDatabase,
	resolveGeneration,
} from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import { Ok, type Result } from 'wellcrafted/result';
import { AppError } from './index.js';

/**
 * Open the newest generation of this definition's store, minting one when the
 * account has never held it.
 *
 * The store is a replica of `account`, because an authority mints every
 * generation. The application supplies the account, since it is what knows
 * which principal it is acting as.
 *
 * `appId` is the OPENING application's, which is not the data id: it is the
 * segment of the address that keeps two applications naming one data id on
 * their own replicas (ADR-0324, ADR-0304). It comes from the handle rather than
 * from a caller, which is what the handle is for, and nothing verifies it: a
 * deployed app is a trusted app (ADR-0334).
 *
 * Two calls, and the first one is not "read the cache". `resolveGeneration`
 * asks the account which generations exist when this device holds none, so a
 * second device joins the notebook the first one made instead of minting a
 * rival. This used to create one whenever the local cache was empty, which
 * forked one account's notes into two histories on the second machine that
 * opened them.
 */
export async function openClientOwnedData<TDefinition extends DataDefinition>(
	appId: string,
	definition: TDefinition,
	account: DatabaseAccount,
): Promise<Result<ReplicaData<TDefinition>, AppError>> {
	const resolved = await resolveGeneration(definition, { appId, account });
	if (resolved.error !== null) {
		return AppError.StorageFailed({ cause: resolved.error });
	}
	const opened = await openDatabase(definition, {
		appId,
		generation: resolved.data.generation,
		account,
	});
	return opened.error === null
		? Ok(opened.data)
		: AppError.StorageFailed({ cause: opened.error });
}
