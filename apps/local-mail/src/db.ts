import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { type DbFile, dbFileAt } from './db-file.ts';
import { intentDbPath, openIntentDb } from './intent.ts';
import {
	bodyHtml,
	bodyText,
	hasExternalizedBody,
	headerValue,
} from './message-fields.ts';
import { accountDir, ensureAccountDir, secureDbFiles } from './paths.ts';
import type { GmailLabel, GmailMessage } from './schema.ts';

/**
 * The local mirror: one SQLite artifact per connected Gmail account. Ports
 * `apps/local-books`' CDC-cursor and transaction discipline (see that file's
 * top comment) onto Gmail's `history.list` shape, which differs from
 * QuickBooks' `/cdc` in ways that shaped the design below:
 *
 * - Gmail's cursor is an opaque, increasing `historyId`, not a timestamp, so
 *   staleness is judged from our own `last_synced_at` wall-clock record, not
 *   from parsing the cursor itself (see `sync.ts`'s `decideMode`).
 * - `history.list`'s `labelsAdded`/`labelsRemoved` records carry a full
 *   current `labelIds` snapshot for a message that may already be mirrored,
 *   not a full object replacement. `patchMessageLabels` handles this as a
 *   targeted field patch, distinct from the generic upsert.
 * - Full backfill is paginated (`messages.list` + per-id `messages.get`), so
 *   it commits per page (`ingestFullPullPage`) rather than accumulating the
 *   whole mailbox in memory before one transaction; the cursor only advances
 *   once, in `finishFullPull`, after every page has committed.
 *
 * The account owns its identity through the directory (`<dataDir>/accounts/<email>/`),
 * not a stored column. Inside that directory the artifact is named by
 * `MIRROR_VERSION` (ADR-0197): nothing about the stored shape is stamped inside
 * the file, and nothing is ever dropped, unlinked, or migrated on open. A shape
 * change is a version bump, which is a different filename, and the predecessor
 * is retained until something reclaims it. Indexes are outside that promise and
 * applied idempotently on every open, so a query optimization costs no re-pull.
 */

export type RealmState = {
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row of the triage list, projected for the HTTP read surface. `labelIds`
 * is the parsed array (the `label_ids` column stores Gmail's JSON string); the
 * UI derives unread/inbox/label chips from it, so no state is invented here.
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

/** A single message opened in the detail pane: a summary, its `To`/`Date`
 * headers, and both body projections. `bodyText` is the stored searchable
 * plain text; `unsafeBodyHtml` is the `text/html` part derived from the stored
 * resource at read time (never stored, so no shape change), unsanitized on
 * purpose. The name carries the warning across the wire: the only caller that
 * may render it is the sanitizer boundary in the SPA, which runs DOMPurify
 * first. */
export type MessageDetail = MessageSummary & {
	to: string | null;
	date: string | null;
	bodyText: string | null;
	unsafeBodyHtml: string | null;
	/**
	 * True when this message has no offline body because Gmail externalized the
	 * body part: `format=full` returned an `attachmentId` where the bytes would
	 * be, and one `messages.get` is the entire per-message budget (ADR-0196), so
	 * they are never fetched. The row is fully synchronized; only the body is
	 * elsewhere. Derived at read time, so it costs no stored column.
	 */
	bodyExternalized: boolean;
};

/** A mirrored Gmail label, for the label-filter rail and the add/remove menu. */
export type LabelSummary = {
	id: string;
	name: string | null;
	type: string | null;
};

/** Label sets are unordered: Gmail may echo the same labels in a different
 * order, so a material change is a set difference, not an array inequality. */
function sameLabelSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const present = new Set(a);
	return b.every((id) => present.has(id));
}

function parseLabelIds(json: string | null): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed)
			? parsed.filter((v) => typeof v === 'string')
			: [];
	} catch {
		return [];
	}
}

export type MailDb = ReturnType<typeof openMailDb>;

/**
 * One column of a declared table: its SQLite name and affinity, an optional
 * trailing constraint, and, when SQLite computes the value itself, the
 * expression it computes it from. A generated column cannot disagree with the
 * stored resource, which is why every column that can be one is one.
 */
