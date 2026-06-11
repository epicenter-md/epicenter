# Epicenter URI Scheme for Cross-Workspace Entity References

**Date**: 2026-04-08
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the `id:` link scheme with `epicenter://` URIs that identify entities across workspaces and double as OS-level deep links. A link in an Opensidian note can point to a Whispering recording or a Honeycrisp note using the same format that Tauri's deep link handler receives when the OS routes an `epicenter://` URL to the app.

## Motivation

### Current State

Internal links use a bare `id:` prefix scoped to the current workspace:

```typescript
// packages/filesystem/src/links.ts
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

Markdown content stores links as:

```markdown
[Meeting Notes](id:01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b)
```

This creates problems:

1. **No cross-workspace references.** A link in Opensidian can't point to a Whispering recording or a Tab Manager bookmark. The `id:` scheme has no workspace or table qualifier.
2. **No deep linking.** The `id:` format isn't a registered URI scheme. Clicking it outside the app does nothing. Links can't be shared via email, Slack, or clipboard between apps.
3. **Custom parsing required.** `id:abc-123` isn't parseable with `new URL()`. Every consumer needs bespoke string manipulation.

### Desired State

A single URI format that works as both an inline content link and an OS deep link:

```markdown
[Meeting Notes](epicenter://opensidian/files/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b)
```

```typescript
const url = new URL('epicenter://opensidian/files/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b');
url.protocol  // 'epicenter:'
url.hostname  // 'opensidian'
url.pathname  // '/files/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b'
```

Tauri receives the same string via `onOpenUrl()` and routes to the correct workspace/entity.

## Research Findings

### How Other Apps Handle Content Links vs Deep Links

| App | Content links | Deep links | Unified? |
|---|---|---|---|
| Obsidian | `[[Page Name]]` (wikilinks) | `obsidian://open?vault=X&file=Y` | No: completely separate formats |
| Notion | Internal page refs | `https://notion.so/workspace/page-id` | Sort of: web URLs serve both (web-first) |
| Bear | `[[note title]]` | `bear://x-callback-url/open-note?id=X` | No |
| Spotify | N/A | `spotify:track:4iV5W9uY...` | N/A: colon-delimited URI, not URL |
| VS Code | N/A | `vscode://file/path:line:col` | N/A |

**Key finding**: Most apps separate content links from deep links. Notion is the exception, but it's web-first so `https://` naturally serves both. No local-first app was found that unifies them.

**Implication**: Unifying is novel for local-first, but the technical path is clear because Tauri's deep link handler receives raw URL strings with no format constraints.

### Tauri Deep Link Plugin

From Context7 + Tauri v2 docs:

**Registration**: declare scheme name in `tauri.conf.json`:

```json
{
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["epicenter"] }
    }
  }
}
```

**Handler**: receives raw URL strings:

```typescript
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';

const startUrls = await getCurrent();  // app launched via deep link
await onOpenUrl((urls) => {            // deep link while running
  console.log('deep link:', urls);
});
```

**Runtime registration** (dev without installing):

```rust
app.deep_link().register("epicenter")?;
```

**Platform constraints**:
- macOS: Works natively.
- Windows/Linux: Without single-instance plugin, OS spawns new instance with URL as CLI arg.
- The scheme name is all the OS matches on. Everything after `epicenter:` is passed through raw.

**Key finding**: Tauri imposes zero constraints on URI structure beyond the scheme name. `epicenter://anything/goes/here` is received as-is.

### Verbosity Is Hidden

The editor's `InternalLinkWidget` (CodeMirror `Decoration.replace`) already replaces the entire `[text](href)` with a styled clickable span showing only the display text. The href is invisible in the editor: users see "Meeting Notes" as an underlined clickable span, not the raw URI.

**Implication**: URI verbosity only matters in raw markdown view and git diffs. The 9-character increase (`id:abc` → `epicenter://ws/table/abc`) has near-zero UX impact.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| URI scheme name | `epicenter` | Matches the product name. Registered once in Tauri config. |
| Workspace as hostname | `epicenter://{workspace}/...` | `new URL()` parses hostname natively. Workspace IDs (`opensidian`, `epicenter.blog`) are valid hostnames. |
| Path structure | `/{table}/{id}` | Two segments. Table first, then entity ID. Clean pathname split. |
| Relative vs absolute | Always absolute | Every link carries full context. No relative resolution logic needed. Editor hides verbosity. Workspace IDs are permanent per README. |
| Deep link registration | Tauri `deep-link` plugin | Config-based, cross-platform, receives raw URL strings. |
| Old `id:` scheme | Remove entirely | Clean break. No backward compatibility layer. Migration rewrites existing content. |

## Architecture

### URI Format

```
epicenter://opensidian/files/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b
└─scheme──┘└workspace┘└table┘└──────────entity id──────────────────┘

Parsed via new URL():
  protocol = 'epicenter:'
  hostname = 'opensidian'
  pathname = '/files/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b'
```

### EntityRef Type

```typescript
type EntityRef = {
  workspace: string;
  table: string;
  id: string;
};
```

### Data Flow

```
User types [[                          Wikilink autocomplete fires
    │                                          │
    ▼                                          ▼
File picker shows matches              User selects "Meeting Notes"
                                               │
                                               ▼
                            makeEntityRef('opensidian', 'files', fileId)
                                               │
                                               ▼
                    Editor inserts [Meeting Notes](epicenter://opensidian/files/abc-123)
                                               │
                                               ▼
                    Link decoration replaces with clickable "Meeting Notes" span
                                               │
                                               ▼ (on click)
                    parseEntityRef(href) → { workspace: 'opensidian', table: 'files', id: 'abc-123' }
                                               │
                              ┌─────────────────┴─────────────────┐
                              ▼                                   ▼
                    Same workspace?                      Different workspace?
                    Navigate locally                     Cross-workspace handler
                                                         (future: open other app)
```

### Markdown Export/Import

```
Workspace content                    Markdown file on disk
epicenter://ws/table/id      →→→     [[Display Text]]        (export)
epicenter://ws/table/id      ←←←     [[Display Text]]        (import + resolve)
```

The wikilink conversion functions change their regex but keep the same structure. The resolve function for import now returns a full `epicenter://` URI instead of a bare `id:`.

## Code Audit Findings

Audit was performed by mentally inlining every helper and reading the result cold.

### Caller Map

```
FUNCTION                              REAL CALLERS (excl. tests/exports/JSDoc)
───────────────────────────────────────────────────────────────────────────────
isInternalLink                        1  link-decorations.ts
getTargetFileId                       1  link-decorations.ts
makeInternalHref                      1  wikilink-autocomplete.ts
convertInternalLinksToWikilinks       3  markdown.ts (×2), materializer.ts
convertWikilinksToInternalLinks       1  push-from-markdown.ts
```

### Stale Boundaries to Collapse

1. **`isInternalLink` + `getTargetFileId`**: 1 caller each, always used sequentially. Every call site does `if (!isInternalLink(href)) continue; const fileId = getTargetFileId(href);`. These are one concept split into two functions. Merge into `parseEntityRef(href): EntityRef | null`.

2. **Duplicated regex**: `INTERNAL_LINK_RE` exists in both `links.ts` and `link-decorations.ts` with different capture groups. One regex, one place.

3. **`makeInternalHref(fileId: FileId)`**: signature too narrow. New scheme needs workspace + table + id.

### Naming Renames

| Current | After | Reason |
|---|---|---|
| `isInternalLink` | Absorbed into `parseEntityRef` | Merged |
| `getTargetFileId` | Absorbed into `parseEntityRef` | Merged |
| `makeInternalHref` | `makeEntityRef` | Describes what it builds |
| `ID_SCHEME` | `EPICENTER_SCHEME` | Names the scheme |
| `INTERNAL_LINK_RE` | `ENTITY_REF_RE` | Consistent naming |
| `InternalLinkWidget` | `EntityRefWidget` | Not "internal" anymore |
| `LinkDecorationConfig.onNavigate(fileId)` | `onNavigate(ref: EntityRef)` | Richer type |

### Keep As-Is

- `isInsideCode()`: justified extraction, non-trivial syntax tree walk
- `InternalLinkWidget` class structure: CodeMirror WidgetType requires it
- `buildDecorations()`: complex scan loop, extraction earns its name
- `wikilinkCompletionSource()`: clean separation from CM wiring
- `convertInternalLinksToWikilinks` / `convertWikilinksToInternalLinks`: 3+ callers, real utility

### Questionable: `ignoreEvent()` Override

`InternalLinkWidget.ignoreEvent()` returns `false`. WidgetType's default returns `true` for most events. Returning `false` means the editor also processes click events (potentially moving the cursor). The widget's click handler already calls `preventDefault + stopPropagation`. This override is either accidental or redundant: investigate during implementation and remove if unnecessary.

## Implementation Plan

### Phase 1: Core URI Utilities

- [x] **1.1** Define `EntityRef` type in `packages/filesystem/src/links.ts`
- [x] **1.2** Replace `ID_SCHEME`, `isInternalLink`, `getTargetFileId`, `makeInternalHref` with `EPICENTER_SCHEME`, `parseEntityRef`, `makeEntityRef`
- [x] **1.3** Consolidate `INTERNAL_LINK_RE` → single `ENTITY_REF_RE` with both capture groups, exported
- [x] **1.4** Update `convertInternalLinksToWikilinks` regex to match `epicenter://` URIs
- [x] **1.5** Update `convertWikilinksToInternalLinks` to accept a resolver returning full `epicenter://` URIs
- [x] **1.6** Update `packages/filesystem/src/index.ts` barrel exports
- [x] **1.7** Update `links.test.ts`: all assertions use new format

### Phase 2: Editor Extensions (Opensidian)

- [x] **2.1** Update `link-decorations.ts`: import `parseEntityRef` and `ENTITY_REF_RE`, remove duplicated regex
- [x] **2.2** Rename `InternalLinkWidget` → `EntityRefWidget`, update `onNavigate` to take `EntityRef`
- [x] **2.3** Investigate and resolve `ignoreEvent()` override: removed, default WidgetType behavior is correct
- [x] **2.4** Update `wikilink-autocomplete.ts`: add `workspaceId` + `tableName` to config, use `makeEntityRef`
- [x] **2.5** Update Opensidian call sites that pass config to these extensions

### Phase 3: Markdown Materializer

- [x] **3.1** Update `packages/workspace/src/extensions/materializer/markdown/markdown.ts`: regex + conversion calls
- [x] **3.2** Update `playground/opensidian-e2e/materializer.ts` and `push-from-markdown.ts`

### Phase 4: Deep Link Handler (Future: Separate Spec)

- [ ] **4.1** Register `epicenter` scheme in Tauri `deep-link` plugin config
- [ ] **4.2** Add `onOpenUrl` handler that parses `epicenter://` URIs and routes to workspace/entity
- [ ] **4.3** Handle cross-workspace routing (open correct app/workspace)

## Edge Cases

### Workspace IDs with Dots

```
epicenter://epicenter.blog/posts/abc-123
```

`new URL()` parses `epicenter.blog` as the hostname. Dots are valid in hostnames. Works.

### Entity IDs with Special Characters

Entity IDs are UUIDs (`01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b`). Hyphens are URL-safe. No encoding needed. If future ID formats include URL-unsafe characters, `encodeURIComponent` / `decodeURIComponent` apply.

### Links to Non-Existent Workspaces

`parseEntityRef` returns the structured ref regardless. Resolution is the caller's responsibility. A link to `epicenter://whispering/recordings/xyz` in Opensidian renders as a clickable span; clicking it is a no-op (the handler checks `ref.workspace === currentWorkspaceId` and ignores non-matching workspaces). Cross-workspace navigation is a future concern.

### Markdown Files on Disk

Exported markdown uses wikilinks (`[[Page Name]]`), not the URI format. The URI only exists in workspace CRDT content. Markdown export/import round-trips through wikilink conversion, which is scheme-agnostic on the wikilink side.

## Resolved Decisions

All questions closed, no ambiguity remains:

1. **Migration**: Not needed: no production data exists. Clean break, no backward compatibility.
2. **Parsing**: `new URL()`: standard, correct, not a hot path.
3. **Cross-workspace clicks**: Same-workspace links navigate locally. Cross-workspace links are a no-op for now (handler checks `ref.workspace === currentWorkspaceId`).
4. **Table segment**: Always explicit. Opensidian already has `conversations` and `chatMessages` tables: linking to them is plausible.

## Success Criteria

- [x] All existing `id:` link tests pass with new `epicenter://` format (17 pass, 0 fail)
- [x] Wikilink autocomplete produces `epicenter://` URIs
- [x] Link decorations render clickable spans for `epicenter://` URIs
- [x] Markdown export converts `epicenter://` to wikilinks
- [x] Markdown import converts wikilinks to `epicenter://` URIs
- [x] `new URL()` successfully parses all generated URIs
- [x] No regressions in markdown materializer round-trip tests
- [x] Zero LSP errors across all 8 changed files

## References

- `packages/filesystem/src/links.ts`: Core link utilities (primary change target)
- `packages/filesystem/src/links.test.ts`: Link tests
- `packages/filesystem/src/index.ts`: Barrel exports
- `apps/opensidian/src/lib/components/editor/extensions/link-decorations.ts`: Editor widget
- `apps/opensidian/src/lib/components/editor/extensions/wikilink-autocomplete.ts`: `[[` autocomplete
- `packages/workspace/src/extensions/materializer/markdown/markdown.ts`: Markdown export
- `playground/opensidian-e2e/materializer.ts`: E2E materializer test
- `playground/opensidian-e2e/push-from-markdown.ts`: Markdown import
- `apps/api/src/app.ts:351-395`: DO naming (NOT changing, separate concern)

## Review

**Completed**: 2026-04-08

### Summary

Replaced the `id:` internal link scheme with `epicenter://` URIs across the entire link system. The change touched 8 files across 3 packages: core link utilities in `@epicenter/filesystem`, editor extensions in Opensidian, and the markdown materializer + playground scripts.

### Implementation Notes

- `isInternalLink` + `getTargetFileId` merged into single `parseEntityRef` (both had 1 real caller, always used sequentially)
- Duplicated regex between `links.ts` and `link-decorations.ts` consolidated into single exported `ENTITY_REF_RE`
- `InternalLinkWidget.ignoreEvent()` override removed: was returning `false` ("let editor process events too") but the click handler already calls `preventDefault + stopPropagation`, making it redundant
- `ContentEditor.svelte` passes `opensidianDefinition.id` as `workspaceId` to the wikilink autocomplete, so the workspace ID comes from the definition rather than a hardcoded string
- Resolver in `convertWikilinksToEntityRefs` now returns full `epicenter://` URIs rather than bare `FileId` values

### Deviations from Spec

None: all phases executed as planned.

### Follow-up Work

- Phase 4 (Tauri deep link handler registration) is deferred to a separate spec
- Cross-workspace click navigation (currently a no-op) needs UX design when multiple workspace support ships
