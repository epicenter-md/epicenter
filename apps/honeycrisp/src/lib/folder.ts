/**
 * The `~/Epicenter/so.epicenter.honeycrisp/` working copy, bound to one store.
 *
 * Three verbs over the folder (ADR-0337), each one the library's with this
 * store bound in. That is all that is left of it: the verbs used to take the
 * declaration beside the data and compile it again on every call, and the
 * store carries its own compiled declaration now, along with its own address
 * (ADR-0340). What this still buys is the boundary: a component that offers a
 * person the button gets three functions rather than the store.
 *
 * They used to hang off the object the route's opener returned, beside the
 * data and the sync status. There is no route-owned opener any more
 * (ADR-0339), and these never belonged to it: they belong to the store's
 * address, which is why they stay functions over an opened store rather than
 * methods on the handle.
 */

import type {
	CheckoutError,
	FolderState,
	PushOutcome,
	PushPlan,
} from '@epicenter/data/artifact/checkout';
import { diff, pull, push } from '@epicenter/data/artifact/checkout';
import type { Result } from 'wellcrafted/result';
import type { HoneycrispData } from './data/index.js';

export type FolderVerbs = {
	/**
	 * Write every file in the folder from these notes (ADR-0341).
	 *
	 * `state` is what `diff` said and a person approved: a pull writes over
	 * everything in it, so confirming the list IS the discard, and one that
	 * stopped being true is refused rather than applied.
	 */
	pull(options: {
		state: FolderState;
	}): Promise<Result<{ files: number }, CheckoutError>>;
	/**
	 * What the folder holds that these notes do not, changing nothing.
	 *
	 * The one question both directions ask: a push applies this list, a pull
	 * writes over it.
	 */
	diff(): Promise<Result<FolderState, CheckoutError>>;
	/**
	 * Apply the folder's edits, then write back the files it touched.
	 *
	 * `plan` is what `diff` said and a person agreed to, and a push that finds
	 * it is no longer true refuses rather than applying an answer to a question
	 * that changed.
	 */
	push(options: {
		plan: PushPlan;
	}): Promise<Result<PushOutcome, CheckoutError>>;
};

export function folderVerbs(data: HoneycrispData): FolderVerbs {
	return {
		pull: ({ state }) => pull({ data, state }),
		diff: () => diff({ data }),
		push: ({ plan }) => push({ data, plan }),
	};
}