type ColumnDeclaration = {
	name: string;
	type: 'TEXT' | 'INTEGER';
	constraint: string | null;
	generated: { expression: string; storage: 'VIRTUAL' | 'STORED' } | null;
};

type TableDeclaration = { table: string; columns: ColumnDeclaration[] };

/** A column this app writes at ingest: an id, the resource, a timestamp, or one
 * of the three values SQL cannot reach (see `MIRROR_TABLES`). */
function stored(
	name: string,
	type: ColumnDeclaration['type'],
	constraint: string | null = null,
): ColumnDeclaration {
	return { name, type, constraint, generated: null };
}

/** A column SQLite projects from the stored resource. */
function projected(
	name: string,
	type: ColumnDeclaration['type'],
	expression: string,
	storage: 'VIRTUAL' | 'STORED',
): ColumnDeclaration {
	return { name, type, constraint: null, generated: { expression, storage } };
}

/**
 * The mirror's declared stored shape, as plain data, and the single source the
 * DDL below is generated from.
 *
 * Three tiers, per ADR-0196, and no fourth:
 *
 * 1. `resource`: the parsed `messages.get(format=full)` payload, verbatim. Not
 *    `raw`: `format=raw` is Gmail's own name for the base64url RFC 5322 blob
 *    this app never fetches, so a column named `raw` holding a parsed resource
 *    was a false statement in the schema. `labels.resource` follows the same
 *    word for the same reason (`labels.list` returns a Label resource); one
 *    mirror should not have two names for "verbatim provider JSON".
 * 2. Every column SQLite can project from it, as a generated column.
 * 3. Exactly the columns SQL cannot project that pushed-down search and sort
 *    need: `subject`, `sender`, `body_text`, and nothing else. `To`, `Date`, and
 *    the HTML body are derived at read time instead.
 *
 * The test for a proposed column is not "is it useful" but "can SQLite project
 * it, and if not, does a pushed-down filter or sort require it?" A column that
 * fails both belongs in a read-time derivation, and adding one is not free
 * either way: it is a `MIRROR_VERSION` bump, so it costs a full re-pull of the
 * mailbox at 20 quota units per message (ADR-0197).
 *
 * Indexes are deliberately absent: an index holds no mirror facts.
 */
const MIRROR_TABLES: TableDeclaration[] = [
	{
		table: '_meta',
		columns: [stored('key', 'TEXT', 'PRIMARY KEY'), stored('value', 'TEXT')],
	},
	{
		table: 'labels',
		columns: [
			stored('id', 'TEXT', 'PRIMARY KEY'),
			stored('resource', 'TEXT', 'NOT NULL'),
			projected('name', 'TEXT', `json_extract(resource, '$.name')`, 'VIRTUAL'),
			projected('type', 'TEXT', `json_extract(resource, '$.type')`, 'VIRTUAL'),
			stored('synced_at', 'TEXT', 'NOT NULL'),
		],
	},
	{
		table: 'messages',
		columns: [
			stored('id', 'TEXT', 'PRIMARY KEY'),
			stored('resource', 'TEXT', 'NOT NULL'),
			projected(
				'thread_id',
				'TEXT',
				`json_extract(resource, '$.threadId')`,
				'VIRTUAL',
			),
			projected(
				'snippet',
				'TEXT',
				`json_extract(resource, '$.snippet')`,
				'STORED',
			),
			projected(
				'label_ids',
				'TEXT',
				`json_extract(resource, '$.labelIds')`,
				'VIRTUAL',
			),
			projected(
				'internal_date',
				'INTEGER',
				`CAST(json_extract(resource, '$.internalDate') AS INTEGER)`,
				'STORED',
			),
			// The three columns SQL cannot project, written by this app at ingest.
			// What each one means is part of the corpus contract, so changing any of
			// these promises is a `MIRROR_VERSION` bump: `subject` is the `Subject`
			// header, `sender` is the `From` header, and `body_text` is the decoded
			// `text/plain` part, else tags stripped from `text/html`. Changing
			// `headerValue` or `bodyText` without bumping the version is the mistake
			// to look for in review.
			stored('subject', 'TEXT'),
			stored('sender', 'TEXT'),
			stored('body_text', 'TEXT'),
			stored('synced_at', 'TEXT', 'NOT NULL'),
		],
	},
];

