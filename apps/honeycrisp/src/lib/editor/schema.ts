/**
 * Honeycrisp's ProseMirror schema for a note's body.
 *
 * Shared so both the live editor (`Editor.svelte`) and the store-run `derive`
 * (`../data`) convert the same document shape (ADR-0264). The editor binds
 * it to a view; `derive` uses it headlessly to read a note's title and preview
 * off the body document.
 */
import { type MarkSpec, type NodeSpec, Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

const taskList = {
	group: 'block',
	content: 'taskItem+',
	parseDOM: [{ tag: 'ul.task-list' }],
	toDOM: () => ['ul', { class: 'task-list' }, 0],
} satisfies NodeSpec;

const taskItem = {
	content: 'paragraph block*',
	attrs: { checked: { default: false } },
	parseDOM: [
		{
			tag: 'li.task-item',
			getAttrs: (dom) => {
				if (!(dom instanceof HTMLElement)) return false;
				return { checked: dom.dataset.checked === 'true' };
			},
		},
	],
	toDOM: (node) => [
		'li',
		{
			class: 'task-item',
			'data-checked': node.attrs.checked ? 'true' : 'false',
		},
		[
			'label',
			{ contenteditable: 'false' },
			[
				'input',
				{
					type: 'checkbox',
					checked: node.attrs.checked ? 'checked' : undefined,
				},
			],
		],
		['div', 0],
	],
} satisfies NodeSpec;

const underline = {
	parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
	toDOM: () => ['u', 0],
} satisfies MarkSpec;

const strike = {
	parseDOM: [
		{ tag: 's' },
		{ tag: 'del' },
		{ tag: 'strike' },
		{ style: 'text-decoration=line-through' },
	],
	toDOM: () => ['s', 0],
} satisfies MarkSpec;

const nodes = addListNodes(
	basicSchema.spec.nodes.append({ taskList, taskItem }),
	'paragraph block*',
	'block',
);

export const noteSchema = new Schema({
	nodes,
	marks: basicSchema.spec.marks.append({ underline, strike }),
});
