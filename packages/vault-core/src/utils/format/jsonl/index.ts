export type JsonlNamespace = {
	/**
	 * Parses a JSON Lines (JSONL) formatted string into an array of objects.
	 * Each line should be a valid JSON object.
	 * @see {@link https://jsonlines.org/ JSON Lines specification}
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse MDN reference}
	 */
	parse(text: string): Record<string, unknown>[];
	/**
	 * Converts an array of objects into a JSON Lines (JSONL) formatted string.
	 * Each object will be serialized as a JSON string on its own line.
	 * @see {@link https://jsonlines.org/ JSON Lines specification}
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify MDN reference}
	 */
	stringify(arr: Record<string, unknown>[]): string;
};

const parse: JsonlNamespace['parse'] = (text) => {
	if (!text || text.trim().length === 0) return [];
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const result = [];

	// Parse each line as JSON, collecting objects and throwing on errors
	for (const [i, line] of lines.entries()) {
		try {
			const obj = JSON.parse(line);
			if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
				result.push(obj as Record<string, unknown>);
			}
		} catch (error) {
			// Re-throw with line number for easier debugging
			throw new Error(`Invalid JSONL at line ${i + 1}: ${line}`, {
				cause: error,
			});
		}
	}
	return result;
};

const stringify: JsonlNamespace['stringify'] = (arr) => {
	if (!Array.isArray(arr) || arr.length === 0)
		throw new Error('Input must be a non-empty array');
	const lines = arr.map((obj) => JSON.stringify(obj));
	return lines.join('\n');
};

export const JSONL = {
	parse,
	stringify,
} satisfies JsonlNamespace;