/**
 * The version of the corpus contract this build stores, and the whole of the
 * artifact's identity on disk: `mail.v<MIRROR_VERSION>.db` (ADR-0197). It is not
 * the app's release version and it is not a migration target. Nothing reads a
 * lower version, and nothing rewrites one.
 *
 * The reader-mirror rewrite that renamed `raw` to `resource` is version `5`.
 *
 * Bump it when this build would store something a previous build did not: an
 * added, removed, or retyped column; a changed promise for what `subject`,
 * `sender`, or `body_text` holds; or a change to which messages a full pull
 * covers. Do not bump it for an index, a read-time derivation such as the HTML
 * body, a comment, or an app release. A bump costs a full re-pull of the mailbox
 * at 20 quota units per message, so it is not a free edit.
 */
const MIRROR_VERSION = 5;

/**
 * The database as materialized for one account:
 * `<dataDir>/accounts/<accountEmail>/`. Every surface that needs the file's
 * path or the list of versions beside it goes through here; nothing outside
 * this file names a database file.
 */
export function mailDbFile(dataDir: string, accountEmail: string): DbFile {
	return dbFileAt({
		version: MIRROR_VERSION,
		directory: accountDir(dataDir, accountEmail),
	});
}

/** `CREATE TABLE IF NOT EXISTS` for one declared table. Every identifier and
 * expression here is authored in this file and the set is closed, so the
 * declaration interpolates into DDL without further checking. */
function createTableSql({ table, columns }: TableDeclaration): string {
	const defs = columns.map((column) => {
		const constraint = column.constraint ? ` ${column.constraint}` : '';
		const generated = column.generated
			? ` GENERATED ALWAYS AS (${column.generated.expression}) ${column.generated.storage}`
			: '';
		return `${column.name} ${column.type}${constraint}${generated}`;
	});
	return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(', ')});`;
}

const CREATE_TABLES = MIRROR_TABLES.map(createTableSql).join('\n');

/**
 * Indexes, outside the corpus contract: they hold no mirror facts, so adding one
 * is a query optimization applied on every open, not a shape change that costs a
 * re-pull (ADR-0197).
 */
const CREATE_INDEXES = `
	CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);
	CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);
