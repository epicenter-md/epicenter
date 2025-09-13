import { YAML } from '../yaml';

type Result = { body: string; frontmatter?: Record<string, unknown> };

export type MarkdownNamespace = {
	/**
	 * Minimal Markdown parser that parses a Markdown string into body text & frontmatter.
	 * Currently supports YAML frontmatter only.
	 * @see {@link ../yaml/index.ts YAML parser}
	 */
	parse(text: string): Result;
	/**
	 * Minimal Markdown stringifier that combines body text & frontmatter into a Markdown string.
	 * Currently supports YAML frontmatter only.
	 * @see {@link ../yaml/index.ts YAML stringifier}
	 */
	stringify(data: Result): string;
};

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

const parse: MarkdownNamespace['parse'] = (text) => {
	if (!text || text.trim().length === 0) return { body: '', frontmatter: {} };

	let body = text;
	let frontmatter: Record<string, unknown> = {};

	const match = text.match(FRONTMATTER_REGEX);
	if (match) {
		const yamlText = match[1];
		if (yamlText === undefined) return { body: text };
		body = text.slice(match[0].length);
		try {
			frontmatter = YAML.parse(yamlText);
		} catch (error) {
			throw new Error('Invalid YAML frontmatter', { cause: error });
		}
	}

	return { body, frontmatter };
};

const stringify: MarkdownNamespace['stringify'] = (data) => {
	if (!data || typeof data.body !== 'string')
		throw new Error('Input must have a body string');

	let frontmatterText = '';
	if (data.frontmatter && Object.keys(data.frontmatter).length > 0) {
		const yamlText = YAML.stringify(data.frontmatter);
		frontmatterText = `---\n${yamlText}---\n\n`;
	}

	return `${frontmatterText}${data.body}`;
};

export const Markdown = {
	parse,
	stringify,
} satisfies MarkdownNamespace;
