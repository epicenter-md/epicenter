import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type AppConfig,
	type CliConfigOverrides,
	loadConfig,
} from '../config.ts';
import { booksDbFile } from '../db.ts';
import type { DbFile } from '../db-file.ts';
import {
	createFileTokenStore,
	resolveRealm,
	type TokenStore,
} from '../token-store.ts';

/** Human-friendly "in 42m" / "3m ago" for the auth and status commands. */
export function formatRelative(targetIso: string, now: number): string {
	const deltaMs = Date.parse(targetIso) - now;
	const mins = Math.round(Math.abs(deltaMs) / 60000);
	const unit =
		mins < 60
			? `${mins}m`
			: mins < 60 * 24
				? `${Math.round(mins / 60)}h`
				: `${Math.round(mins / (60 * 24))}d`;
	return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * The company that the verbs operate on: config, resolved realm, its mirror,
 * and its token store. The mirror is resolved once here so no verb assembles a
 * database path of its own.
 */
export type CompanyContext = {
	config: AppConfig;
	realmId: string;
	mirror: DbFile;
	store: TokenStore;
};

/**
 * Resolve the target company shared by `sync` and `status`: load config, open
 * the token store, and pick the realm from it (explicit flag, or the sole
 * connected company). Returns a user-facing error string when the realm is
 * ambiguous or none is connected.
 */
export async function resolveCompany(
	overrides: CliConfigOverrides,
): Promise<Result<CompanyContext, string>> {
	const config = loadConfig(overrides);
	const store = createFileTokenStore(config.credentialsPath);
	const { data: realmId, error } = await resolveRealm(config, store);
	if (error !== null) return Err(error);
	return Ok({
		config,
		realmId,
		mirror: booksDbFile(config.dataDir, realmId),
		store,
	});
}