`;

type MailDbLocation = { dataDir: string; accountEmail: string };

/**
 * The effective-label view: Gmail's mirrored facts with the durable intent
 * overlay applied, one row per `(message, label)`. Every read model below and
 * every ad-hoc SQL query see the same definition, so "what the app shows" has
 * exactly one meaning (ADR-0198).
 *
 * The shape matters for more than tidiness. Written as a plain join of
 * `messages` against a per-message effective array, SQLite can push a
 * `message_id = ?` constraint from a correlated use straight into the messages
 * primary key. Written as a top-level `UNION ALL` of two branches it cannot, and
 * a filtered page over a large mirror goes from sub-millisecond to hundreds of
 * milliseconds. Keep the union inside the scalar subquery.
 *
 * `overlaid` is false only when there is no intent store to attach, which a
 * read-only opener must not create. The overlay arms simply drop out, which is
 * the honest reading of "nothing is asserted": effective labels are the mirrored
 * ones. It is the same definition with an empty overlay, not a second answer to
 * the same question.
 *
 * The view lives in TEMP, not in the artifact, because it names an attached
 * database: a connection that opened the mirror without `intent` attached must
 * not inherit a view it cannot resolve. TEMP also lets a read-only handle define
 * it, since the temp schema is writable either way. Nothing about this is stored,
 * so it is not a `MIRROR_VERSION` bump.
 */
function effectiveLabelsView(overlaid: boolean): string {
	return `
	CREATE TEMP VIEW IF NOT EXISTS effective_labels AS
		SELECT m.id AS message_id, j.value AS label_id
		  FROM messages m,
		       json_each((
		         SELECT json_group_array(value) FROM (
		           SELECT mirrored.value AS value
		             FROM json_each(m.label_ids) mirrored
		            ${
									overlaid
										? `WHERE NOT EXISTS (
		                  SELECT 1 FROM intent.label_intents i
		                   WHERE i.message_id = m.id AND i.label_id = mirrored.value)
		           UNION ALL
		           SELECT i.label_id
		             FROM intent.label_intents i
		            WHERE i.message_id = m.id AND i.want = 1`
										: ''
								}))) j`;
}

/** The effective label set of the row a query is currently on, as a JSON array
 * string. Correlated, so it is computed only for the rows a page returns. */
const EFFECTIVE_LABEL_IDS = `(
	SELECT json_group_array(e.label_id) FROM effective_labels e
	 WHERE e.message_id = messages.id)`;

/** Whether the row a query is currently on effectively carries `param`'s label.
 * Used for both the label filter and Gmail's trash rule, so the two can never
 * disagree about what "has this label" means. */
function hasEffectiveLabel(param: string): string {
	return `EXISTS (
		SELECT 1 FROM effective_labels e
		 WHERE e.message_id = messages.id AND e.label_id = ${param})`;
}

/**
 * The read-only URI form of a path, for `ATTACH`. SQLite treats an attachment
 * argument beginning with `file:` as a URI, and `?mode=ro` is what keeps a
 * writable mirror connection from becoming a second writer to the durable
 * store. Percent-escaping is not cosmetic here: an unescaped `?` or `#` in a
 * data-dir path would be read as the URI's query or fragment, and SQLite would
 * silently attach a DIFFERENT, empty database rather than fail.
 */
function readOnlyAttachUri(path: string): string {
	const escaped = encodeURI(path).replaceAll('?', '%3f').replaceAll('#', '%23');
	return `file:${escaped}?mode=ro`;
}

/**
 * Attach one account's durable intent store to a mirror connection and define
 * the effective-label view over it.
 *
 * `create` says whether this opener may bring the store into existence. A
 * writable mirror is opened by a path that is about to need it, so it prepares
 * both files. A read-only opener (`query`, `status`) must not: a question about
 * an account should not leave a durable file behind, so when there is no store
 * it attaches nothing and the view degenerates to the mirrored labels.
 *
 * Attaching read-only is the ownership statement, and it also decouples the two
 * files' locks: a writable attachment would be pulled into every
 * `BEGIN IMMEDIATE` on the mirror, so a full-pull page commit would block a
 * triage act mid-flight. `intent.ts` holds the only handle that may write here.
 */
function attachIntent(
	db: Database,
	{ dataDir, accountEmail }: MailDbLocation,
	{ create }: { create: boolean },
): void {
	const path = intentDbPath(dataDir, accountEmail);
	if (create) {
		// Opened and closed by its own owner first: attaching a missing file under
		// `mode=ro` fails outright, and an empty one has no table for the view.
		openIntentDb({ dataDir, accountEmail }).close();
	} else if (!existsSync(path)) {
		db.run(effectiveLabelsView(false));
		return;
	}
	db.run('ATTACH DATABASE ? AS intent', [readOnlyAttachUri(path)]);
	db.run(effectiveLabelsView(true));
}

/**
 * Open the current artifact for writing, creating it if absent. Opening is
 * non-destructive: there is no stored version to compare, nothing is unlinked,
 * and a `MIRROR_VERSION` bump simply means a different filename with an empty
 * successor to backfill. The DDL runs every open because `IF NOT EXISTS` is
 * idempotent against a file that already has the declared shape, which by
 * construction is the only shape this filename ever holds.
 */
