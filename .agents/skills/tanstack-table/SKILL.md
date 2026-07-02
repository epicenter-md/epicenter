---
name: tanstack-table
description: TanStack Table UI state patterns for @tanstack/svelte-table, @tanstack/table-core, createTable, ColumnDef, FlexRender, renderComponent, sorting, filtering, pagination, row identity, and @epicenter/ui/table composition. Use when building or reviewing Svelte data tables, not Epicenter workspace storage tables.
metadata:
  author: epicenter
  version: '1.0'
---

# TanStack Table

## Upstream Grounding

Grounding repos: `TanStack/table` for row models, controlled state, and Svelte rendering helpers; `sveltejs/svelte` for the component and reactivity model.

This skill is for UI table state. Use `workspace-api` for Epicenter CRDT table storage and migrations.

## Local API Baseline

Epicenter currently uses `@tanstack/svelte-table` with:

```typescript
import {
	createTable as createSvelteTable,
	FlexRender,
	renderComponent,
} from '@tanstack/svelte-table';
import type { ColumnDef } from '@tanstack/table-core';
```

## Table Construction Rules

- Always set `getRowId` for persisted or local-first rows. Do not rely on array index identity.
- Keep `data` referentially stable. Avoid creating a fresh array in the table options getter unless the table is intentionally rebuilt.
- Define columns with `satisfies ColumnDef<Row>[]`.
- Give accessor columns stable ids, especially when sorting, hiding, or persisted preferences are involved.
- Use `renderComponent` for reusable header and cell components.
- Include only row models the UI uses: core always, sorted/filter/pagination only when the surface needs them.

## Controlled State

- Control only state Epicenter owns externally, such as sorting, global filter, column visibility, row selection, or pagination.
- If an `onXChange` handler is present, the matching `state.get x()` must also be present.
- Keep state ownership in one component or handle. Do not split sorting, filters, and pagination across unrelated stores without a reason.

## Rendering

- TanStack Table owns row, column, and cell state. `@epicenter/ui/table` owns semantic table markup and styling.
- Render headers and cells with `FlexRender`.
- Key rows by `row.id` and cells by `cell.id`.
- Empty states stay in `epicenter-ui`: when row count is zero, render `Empty.Root` in the table body or surrounding panel.
- Add explicit keyboard behavior for clickable rows. A click handler alone is not a row interaction model.
- Use TanStack Virtual separately for large lists. Do not treat virtualization as a built-in table feature.
