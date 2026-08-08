/**
 * The queryable half of an app's folder: one real database beside its markdown.
 *
 * ADR-0208. `epicenter.sqlite3` is one generic fact relation of JSON shared by
 * every app, so asking it a question means `json_extract` across a union. That
 * is a storage format, not a query surface. This writes the query surface out:
 * `~/Epicenter/<namespace>/<app>.sqlite3`, one real table per Lens table, one
 * column per declared field, so an agent with `sqlite3` and a path can ask.
 *
 * The SQL is not invented here. `lensTableExtractionSql` is the same expression
 * `inspection.ts` mounts as a view for Home, imported rather than rewritten,
 * because two spellings of one extraction drift and ADR-0162 owns the shape.
 *
 * The replica is attached with `mode=ro`, so a write against it fails in the
 * engine rather than in review. Everything here reads it and writes only the
 * projection.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lensTableExtractionSql } from '@epicenter/data/legacy/inspection';
import type { Lens, RowAddress, TableDefinition } from '@epicenter/lens';

/** The alias the replica is attached under. Never `main`, which is the output. */
const REPLICA_SCHEMA = 'replica';

/**
 * How long a read waits for the owner's commit before giving up.
 *
 * The same budget `inspection.ts` uses, and for the same reason: the replica
 * runs an ordinary rollback journal, so a reader only blocks for the brief
 * exclusive moment of a commit.
 */
const BUSY_TIMEOUT_MS = 2_000;

/** Quote one identifier for SQL. Doubling is SQLite's own escape. */
function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Where one namespace's database lives: `<root>/<namespace>/<app>.sqlite3`.
 *
 * The file name is the namespace's last label, and it is decoration in exactly
 * the sense ADR-0207 means: the directory carries the binding name, nothing
 * reads the file name back, and changing it is a rebuild rather than a
 * migration. A namespace is two or more dot-separated `[a-z0-9-]` labels, so
 * the last one is always a safe, non-empty file name.
 */
export function projectionPathFor(root: string, namespace: string): string {
	const app = namespace.slice(namespace.lastIndexOf('.') + 1);
	return join(root, namespace, `${app}.sqlite3`);
}

type TableProjection = {
	/** Bring one row to what the replica says, present or absent. */
	write(rowId: string): void;
};

type NamespaceProjection = {
	database: Database;
	tables: Map<string, TableProjection>;
};

export type FolderProjections = {
	/** Bring one row up to date. A table nothing declares is not ours. */
	apply(address: RowAddress): void;
	close(): void;
};