export function openMailDb({ dataDir, accountEmail }: MailDbLocation) {
	// Resolve the file first: an account email that cannot name one path segment
	// must be refused before anything is created on disk.
	const file = mailDbFile(dataDir, accountEmail);
	ensureAccountDir(dataDir, accountEmail);
	const db = file.open();
	secureDbFiles(file.path);
	db.run(CREATE_TABLES);
	db.run(CREATE_INDEXES);
	// After the mirror's own DDL, so the view's reference to `messages` resolves.
	attachIntent(db, { dataDir, accountEmail }, { create: true });

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	const upsertMessageStmt = db.query(
		`INSERT INTO messages (id, resource, subject, sender, body_text, synced_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   resource = excluded.resource,
		   subject = excluded.subject,
		   sender = excluded.sender,
		   body_text = excluded.body_text,
		   synced_at = excluded.synced_at`,
	);
	const deleteMessageStmt = db.query(`DELETE FROM messages WHERE id = ?`);
	const sweepMessagesStmt = db.query(
		`DELETE FROM messages WHERE synced_at < ?`,
	);
	const getMessageResourceStmt = db.query<{ resource: string }, [string]>(
		`SELECT resource FROM messages WHERE id = ?`,
	);
	const hasMessageStmt = db.query<{ 1: number }, [string]>(
		`SELECT 1 FROM messages WHERE id = ?`,
	);
	const patchMessageLabelsStmt = db.query(
		`UPDATE messages SET resource = ?, synced_at = ? WHERE id = ?`,
	);
	const findLabelByIdOrExactNameStmt = db.query<
		{ id: string; name: string | null },
		[string, string, string]
	>(
		`SELECT id, name FROM labels
		 WHERE id = ? OR name = ?
		 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
		 LIMIT 1`,
	);
	const upsertLabelStmt = db.query(
		`INSERT INTO labels (id, resource, synced_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET resource = excluded.resource, synced_at = excluded.synced_at`,
	);
	const deleteLabelsStmt = db.query(`DELETE FROM labels`);
	const liveMessageCountStmt = db.query<{ n: number }, []>(
		`SELECT count(*) AS n FROM messages`,
	);
	const labelCountStmt = db.query<{ n: number }, []>(
		`SELECT count(*) AS n FROM labels`,
	);
	const recentMessagesStmt = db.query<
		{ subject: string | null; sender: string | null },
		[number]
	>(`SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT ?`);

	function readRealmState(): RealmState {
		return {
			historyId: getMetaStmt.get('history_id')?.value ?? null,
			lastFullPullAt: getMetaStmt.get('last_full_pull_at')?.value ?? null,
			lastSyncedAt: getMetaStmt.get('last_synced_at')?.value ?? null,
		};
	}

	function upsertMessage(message: GmailMessage, syncedAt: string): void {
		upsertMessageStmt.run(
			message.id,
			JSON.stringify(message),
			headerValue(message, 'Subject'),
			headerValue(message, 'From'),
			bodyText(message),
			syncedAt,
		);
	}

	/**
	 * Fold `labelIds` into one row's stored resource, reporting both whether the row was
	 * `found` (the reconciler's fold cares only about this) and whether the label
	 * set `changed` materially (the sync metric counts only these, so an
	 * idempotent history echo of labels already current does not read as drift).
	 * The write is unconditional either way: a no-op patch still refreshes
	 * `synced_at`, matching the prior behaviour.
	 */
	function patchMessageLabelsRow(
		messageId: string,
		labelIds: string[],
		syncedAt: string,
	): { found: boolean; changed: boolean } {
		const row = getMessageResourceStmt.get(messageId);
		if (!row) return { found: false, changed: false };
		const parsed = JSON.parse(row.resource);
		const prevLabelIds: string[] = Array.isArray(parsed.labelIds)
			? parsed.labelIds
			: [];
		const patched = { ...parsed, labelIds };
		patchMessageLabelsStmt.run(JSON.stringify(patched), syncedAt, messageId);
		return { found: true, changed: !sameLabelSet(prevLabelIds, labelIds) };
	}

	return {
		/**
		 * Escape hatch for tests and diagnostics only. Production reads go
		 * through the read models below or the readonly opener; the ad-hoc SQL
		 * product surface is the `query` verb, not this handle.
		 */
		raw: db,

		readRealmState,

		/** Whether a message row is mirrored; sync uses this to detect label patches aimed at unmirrored rows. */
		hasMessage(id: string): boolean {
			return hasMessageStmt.get(id) !== null;
		},

		/**
		 * Fold Gmail's authoritative post-mutation labels into one mirrored row.
		 * Returns false when the row is absent and does not touch `_meta`: a fold
		 * is not a sync pass and must not move staleness or history cursors.
		 */
		patchMessageLabels(
			messageId: string,
			labelIds: string[],
			syncedAt: string,
		) {
			const tx = db.transaction(
				() => patchMessageLabelsRow(messageId, labelIds, syncedAt).found,
			);
			return tx.immediate();
		},

		counts(): { messages: number; labels: number } {
			return {
				messages: liveMessageCountStmt.get()?.n ?? 0,
				labels: labelCountStmt.get()?.n ?? 0,
			};
		},

		findLabelByIdOrExactName(
			label: string,
		): { id: string; name: string | null } | null {
			return findLabelByIdOrExactNameStmt.get(label, label, label) ?? null;
		},

		/** Live messages, newest first, for post-pass reporting. */
		recentMessages(
			limit: number,
		): { subject: string | null; sender: string | null }[] {
			return recentMessagesStmt.all(limit);
		},

		/**
		 * The triage list read model. Newest first; an optional `labelId` filters
		 * to messages carrying that label EFFECTIVELY (Gmail's facts with the
		 * durable intent overlay applied), and an optional `search` matches
		 * subject/sender/body. Both are pushed into SQL so the process never
		 * materializes the whole mirror, and so filtering, ordering, and
		 * `LIMIT`/`OFFSET` are all computed post-overlay: a message the user just
		 * archived leaves the inbox page immediately, and the page still comes
		 * back full. Compiled per call (dynamic WHERE), which is fine at mirror
		 * scale and mirrors the `query` verb's discipline.
		 */
		listMessages({
			labelId,
			search,
			limit,
			offset,
		}: {
			labelId?: string;
			search?: string;
			limit: number;
			offset: number;
		}): MessageSummary[] {
			const where: string[] = [];
			const params: Record<string, string | number> = {
				$limit: limit,
				$offset: offset,
			};
			if (labelId) {
				where.push(hasEffectiveLabel('$labelId'));
				params.$labelId = labelId;
			}
			// Mirror Gmail's own rule: Trash is hidden from every view (Inbox, All
			// mail, any label) except Trash itself. A trashed row is folded, not
			// deleted, so this read-model filter is what makes it leave the current
			// view; asserting `TRASH` makes it leave before Gmail has even been
			// told, because the assertion is part of the effective label set.
			if (labelId !== 'TRASH') {
				where.push(`NOT ${hasEffectiveLabel(`'TRASH'`)}`);
			}
			if (search) {
				where.push(`(subject LIKE $q OR sender LIKE $q OR body_text LIKE $q)`);
				params.$q = `%${search}%`;
			}
			const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
			const rows = db
				.query<
					{
						id: string;
						thread_id: string | null;
						subject: string | null;
						sender: string | null;
						snippet: string | null;
						internal_date: number | null;
						label_ids: string | null;
					},
					Record<string, string | number>
				>(
					`SELECT id, thread_id, subject, sender, snippet, internal_date,
					        ${EFFECTIVE_LABEL_IDS} AS label_ids
					 FROM messages ${clause}
					 ORDER BY internal_date DESC
					 LIMIT $limit OFFSET $offset`,
				)
				.all(params);
			return rows.map((row) => ({
				id: row.id,
				threadId: row.thread_id,
				subject: row.subject,
				sender: row.sender,
				snippet: row.snippet,
				internalDate: row.internal_date,
				labelIds: parseLabelIds(row.label_ids),
			}));
		},

		/** One message with its extracted body, for the detail pane. */
		getMessageDetail(id: string): MessageDetail | null {
			const row = db
				.query<
					{
						id: string;
						thread_id: string | null;
						subject: string | null;
						sender: string | null;
						snippet: string | null;
						internal_date: number | null;
						label_ids: string | null;
						body_text: string | null;
						resource: string;
					},
					[string]
				>(
					`SELECT id, thread_id, subject, sender, snippet, internal_date,
					        ${EFFECTIVE_LABEL_IDS} AS label_ids, body_text, resource
					 FROM messages WHERE id = ?`,
				)
				.get(id);
			if (!row) return null;
			let to: string | null = null;
			let date: string | null = null;
			// Derived at read time from the stored resource, never stored: an HTML
			// body column would only mirror `body_text` for symmetry's sake and
			// rename the artifact. `bodyHtml` is defensive on its own, but the parse
			// shares this try so a corrupt resource yields nulls rather than throwing.
			let unsafeBodyHtml: string | null = null;
			// Likewise read-time: whether Gmail put the body behind an `attachmentId`
			// instead of inline `data`. The reader says so rather than spending a
			// second call per message to fetch it (ADR-0196).
			let bodyExternalized = false;
			try {
				const message = JSON.parse(row.resource) as GmailMessage;
				to = headerValue(message, 'To');
				date = headerValue(message, 'Date');
				unsafeBodyHtml = bodyHtml(message);
				bodyExternalized = hasExternalizedBody(message);
			} catch {
				// Fall back to nulls; the summary fields already carry the essentials.
			}
			return {
				id: row.id,
				threadId: row.thread_id,
				subject: row.subject,
				sender: row.sender,
				snippet: row.snippet,
				internalDate: row.internal_date,
				labelIds: parseLabelIds(row.label_ids),
				to,
				date,
				bodyText: row.body_text,
				unsafeBodyHtml,
				bodyExternalized,
			};
		},

		/** Every mirrored label, for the filter rail and the add/remove menu. */
		listLabels(): LabelSummary[] {
			return db
				.query<{ id: string; name: string | null; type: string | null }, []>(
					`SELECT id, name, type FROM labels ORDER BY type, name`,
				)
				.all();
		},

		/**
		 * One page of a full backfill: upsert every message, no cursor advance.
		 * Called once per `messages.list` page so a
		 * crash mid-backfill loses only the in-flight page, not the whole pull.
		 */
		ingestFullPullPage(messages: GmailMessage[], syncedAt: string): void {
			const tx = db.transaction(() => {
				for (const message of messages) upsertMessage(message, syncedAt);
			});
			tx.immediate();
		},

		/** Replace the label set (small, returned complete by `labels.list` every call). */
		ingestLabels(labels: GmailLabel[], syncedAt: string): void {
			const tx = db.transaction(() => {
				deleteLabelsStmt.run();
				for (const label of labels) {
					upsertLabelStmt.run(label.id, JSON.stringify(label), syncedAt);
				}
			});
			tx.immediate();
		},

		/**
		 * Closes out a FULL pull: records the `historyId` baseline read before
		 * page 1, so changes during the pull replay idempotently instead of
		 * disappearing behind a post-pull cursor.
		 */
		finishFullPull(historyId: string, syncedAt: string): number {
			const tx = db.transaction(() => {
				const swept = sweepMessagesStmt.run(syncedAt).changes;
				setMetaStmt.run('history_id', historyId);
				setMetaStmt.run('last_full_pull_at', syncedAt);
				setMetaStmt.run('last_synced_at', syncedAt);
				return swept;
			});
			return tx.immediate();
		},

		/**
		 * Applies one `history.list` batch and advances the cursor, all in one
		 * transaction (whole-batch atomic, same as local-books' `ingest`): a
		 * crash rolls back to the prior `historyId` and the next pass re-pulls
		 * the window, which is idempotent (upserts and physical deletes both are).
		 *
		 * `labelPatches` carries each affected message's CURRENT full `labelIds`
		 * snapshot (that's what `labelsAdded`/`labelsRemoved` records give us),
		 * so it patches the existing row's stored `labelIds` in place rather than
		 * replacing the row; a patch for a message not yet mirrored is silently
		 * skipped, but only as a residual guard: sync pre-resolves patches
		 * aimed at unmirrored rows into full refetches (`hasMessage`), so a
		 * miss here means the message changed mid-pass and the next pass
		 * converges.
		 *
		 * Returns `labelsChanged`: how many label patches materially changed a
		 * row's label set. A patch whose labels already match (a history echo of
		 * a change the reconciler already folded) is applied but not
		 * counted, so the sync metric reports convergence, not phantom drift.
		 */
		applyHistoryBatch({
			messagesToUpsert,
			messagesToDelete,
			labelPatches,
			newHistoryId,
			syncedAt,
		}: {
			messagesToUpsert: GmailMessage[];
			messagesToDelete: string[];
			labelPatches: { messageId: string; labelIds: string[] }[];
			newHistoryId: string;
			syncedAt: string;
		}): { labelsChanged: number } {
			const tx = db.transaction(() => {
				let labelsChanged = 0;
				for (const message of messagesToUpsert)
					upsertMessage(message, syncedAt);
				for (const id of messagesToDelete) deleteMessageStmt.run(id);
				for (const { messageId, labelIds } of labelPatches) {
					if (patchMessageLabelsRow(messageId, labelIds, syncedAt).changed) {
						labelsChanged += 1;
					}
				}
				setMetaStmt.run('history_id', newHistoryId);
				setMetaStmt.run('last_synced_at', syncedAt);
				return { labelsChanged };
			});
			return tx.immediate();
		},

		close(): void {
			db.close();
		},
	};
}

