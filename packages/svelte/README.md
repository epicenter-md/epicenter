# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package provides utilities that help synchronize Svelte state with external data sources like local storage, remote APIs, or other browser APIs. These utilities handle the complexity of keeping state in sync across multiple sources while maintaining Svelte's reactive paradigm.

## Installation

This package is part of the Epicenter monorepo and is used internally. To use it in your app:

```json
{
  "dependencies": {
    "@epicenter/svelte": "workspace:*"
  }
}
```

## Available Utilities

### `fromData`

Adapts one opened `@epicenter/data` handle into Svelte reactivity, mirroring
the declaration: `tables.<name>`, `kv`, and `persistence`, with the same verbs
and the same types. Reads are reactive; writes pass through unchanged.

A table is HELD as a `SvelteMap` projection keyed by row id, seeded when
`fromData` is called and patched with the row ids each commit names, because
building a row out of CRDT structs costs about two microseconds and rebuilding
ten thousand of them per keystroke does not. `kv` and `persistence` stay
read-through: ten keys and one enum are not worth holding.

Nothing is disposed by hand. The projection and its subscription live as long
as the document they mirror, deliberately: one detached from its source stays
alive and stops being true.

```ts
const app = fromData(data);
const active = $derived(app.tables.notes.rows.filter((n) => !n.deletedAt));
const note = app.tables.notes.get(id);   // wakes only when THAT row moves
app.persistence.get() === 'blocked';     // this device stopped saving
```

### `fromEpicenter`

Mirrors one `@epicenter/app` handle's data session into a rune, on one member,
`state`: `closed`, `opening`, `ready` (carrying the data), and `failed`
(carrying the error and the erase). One property rather than a `status` beside
a `data`, because TypeScript narrows a union and cannot correlate two
properties: flat, `data` would be optional at every read. The store is a field
on the `ready` variant, so a read before it is open does not compile.

The core session owns the state machine; this subscribes to it and runs
`fromData` once, when a store first becomes readable. There is no second
lifecycle here and no second answer to what the session is doing.

Constructing it acquires nothing: it reads one state and subscribes, so it
belongs at module scope, which is one call site by construction. What acquires
is `open`, which comes across untouched and an application calls from its root
after authentication is ready.

Signed-out is not a state here. It never was a fact about the session: it was a
latched read of `account.state` that this wrapper performed because reading
`data` would otherwise open into `Unaddressable`. With opening explicit, an
application that has not authenticated has not called `open`, and the session is
`closed`, which is exactly true. The gate belongs to the application, which is
where the auth client already is.

`eraseReplica` is forwarded like every other verb. It closes the session before
it erases, so it succeeds from every state, which is what lets an account
surface offer it while the store is open.

`close` and `onStateChange` do not come across. The close stays with the module
local that built the handle, which is the one place a hot reload can reach and
no route can; the raw subscription is consumed here rather than offered as a
second way to watch what the rune already reports.

The handle is taken structurally, the way `fromData` takes opened data, so this
package does not depend on `@epicenter/app`.

```ts
// apps/<app>/src/lib/epicenter.svelte.ts, one file for every build
import { createEpicenter } from '@epicenter/app';
import { fromEpicenter } from '@epicenter/svelte';

export const notes = fromEpicenter(
	createEpicenter({ appId, definition, account: auth, binding }),
);
```

```svelte
<script>
  // The application root, once auth is ready.
  if (auth.state.status !== 'signed-out') void notes.open();
</script>

{#if auth.state.status === 'signed-out'}
  <SignInScreen {auth} appName="Honeycrisp" noun="notes" />
{:else if notes.state.status === 'ready'}
  <Notes data={notes.state.data} />
{:else if notes.state.status === 'failed'}
  <!-- `@epicenter/app-shell/boot-screens`. It takes the two words that are
       this application's; the sentence and the repair are `openFailure`'s. -->
  <CannotOpenScreen
    appName="Honeycrisp"
    noun="notes"
    error={notes.state.error}
    retry={() => void notes.open()}
  />
{:else}
  <Loading />
{/if}
```

