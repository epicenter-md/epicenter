# Handoff: Opensidian Internal Links: Phase 1 & 2 [Implemented]

## Task

Implement internal document links for `apps/opensidian/`. Users type `[[` in the CodeMirror editor, get an autocomplete dropdown of files, select one, and a standard markdown link `[File Name](id:GUID)` is inserted. Clicking a decorated link navigates to the target file. The markdown materializer converts `id:` links to `[[wikilinks]]` in `.md` export. This covers Phases 1-2 of the spec at `docs/specs/20260406T150000 opensidian-internal-links.md`.

Load these skills before starting: `monorepo`, `svelte`, `typescript`, `error-handling`, `control-flow`, `styling`, `documentation`.

## Context

### Monorepo Structure

```
apps/opensidian/          ← SvelteKit app, the note-taking app
packages/filesystem/      ← filesTable, FileId, virtual filesystem
packages/workspace/       ← CRDT workspace core (Yjs, timeline, materializer)
packages/ui/              ← shadcn-svelte components
```

Run commands with `bun`. Dev server: `bun dev` from `apps/opensidian/`. Tests: `bun test` from package root.

### The Data Model

Opensidian uses `filesTable` from `@epicenter/filesystem` as its only table. Each file row has a content Y.Doc via `.withDocument('content', { guid: 'id' })`.

**`packages/filesystem/src/table.ts`**: the table definition:
```typescript
export const filesTable = defineTable(
	type({
		id: FileId,
		name: 'string',
		parentId: FileId.or(type.null),
		type: "'file' | 'folder'",
		size: 'number',
		createdAt: 'number',
		updatedAt: 'number',
		trashedAt: 'number | null',
		_v: '1',
	}),
).withDocument('content', {
	guid: 'id',
	onUpdate: () => ({ updatedAt: Date.now() }),
});
```

**`packages/filesystem/src/ids.ts`**: FileId is a branded Guid:
```typescript
export type FileId = Guid & Brand<'FileId'>;
export const FileId = type('string').as<FileId>();
export function generateFileId(): FileId {
	return generateGuid() as FileId;
}
```

### Workspace Definition

**`apps/opensidian/src/lib/workspace/definition.ts`**:
```typescript
import { filesTable } from '@epicenter/filesystem';
import { defineWorkspace } from '@epicenter/workspace';

export const opensidianDefinition = defineWorkspace({
	id: 'opensidian',
	tables: { files: filesTable },
});
```

**`apps/opensidian/src/lib/workspace/workspace.ts`**:
```typescript
import { createWorkspace } from '@epicenter/workspace';
import { opensidianDefinition } from './definition';

export function createOpensidian() {
	return createWorkspace(opensidianDefinition);
}
```

### Client & State

**`apps/opensidian/src/lib/session.svelte.ts`**:
```typescript
const signedIn = getSignedInSession();
const workspace = signedIn.workspace;
const files = signedIn.state.files;
```

**`apps/opensidian/src/lib/state/files-state.svelte.ts`**:
- `signedIn.state.files.activeFileId`: currently open file (`FileId | null`)
- `signedIn.state.files.selectFile(id)`: navigate to a file and open its tab
- `signedIn.state.files.getFile(id)`: get a `FileRow` by ID
- `signedIn.state.files.walkTree(visitor)`: walk the file tree, collecting results
- `fromTable(workspace.tables.files)`: reactive SvelteMap of all file rows

### Current Editor Components

**`apps/opensidian/src/lib/components/editor/ContentEditor.svelte`**:
```svelte
<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import { getSignedInSession } from '$lib/session.svelte';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	const signedIn = getSignedInSession();

	let { fileId }: { fileId: FileId } = $props();
	const doc = fromDisposableCache(
		signedIn.workspace.fileContentDocs,
		() => fileId,
	);
</script>

{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then _}
	<CodeMirrorEditor ytext={doc.current.content.asText()} />
{/await}
```

**`apps/opensidian/src/lib/components/editor/CodeMirrorEditor.svelte`**:
```svelte
<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { EditorState } from '@codemirror/state';
	import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import type * as Y from 'yjs';

	let { ytext }: { ytext: Y.Text } = $props();
	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!container) return;
		const view = new EditorView({
			state: EditorState.create({
				doc: ytext.toString(),
				extensions: [
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					syntaxHighlighting(defaultHighlightStyle),
					markdown(),
					yCollab(ytext, null),
					placeholder('Empty file'),
					EditorView.theme({ /* ... */ }),
				],
			}),
			parent: container,
		});
		return () => view.destroy();
	});
</script>

<div class="h-full w-full overflow-hidden bg-transparent" bind:this={container}></div>
```

### Materializer (for Phase 1.2)

