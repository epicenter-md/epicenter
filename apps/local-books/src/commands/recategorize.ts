import { Value } from 'typebox/value';
import { createQbAccess } from '../books/qb-access.ts';
import {
	RecategorizeInput,
	recategorizeExpense,
} from '../books/recategorize.ts';
import type { ParsedArgs } from '../cli.ts';
import { dbPath } from '../paths.ts';
import { resolveCompany } from './context.ts';

/**
 * `local-books recategorize <Purchase|Bill> <id> --to <accountId>`: move an
 * expense to a different account in QuickBooks (write-through), then fold the
 * authoritative response into the mirror. Running this verb is the approval; it
 * is refused under `LOCAL_BOOKS_READ_ONLY`.
 */
export async function runRecategorize(args: ParsedArgs): Promise<number> {
	const [entityName, id] = args.positionals;
	if (!entityName || !id || !args.to) {
		console.error(
			'Usage: local-books recategorize <Purchase|Bill> <id> --to <accountId> [--to-name <name>] [--line <lineId>]',
		);
		return 1;
	}

	const input: Record<string, unknown> = {
		entity: entityName,
		id,
		account_id: args.to,
	};
	if (args.toName !== undefined) input.account_name = args.toName;
	if (args.line !== undefined) input.line_id = args.line;

	if (!Value.Check(RecategorizeInput, input)) {
		const detail = Value.Errors(RecategorizeInput, input)
			.map((e) => `${e.instancePath || '/'}: ${e.message}`)
			.join('; ');
		console.error(`Invalid recategorize input: ${detail}`);
		return 1;
	}

	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, store } = company;

	const openQb = createQbAccess({
		config,
		realmId,
		store,
		now: () => Date.now(),
	});
	const { data, error: writeError } = await recategorizeExpense({
		openQb,
		dbPath: dbPath(config.dataDir, realmId),
		readOnly: config.readOnly,
		input,
	});
	if (writeError !== null) {
		console.error(writeError.message);
		return 1;
	}

	for (const change of data.changed) {
		const line = change.lineId ? ` line ${change.lineId}` : '';
		console.log(
			`${data.entity} ${data.id}${line}: ${change.fromAccount ?? '(none)'} -> ${change.toAccount}`,
		);
	}
	if (data.folded) {
		console.error(
			`Updated in QuickBooks (SyncToken ${data.syncToken ?? '?'}) and folded into the mirror.`,
		);
	} else {
		console.error(
			`Updated in QuickBooks (SyncToken ${data.syncToken ?? '?'}), but folding into the mirror failed. The next sync will reconcile it; do not retry recategorize (the SyncToken has already bumped).`,
		);
	}
	return 0;
}
