import { Value } from 'typebox/value';
import { createQbAccess } from '../books/qb-access.ts';
import { fetchReport, REPORT_NAMES, ReportInput } from '../books/report.ts';
import type { ParsedArgs } from '../cli.ts';
import { resolveCompany } from './context.ts';

/**
 * `local-books report <Name>`: run a computed statement live from QuickBooks
 * (P&L, balance sheet, cash flow, A/R + A/P aging, trial balance) and print the
 * report JSON. Live, never mirrored, since reports have no CDC to keep fresh.
 */
export async function runReport(args: ParsedArgs): Promise<number> {
	const name = args.positionals[0];
	if (!name) {
		console.error(
			'Usage: local-books report <Name> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--method Cash|Accrual]\n' +
				`Reports: ${REPORT_NAMES.join(', ')}`,
		);
		return 1;
	}

	const input: Record<string, unknown> = { report: name };
	if (args.start !== undefined) input.start_date = args.start;
	if (args.end !== undefined) input.end_date = args.end;
	if (args.method !== undefined) input.accounting_method = args.method;

	if (!Value.Check(ReportInput, input)) {
		const detail = Value.Errors(ReportInput, input)
			.map((e) => `${e.instancePath || '/'}: ${e.message}`)
			.join('; ');
		console.error(`Invalid report input: ${detail}`);
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
	const { data, error: reportError } = await fetchReport({ openQb, input });
	if (reportError !== null) {
		console.error(reportError.message);
		return 1;
	}

	console.log(JSON.stringify(data.data, null, 2));
	return 0;
}
