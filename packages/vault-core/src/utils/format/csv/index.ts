export type CsvOptions = {
	/** Character used to separate values. Default is comma (,). */
	delimiter?: string;
	/** Character used to quote values. Default is double quote ("). */
	quote?: string;
	/** Character used to escape quotes inside quoted values. Default is double quote (") (e.g. "foo ""bar"" baz"). */
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

export type CsvNamespace = {
	/**
	 * Parse CSV text. Default (headers omitted or true) returns array of objects (keyed by header row).
	 * When headers=false, returns a 2D string array of raw rows.
	 */
	parse<T extends Record<string, string> = Record<string, string>>(
		text: string,
		options?: CsvOptions & { headers?: true },
	): T[];
	parse(text: string, options: CsvOptions & { headers: false }): string[][];
	parse<T extends Record<string, string> = Record<string, string>>(
		text: string,
		options?: CsvOptions & { headers?: boolean },
	): T[] | string[][];

	/**
	 * Stringify object rows (default, headers omitted or true) or raw 2D string arrays (headers=false).
	 */
	stringify(
		data: Record<string, unknown>[],
		options?: CsvOptions & { headers?: true },
	): string;
	stringify(data: string[][], options: CsvOptions & { headers: false }): string;
	stringify(
		data: Record<string, unknown>[] | string[][],
		options?: CsvOptions & { headers?: boolean },
	): string;
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
 * Parse a CSV string into objects (default, headers=true) or raw row arrays (headers=false).
 */
function parseCsv<T extends Record<string, string> = Record<string, string>>(
	input: string,
	options?: CsvOptions & { headers?: true },
): T[];
function parseCsv(
	input: string,
	options: CsvOptions & { headers: false },
): string[][];
function parseCsv<T extends Record<string, string> = Record<string, string>>(
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
			// Skip until end of line
			while (i < input.length && input[i] !== '\n') i++;
			continue;
		}

		if (inQuotes) {
			if (char === escapeOpt && next === quoteOpt) {
				field += quoteOpt;
				i++; // skip escaped quote
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
				// CRLF support
			} else {
				field += char;
			}
		}
	}
	// Flush last field & row
	pushField();
	pushRow();

	// If headers !== false → return array of objects
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

// (Removed conditional utility types in favor of overloads for clearer typing.)

/**
 * Stringify arrays or objects into a CSV string.
 */
// Type guards to discriminate between object row input and 2D string array input.
function isObjectRowArray(
	data: Record<string, unknown>[] | string[][],
): data is Record<string, unknown>[] {
	return data.length === 0 || !Array.isArray(data[0]);
}

function is2DStringArray(
	data: Record<string, unknown>[] | string[][],
): data is string[][] {
	return data.length === 0 || Array.isArray(data[0]);
}

// Overloads: callers get proper type expectations without needing casts.
function stringifyCsv(
	data: Record<string, unknown>[],
	options?: CsvOptions & { headers?: true },
): string;
function stringifyCsv(
	data: string[][],
	options: CsvOptions & { headers: false },
): string;
function stringifyCsv(
	data: Record<string, unknown>[] | string[][],
	options?: CsvOptions & { headers?: boolean },
): string {
	const opts = { ...defaultOpts, ...options };

	const rows: string[][] = [];

	// Treat undefined headers as true (consistent with defaults)
	if (opts.headers !== false && isObjectRowArray(data) && data.length > 0) {
		const firstRow = data[0];
		if (firstRow === undefined) return '';
		const keys = Object.keys(firstRow);
		rows.push(keys);
		for (const obj of data) {
			rows.push(keys.map((k) => String(obj[k] ?? '')));
		}
	} else if (is2DStringArray(data)) {
		// Either headers explicitly false or user passed raw rows.
		for (const row of data) {
			// Ensure all values are stringified (in case of accidental non-string entries)
			rows.push(row.map((v) => String(v)));
		}
	}

	const needsQuoting = (val: string) =>
		val.includes(opts.delimiter) ||
		val.includes('\n') ||
		val.includes('\r') ||
		val.includes(opts.quote) ||
		/^\s|\s$/.test(val);

	return rows
		.map((row) =>
			row
				.map((val) => {
					let v = String(val);
					if (needsQuoting(v)) {
						v = v.replaceAll(opts.quote, opts.escape + opts.quote);
						return opts.quote + v + opts.quote;
					}
					return v;
				})
				.join(opts.delimiter),
		)
		.join('\n');
}

export const CSV = {
	parse: parseCsv,
	stringify: stringifyCsv,
} satisfies CsvNamespace;