**`packages/workspace/src/extensions/materializer/markdown/markdown.ts`**: the `markdownMaterializer` extension serializes table rows to `.md` files. Each table gets a `serializer` that produces `{ frontmatter, body, filename }`. The materializer calls `serializer.serialize(row)` for each row and writes frontmatter + body to disk.

**`packages/workspace/src/extensions/materializer/markdown/serializers.ts`**: contains `defaultSerializer()` and `MarkdownSerializer` / `MarkdownDeserializer` types. The serializer's `serialize` function receives the full row as `Record<string, unknown>` and returns `{ frontmatter, body?, filename }`.

### Richtext Link Handling (reference, not modified in this phase)

**`packages/workspace/src/timeline/richtext.ts`**: the `collectInlineRuns` function handles markdown links:
```typescript
case 'link':
	collectInlineRuns(
		node.children,
		{ ...inheritedAttrs, link: { href: node.url } },
		runs,
	);
```

Links in Y.XmlFragment are stored as inline attributes `{ link: { href: url } }` on text runs. This is how external links already work. Internal links will use the same shape with `href: "id:GUID"`.

## Design

### The `id:` Scheme

Internal links use standard markdown link syntax with an `id:` URI scheme prefix:

```markdown
[Meeting Notes](id:01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b)
```

- `id:` prefix is the discriminator. Detection: `href.startsWith('id:')`.
- The GUID after `id:` is a FileId from `filesTable`.
- Works in both Y.Text (literal characters) and Y.XmlFragment (link mark with `{ link: { href: "id:..." } }`).
- Wikilinks `[[Page Name]]` only appear in the `.md` materializer output: never in the CRDT.

### Link Utilities

Create `packages/filesystem/src/links.ts`:

```typescript
import type { FileId } from './ids.js';

const ID_SCHEME = 'id:';

export function isInternalLink(href: string): boolean {
	return href.startsWith(ID_SCHEME);
}

export function getTargetFileId(href: string): FileId {
	return href.slice(ID_SCHEME.length) as FileId;
}

export function makeInternalHref(fileId: FileId): string {
	return `${ID_SCHEME}${fileId}`;
}
```

Export these from `packages/filesystem/src/index.ts`.

### CodeMirror Integration

Two CodeMirror extensions are needed, created as separate files in `apps/opensidian/src/lib/components/editor/extensions/`:

1. **Link decorations** (`link-decorations.ts`): A ViewPlugin that scans the visible document for `[text](id:GUID)` patterns using regex, creates `Decoration.replace` widgets for each match that render as styled clickable spans showing just the display text. Must skip matches inside code blocks (check syntax tree node type). On click, call a provided `onNavigate(fileId)` callback.

2. **Wikilink autocomplete** (`wikilink-autocomplete.ts`): A CodeMirror `autocompletion` source triggered by `[[`. When the user types `[[`, query `workspace.tables.files.getAllValid()` for file rows where `type === 'file'`, filter by what's typed after `[[`, and show a dropdown. On selection, delete the `[[` trigger characters and insert `[File Name](id:GUID)` at the cursor position.

Wire both extensions into `CodeMirrorEditor.svelte`'s extensions array.

### Materializer Changes

In the materializer's serializer output, post-process the `body` string: replace markdown links matching `\[([^\]]+)\]\(id:([^)]+)\)` with `[[$1]]` (wikilink syntax). This happens in the serialize step before writing to disk.

For `pushFromMarkdown` (import direction), replace `\[\[([^\]]+)\]\]` with `[resolved-name](id:GUID)` by looking up the name in `filesTable`. If ambiguous or not found, leave as literal `[[name]]`.

## Phase 1 Tasks (Core Utilities + Materializer)

### 1.1 Create `packages/filesystem/src/links.ts`

- [x] `isInternalLink(href: string): boolean`
- [x] `getTargetFileId(href: string): FileId`
- [x] `makeInternalHref(fileId: FileId): string`
- [x] `convertInternalLinksToWikilinks(body: string): string`
- [x] `convertWikilinksToInternalLinks(body: string, resolveName): string`
- [x] Export from `packages/filesystem/src/index.ts`
- [x] Add tests in `packages/filesystem/src/links.test.ts`

### 1.2 Materializer: `id:` links → `[[wikilinks]]` in `.md` output

- [x] Added `convertInternalLinksToWikilinks` post-processing in `markdown.ts` before both `toMarkdown()` call sites (initial materialization + observer)

Regex: `/\[([^\]]+)\]\(id:[^)]+\)/g` → `[[$1]]`

This only applies to the body content, not frontmatter.

### 1.3 Materializer: `[[wikilinks]]` → `id:` links on import

