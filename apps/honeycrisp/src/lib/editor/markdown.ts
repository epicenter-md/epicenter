/**
 * The Markdown form of a note's body (ADR-0264/0267).
 *
 * One pair of pure functions between the body's ProseMirror document and the
 * export file's body text. `serializeNoteBody` extends the CommonMark default
 * with what `noteSchema` adds over the basic schema: `~~strike~~` and GFM task
 * lists (`- [x]`). `parseNoteBody` mirrors it, so a note round-trips through
 * its own export.
 *
 * Underline is the one deliberate loss: Markdown has no underline, so the text
 * survives and the mark does not. That is this codec's own fidelity choice,
 * exactly the kind ADR-0267 leaves to the application.
 */
import MarkdownIt from 'markdown-it';
import {
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	MarkdownParser,
	MarkdownSerializer,
} from 'prosemirror-markdown';
import { Fragment, type Node, type NodeType } from 'prosemirror-model';

import { noteSchema } from './schema.js';

// The node map is typed by its OrderedMap spec, not by name. `noteSchema`
// declares every one of these nodes, or its constructor would have thrown at
// module load.
const { bullet_list, list_item, paragraph, taskItem, taskList } =
	noteSchema.nodes as unknown as Record<
		'bullet_list' | 'list_item' | 'paragraph' | 'taskItem' | 'taskList',
		NodeType
	>;

const serializer = new MarkdownSerializer(
	{
		...defaultMarkdownSerializer.nodes,
		taskList(state, node) {
			state.renderList(node, '  ', (index) =>
				node.child(index).attrs.checked ? '- [x] ' : '- [ ] ',
			);
		},
		taskItem(state, node) {
			state.renderContent(node);
		},
	},
	{
		...defaultMarkdownSerializer.marks,
		strike: {
			open: '~~',
			close: '~~',
			mixable: true,
			expelEnclosingWhitespace: true,
		},
		underline: { open: '', close: '', mixable: true },
	},
);

export function serializeNoteBody(body: Node): string {
	return serializer.serialize(body, { tightLists: true });
}

/**
 * CommonMark plus strikethrough, matching what the serializer emits. Inline
 * HTML stays off: a note's body is prose, and `<u>` coming back as literal
 * text is better than an HTML parser in the import path.
 */
const tokenizer = MarkdownIt('commonmark', { html: false }).enable(
	'strikethrough',
);

const parser = new MarkdownParser(noteSchema, tokenizer, {
	...defaultMarkdownParser.tokens,
	s: { mark: 'strike' },
});

export function parseNoteBody(text: string): Node {
	return withTaskLists(parser.parse(text));
}

/**
 * `- [x] ` at the head of a list item's first paragraph, GFM's task marker.
 *
 * markdown-it tokenizes a task list as an ordinary bullet list with the marker
 * as literal text, so the marker is lifted back into `taskItem` after parsing
 * rather than taught to the tokenizer.
 */
const TASK_MARKER = /^\[([ xX])\] /;

/**
 * Rebuild the parsed document with every task-shaped bullet list lifted into a
 * `taskList`.
 *
 * A bullet list converts only when EVERY item carries the marker, because
 * `taskList` holds nothing but `taskItem`s: a hand-written list mixing the two
 * shapes stays a bullet list with its markers as visible text, which is also
 * what it looked like in the file.
 */
function withTaskLists(node: Node): Node {
	if (node.isText) return node;
	const children: Node[] = [];
	node.forEach((child) => {
		children.push(withTaskLists(child));
	});
	if (
		node.type === bullet_list &&
		children.length > 0 &&
		children.every(isTaskShaped)
	) {
		return taskList.create(null, children.map(intoTaskItem));
	}
	return node.copy(Fragment.from(children));
}

function isTaskShaped(item: Node): boolean {
	const first = item.firstChild;
	return (
		item.type === list_item &&
		first !== null &&
		first.type === paragraph &&
		TASK_MARKER.test(first.textContent)
	);
}

function intoTaskItem(item: Node): Node {
	// `isTaskShaped` admitted this item, so the first child is a paragraph whose
	// text opens with the marker.
	const first = item.firstChild as Node;
	const marker = TASK_MARKER.exec(first.textContent) as RegExpExecArray;
	const content: Node[] = [first.cut(marker[0].length)];
	for (let index = 1; index < item.childCount; index += 1) {
		content.push(item.child(index));
	}
	return taskItem.create({ checked: marker[1] !== ' ' }, content);
}
