import { parse, stringify } from 'yaml';

// Wanted to use `bun` but apparently YAML stringification is just... not a thing in most implementations...

export type YamlNamespace = {
	/**
	 * Compliant YAML parser. Follows YAML 1.2 spec (superset of JSON).
	 * @see {@link https://yaml.org/spec/1.2.2/ YAML 1.2 specification}
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse MDN reference}
	 */
	parse(
		text: string,
		reviver?: (this: unknown, key: string, value: unknown) => unknown,
	): Record<string, unknown>;
	/**
	 * Compliant YAML stringifier. Follows YAML 1.2 spec (superset of JSON).
	 * @see {@link https://yaml.org/spec/1.2.2/ YAML 1.2 specification}
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify MDN reference}
	 */
	stringify(
		obj: Record<string, unknown>,
		replacer?: (this: unknown, key: string, value: unknown) => unknown,
	): string;
};

export const YAML = {
	parse,
	stringify,
} satisfies YamlNamespace;
