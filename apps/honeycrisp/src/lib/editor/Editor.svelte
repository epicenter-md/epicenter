<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import Heading1Icon from '@lucide/svelte/icons/heading-1';
	import Heading2Icon from '@lucide/svelte/icons/heading-2';
	import Heading3Icon from '@lucide/svelte/icons/heading-3';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import UnderlineIcon from '@lucide/svelte/icons/underline';
	import {
		baseKeymap,
		chainCommands,
		lift,
		setBlockType,
		toggleMark,
		wrapIn,
	} from 'prosemirror-commands';
	import {
		ellipsis,
		emDash,
		inputRules,
		smartQuotes,
		textblockTypeInputRule,
		wrappingInputRule,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import {
		type MarkSpec,
		type MarkType,
		type Node,
		type NodeSpec,
		type NodeType,
		Schema,
	} from 'prosemirror-model';
	import { schema as basicSchema } from 'prosemirror-schema-basic';
	import {
		addListNodes,
		liftListItem,
		sinkListItem,
		splitListItem,
		wrapInList,
	} from 'prosemirror-schema-list';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { redo, undo, ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';

	const taskList: NodeSpec = {
		group: 'block',
		content: 'taskItem+',
		parseDOM: [{ tag: 'ul.task-list' }],
		toDOM: () => ['ul', { class: 'task-list' }, 0],
	};

	const taskItem: NodeSpec = {
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
	};

	const underline: MarkSpec = {
		parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
		toDOM: () => ['u', 0],
	};

	const strike: MarkSpec = {
		parseDOM: [
			{ tag: 's' },
			{ tag: 'del' },
			{ tag: 'strike' },
			{ style: 'text-decoration=line-through' },
		],
		toDOM: () => ['s', 0],
	};

	const nodes = addListNodes(
		basicSchema.spec.nodes.append({ taskList, taskItem }),
		'paragraph block*',
		'block',
	);

	const schema = new Schema({
		nodes,
		marks: basicSchema.spec.marks.append({ underline, strike }),
	});

	function markActive(state: EditorState, markType: MarkType): boolean {
		const { from, $from: resolvedFrom, to, empty } = state.selection;
		if (empty)
			return !!markType.isInSet(state.storedMarks || resolvedFrom.marks());
		return state.doc.rangeHasMark(from, to, markType);
	}

	function nodeActive(
		state: EditorState,
		nodeType: NodeType,
		attrs?: Record<string, unknown>,
	): boolean {
		const { $from: resolvedFrom } = state.selection;

		for (let depth = resolvedFrom.depth; depth >= 0; depth -= 1) {
			const node = resolvedFrom.node(depth);
			if (node.type !== nodeType) continue;
			if (!attrs) return true;
			if (Object.entries(attrs).every(([key, val]) => node.attrs[key] === val))
				return true;
		}

		return false;
	}

	function createPlaceholderPlugin(text: string) {
		return new Plugin({
			props: {
				decorations(state) {
					const { doc } = state;
					if (
						doc.childCount === 1 &&
						doc.firstChild?.isTextblock &&
						doc.firstChild.content.size === 0
					) {
						return DecorationSet.create(doc, [
							Decoration.node(0, doc.firstChild.nodeSize, {
								class: 'is-editor-empty',
								'data-placeholder': text,
							}),
						]);
					}
					return DecorationSet.empty;
				},
			},
		});
	}

	function createTaskItemPlugin() {
		return new Plugin({
			props: {
				handleClickOn(view, _pos, node, nodePos, event) {
					if (node.type !== schema.nodes.taskItem) return false;
					const target = event.target;
					if (
						!(target instanceof HTMLInputElement) ||
						target.type !== 'checkbox'
					)
						return false;
					event.preventDefault();
					view.dispatch(
						view.state.tr.setNodeMarkup(nodePos, undefined, {
							...node.attrs,
							checked: !node.attrs.checked,
						}),
					);
					return true;
				},
			},
		});
	}

	function updateActiveFormats(state: EditorState) {
		activeFormats = {
			bold: markActive(state, schema.marks.strong!),
			italic: markActive(state, schema.marks.em!),
			underline: markActive(state, schema.marks.underline!),
			strike: markActive(state, schema.marks.strike!),
			heading1: nodeActive(state, schema.nodes.heading!, { level: 1 }),
			heading2: nodeActive(state, schema.nodes.heading!, { level: 2 }),
			heading3: nodeActive(state, schema.nodes.heading!, { level: 3 }),
			bulletList: nodeActive(state, schema.nodes.bullet_list!),
			orderedList: nodeActive(state, schema.nodes.ordered_list!),
			taskList: nodeActive(state, schema.nodes.taskList!),
			blockquote: nodeActive(state, schema.nodes.blockquote!),
		};
	}

	/**
	 * Extract title, preview, and word count from the ProseMirror document.
	 *
	 * Title is the first line (up to 80 chars), preview is the first 100 chars,
	 * and word count is computed by splitting on whitespace.
	 */
	function extractTitleAndPreview(doc: Node): {
		title: string;
		preview: string;
		wordCount: number;
	} {
		const text = doc.textContent;
		const firstNewline = text.indexOf('\n');
		const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
		const trimmed = text.trim();
		return {
			title: firstLine.slice(0, 80).trim(),
			preview: text.slice(0, 100).trim(),
			wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
		};
	}

	let {
		yxmlfragment,
		onContentChange,
	}: {
		yxmlfragment: Y.XmlFragment;
		onContentChange?: (content: {
			title: string;
			preview: string;
			wordCount: number;
		}) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();
	let view: EditorView | undefined = $state();
	let activeFormats = $state({
		bold: false,
		italic: false,
		underline: false,
		strike: false,
		heading1: false,
		heading2: false,
		heading3: false,
		bulletList: false,
		orderedList: false,
		taskList: false,
		blockquote: false,
	});

	const activeHeading = $derived.by(() => {
		if (activeFormats.heading1) return 'h1';
		if (activeFormats.heading2) return 'h2';
		if (activeFormats.heading3) return 'h3';
		return '';
	});

	const activeListType = $derived.by(() => {
		if (activeFormats.bulletList) return 'bullet';
		if (activeFormats.orderedList) return 'ordered';
		if (activeFormats.taskList) return 'task';
		return '';
	});

	$effect(() => {
		if (!element) return;

		let currentView: EditorView;

		currentView = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					ySyncPlugin(yxmlfragment),
					yUndoPlugin(),
					createPlaceholderPlugin('Start writing…'),
					createTaskItemPlugin(),
					keymap({
						'Mod-z': undo,
						'Mod-y': redo,
						'Mod-Shift-z': redo,
						'Mod-b': toggleMark(schema.marks.strong!),
						'Mod-i': toggleMark(schema.marks.em!),
						'Mod-u': toggleMark(schema.marks.underline!),
						'Mod-Shift-s': toggleMark(schema.marks.strike!),
						'Mod-Shift-b': () => {
							if (nodeActive(currentView.state, schema.nodes.blockquote!)) {
								return lift(currentView.state, currentView.dispatch);
							}
							return wrapIn(schema.nodes.blockquote!)(
								currentView.state,
								currentView.dispatch,
							);
						},
						Enter: chainCommands(
							splitListItem(schema.nodes.taskItem!),
							splitListItem(schema.nodes.list_item!),
							baseKeymap.Enter!,
						),
						'Mod-]': (state, dispatch) =>
							sinkListItem(schema.nodes.taskItem!)(state, dispatch) ||
							sinkListItem(schema.nodes.list_item!)(state, dispatch),
						Tab: (state, dispatch) =>
							sinkListItem(schema.nodes.taskItem!)(state, dispatch) ||
							sinkListItem(schema.nodes.list_item!)(state, dispatch),
						'Mod-[': (state, dispatch) =>
							liftListItem(schema.nodes.taskItem!)(state, dispatch) ||
							liftListItem(schema.nodes.list_item!)(state, dispatch),
						'Shift-Tab': (state, dispatch) =>
							liftListItem(schema.nodes.taskItem!)(state, dispatch) ||
							liftListItem(schema.nodes.list_item!)(state, dispatch),
					}),
					keymap(baseKeymap),
					inputRules({
						rules: [
							...smartQuotes,
							emDash,
							ellipsis,
							textblockTypeInputRule(
								/^(#{1,3})\s$/,
								schema.nodes.heading!,
								(match) => ({
									level: match[1]!.length,
								}),
							),
							wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
							wrappingInputRule(
								/^(\d+)\.\s$/,
								schema.nodes.ordered_list!,
								(match) => ({ order: Number(match[1]) }),
								(match, node) =>
									node.childCount + node.attrs.order === Number(match[1]),
							),
							wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
							textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
						],
					}),
				],
			}),
			attributes: {
				class:
					'prose dark:prose-invert max-w-none focus:outline-none min-h-full',
			},
			dispatchTransaction(tr) {
				const newState = currentView.state.apply(tr);
				currentView.updateState(newState);
				updateActiveFormats(newState);
				if (tr.docChanged && onContentChange) {
					onContentChange(extractTitleAndPreview(newState.doc));
				}
			},
		});

		view = currentView;
		updateActiveFormats(currentView.state);

		// Fire initial content extraction
		if (onContentChange) {
			onContentChange(extractTitleAndPreview(currentView.state.doc));
		}

		return () => {
			currentView.destroy();
			view = undefined;
		};
	});
