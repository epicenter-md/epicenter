import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * Custom markdown highlight style for the opensidian editor.
 *
 * Replaces CodeMirror's `defaultHighlightStyle` with richer visual
 * differentiation for headings, links, emphasis, code spans, and quotes.
 * Uses CSS custom properties so colors adapt to light/dark themes.
 *
 * @example
 * ```typescript
 * import { markdownHighlighting } from './extensions/markdown-highlight';
 *
 * const extensions = [markdownHighlighting];
 * ```
 */
const markdownHighlightStyle = HighlightStyle.define([
	{ tag: tags.heading1, fontWeight: '700', fontSize: '1.4em' },
	{ tag: tags.heading2, fontWeight: '700', fontSize: '1.2em' },
	{ tag: tags.heading3, fontWeight: '700', fontSize: '1.1em' },
	{ tag: tags.heading4, fontWeight: '700' },
	{ tag: tags.heading5, fontWeight: '700' },
	{ tag: tags.heading6, fontWeight: '700' },
	{
		tag: tags.link,
		color: 'var(--primary, #3b82f6)',
		textDecoration: 'underline',
		textUnderlineOffset: '2px',
	},
	{ tag: tags.url, color: 'var(--muted-foreground, #6b7280)' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.strong, fontWeight: '700' },
	{ tag: tags.strikethrough, textDecoration: 'line-through' },
	{
		tag: tags.monospace,
		fontFamily:
			'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
	},
	{
		tag: tags.quote,
		color: 'var(--muted-foreground, #6b7280)',
		fontStyle: 'italic',
	},
	{ tag: tags.meta, color: 'var(--muted-foreground, #6b7280)' },
]);

/** Markdown syntax highlighting extension. Drop into the editor's extension array. */
export const markdownHighlighting = syntaxHighlighting(markdownHighlightStyle);
