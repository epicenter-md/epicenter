import type { Adapter, UniqueAdapters } from './adapter';
import {
	defaultConvention,
	listColumns,
	listPrimaryKeys,
	listTables,
} from './codec';
import type {
	AdapterIDs,
	AdapterTableMap,
	CoreOptions,
	ExportOptions,
	ImportOptions,
	IngestOptions,
	Vault,
} from './config';
import type { CompatibleDB } from './db';
import { runImportPipeline } from './import/importPipeline';
import {
	createMigrationMetadataFile,
	MIGRATION_META_DIR,
} from './import/migrationMetadata';
import { runStartupSqlMigrations } from './migrations';

/** Minimal Drizzle-DB type expected by core. Hosts pass a concrete Drizzle instance. */
export type DrizzleDb = CompatibleDB<unknown>;

/**
 * Construct a Vault bound to a Drizzle DB. No IO; pure orchestration.
 */
export function createVault<TAdapters extends readonly Adapter[]>(
	options: CoreOptions<TAdapters>,
): Vault<TAdapters> {
	const db = options.database;

	// Ensure migrations have been applied before we touch adapter tables.
	async function ensureMigrationsUpToDate(adapter: Adapter) {
		const versions = adapter.versions;
		if (!versions || versions.length === 0) return;
		await runStartupSqlMigrations(adapter.id, versions, db);
	}

	// Standard Schema validation runner
	async function runValidation(
		adapter: Adapter,
		value: unknown,
	): Promise<unknown> {
		const { validator } = adapter;
		if (!validator)
			throw new Error(
				`validation required: adapter '${adapter.id}' has no validator`,
			);

		const result = await validator['~standard'].validate(value);
		if (result.issues)
			throw new Error(
				`importData: validation failed for adapter '${adapter.id}': ${result.issues
					.map((i) => `${i.path ?? ''} ${i.message ?? ''}`.trim())
					.join('; ')}`,
			);
		return (result as unknown as { value?: unknown }).value ?? value;
	}

	/**
	 * Ensure no duplicate adapter IDs at runtime (covers non-literal arrays)
	 * @throws if duplicate IDs found
	 */
	function ensureNoDuplicateAdapterIds(
		adapters: UniqueAdapters<readonly Adapter[]>,
	) {
		const seen = new Set<string>();
		for (const a of adapters) {
			if (seen.has(a.id))
				throw new Error(
					`createVault: duplicate adapter ID found at runtime: '${a.id}'`,
				);
			seen.add(a.id);
		}
	}

	/**
	 * Drop all rows from a table by name, then insert all provided rows.
	 * @throws if table not found in adapter schema
	 */
	async function replaceAdapterTables(
		adapter: Adapter,
		dataset: Record<string, unknown[]>,
	) {
		const { schema } = adapter;
		for (const [tableName, rows] of Object.entries(dataset)) {
			const table = schema[tableName as keyof typeof schema];
			if (!table)
				throw new Error(
					`replaceAdapterTables: unknown table ${tableName} for adapter '${adapter.id}'`,
				);

			await db.delete(table);
			for (const row of rows) {
				await db.insert(table).values([row]);
			}
		}
	}

	return {
		async exportData(opts: ExportOptions<TAdapters>) {
			const {
				adapterIDs,
				codec,
				conventions: conv = defaultConvention(),
			} = opts;
			const adapters =
				adapterIDs === undefined
					? options.adapters
					: options.adapters.filter((a) => adapterIDs.includes(a.id));

			ensureNoDuplicateAdapterIds(adapters);

			const files = new Map<string, File>();

			// Iterate over each adapter
			for (const adapter of adapters) {
				await ensureMigrationsUpToDate(adapter);
				const { schema } = adapter;
				const adapterId = adapter.id;

				// Iterate over each table in the adapter's schema
				for (const [tableName, table] of listTables(schema)) {
					// Select for all rows from the table
					const rows = await db.select().from(table);

					const pkCols = listPrimaryKeys(tableName, table);
					const tableCols = new Set(listColumns(table).map(([name]) => name));

					for (const row of rows) {
						// Build a flat record deterministically for the codec
						const rec: Record<string, unknown> = {};
						for (const [k, v] of Object.entries(row)) {
							if (!tableCols.has(k)) continue;
							if (v === undefined || v === null) continue;
							rec[k] = codec.normalize ? codec.normalize(v, k) : v;
						}

						// Compute path using PK values
						const pkValues = pkCols.map(([name]) => row[name]);
						const basePath = conv.pathFor(adapterId, tableName, pkValues);

						const path = `${basePath}.${codec.fileExtension}`;
						const filename = path.split('/').pop();
						if (!filename) throw new Error('invalid filename');
						const text = codec.stringify(rec);
						const file = new File([text], filename, {
							type: codec.mimeType,
						});

						files.set(path, file);
					}
				}
				const { path: metaPath, file: metaFile } =
					await createMigrationMetadataFile(adapter, db);
				files.set(metaPath, metaFile);
			}

			return files;
		},
		async importData(opts: ImportOptions<TAdapters>) {
			const { adapterID, files, codec } = opts;
			const adapter = options.adapters.find((a) => a.id === adapterID);
			if (!adapter)
				throw new Error(`importData: unknown adapter ID '${adapterID}'`);

			await ensureMigrationsUpToDate(adapter);

			const { schema, id: adapterId } = adapter;
			// Build one huge object with all data, run validator, then upsert in one call

			// Collect rows per dataset key for a single upsert call
			const dataset: Record<string, unknown[]> = {};
			let detectedTag: string | undefined;

			for (const [path, input] of files) {
				const text = await input.text();

				const parts = path.split('/').filter((segment) => segment.length > 0);
				const metaIndex = parts.indexOf(MIGRATION_META_DIR);
				// TODO clean this up
				if (metaIndex !== -1) {
					try {
						const parsed = codec.parse(text) as { tag?: string };
						if (typeof parsed?.tag === 'string') detectedTag = parsed.tag;
					} catch {
						// ignore malformed metadata
					}
					continue;
				}

				if (parts.length < 2) continue; // No nested paths supported

				const tableName = parts[0];

				// Check that file extension matches codec
				const file = parts.slice(1).join('/');
				const dot = file.indexOf('.');
				if (dot < 0)
					throw new Error(`importData: file ${path} has no extension`);
				const ext = file.slice(dot + 1);
				if (ext !== codec.fileExtension)
					throw new Error(
						`importData: file ${path} has wrong extension (expected ${codec.fileExtension})`,
					);

				// Find matching table in schema
				const table = schema[tableName as keyof typeof schema];
				if (!table) throw new Error(`importData: unknown table ${tableName}`);

				// Parse file text into a record
				const rec = codec.parse(text);
				const row: Record<string, unknown> = {};
				const tableCols = new Set(listColumns(table).map(([name]) => name));
				for (const [k, v] of Object.entries(rec ?? {})) {
					if (!tableCols.has(k)) continue;
					row[k] = codec.denormalize ? codec.denormalize(v, k) : v;
				}

				const key = tableName.slice(adapterId.length + 1);

				// Initialize bucket if needed
				dataset[key] ??= [];

				const bucket = dataset[key];
				bucket.push(row);
			}

			const pipelineOutput = await runImportPipeline({
				adapter,
				dataset,
				transformsOverride: opts.transforms,
				versionsOverride: opts.versions,
				dataValidator: undefined,
				sourceTag: opts.sourceTag,
				detectedTag,
			});

			const schemaValidator = opts.dataValidator;
			if (!schemaValidator)
				throw new Error(
					`importData: dataValidator (drizzle-arktype) is required for adapter '${adapter.id}'`,
				);

			const validatedDataset = await schemaValidator(pipelineOutput);
			await replaceAdapterTables(
				adapter,
				validatedDataset as Record<string, unknown[]>,
			);
		},
		async ingestData(opts: IngestOptions) {
			const adapter = opts.adapter;
			const file = opts.file;

			ensureNoDuplicateAdapterIds([adapter]);
			await ensureMigrationsUpToDate(adapter);

			if (!adapter.ingestors || adapter.ingestors.length === 0)
				throw new Error(
					`ingestData: adapter '${adapter.id}' has no ingestors configured`,
				);

			const ingestor = adapter.ingestors.find((i) => {
				try {
					return i.matches(file);
				} catch {
					return false;
				}
			});
			if (!ingestor)
				throw new Error(
					`ingestData: no ingestor matched file '${file.name}' for adapter '${adapter.id}'`,
				);

			const dataset = await ingestor.parse(file);

			// Run validation and use morphed value
			const validated = await runValidation(adapter, dataset);
			await replaceAdapterTables(
				adapter,
				validated as Record<string, unknown[]>,
			);
		},
		getQueryInterface() {
			// Populate a map of adapter ID -> table name -> table object
			const tables = {} as AdapterTableMap<TAdapters>;
			for (const adapter of options.adapters) {
				tables[adapter.id as AdapterIDs<TAdapters>] = adapter.schema;
			}
			return {
				db,
				tables,
			};
		},
	};
}
