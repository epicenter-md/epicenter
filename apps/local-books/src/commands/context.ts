import type { Mirror } from '@epicenter/sqlite/bun-mirror';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { resolveRealm } from '../companies.ts';
import {
	type AppConfig,
	type CliConfigOverrides,
	loadConfig,
} from '../config.ts';
import { booksMirror } from '../db.ts';
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

/**
 * The company that the verbs operate on: config, resolved realm, its mirror,
 * and its token store. The mirror is resolved once here so no verb assembles a
 * database path of its own.
 */
export type CompanyContext = {
	config: AppConfig;
	realmId: string;
	mirror: Mirror;
	store: TokenStore;
};

/**
 * Resolve the target company shared by `sync` and `status`: load config, pick
 * the realm (explicit flag, recorded default, or the sole authenticated one),
 * and open its token store. Returns a user-facing error string when the realm is
 * ambiguous or none is authenticated.
 */
export function resolveCompany(
	overrides: CliConfigOverrides,
): Result<CompanyContext, string> {
	const config = loadConfig(overrides);
	const { data: realmId, error } = resolveRealm(config);
	if (error !== null) return Err(error);
	return Ok({
		config,
		realmId,
		mirror: booksMirror(config.dataDir, realmId),
		store: createFileTokenStore(config.credentialsPath),
	});
}
