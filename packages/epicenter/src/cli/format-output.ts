export type FormatOptions = {
	/** Override format (default: json, auto-pretty for TTY) */
	format?: 'json' | 'jsonl';
};

/**
 * Format a single value as JSON
 */
export function formatJson(
	value: unknown,
	options: FormatOptions = {},
): string {
	const shouldPretty =
		options.format !== 'jsonl' && (process.stdout.isTTY ?? false);
	return JSON.stringify(value, null, shouldPretty ? 2 : undefined);
}

/**
 * Format an array as JSONL (one JSON object per line)
 */
export function formatJsonl(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}

/**
 * Output data to stdout with appropriate formatting
 */
export function output(value: unknown, options: FormatOptions = {}): void {
	if (options.format === 'jsonl') {
		if (!Array.isArray(value)) {
			throw new Error('JSONL format requires an array value');
		}
		console.log(formatJsonl(value));
	} else {
		console.log(formatJson(value, options));
	}
}

/**
 * Output an error message to stderr
 */
export function outputError(message: string): void {
	console.error(message);
}

/**
 * Create yargs options for format flag
 */
export function formatYargsOptions() {
	return {
		format: {
			type: 'string' as const,
			choices: ['json', 'jsonl'] as const,
			description: 'Output format (default: json, auto-pretty for TTY)',
		},
	};
}
