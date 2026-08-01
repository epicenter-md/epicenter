import { queryBooks } from '../books/query.ts';
import type { ParsedArgs } from '../cli.ts';
import { resolveCompany } from './context.ts';

/**
 * `local-books query "<sql>"`: run a read-only SQL query against the local
 * mirror and print the rows as JSON (pipeable). The front door for a human, and
 * the same surface an off-the-shelf coding agent uses when pointed at the file.
 */
export async function runQuery(args: ParsedArgs): Promise<number> {
	const sql = args.positionals[0];
	if (!sql) {
		console.error(
			'Usage: local-books query "<sql>"  (a read-only SELECT over the local mirror)',
		);
		return 1;
	}

	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { data, error: queryError } = queryBooks({ site: company.mirror, sql });
	if (queryError !== null) {
		console.error(queryError.message);
		return 1;
	}

	console.log(JSON.stringify(data.rows, null, 2));
	const note = data.truncated ? ' (capped; more rows matched)' : '';
	console.error(`${data.rowCount} row${data.rowCount === 1 ? '' : 's'}${note}`);
	return 0;
}
