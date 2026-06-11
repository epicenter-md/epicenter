# Shallow Reactive State Over Deep Models

I tried to build a single `$state` object that mirrored my entire data model. Tables, rows, cells, the works. The plan was elegant: one source of Svelte state, surgically updated by multiple Yjs observers. A singleton for the single-page app.

It was a nightmare.

## The Temptation

When you have a data structure like this:

```typescript
// The underlying Yjs structure
workspace.tables.posts.rows['row-1'].cells['title']
workspace.tables.posts.rows['row-1'].cells['published']
workspace.tables.posts.rows['row-2'].cells['title']
// ... hundreds more
```

The instinct is to create a matching `$state`:

```typescript
let workspace = $state({
  tables: {
    posts: {
      rows: {
        'row-1': { title: 'Hello', published: false },
        'row-2': { title: 'World', published: true },
      }
    }
  }
});
```

Then you'd wire up observers at each level. Table observer, row observer, cell observer. Each surgically updating its slice of this giant state tree.

## Why It Falls Apart

The problem isn't performance. Svelte's fine-grained reactivity handles deep nested objects well. The problem is **coordination complexity**.

When you have 20 observers all mutating different parts of one state tree:
- Observer lifecycle becomes tangled (which observers exist when?)
- Partial updates create inconsistent intermediate states
- Error boundaries are unclear (one observer fails, what happens to the rest?)
- Testing requires mocking the entire tree
- You're constantly thinking about the whole model, not the piece you're rendering

I spent more time managing observer coordination than building features.

## The Realization

TanStack Query figured this out years ago. You don't create one giant cache and surgically update it. You call `createQuery` in each component that needs data. The query is scoped to that component's lifecycle. When the component unmounts, the query cleans up.

The same principle applies to reactive state over external sources:

**Scope your `$state` to the UI that needs it, not the data model it represents.**

## The Pattern

Instead of one giant state tree, create small, shallow state objects where they're consumed:

```typescript
// cell-editor.svelte.ts
export function reactiveCellValue(cell: Cell) {
  let value = $state(cell.get());

  const subscribe = createSubscriber((update) => {
    return cell.observe(() => {
      value = cell.get();
      update();
    });
  });

  return {
    get value() {
      subscribe();
      return value;
    },
    set(newValue: string) {
      cell.set(newValue); // Mutate the source, not $state
    }
  };
}
```

```svelte
<!-- CellEditor.svelte -->
<script lang="ts">
  const { cell } = $props();
  const reactiveCell = reactiveCellValue(cell);
</script>

<input bind:value={reactiveCell.value} oninput={(e) => reactiveCell.set(e.target.value)} />
```

Each cell editor creates its own tiny reactive wrapper. When the cell editor unmounts, `createSubscriber` cleans up the observer. No coordination. No thinking about the rest of the table.

## The Mental Model

Think of it like this:

| Approach | Analogy |
|----------|---------|
| One giant `$state` tree | One database connection shared everywhere, manually managing transactions |
| Scoped `$state` per component | Each component opens a cursor to exactly what it needs |

The scoped approach means:
- **State is shallow**: Just the cell value, not the cell within a row within a table
- **Subscriptions are lightweight**: One observer per rendered piece of UI
- **Problems are isolated**: A bug in the cell editor doesn't corrupt the row state
- **Lifecycle is automatic**: Component mounts → state created. Component unmounts → observer cleaned up.

## When You Need Multiple Values

Sometimes a component needs a few related values. Keep them together, but still scoped:

```typescript
// row-summary.svelte.ts
export function reactiveRowSummary(row: Row) {
  let title = $state(row.get('title'));
  let published = $state(row.get('published'));

  const subscribe = createSubscriber((update) => {
    return row.observe(() => {
      title = row.get('title');
      published = row.get('published');
      update();
    });
  });

  return {
    get title() { subscribe(); return title; },
    get published() { subscribe(); return published; },
  };
}
```

Still shallow. Still scoped. The row summary component doesn't know or care about other rows.

## What About Shared State?

If multiple components need the same reactive value, lift the reactive wrapper to their common ancestor and pass it down via props or context. Don't try to deduplicate at the data layer. Let Svelte's component tree handle sharing.

```svelte
<!-- TableView.svelte -->
<script lang="ts">
  const { table } = $props();

  // One reactive wrapper, shared by children
  const reactiveRowIds = reactiveTableRowIds(table);
</script>

{#each reactiveRowIds.value as rowId}
  <RowEditor row={table.getRow(rowId)} />
{/each}
```

The `RowEditor` creates its own scoped state for the row it's editing. The parent just manages which rows exist.

## The Tradeoff

This approach means you might have many small `$state` objects instead of one big one. That's fine. Svelte handles this efficiently, and the simplicity gains outweigh any micro-overhead.

The real cost of the "one giant state" approach isn't performance. It's the mental overhead of coordinating mutations across a shared mutable tree. That complexity compounds. Small, scoped state stays simple.

## Key Takeaways

1. **Scope state to UI, not data model**: Create reactive wrappers where they're consumed
2. **Keep state shallow**: A cell editor needs cell state, not table→row→cell state
3. **Let component lifecycle manage observer lifecycle**: `createSubscriber` handles cleanup
4. **Mutations go to the source**: Never mutate `$state` directly; update the underlying Yjs/external store
5. **Share by lifting, not by globalizing**: If components need the same state, lift the wrapper to their ancestor

The pattern mirrors TanStack Query's insight: don't build one cache and surgically update it. Build many small queries scoped to the components that need them. Same principle, applied to reactive state over external sources.
