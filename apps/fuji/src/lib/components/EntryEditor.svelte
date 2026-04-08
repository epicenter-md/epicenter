<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { baseKeymap, toggleMark } from 'prosemirror-commands';
	import {
		ellipsis,
		emDash,
		inputRules,
		smartQuotes,
		textblockTypeInputRule,
		wrappingInputRule,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import { Schema } from 'prosemirror-model';
	import { schema as basicSchema } from 'prosemirror-schema-basic';
	import {
		addListNodes,
		liftListItem,
		sinkListItem,
		splitListItem,
	} from 'prosemirror-schema-list';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { format } from 'date-fns';
	import { redo, undo, ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';
	import type { Entry } from '$lib/workspace';
	import TagInput from './TagInput.svelte';

	let {
		entry,
		ytext,
		onUpdate,
		onBack,
	}: {
		entry: Entry;
		ytext: Y.Text;
		onUpdate: (
			updates: Partial<{
				title: string;
				subtitle: string;
				type: string[];
				tags: string[];
			}>,
		) => void;
		onBack: () => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	const schema = new Schema({
		nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
		marks: basicSchema.spec.marks,
	});

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

	$effect(() => {
		if (!element) return;

		const view = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					// y-prosemirror ySyncPlugin accepts Y.Text at runtime despite typed for Y.XmlFragment
					ySyncPlugin(ytext as unknown as Y.XmlFragment),
					yUndoPlugin(),
					createPlaceholderPlugin('Start writing\u2026'),
					keymap({
						'Mod-z': undo,
						'Mod-y': redo,
						'Mod-Shift-z': redo,
						'Mod-b': toggleMark(schema.marks.strong!),
						'Mod-i': toggleMark(schema.marks.em!),
						Enter: splitListItem(schema.nodes.list_item!),
						'Mod-]': sinkListItem(schema.nodes.list_item!),
						Tab: sinkListItem(schema.nodes.list_item!),
						'Mod-[': liftListItem(schema.nodes.list_item!),
						'Shift-Tab': liftListItem(schema.nodes.list_item!),
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
								(match) => ({ level: match[1]!.length }),
							),
							wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
							wrappingInputRule(
								/^(\d+)\.\s$/,
								schema.nodes.ordered_list!,
								(match) => ({ order: +match[1]! }),
								(match, node) =>
									node.childCount + node.attrs.order === +match[1]!,
							),
							wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
							textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
						],
					}),
				],
			}),
			attributes: {
				class:
					'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
			},
		});

		return () => view.destroy();
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header with back button -->
	<div class="flex items-center gap-2 border-b px-4 py-2">
		<Button variant="ghost" size="icon" class="size-7" onclick={onBack}>
			<ArrowLeftIcon class="size-4" />
		</Button>
		<span class="text-sm text-muted-foreground">Back to entries</span>
	</div>

	<!-- Entry metadata -->
	<div class="flex flex-col gap-3 border-b px-6 py-4">
		<input
			type="text"
			class="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
			placeholder="Entry title"
			value={entry.title}
			oninput={(e) => onUpdate({ title: e.currentTarget.value })}
		>
		<input
			type="text"
			class="w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/60"
			placeholder="Subtitle \u2014 a one-liner for your blog listing"
			value={entry.subtitle}
			oninput={(e) => onUpdate({ subtitle: e.currentTarget.value })}
		>

		<div class="flex flex-wrap items-center gap-4">
			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Type</span>
				<TagInput
					values={entry.type}
					placeholder="Add type\u2026"
					onAdd={(value) =>
						onUpdate({ type: [...entry.type, value] })}
					onRemove={(value) =>
						onUpdate({
							type: entry.type.filter((t) => t !== value),
						})}
				/>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Tags</span>
				<TagInput
					values={entry.tags}
					placeholder="Add tag\u2026"
					onAdd={(value) =>
						onUpdate({ tags: [...entry.tags, value] })}
					onRemove={(value) =>
						onUpdate({
							tags: entry.tags.filter((t) => t !== value),
						})}
				/>
			</div>
		</div>
	</div>

	<!-- Editor body -->
	<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>

	<!-- Timestamps footer -->
	<div
		class="flex items-center justify-end border-t px-6 py-2 text-xs text-muted-foreground"
	>
		<span>
			Created {format(parseDateTime(entry.createdAt), 'MMM d \u00b7 h:mm a')}
			\u00b7 Updated
			{format(parseDateTime(entry.updatedAt), 'MMM d \u00b7 h:mm a')}
		</span>
	</div>
</div>

<style>
	:global(.ProseMirror) {
		min-height: 100%;
	}
	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>
