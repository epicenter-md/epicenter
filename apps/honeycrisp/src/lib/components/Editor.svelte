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
	import { Editor, Extension } from '@tiptap/core';
	import Placeholder from '@tiptap/extension-placeholder';
	import TaskItem from '@tiptap/extension-task-item';
	import TaskList from '@tiptap/extension-task-list';
	import Underline from '@tiptap/extension-underline';
	import StarterKit from '@tiptap/starter-kit';
	import { ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';

	let {
		yxmlfragment,
		onContentChange,
	}: {
		yxmlfragment: Y.XmlFragment;
		onContentChange?: (content: { title: string; preview: string; wordCount: number }) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();
	let editor: Editor | undefined = $state();
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

	/**
	 * Create a Tiptap extension that wraps y-prosemirror plugins for Yjs collaboration.
	 *
	 * Uses ySyncPlugin for binding ProseMirror state to Y.XmlFragment, and yUndoPlugin for
	 * collaborative undo/redo that respects per-client origins.
	 */
	function createYjsExtension(xmlFragment: Y.XmlFragment) {
		return Extension.create({
			name: 'yjs-collaboration',
			addProseMirrorPlugins() {
				return [ySyncPlugin(xmlFragment), yUndoPlugin()];
			},
		});
	}

	function extractTitleAndPreview(ed: Editor): {
		title: string;
		preview: string;
		wordCount: number;
	} {
		const text = ed.getText();
		const firstNewline = text.indexOf('\n');
		const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
		const trimmed = text.trim();
		return {
			title: firstLine.slice(0, 80).trim(),
			preview: text.slice(0, 100).trim(),
			wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
		};
	}

	$effect(() => {
		if (!element) return;

		const yjsExtension = createYjsExtension(yxmlfragment);

		const ed = new Editor({
			element,
			extensions: [
				StarterKit.configure({
					// Disable built-in history — yUndoPlugin handles undo/redo
					history: false,
				}),
				Placeholder.configure({
					placeholder: 'Start writing…',
				}),
				TaskList,
				TaskItem.configure({ nested: true }),
				Underline,
				yjsExtension,
			],
			editorProps: {
				attributes: {
					class:
						'prose dark:prose-invert max-w-none focus:outline-none min-h-full',
				},
			},
			onUpdate({ editor: ed }) {
				if (!onContentChange) return;
				onContentChange(extractTitleAndPreview(ed));
			},
			onTransaction({ editor: ed }) {
				activeFormats = {
					bold: ed.isActive('bold'),
					italic: ed.isActive('italic'),
					underline: ed.isActive('underline'),
					strike: ed.isActive('strike'),
					heading1: ed.isActive('heading', { level: 1 }),
					heading2: ed.isActive('heading', { level: 2 }),
					heading3: ed.isActive('heading', { level: 3 }),
					bulletList: ed.isActive('bulletList'),
					orderedList: ed.isActive('orderedList'),
					taskList: ed.isActive('taskList'),
					blockquote: ed.isActive('blockquote'),
				};
			},
		});

		editor = ed;

		// Fire initial content extraction
		if (onContentChange) {
			onContentChange(extractTitleAndPreview(ed));
		}

		return () => {
			ed.destroy();
			editor = undefined;
		};
	});
</script>

<div class="flex h-full flex-col">
	{#if editor}
		<div class="flex items-center gap-1 border-b p-2">
			<Tooltip.Root>
				<Tooltip.Trigger>
					<Toggle
						size="sm"
						pressed={activeFormats.bold}
						onPressedChange={() => editor?.chain().focus().toggleBold().run()}
					>
						<BoldIcon class="size-4" />
					</Toggle>
				</Tooltip.Trigger>
				<Tooltip.Content>Bold (⌘B)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<Toggle
						size="sm"
						pressed={activeFormats.italic}
						onPressedChange={() => editor?.chain().focus().toggleItalic().run()}
					>
						<ItalicIcon class="size-4" />
					</Toggle>
				</Tooltip.Trigger>
				<Tooltip.Content>Italic (⌘I)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<Toggle
						size="sm"
						pressed={activeFormats.underline}
						onPressedChange={() => editor?.chain().focus().toggleUnderline().run()}
					>
						<UnderlineIcon class="size-4" />
					</Toggle>
				</Tooltip.Trigger>
				<Tooltip.Content>Underline (⌘U)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<Toggle
						size="sm"
						pressed={activeFormats.strike}
						onPressedChange={() => editor?.chain().focus().toggleStrike().run()}
					>
						<StrikethroughIcon class="size-4" />
					</Toggle>
				</Tooltip.Trigger>
				<Tooltip.Content>Strikethrough (⌘⇧S)</Tooltip.Content>
			</Tooltip.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeFormats.heading1 ? 'h1' : activeFormats.heading2 ? 'h2' : activeFormats.heading3 ? 'h3' : ''}
				onValueChange={(v) => {
					if (v === 'h1') editor?.chain().focus().toggleHeading({ level: 1 }).run();
					else if (v === 'h2') editor?.chain().focus().toggleHeading({ level: 2 }).run();
					else if (v === 'h3') editor?.chain().focus().toggleHeading({ level: 3 }).run();
				}}
			>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="h1"
							><Heading1Icon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Heading 1</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="h2"
							><Heading2Icon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Heading 2</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="h3"
							><Heading3Icon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Heading 3</Tooltip.Content>
				</Tooltip.Root>
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeFormats.bulletList
					? 'bullet'
					: activeFormats.orderedList
						? 'ordered'
						: activeFormats.taskList
							? 'task'
							: ''}
				onValueChange={(v) => {
					if (v === 'bullet') editor?.chain().focus().toggleBulletList().run();
					else if (v === 'ordered') editor?.chain().focus().toggleOrderedList().run();
					else if (v === 'task') editor?.chain().focus().toggleTaskList().run();
				}}
			>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="bullet"
							><ListIcon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Bullet List</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="ordered"
							><ListOrderedIcon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Ordered List</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<ToggleGroup.Item value="task"
							><ListChecksIcon class="size-4" /></ToggleGroup.Item
						>
					</Tooltip.Trigger>
					<Tooltip.Content>Checklist</Tooltip.Content>
				</Tooltip.Root>
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<Tooltip.Root>
				<Tooltip.Trigger>
					<Toggle
						size="sm"
						pressed={activeFormats.blockquote}
						onPressedChange={() => editor?.chain().focus().toggleBlockquote().run()}
					>
						<QuoteIcon class="size-4" />
					</Toggle>
				</Tooltip.Trigger>
				<Tooltip.Content>Blockquote (⌘⇧B)</Tooltip.Content>
			</Tooltip.Root>
		</div>
	{/if}
	<div bind:this={element} class="flex-1 overflow-y-auto p-8"></div>
</div>

<style>
	:global(.tiptap) {
		min-height: 100%;
	}
	:global(.tiptap > *:first-child) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
	}
	:global(.tiptap p.is-editor-empty:first-child::before) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.tiptap ul[data-type="taskList"]) {
		list-style: none;
		padding-left: 0;
	}
	:global(.tiptap ul[data-type="taskList"] li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	:global(.tiptap ul[data-type="taskList"] li > label) {
		margin-top: 0.25rem;
	}
</style>
