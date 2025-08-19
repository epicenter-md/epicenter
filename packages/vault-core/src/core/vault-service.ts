import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { CompatibleDB } from './adapter';
import type { Codec, ConventionProfile } from './codec';
import { detectPrimaryKey, listColumns, listTables } from './codec';
import type { VaultServiceConfig } from './config';
import type { FileStore } from './fs';
import type { Importer } from './importer';
import {
	applySqlPlan,
	dropAdapterTables,
	getCurrentDbMigrationTag,
	listSqlSteps,
	planToVersion,
	readMigrationJournal,
	resolveMigrationsDir,
} from './migrations';
import type { SyncEngine } from './sync';

export class VaultService<
	TDatabase extends CompatibleDB,
	TImporters extends Importer[],
> {
	readonly importers: TImporters;
	readonly db: TDatabase;
	readonly migrateFunc: (
		db: TDatabase,
		config: MigrationConfig,
	) => Promise<void>;
	readonly syncEngine?: SyncEngine;
	readonly codec?: Codec<string, string>;
	readonly conventions?: ConventionProfile;

	constructor(config: VaultServiceConfig<TDatabase, TImporters>) {
		this.importers = config.importers;
		this.db = config.database;
		this.migrateFunc = config.migrateFunc;
		this.syncEngine = config.syncEngine;
		this.codec = config.codec;
		this.conventions = config.conventions;
	}

	static async create<
		TDatabase extends CompatibleDB,
		TImporters extends Importer[],
	>(config: VaultServiceConfig<TDatabase, TImporters>) {
		const svc = new VaultService(config);
		await svc.migrate();
		return svc;
	}

	/**
	 * Run migrations for installed importers.
	 */
	private async migrate() {
		for (const importer of this.importers) {
			await this.migrateFunc(this.db, {
				migrationsFolder: importer.drizzleConfig.out ?? '',
				migrationsSchema: importer.drizzleConfig.migrations?.schema ?? '',
				migrationsTable: importer.drizzleConfig.migrations?.table ?? '',
			});
		}
	}

	/**
	 * Parse a blob with a specific importer and upsert into the database.
	 * Returns the parsed payload for auditing if needed.
	 */
	async importBlob(blob: Blob, importerId: string) {
		const importer = this.importers.find((i) => i.id === importerId);
		if (!importer) throw new Error(`Importer not found: ${importerId}`);

		const parsed = await importer.parse(blob);
		const valid = importer.validator.assert(parsed);
		await importer.upsert(this.db, valid);
		return { importer: importer.name, parsed };
	}

	/**
	 * Export DB state using the injected SyncEngine and codec.
	 */
	async export(importerId: string, store: FileStore) {
		const importer = this.importers.find((i) => i.id === importerId);
		if (!importer) throw new Error(`Importer not found: ${importerId}`);
		if (!this.codec || !this.conventions)
			throw new Error('No formats/conventions configured');
		const { codec: format, conventions } = this;
		const adapterId = importer.id;
		// Support both shapes: importer.adapter.schema (new) and importer.schema (legacy)
		const schema: Record<string, SQLiteTable> =
			((
				importer as unknown as { adapter?: { schema: Record<string, unknown> } }
			)?.adapter?.schema as Record<string, SQLiteTable>) ??
			(importer as unknown as { schema?: Record<string, SQLiteTable> })
				.schema ??
			({} as Record<string, SQLiteTable>);
		const files: Record<string, string> = {};

		for (const [tableName, table] of listTables(schema)) {
			// Query all rows
			const rows: Record<string, unknown>[] = await (
				this.db as unknown as {
					select: () => {
						from: (t: unknown) => Promise<Record<string, unknown>[]>;
					};
				}
			)
				.select()
				.from(table);

			const pkCols = detectPrimaryKey(tableName, table) ?? [];

			for (const row of rows) {
				// Build a flat record deterministically for the codec
				const rec: Record<string, unknown> = {};
				const tableCols = new Set(
					listColumns(table).map(([name]: [string, unknown]) => name),
				);
				for (const [k, v] of Object.entries(row)) {
					if (!tableCols.has(k)) continue; // ignore non-column fields (if any)
					if (v === undefined || v === null) continue; // omit nulls -> undefined on re-import
					rec[k] = format.normalize ? format.normalize(v, k) : v;
				}

				// Compute path using PK values
				const pkValues: Record<string, unknown> = {};
				for (const pk of pkCols) pkValues[pk] = row[pk];
				const basePath = conventions.pathFor(adapterId, tableName, pkValues);
				const path = `${basePath}.${format.fileExtension}`;

				const text = format.stringify(rec);
				await store.write(path, text);
				files[path] = '';
			}
		}

		return { files, createdAt: new Date().toISOString() };
	}

	/**
	 * Import DB state from filesystem into DB using the injected SyncEngine and codec.
	 */
	async import(importerId: string, store: FileStore) {
		const importer = this.importers.find((i) => i.id === importerId);
		if (!importer) throw new Error(`Importer not found: ${importerId}`);
		if (!this.codec || !this.conventions)
			throw new Error('No formats/conventions configured');
		const { codec: configuredCodec, conventions } = this;
		const adapterId = importer.id;
		const schema: Record<string, SQLiteTable> =
			((
				importer as unknown as { adapter?: { schema: Record<string, unknown> } }
			)?.adapter?.schema as Record<string, SQLiteTable>) ??
			(importer as unknown as { schema?: Record<string, SQLiteTable> })
				.schema ??
			({} as Record<string, SQLiteTable>);

		// Collect rows per dataset key for a single upsert call
		const dataset: Record<string, unknown[]> = {};
		// Initialize all dataset keys to empty arrays to satisfy validators expecting present arrays
		for (const [tableName] of listTables(schema)) {
			const key = conventions.datasetKeyFor(adapterId, tableName);
			if (!dataset[key]) dataset[key] = [];
		}
		const prefix = `vault/${adapterId}/`;
		const paths = await store.list(prefix);

		for (const path of paths) {
			if (!path.startsWith(prefix)) continue;
			const rel = path.slice(prefix.length);
			const parts = rel.split('/');
			if (parts.length < 2) continue;
			const tableName =
				parts[0] as keyof typeof importer.adapter.schema as string;
			const file = parts.slice(1).join('/');
			const dot = file.lastIndexOf('.');
			if (dot < 0) continue;
			const fileId = file.slice(0, dot);
			const ext = file.slice(dot + 1);

			// Use configured codec; skip files with other extensions
			const format = configuredCodec;
			if (format.fileExtension !== ext) continue;

			const table = schema[tableName as keyof typeof schema] as SQLiteTable;
			if (!table) continue;

			const text = await store.read(path);
			if (text == null) continue;
			const rec = format.parse(text);
			const row: Record<string, unknown> = {};

			const tableCols = new Set(
				listColumns(table).map(([name]: [string, unknown]) => name),
			);
			for (const [k, v] of Object.entries(rec ?? {})) {
				if (!tableCols.has(k)) continue;
				row[k] = format.denormalize ? format.denormalize(v, k) : v;
			}

			// Ensure PK values exist; if missing in headers, try to reconstruct from filename
			const pkCols = detectPrimaryKey(tableName, table) ?? [];
			const fileParts = fileId.split('__');
			for (let i = 0; i < pkCols.length; i++) {
				const key = pkCols[i];
				if (row[key] === undefined) row[key] = fileParts[i];
			}

			const key = conventions.datasetKeyFor(adapterId, tableName);
			if (!dataset[key]) dataset[key] = [];
			(dataset[key] as unknown[]).push(row);
		}

		// Prepare and upsert (no ArkType validation here):
		// Normalize dataset values: convert null -> undefined and coerce numeric-like to strings
		for (const key of Object.keys(dataset)) {
			const rows = dataset[key] as Record<string, unknown>[];
			for (const row of rows) {
				for (const [k, v] of Object.entries(row)) {
					if (v === null) {
						row[k] = undefined;
						continue;
					}
					// Heuristic: fields commonly textual but sometimes numeric in exports
					if (
						typeof v === 'number' &&
						/(?:^|_)(?:id|name|slug|subreddit|channel|parent|media|value|image|url|stake|selection)(?:$|_)/.test(
							k,
						)
					) {
						row[k] = String(v);
					}
				}
			}
		}
		// ArkType validator is used only for first-ingest (blob imports), not for FS re-imports.
		// We rely on DB constraints/migrations and importer.upsert to handle shaping.
		await importer.upsert(this.db, dataset);
	}

	/**
	 * Prepare DB schema for vault import by migrating to a target version, import, then migrate to head.
	 * This does not run ArkType validation; it assumes the vault content is trusted.
	 */
	async migrateImportMigrate(
		importerId: string,
		store: FileStore,
		options: { targetTag: string },
	) {
		const importer = this.importers.find((i) => i.id === importerId);
		if (!importer) throw new Error(`Importer not found: ${importerId}`);
		// 1) Drop adapter tables (scoped)
		await dropAdapterTables(this.db, importer);
		// 2) Read journal + steps and compute plan to target
		const dir = resolveMigrationsDir(importer);
		const journal = await readMigrationJournal(dir);
		const steps = await listSqlSteps(dir);
		// TODO: Read current DB tag from drizzle migrations table
		const current = await getCurrentDbMigrationTag(this.db, importer);
		const plan = planToVersion(journal, steps, current, options.targetTag);
		// 3) Apply plan
		await applySqlPlan(this.db, importer, plan);
		// TODO: mark applied in drizzle migrations table
		// await markApplied(this.db, importer, options.targetTag);
		// 4) Import vault content without validation
		await this.import(importerId, store);
		// 5) Migrate to head using provided migrateFunc (drizzle’s migrator)
		await this.migrateFunc(this.db, {
			migrationsFolder: importer.drizzleConfig.out ?? '',
			migrationsSchema: importer.drizzleConfig.migrations?.schema ?? '',
			migrationsTable: importer.drizzleConfig.migrations?.table ?? '',
		});
	}
}
