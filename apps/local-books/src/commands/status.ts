import { readBooksStatus } from '../books/status.ts';
import type { ParsedArgs } from '../cli.ts';
import { formatRelative, resolveCompany } from './context.ts';

/** Report token state and the per-entity mirror state (cursor, counts). */
export async function runStatus(args: ParsedArgs): Promise<number> {
	const { data: company, error } = await resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, mirror, store } = company;

	const status = await readBooksStatus({ config, realmId, mirror, store });
	const now = Date.now();

	console.log(`Company ID:   ${status.realmId}`);
	console.log(`QuickBooks:   ${status.environment}`);
	console.log(`Data dir:     ${status.dataDir}`);
	console.log(`Token file:   ${status.tokenFile}`);

	if (!status.accessToken || !status.refreshToken) {
		console.log(`Connection:   not connected. Run "local-books auth".`);
	} else {
		const access = status.accessToken.valid ? 'valid' : 'expired';
		const refresh = status.refreshToken.valid ? 'valid' : 'expired';
		console.log(
			`Connection:   access ${access} (${formatRelative(status.accessToken.expiresAt, now)}), ` +
				`refresh ${refresh} (${formatRelative(status.refreshToken.expiresAt, now)})`,
		);
	}

	// Retained earlier versions are inventory, not a fault: they are reported in
	// both branches because the interesting case is exactly the one where the
	// current copy is missing and an older one is still sitting beside it.
	const retained = status.predecessors.length;
	const predecessorLine =
		retained === 0
			? null
			: `Retained:     ${retained} earlier ${retained === 1 ? 'copy' : 'copies'} from a previous version (${status.predecessors.map((v) => `v${v}`).join(', ')})`;

	if (status.mirror === 'empty') {
		console.log(`Local copy:   not built yet. Run "local-books sync --full".`);
		if (predecessorLine) console.log(predecessorLine);
		return 0;
	}
	// The artifact carries its corpus version in the filename, so print the path:
	// pointing an agent or `sqlite3` at the file is the whole reason someone runs
	// `status`, and the name changes when the version does.
	const building =
		status.mirror === 'building'
			? '  (building: no full pull has finished)'
			: '';
	console.log(`Local copy:   ${status.mirrorPath}${building}`);
	if (predecessorLine) console.log(predecessorLine);

	// The cursor is one high-water mark for the whole company (CDC's contract), so
	// it is shown once at the realm level, not repeated per entity.
	console.log(
		`Synced through:${status.cdcCursor ? ` ${status.cdcCursor}` : ' -'}`,
	);
	console.log(`Last full:     ${status.lastFullPullAt ?? '-'}`);
	console.log(`Last synced:   ${status.lastSyncedAt ?? '-'}`);
	console.log('');
	console.log(
		`${'Record type'.padEnd(13)} ${'Rows'.padStart(7)} ${'Removed'.padStart(8)}`,
	);
	for (const s of status.entities) {
		// Only the uninitialized case is worth a marker: a row count already tells
		// the reader a pulled entity's state, but `0` alone is ambiguous between
		// "synced, genuinely empty" and "never synced". Annotate the latter (the
		// only informative state) instead of printing a status on all 16 lines.
		if (!s.initialized) {
			console.log(`${s.entity.padEnd(13)} ${'-'.padStart(7)}  not synced yet`);
			continue;
		}
		console.log(
			`${s.entity.padEnd(13)} ${String(s.rows).padStart(7)} ${String(s.deleted).padStart(8)}`,
		);
	}
	return 0;
}
