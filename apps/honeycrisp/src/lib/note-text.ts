/**
 * Flatten a note's prose to text without a ProseMirror view.
 *
 * Takes the body root itself rather than the note's document, so the name of
 * that root stays in one place (`NOTE_BODY`, declared at `create` time) instead
 * of being spelled again here as a literal.
 *
 * The editor derives the same string through ProseMirror when a note is open,
 * and this is the path for the notes that are not. It walks the Yjs types the
 * editor binds to, so it needs no schema and no editor state: every `Y.XmlText`
 * in the tree contributes its characters, joined by spaces so words in adjacent
 * blocks do not merge, which is the same rule `extractNoteMetadata` follows.
 *
 * This is what makes search cover a whole note. The row carries `title` and
 * `preview`, and `preview` is a hundred characters for a list subtitle, so
 * searching it alone could never find a word past the opening line. Prose lives
 * in the document plane by decision (ADR-0207) so it can merge per character,
 * which means the row will never carry it and reading it is the application's
 * job.
 *
 * Called per note per search keystroke, and that is cheap on purpose: a note's
 * prose is a type in the application's own document, so this is a walk over
 * memory with nothing to open, nothing to await, and nothing to cache. An
 * earlier release did cache it, in a map that `warm()` only ever filled and
 * never refreshed, so prose arriving from another device stayed invisible to
 * search forever. Reading through is both smaller and correct.
 */
export function readNoteText(body: unknown): string {
	const root = body as { toJSON?: () => unknown } | undefined;
	if (typeof root?.toJSON !== 'function') return '';

	// `toJSON` is the type's own public shape: a node is either a string, which
	// is text, or an object with `children`. Yjs 14 has one `YType` rather than
	// distinct XML classes, so there is no class to branch on and no reason to
	// reach past this into internals.
	const parts: string[] = [];
	const visit = (node: unknown): void => {
		if (typeof node === 'string') {
			parts.push(node);
			return;
		}
		if (node === null || typeof node !== 'object') return;
		const { children } = node as { children?: unknown };
		if (Array.isArray(children)) for (const child of children) visit(child);
	};
	visit(root.toJSON());
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}
