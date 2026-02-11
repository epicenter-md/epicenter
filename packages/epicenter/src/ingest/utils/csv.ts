/**
 * CSV Parser - ported from vault-core
 *
 * Zero-dependency CSV parser with full support for:
 * - Headers (object output) or raw mode (2D array output)
 * - Quoted values, escape characters
 * - Comments, empty line handling
 * - Custom delimiters
 */

export type CsvOptions = {
	/** Character used to separate values. Default is comma (,). */
	delimiter?: string;
	/** Character used to quote values. Default is double quote ("). */
	quote?: string;
	/** Character used to escape quotes inside quoted values. Default is double quote ("). */
	escape?: string;
	/** Whether to trim whitespace around values. Default is true. */
	trim?: boolean;
	/** Whether the first row contains headers. Default is true. */
	headers?: boolean;
	/** Whether to skip empty lines. Default is true. */
	skipEmptyLines?: boolean;
	/** If comments are included, the character used to denote them. Default is #. */
	comment?: string;
};

const defaultOpts: Required<CsvOptions> = {
	delimiter: ',',
	quote: '"',
	escape: '"',
	trim: true,
	headers: true,
	skipEmptyLines: true,
	comment: '#',
};

/**
 * Parse CSV text into objects (headers=true) or raw 2D array (headers=false).
 */
export function parseCsv<
	T extends Record<string, string> = Record<string, string>,
>(input: string, options?: CsvOptions & { headers?: true }): T[];
export function parseCsv(
	input: string,
	options: CsvOptions & { headers: false },
): string[][];
export function parseCsv<
	T extends Record<string, string> = Record<string, string>,
>(
	input: string,
	options?: CsvOptions & { headers?: boolean },
): T[] | string[][] {
	const opts = { ...defaultOpts, ...options };

	const rows: string[][] = [];
	let current: string[] = [];
	let field = '';
	let inQuotes = false;

	const delimiterOpt = opts.delimiter;
	const quoteOpt = opts.quote;
	const escapeOpt = opts.escape;

	const pushField = () => {
		let val = field;
		if (opts.trim) val = val.trim();
		current.push(val);
		field = '';
	};

	const pushRow = () => {
		if (!(opts.skipEmptyLines && current.length === 1 && current[0] === '')) {
			rows.push(current);
		}
		current = [];
	};

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		// Handle comments at start of line
		if (
			!inQuotes &&
			char === opts.comment &&
			(i === 0 || input[i - 1] === '\n' || input[i - 1] === '\r')
		) {
			while (i < input.length && input[i] !== '\n') i++;
			continue;
		}

		if (inQuotes) {
			if (char === escapeOpt && next === quoteOpt) {
				field += quoteOpt;
				i++;
			} else if (char === quoteOpt) {
				inQuotes = false;
			} else {
				field += char;
			}
		} else {
			if (char === quoteOpt) {
				inQuotes = true;
			} else if (char === delimiterOpt) {
				pushField();
			} else if (char === '\n') {
				pushField();
				pushRow();
			} else if (char === '\r') {
				// CRLF support - skip CR
			} else {
				field += char;
			}
		}
	}

	// Flush last field & row
	pushField();
	pushRow();

	// If headers → return array of objects
	if (opts.headers !== false && rows.length > 0) {
		const [headerRow, ...body] = rows;
		return body.map((row) => {
			const obj: Record<string, string> = {};
			for (const [idx, key] of headerRow?.entries() ?? []) {
				obj[key] = row[idx] ?? '';
			}
			return obj as T;
		});
	}

	return rows;
}

export const CSV = {
	parse: parseCsv,
};
