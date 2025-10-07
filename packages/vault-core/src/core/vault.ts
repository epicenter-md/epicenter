import { createSelectSchema } from 'drizzle-arktype';
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

	// Early validation: enforce adapter transform keys exactly match required version tags
	ensureNoDuplicateAdapterIds(options.adapters);

	// Ensure migrations have been applied before we touch adapter tables.
	async function ensureMigrationsUpToDate(adapter: Adapter, _ctx: string) {
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
		if (result.issues) {
			throw new Error(
				`importData: validation failed for adapter '${adapter.id}': ${result.issues
					.map((i) => i.message.trim())
					.join('; ')}`,
			);
		}
		return 'value' in result ? result.value : value;
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
	 * Build a drizzle-arktype based dataset validator for a given adapter's schema.
	 * Validates the de-prefixed dataset shape: { [unprefixedTable]: Row[] }.
	 * Throws with aggregated messages on any row failure and returns morphed rows when available.
	 */
	async function createDrizzleArkTypeValidator(adapter: Adapter) {
		// Precompute per-table select schemas indexed by unprefixed table key
		const schemas = new Map<string, ReturnType<typeof createSelectSchema>>();
		for (const [tableName, table] of listTables(adapter.schema)) {
			// Expect tableName like "<adapterId>_<unprefixed>"; strip "<adapterId>_"
			const unprefixed = tableName.startsWith(`${adapter.id}_`)
				? tableName.slice(adapter.id.length + 1)
				: tableName;
			const t = createSelectSchema(table);
			schemas.set(unprefixed, t);
		}

		return async (value: unknown) => {
			const ds = (value ?? {}) as Record<string, unknown[]>;
			const issues: string[] = [];
			const out: Record<string, unknown[]> = {};

			for (const [key, rows] of Object.entries(ds)) {
				const typeForTable = schemas.get(key);
				if (!typeForTable) {
					issues.push(
						`unknown table '${key}' for adapter '${adapter.id}' (no schema found)`,
					);
					continue;
				}
				const validator = typeForTable['~standard'];
				if (!Array.isArray(rows)) {
					issues.push(`table '${key}' expected an array`);
					continue;
				}
				const nextRows: unknown[] = [];
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					const res = await validator.validate(row);
					if (res.issues) {
						const msgs = res.issues
							.map((m: { message: string }) => m.message.trim())
							.join('; ');
						issues.push(`${key}[${i}]: ${msgs}`);
					} else {
						const v = res.value ?? row;
						nextRows.push(v);
					}
				}
				out[key] = nextRows;
			}

			if (issues.length) {
				throw new Error(
					`importData: drizzle-arktype validation failed for adapter '${adapter.id}': ${issues.join('; ')}`,
				);
			}
			return out;
		};
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
			// Try direct lookup first (for prefixed keys like 'test_items')
			let table = schema[tableName as keyof typeof schema];

			// If not found, try adding adapter prefix (for unprefixed keys like 'items')
			if (!table) {
				const prefixedName = `${adapter.id}_${tableName}`;
				table = schema[prefixedName as keyof typeof schema];
			}

			// If still not found, throw with helpful error
			if (!table) {
				const prefixedName = `${adapter.id}_${tableName}`;
				throw new Error(
					`replaceAdapterTables: unknown table '${tableName}' for adapter '${adapter.id}'. Tried '${tableName}' and '${prefixedName}'`,
				);
			}

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
				await ensureMigrationsUpToDate(adapter, 'exportData');
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
							rec[k] = v;
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
		async importData(opts: ImportOptions) {
			const { files, codec } = opts;

			// Group files by detected adapter id and collect per-adapter detected tags from metadata
			type Group = { files: Array<[string, File]>; detectedTag?: string };
			const groups = new Map<string, Group>();

			const knownAdapterIds = new Set(options.adapters.map((a) => a.id));

			for (const [path, input] of files) {
				const parts = path.split('/').filter((segment) => segment.length > 0);

				// Locate any known adapter id segment in the path
				const adapterIndex = parts.findIndex((p) => knownAdapterIds.has(p));
				if (adapterIndex === -1) continue; // can't determine adapter; skip

				const adapterIdFromPath = parts[adapterIndex];
				if (!adapterIdFromPath)
					throw new Error('unable to determine adapter ID from path');

				// Migration metadata handling; associate detected tag with this adapter group
				if (parts.includes(MIGRATION_META_DIR)) {
					try {
						const text = await input.text();
						const parsed = codec.parse(text);
						if (typeof parsed.tag === 'string') {
							const group = groups.get(adapterIdFromPath) ?? { files: [] };
							group.detectedTag = parsed.tag;
							groups.set(adapterIdFromPath, group);
						}
					} catch {
						// ignore malformed metadata
					}
					continue;
				}

				const group = groups.get(adapterIdFromPath) ?? { files: [] };
				group.files.push([path, input]);
				groups.set(adapterIdFromPath, group);
			}

			// Process each adapter group independently
			for (const [adapterId, group] of groups) {
				const adapter = options.adapters.find((a) => a.id === adapterId);
				if (!adapter) continue; // unknown adapter in bundle; skip

				await ensureMigrationsUpToDate(adapter, 'importData');

				const { schema } = adapter;
				const dataset: Record<string, unknown[]> = {};

				for (const [path, input] of group.files) {
					const parts = path.split('/').filter((segment) => segment.length > 0);

					// Recompute indices for this path
					const aIdx = parts.indexOf(adapterId);
					if (aIdx === -1) continue;
					const pathParts = parts.slice(aIdx);
					if (pathParts.length < 2) continue; // Need adapter/table structure

					const tableName = pathParts[1];
					if (!tableName)
						throw new Error(
							'importData: unable to determine table name from path',
						);

					// Extension check against codec
					const dot = path.lastIndexOf('.');
					if (dot < 0)
						throw new Error(`importData: file ${path} has no extension`);
					const ext = path.slice(dot + 1);
					if (ext !== codec.fileExtension)
						throw new Error(
							`importData: file ${path} has wrong extension (expected ${codec.fileExtension})`,
						);

					// Table lookup
					const table = schema[tableName as keyof typeof schema];
					if (!table) throw new Error(`importData: unknown table ${tableName}`);

					// Parse and denormalize row by table columns
					const text = await input.text();
					const rec = codec.parse(text);
					const row: Record<string, unknown> = {};
					const tableCols = new Set(listColumns(table).map(([name]) => name));
					for (const [k, v] of Object.entries(rec ?? {})) {
						if (!tableCols.has(k)) continue;
						row[k] = v;
					}

					// Dataset key is unprefixed table name (strip '<adapterId>_')
					const key = tableName.slice(adapterId.length + 1);
					dataset[key] ??= [];
					dataset[key].push(row);
				}

				// Build required drizzle-arktype validator bound to this adapter's schema
				const dataValidator = await createDrizzleArkTypeValidator(adapter);

				// Run migrations/transforms pipeline with drizzle-arktype validation (sole validator for import)
				// We don't want to run the adapter's built-in validator here because it likely won't match the preprocessed shape
				const validatedDataset = await runImportPipeline({
					adapter,
					dataset,
					transformsOverride: undefined,
					versionsOverride: undefined,
					dataValidator,
					sourceTag: undefined,
					detectedTag: group.detectedTag,
				});

				// Replace adapter tables with validated dataset
				await replaceAdapterTables(adapter, validatedDataset);
			}
		},
		async ingestData(opts: IngestOptions) {
			const adapter = opts.adapter;
			const file = opts.file;

			ensureNoDuplicateAdapterIds([adapter]);
			await ensureMigrationsUpToDate(adapter, 'ingestData');

			if (!adapter.ingestors || adapter.ingestors.length === 0)
				throw new Error(
					`ingestData: adapter '${adapter.id}' has no ingestors configured`,
				);

			// Catch may be unnecessary, but protects against faulty ingestor implementations
			const ingestor = adapter.ingestors.find((i) => {
				try {
					return i.matches(file);
				} catch {
					return false;
				}
			});
			// If no ingestor matched, throw
			if (!ingestor)
				throw new Error(
					`ingestData: no ingestor matched file '${file.name}' for adapter '${adapter.id}'`,
				);

			const dataset = await ingestor.parse(file);

			// Run validation and use morphed value
			const validated = await runValidation(adapter, dataset);

			// TODO is this necessary or is there a better way?
			// We might be able to do a runtime-based "on-conflict-replace" insert instead
			await replaceAdapterTables(
				adapter,
				// TODO refine type
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