function openProjection({
	root,
	replicaPath,
	lens,
}: {
	root: string;
	replicaPath: string;
	lens: Lens<Record<string, TableDefinition>>;
}): NamespaceProjection {
	const path = projectionPathFor(root, lens.namespace);
	mkdirSync(dirname(path), { recursive: true });

	// Rebuilt from empty at every boot rather than opened, migrated, or repaired.
	// That is what makes "read-only" true without a filesystem mode nobody can
	// enforce: a stray write to a file the design says nobody may write survives
	// exactly until the next launch. The journal siblings go too, so a crashed
	// previous process cannot leave a hot journal to roll into a fresh file.
	for (const suffix of ['', '-journal', '-wal', '-shm']) {
		rmSync(`${path}${suffix}`, { force: true });
	}

	const database = new Database(path, { create: true });
	try {
		database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		// A URI filename is the only spelling that carries `mode=ro`, and passing
		// it as a parameter keeps a home directory holding a quote from becoming
		// SQL. `pathToFileURL` does the percent-encoding a bare path would not.
		database.run(`ATTACH DATABASE ? AS ${quoteIdentifier(REPLICA_SCHEMA)}`, [
			`${pathToFileURL(replicaPath).href}?mode=ro`,
		]);

		const tables = new Map<string, TableProjection>();
		for (const [tableName, definition] of Object.entries(lens.tables)) {
			const extraction = lensTableExtractionSql({
				schema: REPLICA_SCHEMA,
				namespace: lens.namespace,
				tableName,
				fieldNames: Object.keys(definition.fields),
			});
			const quoted = quoteIdentifier(tableName);

			// A real table, not a view over the attached replica: an agent has a
			// path and `sqlite3`, not a connection to configure first (ADR-0208).
			database.run(`CREATE TABLE ${quoted} AS ${extraction}`);
			// A table name must start with a letter, so a leading underscore here
			// can never collide with another projected table.
			database.run(
				`CREATE INDEX ${quoteIdentifier(`_${tableName}_id`)} ON ${quoted}("id")`,
			);

			const remove = database.prepare<unknown, [string]>(
				`DELETE FROM ${quoted} WHERE "id" = ?`,
			);
			// Filtering the extraction rather than re-deriving it row-wise. SQLite
			// flattens the subquery into a primary-key lookup on the fact relation,
			// and there stays exactly one spelling of a Lens table's columns.
			const insert = database.prepare<unknown, [string]>(
				`INSERT INTO ${quoted} SELECT * FROM (${extraction}) WHERE "id" = ?`,
			);
			// Delete then insert, in one transaction. The extraction selects present
			// rows only, so the insert contributes nothing for a row that went
			// absent and the delete is what removes it; the transaction is what
			// stops a reader from seeing the gap between them.
			const write = database.transaction((rowId: string) => {
				remove.run(rowId);
				insert.run(rowId);
			});
			tables.set(tableName, { write });
		}
		return { database, tables };
	} catch (cause) {
		database.close();
		throw cause;
	}
}

/**
 * Open one database per Lens, each rebuilt from the replica as it stands.
 *
 * One Lens is one namespace is one file. Two Lenses sharing a namespace would
 * be two apps claiming one folder, which nothing in the address space allows.
 */
export function openFolderProjections({
	root,
	replicaPath,
	lenses,
}: {
	root: string;
	replicaPath: string;
	lenses: readonly Lens<Record<string, TableDefinition>>[];
}): FolderProjections {
	const byNamespace = new Map<string, NamespaceProjection>();
	const close = () => {
		for (const projection of byNamespace.values()) projection.database.close();
		byNamespace.clear();
	};

	try {
		for (const lens of lenses) {
			byNamespace.set(
				lens.namespace,
				openProjection({ root, replicaPath, lens }),
			);
		}
	} catch (cause) {
		// A half-open set would answer for some apps and not others, with nothing
		// on disk saying which.
		close();
		throw cause;
	}

	return {
		apply(address) {
			byNamespace
				.get(address.namespace)
				?.tables.get(address.tableName)
				?.write(address.rowId);
		},
		close,
	};
}

/**
 * Keep every projection current for as long as this runs.
 *
 * The same invalidation stream the renderer reads, subscribed separately: the
 * markdown and the database are two views of one row and neither waits on the
 * other.
 *
 * Failing to project never takes the host down, and that includes failing to
 * open. The projection is a query surface over rows the replica already holds,
 * so losing it costs a convenience; refusing to boot over it would cost the
 * applications. A caller that wants the failure calls `openFolderProjections`
 * directly, which is what the tests do.
 */
export function startFolderProjector({
	root,
	replicaPath,
	lenses,
	subscribe,
	onError = () => undefined,
}: {
	root: string;
	replicaPath: string;
	lenses: readonly Lens<Record<string, TableDefinition>>[];
	subscribe(listener: (addresses: readonly RowAddress[]) => void): () => void;
	onError?: (cause: unknown) => void;
}): () => void {
	let projections: FolderProjections;
	try {
		projections = openFolderProjections({ root, replicaPath, lenses });
	} catch (cause) {
		onError(cause);
		return () => undefined;
	}

	const unsubscribe = subscribe((addresses) => {
		try {
			for (const address of addresses) projections.apply(address);
		} catch (cause) {
			onError(cause);
		}
	});
	return () => {
		unsubscribe();
		projections.close();
	};
}
