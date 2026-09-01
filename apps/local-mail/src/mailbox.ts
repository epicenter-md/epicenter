/**
 * One account's disposable mail cache, which is one file.
 *
 * No statement here names an account, because the file is the scope
 * (ADR-0319). A second connected account is a second file with a second
 * handle, so a query cannot reach it, and clearing this one is unlinking a
 * file rather than deleting rows out of a shared one. The handle is
 * asynchronous and has no transaction callback (ADR-0312), so anything that
 * has to be all-or-nothing is one `batch`.
 *
 * **The effective-label overlay is a parameter, not a view.** The previous
 * design attached the durable intent store to the mirror connection and defined
 * a SQL view across the two. Two databases opened through one scoped handle
 * cannot be attached to each other, and that turns out to be the better shape:
 * undelivered intent is small by construction (a row leaves as soon as Gmail
 * confirms it), so a read loads the account's pending assertions and hands the
 * query two explicit id lists. Filtering, ordering, and paging stay pushed down
 * and stay post-overlay, which is what makes an archived message leave the
 * inbox page immediately and the page still come back full.
 */

import type { AppSqliteDatabase } from '@epicenter/app';
import { type Statement, sqliteHandle } from './handle.ts';
import type { LabelIntent } from './intent-store.ts';
import {
	bodyHtml,
	bodyText,
	hasExternalizedBody,
	headerValue,
} from './message-fields.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