</script>

{#snippet toggleButton(pressed: boolean, onToggle: () => void, icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Toggle size="sm" {pressed} onPressedChange={onToggle}>
				<svelte:component this={icon} class="size-4" />
			</Toggle>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{#snippet groupItem(value: string, icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<ToggleGroup.Item {value}>
				<svelte:component this={icon} class="size-4" />
			</ToggleGroup.Item>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<div class="flex h-full flex-col">
	{#if view}
		<div class="flex items-center gap-1 border-b p-2">
			{@render toggleButton(activeFormats.bold, () => { toggleMark(schema.marks.strong!)(view!.state, view!.dispatch); view!.focus(); }, BoldIcon, 'Bold (⌘B)')}
			{@render toggleButton(activeFormats.italic, () => { toggleMark(schema.marks.em!)(view!.state, view!.dispatch); view!.focus(); }, ItalicIcon, 'Italic (⌘I)')}
			{@render toggleButton(activeFormats.underline, () => { toggleMark(schema.marks.underline!)(view!.state, view!.dispatch); view!.focus(); }, UnderlineIcon, 'Underline (⌘U)')}
			{@render toggleButton(activeFormats.strike, () => { toggleMark(schema.marks.strike!)(view!.state, view!.dispatch); view!.focus(); }, StrikethroughIcon, 'Strikethrough (⌘⇧S)')}

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeHeading}
				onValueChange={(value) => {
					switch (value) {
						case 'h1':
						case 'h2':
						case 'h3': {
							const level = ({ h1: 1, h2: 2, h3: 3 } satisfies Record<'h1' | 'h2' | 'h3', number>)[value];
							const isActive = nodeActive(view!.state, schema.nodes.heading!, { level });
							if (isActive) {
								setBlockType(schema.nodes.paragraph!)(view!.state, view!.dispatch);
							} else {
								setBlockType(schema.nodes.heading!, { level })(view!.state, view!.dispatch);
							}
							view!.focus();
							break;
						}
					}
				}}
			>
				{@render groupItem('h1', Heading1Icon, 'Heading 1')}
				{@render groupItem('h2', Heading2Icon, 'Heading 2')}
				{@render groupItem('h3', Heading3Icon, 'Heading 3')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeListType}
				onValueChange={(value) => {
					if (!view) return;

					switch (value) {
						case 'bullet': {
							if (nodeActive(view.state, schema.nodes.bullet_list!)) {
								liftListItem(schema.nodes.list_item!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.bullet_list!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
						case 'ordered': {
							if (nodeActive(view.state, schema.nodes.ordered_list!)) {
								liftListItem(schema.nodes.list_item!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.ordered_list!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
						case 'task': {
							if (nodeActive(view.state, schema.nodes.taskList!)) {
								liftListItem(schema.nodes.taskItem!)(view.state, view.dispatch);
							} else {
								wrapInList(schema.nodes.taskList!)(view.state, view.dispatch);
							}
							view.focus();
							break;
						}
					}
				}}
			>
				{@render groupItem('bullet', ListIcon, 'Bullet List')}
				{@render groupItem('ordered', ListOrderedIcon, 'Ordered List')}
				{@render groupItem('task', ListChecksIcon, 'Checklist')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			{@render toggleButton(activeFormats.blockquote, () => { if (nodeActive(view!.state, schema.nodes.blockquote!)) { lift(view!.state, view!.dispatch); } else { wrapIn(schema.nodes.blockquote!)(view!.state, view!.dispatch); } view!.focus(); }, QuoteIcon, 'Blockquote (⌘⇧B)')}
		</div>
	{/if}
	<div bind:this={element} class="flex-1 overflow-y-auto p-8"></div>
</div>

<style>
	:global(.ProseMirror) {
		min-height: 100%;
	}
	:global(.ProseMirror > *:first-child) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
	}
	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.ProseMirror ul.task-list) {
		list-style: none;
		padding-left: 0;
	}
	:global(.ProseMirror ul.task-list li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	:global(.ProseMirror ul.task-list li > label) {
		margin-top: 0.25rem;
	}
</style>
