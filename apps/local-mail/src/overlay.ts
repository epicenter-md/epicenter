/**
 * Gmail's facts with this device's undelivered opinions applied.
 *
 * The mirror holds what Gmail last said. `intent.db` holds what the user did
 * that Gmail has not been told about yet (ADR-0198). Every read surface needs
 * the two combined, and this module is the whole of that combination.
 *
 * It is deliberately plain data with no database in it. That is the point: the
 * two files used to be combined by attaching one to the other and joining
 * across them in SQL, which bought a correct page and cost a cross-database
 * `ATTACH`, a URI-escaped read-only filename, and a temp view redefined on
 * every open. The intent set is tiny by construction (a partial map over only
 * the messages the user touched, emptied as Gmail confirms them), so carrying
 * it in memory and handing SQL the few ids it needs is both smaller and more
 * honest about who owns what.
 *
 * The division of labour, which is the reason this type has the shape it does:
 *
 * - SQL decides WHICH rows come back, because filtering, ordering and
 *   `LIMIT`/`OFFSET` have to agree, and an overlay applied after paging could
 *   only ever remove rows from a page. It could never add the message the user
 *   just moved INTO the label being viewed. `addedTo` and `removedFrom` are
 *   what SQL needs to get that right, and they go in as bound parameters.
 * - JS decides WHAT each returned row says, because that is per-row decoration
 *   with no bearing on the page. `effectiveLabels` is that.
 */

import type { LabelIntent } from './intent.ts';

export type LabelOverlay = {
	/** Whether any opinion is outstanding at all. */
	readonly isEmpty: boolean;
	/**
	 * Message ids asserted INTO this label and not yet delivered. A row here may
	 * not carry the label in the mirror at all, which is exactly why a filter
	 * cannot be applied after paging.
	 */
	addedTo(labelId: string): string[];
	/** Message ids asserted OUT of this label and not yet delivered. */
	removedFrom(labelId: string): string[];
	/**
	 * One message's effective label set: the mirrored labels, minus the ones
	 * asserted off, plus the ones asserted on.
	 *
	 * Mirrored order first and additions appended, matching what the SQL view
	 * this replaces produced, so no caller sees its label chips reorder.
	 */
	effectiveLabels(messageId: string, mirrored: readonly string[]): string[];
};

/** An empty overlay: every read degenerates to Gmail's facts. */
const EMPTY: LabelOverlay = {
	isEmpty: true,
	addedTo: () => [],
	removedFrom: () => [],
	effectiveLabels: (_messageId, mirrored) => [...mirrored],
};

/**
 * Index one account's undelivered assertions for reading.
 *
 * Built once per query rather than consulted per row: the input is already in
 * memory and small, and three lookups against maps beat re-scanning it for
 * every message on the page.
 */
export function overlayOf(intents: readonly LabelIntent[]): LabelOverlay {
	if (intents.length === 0) return EMPTY;

	/** labelId -> message ids that asserted it on, and off. */
	const added = new Map<string, string[]>();
	const removed = new Map<string, string[]>();
	/** messageId -> labelId -> wanted. */
	const byMessage = new Map<string, Map<string, boolean>>();

	for (const intent of intents) {
		const side = intent.want ? added : removed;
		const ids = side.get(intent.labelId);
		if (ids) ids.push(intent.messageId);
		else side.set(intent.labelId, [intent.messageId]);

		let labels = byMessage.get(intent.messageId);
		if (!labels) {
			labels = new Map();
			byMessage.set(intent.messageId, labels);
		}
		labels.set(intent.labelId, intent.want);
	}

	return {
		isEmpty: false,
		addedTo: (labelId) => added.get(labelId) ?? [],
		removedFrom: (labelId) => removed.get(labelId) ?? [],
		effectiveLabels(messageId, mirrored) {
			const opinions = byMessage.get(messageId);
			if (!opinions) return [...mirrored];
			const effective = mirrored.filter(
				(labelId) => opinions.get(labelId) !== false,
			);
			for (const [labelId, want] of opinions) {
				if (want && !effective.includes(labelId)) effective.push(labelId);
			}
			return effective;
		},
	};
}
