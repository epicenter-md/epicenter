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
 * credentials and owns no application data (ADR-0226, ADR-0227). What the
 * desktop leaf adds is an admission round trip before this call, not a
 * different store after it.
 */

import {
	createGeneration,
	newestGeneration,
	openDatabase,
} from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import type { LocalData } from '@epicenter/data';
import { Ok, type Result } from 'wellcrafted/result';
import { AppError } from './index.js';

/**
 * Open the newest generation of this definition's store, minting one when this
 * machine has never held it.
 *
 * **This opens a LOCAL document, which never receives a foreign byte.** The
 * account registry an application keeps here is therefore device-local: it does
 * not reach an authority and does not appear on a person's other devices.
 * ADR-0310 describes a registry that synchronizes while its credentials do not,
 * and that half is unbuilt. Making it true means opening the account overload
 * of `openDatabase`, which needs the signed-in principal the host brokers, and
 * that is a decision about which authority an application's own data belongs to
 * rather than a change to this function.
 */
export async function openClientOwnedData<TDefinition extends DataDefinition>(
	definition: TDefinition,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const generation = await newestGeneration(definition.id);
	if (generation === undefined) {
		const created = await createGeneration(definition);
		if (created.error !== null) {
			return AppError.StorageFailed({ cause: created.error });
		}
		return openGeneration(definition, created.data.generation);
	}
	return openGeneration(definition, generation);
}

async function openGeneration<TDefinition extends DataDefinition>(
	definition: TDefinition,
	generation: number,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const opened = await openDatabase(definition, { generation });
	return opened.error === null
		? Ok(opened.data)
		: AppError.StorageFailed({ cause: opened.error });
}