- [x] `convertWikilinksToInternalLinks` utility created and tested
- [ ] Wire into `pushFromMarkdown`: deferred because `pushFromMarkdown` does not exist yet in the codebase (only referenced in README as planned feature)
  > **Note**: The utility function is ready in `@epicenter/filesystem`. When `pushFromMarkdown` is implemented, call `convertWikilinksToInternalLinks(body, resolveName)` on the parsed body before passing to the deserializer.

## Phase 2 Tasks (Editor Integration)

### 2.1 Link decoration plugin

- [x] Created `apps/opensidian/src/lib/components/editor/extensions/link-decorations.ts`
- [x] ViewPlugin scans visible ranges, skips code blocks, creates Decoration.replace widgets
- [x] Config: `{ onNavigate, resolveTitle? }`

### 2.2 Wikilink autocomplete

- [x] Created `apps/opensidian/src/lib/components/editor/extensions/wikilink-autocomplete.ts`
- [x] Installed `@codemirror/autocomplete@6.20.1` (was not available)
- [x] CompletionSource triggered by `[[`, filters files, inserts `[Name](id:GUID)`
- [x] Config: `{ getFiles }`

### 2.3 Wire into CodeMirrorEditor.svelte

- [x] `CodeMirrorEditor.svelte` accepts `onNavigate`, `resolveTitle`, `getFiles` props
- [x] Both extensions added to the CodeMirror extensions array
- [x] `ContentEditor.svelte` passes `signedIn.state.files.selectFile`, `signedIn.state.files.getFile(...).name`, and the workspace file list

## MUST DO

- Use `bun` for all commands (never npm/yarn/pnpm)
- Follow Svelte 5 runes patterns (`$props()`, `$derived`, `$state`): no legacy `export let` or stores
- Follow existing TypeScript conventions: `type` not `interface`, branded IDs, co-located types
- Export link utilities from `packages/filesystem/src/index.ts`
- Write tests for link utilities (`links.test.ts`)
- Use `FileId` branded type: never raw `string` for file IDs
- Check `lsp_diagnostics` on every changed file before marking a task complete
- Keep changes minimal: don't refactor existing code
- Em dashes are closed (no spaces): `text. Text` not `text: text`
- JSDoc on all public exports with `@example` blocks

## MUST NOT DO

- Do not store the link graph in Yjs / Y.Doc / Y.Map: it's derived data, computed locally
- Do not store `[[wikilink]]` syntax in the CRDT: wikilinks only exist in materializer `.md` output
- Do not modify `packages/workspace/src/timeline/richtext.ts`: Phase 4 concern
- Do not modify `packages/workspace/src/timeline/timeline.ts`
- Do not install new dependencies (CodeMirror's `@codemirror/autocomplete` should already be available via `@codemirror/view` or install it if genuinely missing, but check first)
- Do not create a backlinks panel (Phase 3)
- Do not add TipTap/ProseMirror richtext support (Phase 4)
- Do not modify any files outside `apps/opensidian/` and `packages/filesystem/` (exception: materializer serializers if needed for Phase 1.2)
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Do not commit unless explicitly asked

## Review

**Status**: Implemented
**Date**: 2026-04-06
**Branch**: feat/fix-dashboard

### Summary

Implemented internal document links for opensidian across two phases. Phase 1 added link utilities (`isInternalLink`, `getTargetFileId`, `makeInternalHref`, plus bidirectional conversion functions) to `@epicenter/filesystem` and wired the export direction into the markdown materializer. Phase 2 created two CodeMirror extensions. Link decorations (ViewPlugin rendering `[text](id:GUID)` as styled clickable spans) and wikilink autocomplete (`[[` trigger → file dropdown → markdown link insertion): then wired both into the editor components.

### Deviations from Spec

- **Phase 1.3 partially deferred**: `pushFromMarkdown` does not exist in the codebase (only appears in the workspace README as a planned feature). The `convertWikilinksToInternalLinks` utility was created and tested, ready to wire when `pushFromMarkdown` is implemented.
- **`@codemirror/autocomplete` installed**: The spec noted to check first. It was genuinely missing, so it was added as a dependency. Required deduplicating `@codemirror/view` versions (6.40→6.41) afterward.
- **Two additional conversion functions added to links.ts**: `convertInternalLinksToWikilinks` and `convertWikilinksToInternalLinks` were added alongside the three specified utilities, since the materializer needs them.

### Follow-up Work

- Wire `convertWikilinksToInternalLinks` into `pushFromMarkdown` when it's implemented
- Cmd/Ctrl+click to open link in new tab (spec mentions as future)
- Backlinks panel (Phase 3)
- TipTap/ProseMirror richtext support for `id:` links in Y.XmlFragment (Phase 4)
