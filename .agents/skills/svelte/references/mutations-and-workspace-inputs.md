# Svelte Mutations And Workspace Inputs

Detailed Svelte guidance for TanStack Query mutation placement, inline template actions, and commit-on-blur workspace field editing.

# Mutation Patterns

## Core Rule

In `.svelte` files, use `createMutation` for user-triggered async operations when the template observes operation lifecycle state: disabled controls, loading text, spinners, success handling, or error handling.

`createMutation` is the component operation lifecycle primitive. It is not reserved for cache invalidation, retry policy, or shared mutation keys.

Use `defineMutation` in `$lib/rpc` when the operation has shared query-layer identity: multiple consumers, cache invalidation, optimistic updates, `useIsMutating`, or a reusable RPC boundary. For a one-off Result-returning component action, keep the operation as a plain function in `$lib/operations`, `$lib/services`, or a focused module, then wrap it locally with `createMutation(() => mutationOptions({ mutationKey, mutationFn }))`.

Use direct `await` when no template lifecycle state is observed, when the code runs outside component context, or when a sequential workflow would become harder to read as mutation callbacks. Shared Wellcrafted mutations are callable, so imperative RPC mutation usage is `await rpc.thing(input)`.

## Async Button Pattern

Pass `onSuccess` and `onError` as the second argument to `.mutate()` so the callback stays next to the UI action that needs it:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import * as rpc from '$lib/query';

	const deleteSession = createMutation(
		() => rpc.sessions.deleteSession.options,
	);

	// Local state that we can access in callbacks
	let isDialogOpen = $state(false);
</script>

<Button
	onclick={() => {
		deleteSession.mutate(
			{ sessionId },
			{
				onSuccess: () => {
					// Access local state and context
					isDialogOpen = false;
					toast.success('Session deleted');
					goto('/sessions');
				},
				onError: (error) => {
					toast.error(error.title, { description: error.description });
				},
			},
		);
	}}
	disabled={deleteSession.isPending}
