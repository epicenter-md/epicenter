import { parse } from 'toml';

export type TomlNamespace = {
	/** Minimal TOML parser/stringifier.
	 * @see {@link https://toml.io/en/v1.0.0 TOML specification}
	 */
	parse(text: string): Record<string, unknown>;
	// I guess TOML stringification is not really a thing??
	// stringify(data: Record<string, unknown>): string;
};

export const TOML = {
	parse,
} satisfies TomlNamespace;