export type CacheState = {
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row of the triage list. `labelIds` is the EFFECTIVE set: Gmail's facts
 * with this machine's undelivered triage applied, so the list shows what a
 * person did rather than what Gmail has heard about.
 */
export type MessageSummary = {
	id: string;
	threadId: string | null;
	subject: string | null;
	sender: string | null;
	snippet: string | null;
	internalDate: number | null;
	labelIds: string[];
};

export type MessageDetail = MessageSummary & {
	to: string | null;
	date: string | null;
	bodyText: string | null;
	/**
	 * The `text/html` part, derived at read time and never stored, unsanitized on
	 * purpose. The name carries the warning: the only caller that may render it
	 * is the sanitizer boundary in the UI.
	 */
	unsafeBodyHtml: string | null;
	/**
	 * Gmail put this body behind an `attachmentId` rather than inline, and one
	 * `messages.get` is the entire per-message budget (ADR-0196). The row is
	 * fully synchronized; only the body is elsewhere.
	 */
	bodyExternalized: boolean;
};

export type LabelSummary = {
	id: string;
	name: string | null;
	type: string | null;
};

/** What a read applies on top of Gmail's facts, for one account. */
export type LabelOverlay = {
	/** `messageId` -> labels this machine wants on it. */
	wanted: Map<string, Set<string>>;
	/** `messageId` -> labels this machine wants off it. */
	unwanted: Map<string, Set<string>>;
};

export const EMPTY_OVERLAY: LabelOverlay = {
	wanted: new Map(),
	unwanted: new Map(),
};

export function overlayOf(intents: readonly LabelIntent[]): LabelOverlay {
	const overlay: LabelOverlay = { wanted: new Map(), unwanted: new Map() };
	for (const intent of intents) {
		const side = intent.want ? overlay.wanted : overlay.unwanted;
		const labels = side.get(intent.messageId) ?? new Set<string>();
		labels.add(intent.labelId);
		side.set(intent.messageId, labels);
	}
	return overlay;
}

/** The effective label set of one mirrored row under `overlay`. */
export function effectiveLabels(
	messageId: string,
	mirrored: readonly string[],
	overlay: LabelOverlay,
): string[] {
	const unwanted = overlay.unwanted.get(messageId);
	const labels = new Set(
		unwanted === undefined
			? mirrored
			: mirrored.filter((label) => !unwanted.has(label)),
	);
	for (const label of overlay.wanted.get(messageId) ?? []) labels.add(label);
	return [...labels];
}

export type Mailbox = ReturnType<typeof openMailbox>;

export function openMailbox(mail: AppSqliteDatabase) {
	const { all, run, batch } = sqliteHandle(mail);

	function upsertMessageStatement(message: GmailMessage, syncedAt: string) {
		return {
			sql: `INSERT INTO messages (id, resource, subject, sender, body_text, synced_at)
			      VALUES (?, ?, ?, ?, ?, ?)
			      ON CONFLICT(id) DO UPDATE SET
			        resource = excluded.resource,
			        subject = excluded.subject,
			        sender = excluded.sender,
			        body_text = excluded.body_text,
			        synced_at = excluded.synced_at`,
			parameters: [
				message.id,
				JSON.stringify(message),
				headerValue(message, 'Subject'),
				headerValue(message, 'From'),
				bodyText(message),
				syncedAt,
			] as const,
		};
	}

	/**
	 * Fold a new label set into one stored row, as a statement plus a verdict.
	 *
	 * Returned rather than executed, because its two callers commit differently:
	 * a fold after a delivery is one write on its own, and a history batch folds
	 * several inside the batch that also advances the cursor. The read has to
	 * happen outside either, since the handle has no transaction callback to read
	 * within (ADR-0312); a row that moves between the read and the write
	 * converges on the next pass, which is already how a missed patch behaves.
	 */
	async function foldLabels(
		messageId: string,
		labelIds: readonly string[],
		syncedAt: string,
	): Promise<{ statement: Statement; changed: boolean } | undefined> {
		const [row] = await all<{ resource: string }>(
			`SELECT resource FROM messages WHERE id = ?`,
			[messageId],
		);
		if (row === undefined) return undefined;
		const parsed = JSON.parse(row.resource) as GmailMessage & {
			labelIds?: string[];
		};
		const previous = Array.isArray(parsed.labelIds) ? parsed.labelIds : [];
		return {
			statement: {
				sql: `UPDATE messages SET resource = ?, synced_at = ?
				      WHERE id = ?`,
				parameters: [
					JSON.stringify({ ...parsed, labelIds: [...labelIds] }),
					syncedAt,
					messageId,
				],
			},
			changed: !sameLabelSet(previous, labelIds),
		};
	}

	function setMetaStatement(key: string, value: string) {
		return {
			sql: `INSERT INTO cache_meta (key, value) VALUES (?, ?)
			      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			parameters: [key, value] as const,
		};
	}

	/**
	 * `messages.id` carries `label` effectively, as SQL.
	 *
	 * Two arms, because that is what the overlay means: a row whose mirrored
	 * labels include it and whose intent does not remove it, or a row whose
	 * intent adds it. An absent arm is omitted rather than bound to an empty
	 * list, because `id NOT IN (NULL)` is unknown rather than true, and an
	 * unknown under a `NOT` silently empties the page.
	 */
	function hasEffectiveLabel(
		label: string,
		overlay: LabelOverlay,
	): { sql: string; parameters: (string | number | null)[] } {
		const added = idsAsserting(overlay.wanted, label);
		const removed = idsAsserting(overlay.unwanted, label);
		const parameters: (string | number | null)[] = [label];
		let mirrored = `EXISTS (SELECT 1 FROM json_each(messages.label_ids) l WHERE l.value = ?)`;
		if (removed.length > 0) {
			mirrored += ` AND messages.id NOT IN (${removed.map(() => '?').join(', ')})`;
			parameters.push(...removed);
		}
		if (added.length === 0) return { sql: `(${mirrored})`, parameters };
		parameters.push(...added);
		return {
			sql: `((${mirrored}) OR messages.id IN (${added.map(() => '?').join(', ')}))`,
			parameters,
		};
	}

	function idsAsserting(
		side: Map<string, Set<string>>,
		label: string,
	): string[] {
		const ids: string[] = [];
		for (const [messageId, labels] of side) {
			if (labels.has(label)) ids.push(messageId);
		}
		return ids;
	}

	function toSummary(
		row: {
			id: string;
			thread_id: string | null;
			subject: string | null;
			sender: string | null;
			snippet: string | null;
			internal_date: number | null;
			label_ids: string | null;
		},
		overlay: LabelOverlay,
	): MessageSummary {
		return {
			id: row.id,
			threadId: row.thread_id,
			subject: row.subject,
			sender: row.sender,
			snippet: row.snippet,
			internalDate: row.internal_date,
			labelIds: effectiveLabels(row.id, parseLabelIds(row.label_ids), overlay),
		};
	}

	return {
		async readCacheState(): Promise<CacheState> {
			const rows = await all<{ key: string; value: string | null }>(
				`SELECT key, value FROM cache_meta`,
			);
			const meta = new Map(rows.map((row) => [row.key, row.value]));
			return {
				historyId: meta.get('history_id') ?? null,
				lastFullPullAt: meta.get('last_full_pull_at') ?? null,
				lastSyncedAt: meta.get('last_synced_at') ?? null,
			};
		},

		async counts(): Promise<{ messages: number; labels: number }> {
			const [messages, labels] = await Promise.all([
				all<{ n: number }>(`SELECT count(*) AS n FROM messages`),
				all<{ n: number }>(`SELECT count(*) AS n FROM labels`),
			]);
			return { messages: messages[0]?.n ?? 0, labels: labels[0]?.n ?? 0 };
		},

		async hasMessage(id: string): Promise<boolean> {
			const rows = await all(`SELECT 1 AS present FROM messages WHERE id = ?`, [
				id,
			]);
			return rows.length > 0;
		},

		async findLabelByIdOrExactName(
			label: string,
		): Promise<{ id: string; name: string | null } | null> {
			const rows = await all<{ id: string; name: string | null }>(
				`SELECT id, name FROM labels
				 WHERE id = ? OR name = ?
				 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
				 LIMIT 1`,
				[label, label, label],
			);
			return rows[0] ?? null;
		},

		/**
		 * One page of the triage list, newest first.
		 *
		 * Gmail's own rule for Trash is reproduced here rather than in a caller:
		 * a trashed message is hidden from every view except Trash itself. It is
		 * folded rather than deleted, so this filter is what makes it leave the
		 * current view, and asserting `TRASH` makes it leave before Gmail has even
		 * been told, because the assertion is part of the effective set.
		 */
		async listMessages({
			labelId,
			search,
			limit,
			offset,
			overlay = EMPTY_OVERLAY,
		}: {
			labelId?: string;
			search?: string;
			limit: number;
			offset: number;
			overlay?: LabelOverlay;
		}): Promise<MessageSummary[]> {
			const where: string[] = [];
			const parameters: (string | number | null)[] = [];
			if (labelId !== undefined) {
				const carries = hasEffectiveLabel(labelId, overlay);
				where.push(carries.sql);
				parameters.push(...carries.parameters);
			}
			if (labelId !== 'TRASH') {
				const trashed = hasEffectiveLabel('TRASH', overlay);
				where.push(`NOT ${trashed.sql}`);
				parameters.push(...trashed.parameters);
			}
			if (search !== undefined && search !== '') {
				where.push(`(subject LIKE ? OR sender LIKE ? OR body_text LIKE ?)`);
				const pattern = `%${search}%`;
				parameters.push(pattern, pattern, pattern);
			}
			parameters.push(limit, offset);
			const rows = await all<{
				id: string;
				thread_id: string | null;
				subject: string | null;
				sender: string | null;
				snippet: string | null;
				internal_date: number | null;
				label_ids: string | null;
			}>(
				`SELECT id, thread_id, subject, sender, snippet, internal_date, label_ids
				 FROM messages${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
				 ORDER BY internal_date DESC
				 LIMIT ? OFFSET ?`,
				parameters,
			);
			return rows.map((row) => toSummary(row, overlay));
		},

		async getMessageDetail(
			id: string,
			overlay: LabelOverlay = EMPTY_OVERLAY,
		): Promise<MessageDetail | null> {
			const rows = await all<{
				id: string;
				thread_id: string | null;
				subject: string | null;
				sender: string | null;
				snippet: string | null;
				internal_date: number | null;
				label_ids: string | null;
				body_text: string | null;
				resource: string;
			}>(
				`SELECT id, thread_id, subject, sender, snippet, internal_date,
				        label_ids, body_text, resource
				 FROM messages WHERE id = ?`,
				[id],
			);
			const row = rows[0];
			if (row === undefined) return null;
			const summary = toSummary(row, overlay);
			// Derived at read time from the stored resource, never stored: an HTML
			// body column would only mirror `body_text` for symmetry's sake. A
			// corrupt resource yields nulls rather than throwing.
			try {
				const message = JSON.parse(row.resource) as GmailMessage;
				return {
					...summary,
					to: headerValue(message, 'To'),
					date: headerValue(message, 'Date'),
					bodyText: row.body_text,
					unsafeBodyHtml: bodyHtml(message),
					bodyExternalized: hasExternalizedBody(message),
				};
			} catch {
				return {
					...summary,
					to: null,
					date: null,
					bodyText: row.body_text,
					unsafeBodyHtml: null,
					bodyExternalized: false,
				};
			}
		},

		async listLabels(): Promise<LabelSummary[]> {
			return all(
				`SELECT id, name, type FROM labels
				 ORDER BY type, name`,
			);
		},

		/**
		 * One page of a full backfill: upsert every message, no cursor advance.
		 * One `batch` per page, so a crash mid-backfill loses the in-flight page
		 * rather than the whole pull.
		 */
		async ingestFullPullPage(
			messages: readonly GmailMessage[],
			syncedAt: string,
		): Promise<void> {
			await batch(
				messages.map((message) => upsertMessageStatement(message, syncedAt)),
			);
		},

		/** Replace the label set, which `labels.list` returns complete every call. */
		async ingestLabels(
			labels: readonly GmailLabel[],
			syncedAt: string,
		): Promise<void> {
			await batch([
				{
					sql: `DELETE FROM labels`,
				},
				...labels.map((label) => ({
					sql: `INSERT INTO labels (id, resource, synced_at)
					      VALUES (?, ?, ?)
					      ON CONFLICT(id) DO UPDATE SET
					        resource = excluded.resource,
					        synced_at = excluded.synced_at`,
					parameters: [label.id, JSON.stringify(label), syncedAt] as const,
				})),
			]);
		},

		/**
		 * Close out a full pull: sweep what this pass did not touch and record the
		 * `historyId` baseline read BEFORE page one, so changes made during the
		 * pull replay idempotently instead of disappearing behind a later cursor.
		 */
		async finishFullPull(historyId: string, syncedAt: string): Promise<number> {
			const changes = await batch([
				{
					sql: `DELETE FROM messages WHERE synced_at < ?`,
					parameters: [syncedAt],
				},
				setMetaStatement('history_id', historyId),
				setMetaStatement('last_full_pull_at', syncedAt),
				setMetaStatement('last_synced_at', syncedAt),
			]);
			return changes[0] ?? 0;
		},

		/**
		 * Fold Gmail's authoritative post-mutation labels into one mirrored row.
		 *
		 * Reports whether the row was there at all, and whether its label set
		 * changed materially. A fold is not a sync pass, so it touches no cursor
		 * and no staleness timestamp.
		 */
		async patchMessageLabels(
			messageId: string,
			labelIds: readonly string[],
			syncedAt: string,
		): Promise<{ found: boolean; changed: boolean }> {
			const fold = await foldLabels(messageId, labelIds, syncedAt);
			if (fold === undefined) return { found: false, changed: false };
			await run(fold.statement.sql, fold.statement.parameters);
			return { found: true, changed: fold.changed };
		},

		/**
		 * Apply one `history.list` batch and advance the cursor together, so a
		 * crash rolls back to the prior `historyId` and the next pass re-pulls the
		 * window, which is idempotent either way.
		 *
		 * The label patches are read first, outside the batch, because a patch
		 * needs the row it is patching and the handle has no transaction callback
		 * to read inside. A row that moved between the read and the write converges
		 * on the next pass, which is already how a missed patch behaves.
		 */
		async applyHistoryBatch({
			messagesToUpsert,
			messagesToDelete,
			labelPatches,
			newHistoryId,
			syncedAt,
		}: {
			messagesToUpsert: readonly GmailMessage[];
			messagesToDelete: readonly string[];
			labelPatches: readonly { messageId: string; labelIds: string[] }[];
			newHistoryId: string;
			syncedAt: string;
		}): Promise<{ labelsChanged: number }> {
			const folds: { statement: Statement; changed: boolean }[] = [];
			for (const patch of labelPatches) {
				const fold = await foldLabels(
					patch.messageId,
					patch.labelIds,
					syncedAt,
				);
				if (fold !== undefined) folds.push(fold);
			}

			await batch([
				...messagesToUpsert.map((message) =>
					upsertMessageStatement(message, syncedAt),
				),
				...messagesToDelete.map((id) => ({
					sql: `DELETE FROM messages WHERE id = ?`,
					parameters: [id] as const,
				})),
				...folds.map((fold) => fold.statement),
				setMetaStatement('history_id', newHistoryId),
				setMetaStatement('last_synced_at', syncedAt),
			]);
			return { labelsChanged: folds.filter((fold) => fold.changed).length };
		},
	};
}

/** Label sets are unordered: Gmail may echo the same labels in another order. */
function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const present = new Set(a);
	return b.every((id) => present.has(id));
}

function parseLabelIds(json: string | null): string[] {
	if (json === null || json === '') return [];
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: [];
	} catch {
		return [];
	}
}
