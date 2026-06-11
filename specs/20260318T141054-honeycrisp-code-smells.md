# Honeycrisp: Code Smell Fixes

## Goal

Fix 7 code smells: dual-personality components, over-coupled card, repetitive toolbar, nested ternaries, copy-paste sort dropdown. Update Svelte skill to prevent recurrence.

## Changes

### 1. NoteList: props instead of dual-source $derived
- Accept `notes: Note[]`, `title: string`, `showControls?: boolean`, `emptyMessage?: string`
- Parent (+page.svelte) does the view-mode branching, passes appropriate data
- Data-driven sort dropdown (array + {#each})
- Pass `isSelected` and `onSelect` to NoteCard

### 2. NoteCard: derive from note, drop viewState
- Derive `isDeleted` from `note.deletedAt !== undefined` instead of viewState
- Accept `isSelected: boolean` and `onSelect: () => void` props
- Remove viewState import entirely

### 3. +page.svelte: explicit view-mode branching
- `{#if viewState.isRecentlyDeletedView}` wraps NoteList with different props

### 4. Editor: snippets for toolbar, extract ternaries
- `toggleButton` snippet for inline format buttons
- `groupItem` snippet for ToggleGroup items
- Extract `activeHeading` and `activeListType` to $derived variables

### 5. Svelte skill: add 3 new patterns
- Prop-first data derivation
- View-mode branching limit
- Data-driven repetitive markup

## Todo

- [ ] NoteList: props + data-driven sort + pass isSelected/onSelect to NoteCard
- [ ] NoteCard: derive isDeleted from note, accept isSelected/onSelect props, drop viewState
- [ ] +page.svelte: view-mode branching for NoteList props
- [ ] Editor: snippets + extract ternaries
- [ ] Svelte skill: add 3 new pattern sections
- [ ] Verify diagnostics

## Review

_To be filled after completion._