>
	{#if deleteSession.isPending}
		Deleting...
	{:else}
		Delete
	{/if}
</Button>
```

Name the mutation after the user action, not with a `Mutation` suffix. The suffix repeats the type and makes templates noisier.

For component-local operation lifecycle, wrap the function locally:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import { exportRecordingsMarkdown } from '$lib/recording-markdown-export';
	import { report } from '$lib/report';

	const exportMarkdown = createMutation(() =>
		mutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: exportRecordingsMarkdown,
		}),
	);
</script>

<Button
	onclick={() => {
		exportMarkdown.mutate(undefined, {
			onSuccess: (data) => {
				if (data.status === 'cancelled') return;

				report.success({
					title: 'Recording markdown exported',
					description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
				});
			},
			onError: (error) => {
				report.error({
					title: 'Recording markdown export failed',
					cause: error,
				});
			},
		});
	}}
	disabled={exportMarkdown.isPending}
>
	{exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
</Button>
```

Do not create an RPC adapter only to get `isPending` for one component. Local `createMutation` gives the component a standard pending/error/success surface without pretending the operation is shared query-layer state.

## Whispering RPC Pattern

Read this section when editing Whispering components that use shared RPC
adapters or component-local operation lifecycles.

Whispering components consume shared RPC adapters through `.options` inside an
accessor:

```svelte
<script lang="ts">
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/rpc';

	const playbackUrl = createQuery(() =>
		rpc.audio.getPlaybackUrl(() => recordingId).options,
	);

	const transformRecording = createMutation(
		() => rpc.transformer.transformRecording.options,
	);
</script>
```

For a component-local operation lifecycle, do not add a new RPC adapter only to
observe `isPending`. Wrap the operation locally:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import { startManualRecording } from '$lib/operations/recording';

	const startRecording = createMutation(() =>
		mutationOptions({
			mutationKey: ['recording', 'startManual'],
			mutationFn: startManualRecording,
		}),
	);
</script>
```

Whispering error presentation goes through `$lib/report` at the UI or operation
boundary:

```typescript
if (error) {
	report.error({ cause: error });
	return;
}
```

## Direct Await Pattern

In `.ts` files, use direct `await` because `createMutation` requires component context. For shared Wellcrafted mutations, call the mutation definition directly:

```typescript
// In a .ts file (e.g., load function, utility)
const result = await rpc.sessions.createSession({
	body: { title: 'New Session' },
});

const { data, error } = result;
if (error) {
	// Handle error
} else if (data) {
	// Handle success
}
```

In `.svelte` files, direct `await` is still appropriate when the template does not read pending, success, or error state:

```svelte
<Button
	onclick={async () => {
		await navigator.clipboard.writeText(value);
	}}
>
	Copy
</Button>
```

If the next edit adds `disabled={isCopying}`, a spinner, loading text, or toast lifecycle, promote the action to `createMutation` instead of adding a one-off `$state` pending flag.

For when a single-use handler should be inlined at its call site versus kept as a named function, see "Single-Use Functions And Aliases" in [component and UI patterns](component-ui-patterns.md).

# Commit-on-Blur for Workspace String Fields

For plain string fields backed by a workspace table or Y.Map row (title, subtitle, name, description, license, label), **commit on `onblur`, not `oninput`**. Per-keystroke writes turn one typing session into N Yjs transactions, N IDB writes, N sync messages, and N BroadcastChannel posts. Commit-on-blur collapses that to one.

The pattern has two halves: the **per-input handler** and the **app-wide safety net**. Both are required: the safety net is what makes commit-on-blur survive Cmd+W mid-edit.

## The handler

```svelte
<input
  type="text"
  value={entry.title}
  onblur={(e) => {
    const next = e.currentTarget.value;
    if (next !== entry.title) updateEntry({ title: next });
  }}
/>
```

The compare-then-write guard avoids a no-op Yjs transaction when focus passes through an unchanged field. For factories that update many fields, extract a small `commit(field, next)` helper that does the compare internally.

## The safety net (app-wide, in `+layout.svelte`)

```svelte
<script lang="ts">
  function flushPendingEdits() {
    if (
      document.visibilityState === 'hidden' &&
      document.activeElement instanceof HTMLElement
    ) {
      document.activeElement.blur();
    }
  }
</script>

<svelte:document onvisibilitychange={flushPendingEdits} />
<svelte:window onpagehide={flushPendingEdits} />
```

When the page is being hidden (tab close, Cmd+W, tab switch, window minimize, iOS app-switch, bfcache), `.blur()` on the focused element synchronously dispatches its blur event, which synchronously runs your commit handler, which synchronously updates the Y.Doc: all before the page tears down. Six lines, one place, every `<input onblur>` in the app inherits the resilience.

`visibilitychange` is a document event, `pagehide` is a window event. Per Svelte's `packages/svelte/elements.d.ts`, `onvisibilitychange` lives on `SvelteDocumentAttributes` and `onpagehide` lives on `SvelteWindowAttributes`: keep them on the right element. Listen to both: visibilitychange is more reliable on iOS Safari, pagehide catches bfcache navigations.

## The default for new apps

Every new app under `apps/*` should ship the safety net in `+layout.svelte` as part of scaffolding. Treat it like `<Toaster />` or `<ModeWatcher />`: a layout-level concern that's free once installed. See `workspace-app-composition` for where this fits in the `+layout.svelte` checklist.

## When NOT to use commit-on-blur

| Field type | Pattern |
|---|---|
| Plain string Y.Map field (title, subtitle, name, description, license) | **commit-on-blur** |
| Y.Text bound through y-prosemirror / y-codemirror / tiptap | per-keystroke (CRDT operates at character level) |
| Discrete selectors (radio, checkbox, datepicker, tag pickers) | inline event handler: already one event per action |
| Search box / filter that doesn't persist | local `$state` only, no commit |
| Component-local form state submitted on a button click | accumulate in `$state`, commit in the click handler |

For Y.Text fields you specifically want every keystroke to participate in operational transform: commit-on-blur defeats the point of the CRDT.

## Defensive variant: local state + focus flag

If a sibling tab editing the same row could clobber in-progress typing (rare in personal apps), reach for a local-state buffer with a focus flag: but only if the clobber actually shows up:

```svelte
<script lang="ts">
  let localTitle = $state(entry.title);
  let editing = $state(false);
  $effect(() => { if (!editing) localTitle = entry.title; });
</script>

<input
  bind:value={localTitle}
  onfocus={() => (editing = true)}
  onblur={() => {
    editing = false;
    if (localTitle !== entry.title) commit(localTitle);
  }}
/>
```

For true conflict-free text editing across tabs, switch the field to Y.Text + a CRDT-aware editor binding instead.

See `docs/articles/commit-on-blur-survives-tab-close.md` for the full rationale, persistence-layer reliability table, and the page-lifecycle guarantees behind the safety net.
