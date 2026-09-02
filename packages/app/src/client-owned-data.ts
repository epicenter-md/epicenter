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
	createGeneration,
	type DatabaseAccount,
	newestGeneration,
	openDatabase,
} from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import { Ok, type Result } from 'wellcrafted/result';
import { AppError } from './index.js';

/**
 * Open the newest generation of this definition's store, minting one when this
 * machine has never held it.
 *
 * The store is a replica of `account`, because an authority mints every
 * generation. The application supplies the account, since it is what knows
 * which principal it is acting as.
 */
export async function openClientOwnedData<TDefinition extends DataDefinition>(
	definition: TDefinition,
	account: DatabaseAccount,
): Promise<Result<ReplicaData<TDefinition>, AppError>> {
	const generation = await newestGeneration(definition.id, account);
	if (generation === undefined) {
		const created = await createGeneration(definition, { account });
		if (created.error !== null) {
			return AppError.StorageFailed({ cause: created.error });
		}
		return openGeneration(definition, created.data.generation, account);
	}
	return openGeneration(definition, generation, account);
}

async function openGeneration<TDefinition extends DataDefinition>(
	definition: TDefinition,
	generation: number,
	account: DatabaseAccount,
): Promise<Result<ReplicaData<TDefinition>, AppError>> {
	const opened = await openDatabase(definition, { generation, account });
	return opened.error === null
		? Ok(opened.data)
		: AppError.StorageFailed({ cause: opened.error });
}
