import { Err, Ok, type Result } from 'wellcrafted/result';
import { createQbAccess, type OpenQbClient } from '../books/qb-access.ts';
import type { ParsedArgs } from '../cli.ts';
import { resolveRealm } from '../companies.ts';
import { type AppConfig, loadConfig } from '../config.ts';
import { dbPath as resolveDbPath } from '../paths.ts';
import { createFileTokenStore, type TokenStore } from '../token-store.ts';

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

/** The company that sync/status operate on: config, resolved realm, its token store. */
export type CompanyContext = {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
};

/**
 * Resolve the target company shared by `sync` and `status`: load config, pick
 * the realm (explicit flag, recorded default, or the sole authenticated one),
 * and open its token store. Returns a user-facing error string when the realm is
 * ambiguous or none is authenticated.
 */
export function resolveCompany(
	args: ParsedArgs,
): Result<CompanyContext, string> {
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});
	const { data: realmId, error } = resolveRealm(config);
	if (error !== null) return Err(error);
	return Ok({
		config,
		realmId,
		store: createFileTokenStore(config.credentialsPath),
	});
}

/** A resolved company plus its opened QuickBooks access and mirror db path. */
export type CompanyAccess = CompanyContext & {
	dbPath: string;
	openQb: OpenQbClient;
};

/**
 * Resolve the target company and open its QuickBooks access in one step: the
 * shape `report`, `recategorize`, `query`, and `status` all rebuild on top of
 * {@link resolveCompany} (a `createQbAccess` call with a fresh clock, plus the
 * mirror's db path). Each CLI command still owns picking which pieces it uses.
 */
export function openCompany(args: ParsedArgs): Result<CompanyAccess, string> {
	const { data: company, error } = resolveCompany(args);
	if (error !== null) return Err(error);
	const { config, realmId, store } = company;
	return Ok({
		config,
		realmId,
		store,
		dbPath: resolveDbPath(config.dataDir, realmId),
		openQb: createQbAccess({ config, realmId, store, now: () => Date.now() }),
	});
}
