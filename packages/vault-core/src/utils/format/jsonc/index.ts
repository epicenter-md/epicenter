export type JsoncNamespace = {
	/**
	 * Minimal JSONC parser/stringifier supporting comments and trailing commas.
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse MDN reference}
	 */
	parse(
		text: string,
		reviver?: (this: unknown, key: string, value: unknown) => unknown,
	): Record<string, unknown>;
	/**
	 * Minimal JSONC stringifier (currently identical to JSON.stringify).
	 * Does not add comments or trailing commas.
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify MDN reference}
	 */
	stringify(
		obj: Record<string, unknown>,
		replacer?: (this: unknown, key: string, value: unknown) => unknown,
		space?: string | number,
	): string;
};

const parse: JsoncNamespace['parse'] = (text, reviver) => {
	// Simple JSONC parser that removes comments and trailing commas
	const noComments = text
		.replace(/\/\/.*$/gm, '') // Remove single-line comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
		.replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas

	return JSON.parse(noComments, reviver);
};

const stringify: JsoncNamespace['stringify'] = JSON.stringify;

export const JSONC = {
	parse,
	stringify,
} satisfies JsoncNamespace;
