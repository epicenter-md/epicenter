import { createQbAccess } from '../books/qb-access.ts';
import { fetchReport, parseReportName, REPORT_NAMES } from '../books/report.ts';
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

	const { data: report, error: nameError } = parseReportName(name);
	if (nameError !== null) {
		console.error(nameError.message);
		return 1;
	}

	let accounting_method: 'Cash' | 'Accrual' | undefined;
	if (args.method !== undefined) {
		if (args.method !== 'Cash' && args.method !== 'Accrual') {
			console.error('--method must be "Cash" or "Accrual".');
			return 1;
		}
		accounting_method = args.method;
	}

	const { data: company, error } = await resolveCompany(args);
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
	const { data, error: reportError } = await fetchReport({
		openQb,
		input: {
			report,
			start_date: args.start,
			end_date: args.end,
			accounting_method,
		},
	});
	if (reportError !== null) {
		console.error(reportError.message);
		return 1;
	}

	console.log(JSON.stringify(data.data, null, 2));
	return 0;
}
