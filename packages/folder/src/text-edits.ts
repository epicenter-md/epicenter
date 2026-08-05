/**
 * Turn "the body used to say this, now it says that" into an operation a
 * `Y.Text` can accept.
 *
 * The distinction is the whole reason this file exists. Setting a document's
 * text replaces every character, which discards the structure a CRDT exists to
 * keep and throws away anything an open editor is holding. Saying "delete six
 * characters at 22, insert `Monday`" leaves everything else alone (ADR-0207).
 *
 * One hunk, found by trimming the matching head and tail. A minimal diff would
 * split scattered edits into separate operations and produce a tighter update
 * log, which is worth exactly nothing until a log is measured and found fat:
 * the result of applying either is identical, and a body is only ever pushed
 * when nobody else touched it. Put a real diff here when there is a log to point
 * at, not before.
 */

/**
 * One replacement, in character offsets against the text being edited.
 *
 * An array because the caller applies a sequence and should not care how many
 * this produced, and in descending `at` order for the same reason: if a future
 * diff emits several, they still apply without offset bookkeeping.
 */
export type TextEdit = {
	at: number;
	remove: number;
	insert: string;
};

/** True when splitting here would cut a surrogate pair in half. */
function splitsSurrogatePair(text: string, index: number): boolean {
	const high = text.charCodeAt(index - 1);
	const low = text.charCodeAt(index);
	return high >= 0xd8_00 && high <= 0xdb_ff && low >= 0xdc_00 && low <= 0xdf_ff;
}

/**
 * The edits that carry `base` to `next`, as an operation rather than a replacement.
 *
 * Returns an empty array when they already agree, which is the case that matters
 * most: a file whose body you never touched must produce no operations at all,
 * so a peer's work is never overwritten by an accurate picture of a stale world.
 */
export function textEdits(base: string, next: string): TextEdit[] {
	if (base === next) return [];

	const shorter = Math.min(base.length, next.length);

	let head = 0;
	while (head < shorter && base[head] === next[head]) head++;
	if (head > 0 && head < shorter && splitsSurrogatePair(base, head)) head--;

	let tail = 0;
	while (
		tail < shorter - head &&
		base[base.length - 1 - tail] === next[next.length - 1 - tail]
	) {
		tail++;
	}
	if (tail > 0 && splitsSurrogatePair(base, base.length - tail)) tail--;

	return [
		{
			at: head,
			remove: base.length - head - tail,
			insert: next.slice(head, next.length - tail),
		},
	];
}

/** Apply edits to a plain string. The reference `Y.Text` mirrors this exactly. */
export function applyTextEdits(
	base: string,
	edits: readonly TextEdit[],
): string {
	let text = base;
	for (const edit of edits) {
		text =
			text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove);
	}
	return text;
}
