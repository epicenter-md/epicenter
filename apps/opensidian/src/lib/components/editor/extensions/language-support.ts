import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import {
	defaultHighlightStyle,
	type LanguageSupport,
	syntaxHighlighting,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { markdownHighlighting } from './markdown-highlight';

const LANGUAGE_MAP: Record<string, () => LanguageSupport> = {
	'.js': () => javascript(),
	'.jsx': () => javascript({ jsx: true }),
	'.ts': () => javascript({ typescript: true }),
	'.tsx': () => javascript({ jsx: true, typescript: true }),
	'.css': css,
	'.html': html,
	'.json': json,
	'.md': markdown,
};

/**
 * Get all CodeMirror extensions for a filename and color mode.
 *
 * Returns the language parser and syntax highlight style appropriate for
 * the file type. Markdown files get the custom CSS-var-based highlight
 * style; code files get `oneDarkHighlightStyle` (dark) or
 * `defaultHighlightStyle` (light). Unknown extensions fall back to
 * markdown since opensidian is primarily a note-taking app.
 *
 * Does NOT include autocompletion. Callers add that based on context
 * (code files get `autocompletion()`, markdown gets `wikilinkAutocomplete`).
 *
 * @example
 * ```typescript
 * const extensions = getEditorExtensions('index.ts', true);
 * // → [javascript({ typescript: true }), syntaxHighlighting(oneDarkHighlightStyle)]
 *
 * const mdExtensions = getEditorExtensions('README.md', false);
 * // → [markdown(), markdownHighlighting]
 * ```
 */
export function getEditorExtensions(
	filename: string,
	isDark: boolean,
): Extension[] {
	const dotIndex = filename.lastIndexOf('.');
	const ext = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
	const createLanguage = LANGUAGE_MAP[ext];

	// Unknown extension → fall back to markdown (opensidian is a note-taking app)
	if (!createLanguage || ext === '.md') {
		return [createLanguage?.() ?? markdown(), markdownHighlighting];
	}

	const style = isDark ? oneDarkHighlightStyle : defaultHighlightStyle;
	return [createLanguage(), syntaxHighlighting(style)];
}