/**
 * The read-only view of the current artifact, for surfaces that must never
 * write and must never conjure a file (`status`, `query`). Returns `null` when
 * the current artifact does not exist, which is the honest answer to "is there a
 * mirror to read": the caller reports it rather than creating one, and a
 * predecessor is never opened here (the moment `MIRROR_VERSION` moved past it,
 * it stopped being authoritative and reading it would be a compatibility layer;
 * `mailDbFile(...).versions()` is where a deliberate inspector gets its path).
 *
 * The filename is the shape guarantee, so there is no stored version to check.
 * Reads still compile at call time and tolerate absent tables, because a
 * writable open that died between creating the file and running its DDL leaves
 * a current artifact with nothing in it; that reports as empty, not as a crash.
 * The handle rejects writes at the SQLite level, and `busy_timeout` keeps reads
 * from failing against a lock a concurrent reconcile briefly holds.
 *
 * The intent overlay is attached here too, so `local-mail query` and the MCP
 * `query` tool see the same `effective_labels` the app's read models do. SQLite
 * refuses writes through an attachment on a read-only connection, so the ad-hoc
 * SQL surface can read the durable store without becoming a second writer to it,
 * and an account with no intent store gets no file created for having been
 * asked about.
 */
export function openMailDbReadonly({ dataDir, accountEmail }: MailDbLocation) {
	const db = mailDbFile(dataDir, accountEmail).openReadonly();
	if (db === null) return null;
	attachIntent(db, { dataDir, accountEmail }, { create: false });

	const hasTable = (name: string): boolean =>
		db
			.query<{ 1: number }, [string]>(
				`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(name) !== null;

	const meta = (key: string): string | null =>
		hasTable('_meta')
			? (db
					.query<{ value: string | null }, [string]>(
						`SELECT value FROM _meta WHERE key = ?`,
					)
					.get(key)?.value ?? null)
			: null;

	const countRows = (table: 'messages' | 'labels'): number =>
		hasTable(table)
			? (db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
					?.n ?? 0)
			: 0;

	return {
		/** The ad-hoc SQL surface (the `query` verb and tests). */
		raw: db,

		realmState(): RealmState {
			return {
				historyId: meta('history_id'),
				lastFullPullAt: meta('last_full_pull_at'),
				lastSyncedAt: meta('last_synced_at'),
			};
		},

		counts(): { messages: number; labels: number } {
			return { messages: countRows('messages'), labels: countRows('labels') };
		},

		close(): void {
			db.close();
		},
	};
}
