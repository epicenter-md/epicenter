# Commit-on-blur Survives Tab Close (with Six Lines of Svelte)

Most autosave UIs have the same problem. You wire `onblur` to commit, the user types something, then hits Cmd+W. The blur event never fires. The data is gone.

The usual fix is per-keystroke commits: write to your store on every `oninput`. That works, but for a YJS app it's expensive: every keystroke becomes a Y.Doc transaction, an IndexedDB write, a sync update over the wire, a BroadcastChannel post to other tabs. Typing "hello world" creates 11 of each.

Here's a better fix.

## The six lines

```svelte
<!-- +layout.svelte -->
<svelte:document onvisibilitychange={flushPendingEdits} />
<svelte:window onpagehide={flushPendingEdits} />
```

```ts
function flushPendingEdits() {
  if (
    document.visibilityState === 'hidden' &&
    document.activeElement instanceof HTMLElement
  ) {
    document.activeElement.blur();
  }
}
```

That's it. Every `<input onblur={...}>` in your app now survives Cmd+W, Cmd+Q, tab switch, browser minimize, and iOS app-switch. Because forcing `.blur()` on the focused element synchronously fires its blur event, which synchronously runs your commit handler.

Two special elements, not one: `visibilitychange` is a document event, `pagehide` is a window event. That's not a Svelte choice. It's how the DOM ships them, and Svelte's `packages/svelte/elements.d.ts` reflects it: `onvisibilitychange` lives on `SvelteDocumentAttributes`, `onpagehide` lives on `SvelteWindowAttributes`. Putting `onpagehide` on `<svelte:document>` typechecks loosely but won't fire reliably; keep them on the right element.

## Why this works

When the user closes a tab, the browser fires `visibilitychange` (state goes to `'hidden'`) before unloading the page. From that handler you have a small window of synchronous JavaScript. `document.activeElement.blur()` doesn't queue anything. It dispatches the blur event right then and there. Your `onblur` handler runs as part of the same call stack:

```
user hits Cmd+W
  ↓
visibilitychange fires
  ↓
document.activeElement.blur()  ← sync
  ↓
onblur dispatched              ← sync
  ↓
your commit handler runs       ← sync
  ↓
Y.Doc.transact updates state   ← sync
  ↓
✅ Y.Doc has the change in memory before the page is destroyed
```

The Page Lifecycle API guarantees `visibilitychange` fires before `pagehide` and `unload`. The MDN docs explicitly recommend it over `beforeunload` for save-state-on-exit because beforeunload is unreliable on mobile and inside iframes. We listen to `pagehide` too as a belt-and-suspenders for browsers that lag on visibilitychange (mainly older iOS Safari).

## What about the async stuff?

Y.Doc updates are synchronous, but everything that observes them is async:

- **y-indexeddb** queues an IDB write. Typically commits in 5-50ms. Browsers usually grant this much grace on graceful close.
- **attachSync** buffers a WebSocket send. Browsers may abort the connection before the buffer flushes.
- **BroadcastChannel** posts to other tabs. Effectively synchronous from the sender's view; other tabs receive on their next event loop tick.

So for a graceful Cmd+W, your local IDB usually catches the write. Other tabs always do. Server sync is the weakest link. But here's the thing: it doesn't matter for a local-first app. Next time the page launches, it hydrates from IDB (which has the change), reconnects to the sync server, and pushes any local-only updates. The data isn't lost; it's just waiting.

The only scenario where data is genuinely lost is force-quit (kill -9, OS panic, power loss) within the ~50ms window between Y.Doc update and IDB flush. No JavaScript pattern saves you from that. It's an OS-level concern.

## Why `<svelte:document>` and not `addEventListener`

You could write `document.addEventListener('visibilitychange', ...)` in a TS module instead. It works. But `<svelte:document>` is idiomatic Svelte 5 for the same reason `<svelte:window>` is idiomatic for keyboard listeners:

- Auto cleanup on layout teardown: no `$effect` + return-cleanup boilerplate
- SSR-safe: Svelte only attaches the listener in the browser
- Matches the rest of your event-handler style (`onclick={fn}` rather than `addEventListener('click', fn)`)
- Lives in the routing layer, where lifecycle concerns belong

For a one-off bare DOM event, `<svelte:document>` wins.

## What about `bind:value` and local state?

A more defensive variant of commit-on-blur uses local `$state` plus a focus flag:

```svelte
<script>
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
>
```

This protects against an edge case: while you're typing, some sibling field on the same row updates (e.g., another tab edits the timestamp), the parent re-renders, and `value={entry.title}` clobbers your in-progress typing.

In practice for personal apps, that edge case is rare. Two tabs editing the same row's title at the same time is uncommon. Sibling updates may or may not even retrigger the input depending on how your reactive layer hands rows to children. Reach for the local-state version only if the clobber actually shows up: until then, the simpler `value + onblur` form is fine, and it matches the style of inline event handlers everywhere else in your component.

If you want true conflict-free text editing across tabs, use **Y.Text bound through ProseMirror or CodeMirror** for that field. That's a different tool with a different cost. For plain string fields like title, subtitle, name: commit-on-blur with the safety net is the right fit.

## What you avoid

The commit-on-blur + visibilitychange pattern gives you per-edit-session granularity for free:

| | Per-keystroke | Commit-on-blur | Commit-on-blur + visibilitychange |
|---|---|---|---|
| Y.Doc transactions per typing session | N | 1 | 1 |
| Sync messages on the wire | N | 1 | 1 |
| Cmd+W mid-edit | last ~100ms maybe lost | **whole session lost** | last ~100ms maybe lost |
| Code complexity | inline `oninput` | inline `onblur` | inline `onblur` + 6 global lines |

You're paying six lines for the resilience. Same data-loss profile as per-keystroke. Same idiomatic call sites as if you ignored the problem.

## When it doesn't apply

The pattern is for **plain string fields persisted to a Y.Map row**. Specifically:

- Title, subtitle, name, label inputs: yes
- Forms that submit on blur or button click: yes
- Notes / bodies: use Y.Text with a CRDT-aware editor binding (y-prosemirror, y-codemirror); per-keystroke is the right model there
- Discrete selectors (radio, checkbox, datepicker): already discrete events, no continuous typing problem
- Search boxes that don't persist: irrelevant; no save needed

For text editors that need character-level CRDT merging, you don't want commit-on-blur. You want every keystroke to participate in operational transform. Use the right tool for the field.

## The takeaway

The default Svelte commit-on-blur pattern has a bug: Cmd+W skips your save. The fix is two special elements in your root layout: `<svelte:document onvisibilitychange>` and `<svelte:window onpagehide>`: calling `.blur()` on the focused element. Six lines. Synchronous all the way through to your Y.Doc update. No per-keystroke churn, no debounce timers, no local state buffer.

It's the kind of pattern you write once at the layout level and forget. Every `<input onblur>` in your app inherits the safety net.
