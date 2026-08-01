import ms from 'ms';
import { createQbAccess } from '../books/qb-access.ts';
import type { ParsedArgs } from '../cli.ts';
import { openBooksDb } from '../db.ts';
import { DEFAULT_ENTITIES, isKnownEntity } from '../entities.ts';
import {
	repairEntities,
	runSyncLoop,
	type SyncDeps,
	type SyncOutcome,
	syncRealm,
} from '../sync.ts';
import { resolveCompany } from './context.ts';

/** Print one sync pass: the realm line + per-entity counts to stdout, failures to stderr. */
function reportOutcome(o: SyncOutcome): void {
	console.log(
		`${o.mode.padEnd(11)} ${o.reason}` +
			`  cursor ${o.cursorBefore ?? '(none)'} -> ${o.cursorAfter ?? '(none)'}`,
	);
	for (const e of o.entities) {
		console.log(
			`${e.entity.padEnd(13)} ${e.upserted} added or updated, ${e.deleted} removed` +
				`${e.backfilled ? '  [full pull]' : ''}`,
		);
	}
	for (const f of o.failures) {
		console.error(`${f.entity}: sync failed: ${f.error.message}`);
	}
}

/**
 * Refresh the local mirror. The default is a realm pass: one mode decision for
 * the whole company (FULL vs INCREMENTAL from the stored cursor; `--full`
 * forces FULL), advancing the single realm cursor. `--entity <name>...` instead
 * runs a targeted FULL repair of just those tables, leaving the cursor untouched.
 * `--interval` keeps the realm pass running on a loop until Ctrl-C.
 */
export async function runSync(args: ParsedArgs): Promise<number> {
	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, mirror, store } = company;

	const repairTargets = args.entities;
	const unknown = repairTargets.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		console.error(
			`Unknown entities: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
		return 1;
	}
	if (repairTargets.length > 0 && args.intervalMs != null) {
		console.error(
			'Cannot combine --entity with --interval. Run a one-time "sync --entity" pass, then start the "sync --interval" loop.',
		);
		return 1;
	}

	const now = () => Date.now();
	const log = (m: string) => console.error(m);
	// The same opener report/recategorize/MCP use: it reloads the token and
	// builds the client, or returns a "run auth" reason. One way to open a client.
	const { data: client, error: openError } = await createQbAccess({
		config,
		realmId,
		store,
		now,
		log,
	})();
	if (openError !== null) {
		console.error(openError);
		return 1;
	}
	const db = openBooksDb(mirror);
	const deps: SyncDeps = { db, client, config, now, log };

	// Looping mode: keep the mirror fresh until interrupted.
	if (args.intervalMs != null) {
		const controller = new AbortController();
		const stop = () => {
			console.error('\nstopping...');
			controller.abort();
		};
		process.on('SIGINT', stop);
		console.error(
			`Syncing ${config.entities.join(', ')} for company ${realmId} (${config.environment}) every ${ms(args.intervalMs)}; press Ctrl-C to stop.`,
		);
		await runSyncLoop(deps, {
			forceFull: args.full,
			intervalMs: args.intervalMs,
			signal: controller.signal,
			onPass: reportOutcome,
		});
		process.off('SIGINT', stop);
		db.close();
		return 0;
	}

	// Single pass: a targeted repair when `--entity` is given, else the realm pass.
	if (repairTargets.length > 0) {
		console.error(
			`Repairing ${repairTargets.join(', ')} for company ${realmId} (${config.environment})...`,
		);
		const outcome = await repairEntities(deps, repairTargets);
		db.close();
		reportOutcome(outcome);
		return outcome.failures.length > 0 ? 1 : 0;
	}

	console.error(
		`Syncing ${config.entities.join(', ')} for company ${realmId} (${config.environment})${args.full ? ' [--full]' : ''}...`,
	);
	const outcome = await syncRealm(deps, { forceFull: args.full });
	db.close();
	reportOutcome(outcome);
	return outcome.failures.length > 0 ? 1 : 0;
}
