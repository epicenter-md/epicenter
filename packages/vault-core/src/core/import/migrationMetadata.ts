/**
 * Utilities for producing metadata files that describe an adapter’s migration state.
 *
 * When we export data, we attach a JSON manifest so future imports know:
 *   - Which version tag the vault was on (ledger vs. adapter default)
 *   - Which tags are declared in the adapter today
 *   - When the export snapshot was taken
 *
 * Host tooling can read this file to pre-populate “source version” selectors, drive
 * transform planning, or display drift warnings (ledger vs. declared versions).
 */
import { jsonFormat } from '../../codecs';
import type { Adapter } from '../adapter';
import type { DrizzleDb } from '../db';
import { ensureVaultLedgerTables, getVaultLedgerTag } from '../migrations';

export const MIGRATION_META_DIR = '__meta__';
export const MIGRATION_META_FILENAME = 'migration.json';

/**
 * Shape of the emitted metadata file (written as JSON under __meta__/ADAPTER/migration.json).
 */
export type MigrationMetadata = {
	adapterId: string;
	tag: string | null;
	source: 'ledger' | 'adapter';
	ledgerTag: string | null;
	latestDeclaredTag: string | null;
	versions: string[];
	exportedAt: Date;
};

/**
 * Helper: fetch the last-applied tag for an adapter from the migration store.
 * Returns undefined when the host does not provide a store or when no tag is stored yet,
 * which signals downstream logic to fall back to adapter-declared versions.
 */
async function resolveLedgerTag(
	adapterId: string,
	db?: DrizzleDb,
): Promise<string | undefined> {
	if (!db) return undefined;
	await ensureVaultLedgerTables(db);
	return (await getVaultLedgerTag(db, adapterId)) ?? undefined;
}

/**
 * Produce migration metadata for a single adapter.
 *
 * Priority order for `tag`:
 *   1. ledgerTag (vault-migrations table) when available
 *   2. latest declared tag from the adapter manifest
 *   3. null when neither exists (fresh adapter)
 *
 * `versions` is emitted as the manifest’s ordered tag list so consumers can plan forward chains.
 */
export async function createMigrationMetadata(
	adapter: Adapter,
	db?: DrizzleDb,
	clock: () => Date = () => new Date(),
): Promise<MigrationMetadata> {
	const versions = adapter.versions ?? [];
	const declaredTags = versions.map((v) => v.tag);
	const ledgerTag = await resolveLedgerTag(adapter.id, db);
	const latestDeclaredTag = declaredTags.length
		? declaredTags[declaredTags.length - 1]
		: undefined;
	const resolvedTag = ledgerTag ?? latestDeclaredTag ?? null;
	return {
		adapterId: adapter.id,
		tag: resolvedTag,
		source: ledgerTag ? 'ledger' : 'adapter',
		ledgerTag: ledgerTag ?? null,
		latestDeclaredTag: latestDeclaredTag ?? null,
		versions: declaredTags,
		exportedAt: clock(),
	};
}

/**
 * Convenience: build the on-disk metadata file alongside the in-memory metadata object.
 * Returns both so callers can stash the file in an export archive and keep the parsed metadata.
 */
export async function createMigrationMetadataFile(
	adapter: Adapter,
	db?: DrizzleDb,
	clock?: () => Date,
): Promise<{ path: string; file: File; metadata: MigrationMetadata }> {
	const metadata = await createMigrationMetadata(adapter, db, clock);
	const file = new File(
		// We'll use JSON codec here so that date serialization is consistent
		[jsonFormat.stringify(metadata)],
		MIGRATION_META_FILENAME,
		{ type: 'application/json' },
	);
	return {
		path: `${MIGRATION_META_DIR}/${adapter.id}/${MIGRATION_META_FILENAME}`,
		file,
		metadata,
	};
}