### `fromSubscription`

One value read through a subscription, kept fresh. The four lines every
adapter in this repo used to write by hand, written once, so the announce
cannot be forgotten: forget it and the value stays correct and never updates
again.

```ts
const preview = fromSubscription(
  (update) => table.watch(body, update),
  () => notePreview(body),
);
preview.current;
```

### `createPersistedState`

Creates a persisted state object tied to local storage, accessible through `.value`. This utility ensures your state survives page refreshes and synchronizes across browser tabs.

#### Features

- **Synchronous initialization**: Immediate access to a valid value
- **Automatic validation**: Uses the provided schema to validate stored data
- **Cross-tab synchronization**: Syncs state across browser tabs via storage events
- **Graceful error recovery**: Falls back to defaults via `onParseError` handler
- **Type-safe**: Full TypeScript support with inferred types

#### Usage

```typescript
import { createPersistedState } from '@epicenter/svelte';
import { z } from 'zod';

// Define your schema
const settingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  notifications: z.boolean()
});

// Create persisted state
const settings = createPersistedState({
  key: 'app-settings',
  schema: settingsSchema,
  onParseError: (error) => {
    // Handle different error types
    if (error.type === 'storage_empty') {
      return { theme: 'light', notifications: true }; // default value
    }
    console.error('Settings parse error:', error);
    return { theme: 'light', notifications: true }; // fallback value
  }
});

// Use in component
$effect(() => {
  console.log('Current theme:', settings.value.theme);
});

// Update settings
settings.value = { theme: 'dark', notifications: false };
```

**Note:** For production use, consider wrapping the persisted state in an encapsulated pattern with controlled access methods. See [Encapsulated State Pattern](../../docs/patterns/encapsulated-state-pattern.md) for best practices.

#### API

```typescript
createPersistedState<TSchema extends StandardSchemaV1>(options: {
  key: string;
  schema: TSchema;
  onParseError: (error: ParseErrorReason<TSchema>) => StandardSchemaV1.InferOutput<TSchema>;
  onUpdateSuccess?: (newValue: StandardSchemaV1.InferOutput<TSchema>) => void;
  onUpdateError?: (error: unknown) => void;
  onUpdateSettled?: () => void;
})
```

#### Parameters

- **`key`**: The key used to store the value in local storage
- **`schema`**: A Standard Schema v1 compatible schema for validation
- **`onParseError`**: Handler called when the value from storage cannot be parsed or validated. Must return a valid default value.
- **`onUpdateSuccess`** (optional): Called when the value is successfully written to storage
- **`onUpdateError`** (optional): Called when writing to storage fails
- **`onUpdateSettled`** (optional): Called after update attempt completes (success or failure)

#### Error Types

The `onParseError` handler receives one of these error types:

- **`storage_empty`**: No value found in storage for the given key
- **`json_parse_error`**: Failed to parse the stored JSON string
- **`schema_validation_async_during_sync`**: Schema validation returned a Promise during synchronous parsing
- **`schema_validation_failed`**: Schema validation failed with specific issues

#### Example: Persisting Table State

```typescript
// Persist table sorting state
const sorting = createPersistedState({
  key: 'data-table-sorting',
  schema: z.array(z.object({
    id: z.string(),
    desc: z.boolean()
  })),
  onParseError: () => [{ id: 'created_at', desc: true }] // default sort
});

// Persist row selection
const rowSelection = createPersistedState({
  key: 'data-table-selection',
  schema: z.record(z.boolean()),
  onParseError: () => ({}) // no selection by default
});
```

## Contributing

When adding new utilities to this package:

1. Add the utility file to `src/`
2. Export it from `src/index.ts`
3. Update this README with documentation
4. Add type tests if applicable

## Dependencies

This package depends on:

- `svelte`: For reactive state primitives
- `@standard-schema/spec`: For schema validation types
- `wellcrafted`: For error handling utilities
