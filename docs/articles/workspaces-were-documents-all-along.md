# Workspaces Were Documents All Along

> **Historical note (2026-07-12):** This article traces the earlier root-Y.Doc
> workspace architecture. The target workspace family composes a records
> database, stable synchronized KV, and format-addressed child documents as
> separate storage planes. See
> [Workspace data model](../reference/workspace-data-model.md).

I built the workspace API five times. Each version deleted more code than the last, until the fifth version put some of it back : for a reason the earlier versions hadn't earned the right to see yet. Here's how I got there.

## The first version felt great to call

Epicenter is a local-first workspace framework built on Yjs. When I first wrote the workspace API, I leaned on a pattern I already liked : a builder chain. Each capability was an extension, each extension added itself under a string key, and the types flowed through:

```ts
const client = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, loadToken }))
  .withActions((client) => ({
    entries: { create: defineMutation({ ... }) },
  }));
```

It reads well. You can scan it top to bottom and see what the app has. The API I was building felt polished the first time I ran it : I remember liking how the generics propagated so `client.extensions.sync.whenConnected` was typed correctly at the end of the chain. That felt like a win.

What I didn't see right away was how much of that polish depended on the builder knowing things the caller shouldn't have had to know. The sync extension had an implicit dependency on persistence being registered first. Actions got wired into the sync extension via a hidden `'sync'` key lookup so inbound RPC could reach them : I left a TODO comment apologizing for the string coupling. Every app had the same chain in the same order and everyone knew you didn't reorder it.

I kept using it for months before I admitted what it was. It felt like composition, but it was a script. You couldn't swap the order, you couldn't mix-and-match, and when I tried to use it in a CLI (no IndexedDB, no browser) I ended up writing a different chain that happened to have three of the four extensions and everything threaded together by a bunch of shared types.

A little too magical. Nice surface, load-bearing convention underneath.

## The second version was honest about the lifecycle

The rewrite came when I wanted to reuse the Y.Doc lifecycle for per-entry content documents (each entry has a rich-text field backed by its own Y.Doc). I sat down intending to add a `.withDocument()` sugar to `createWorkspace` and instead pulled the lifecycle out into a primitive called `defineDocument`. It's a refcounted cache keyed by id : the user owns construction, the cache owns identity and refcounts. Everything else got simpler around it.

Workspaces became a thin wrapper on top:

```ts
// workspace.ts
export const fuji = defineWorkspace({
  id: 'epicenter-fuji',
  tables: { entries: entriesTable },
});

// client.ts
const base = fuji.open('epicenter-fuji');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);
const sync = attachSync(base.ydoc, { url, loadToken, waitFor: idb.whenLoaded });

export const workspace = Object.assign(base, {
  idb, sync,
  actions: defineActions({ ... }),
  whenReady: idb.whenLoaded,
});
```

This felt so much better. No chain, no hidden init order, no `'sync'` key lookup. Apps wire what they want in whatever order makes sense. Tests skip persistence. Node skips IndexedDB. The CLI could finally write its own composition without fighting a builder that assumed a browser.

Yes, I lost something : extensions used to be able to sequentially build on each other, with each extension's factory receiving the previous ones typed in context. In the new world, attachments don't see each other through framework types; they see each other because they're `const idb` and `const sync` in the same closure. That's worse if you want a framework-enforced "this extension depends on that one" relationship. It's better if you want "look at the file and see what happens."

I shipped this and used it for a while. It was clearly the right shape for workspaces. Something still itched.

## The realization came from the content docs

The per-entry content documents : the thing that had driven the `defineDocument` extraction in the first place : looked like this:

```ts
export const entryContentDocs = defineDocument((entryId: EntryId) => {
  const ydoc = new Y.Doc({ guid: docGuid({ ... }), gc: false });
  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { ... });
  return {
    ydoc, content,
    whenReady: idb.whenLoaded,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});
```

One file, one closure, everything inline. Schema and transport living next to each other. No separation of "define" and "wire". Read it once and you know what the doc is, what it stores, how it persists, where it syncs.

I was reading `define-workspace.ts` one evening : the 33-line body of the wrapper : and realized it was doing the exact same thing. It called `new Y.Doc`, then a sequence of `attach*` functions, then returned a bundle. It was a closure. I just couldn't see it because it was hidden inside a factory that returned another factory.

Workspaces were documents. I'd been calling them something else for a year.

## Version three: delete the wrapper

The third rewrite was mechanical. Delete `defineWorkspace`. Have apps call `defineDocument` directly with whatever shape they want. Fuji's two files become one:

```ts
const fuji = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id, gc: false });

  const tables = attachTables(ydoc, { entries: entriesTable });
  const kv = attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});
  const enc = attachEncryption(ydoc, { tables, kv });

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => websocketUrl(`${APP_URLS.API}/workspaces/${docId}`),
    loadToken: async () => auth.token,
    waitFor: idb.whenReady,
    awareness: awareness.raw,
  });

  return {
    id, ydoc, tables: tables.helpers, kv: kv.helper, awareness, enc, idb, sync,
    actions: defineActions({ ... }),
    whenReady: idb.whenReady,
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed, enc.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}, { gcTime: Infinity });

export const workspace = fuji.open('epicenter-fuji');
```

No `Object.assign`. No separate definition file. The return object is the workspace : whatever components consume as `workspace.sync` or `workspace.tables` lives right there in the closure.

The thing I'd been worried about losing : extensions that see each other through framework types : turns out not to matter when you're writing the composition in one file. `sync` references `idb.whenReady` directly because they're both local variables in the same scope. TypeScript sees them. I see them. There's nothing to thread through.

## Version four: I deleted the framework's wrapper too

Six months after the v3 collapse I went looking at `defineDocument` itself. By then it had been renamed once or twice : `createDocumentFactory`, then back : and accumulated a cluster of friends. There was a `Document` structural type that said "what `factory.open()` returns." There was a `DocumentHandle<T>` brand stamped on every value the cache emitted. There was an `iterateActions` walker that knew how to descend through a `DocumentHandle` looking for callable actions. There was an `ActionIndex` that flattened the result into a string-keyed map for the CLI. And there was a `DOCUMENT_HANDLE` symbol being checked in three places.

I sat down to write a short doc explaining what each piece was for and noticed the explanations all started with "this exists because the other one needs it." The brand existed so the iterator could recognize a handle. The iterator existed so the index could be built. The index existed because actions could be anywhere on the bundle and the CLI didn't know where to look. The structural type existed to give the iterator something to descend into. They were holding each other up.

Underneath all of it was a refcounted cache with a five-second grace timer for teardown. That part was real. Multiple components mounting the same entry-content doc need to share one Y.Doc; clicking entry → entry → back-to-entry shouldn't thrash IndexedDB. That problem is genuinely hard and I wasn't going to write it twice.

So I stripped the cache to its honest contract and renamed the file:

```ts
export function createDisposableCache<
  Id extends string | number,
  T extends Disposable,
>(
  build: (id: Id) => T,
  opts?: { gcTime?: number },
): DisposableCache<Id, T>;
```

`T extends Disposable`. That's the whole constraint. Y.Docs satisfy it. Audio decoders satisfy it. Tauri webview handles satisfy it. The cache doesn't know or care which one it's holding.

The `Document` type went. The `DocumentHandle` brand went. `iterateActions` got inlined into its one remaining caller (the AI tool bridge). `ActionIndex` got replaced by `actions[path]` : which was always the actual operation; the index was caching a lookup that didn't need caching. The CLI loader stopped wrapping every workspace in an `entry.handle` envelope and just returned the workspace export directly.

About six hundred lines of net deletion. The remaining ~150 lines do the same thing the original five hundred did, with no friends.

## Version five: I un-deleted my wrapper

The v3 article ended on "delete the wrapper." Smug little ending. Then I built one more app, then a second non-browser consumer needed to construct the doc for codegen, then a Tauri target appeared, then the build-config reached into a workspace to derive route types : and every one of those imports dragged the whole browser binding with it. `y-indexeddb` references `indexedDB` at module scope. `BroadcastChannel` is a global. The Node config blew up on import.

I tried for a few hours to fix this with surgical exports : a "headless" entry, a "browser" entry, conditional re-exports. It got worse with every attempt because the workspace's identity (its Y.Doc, its schema, its encryption, its tables) lived at the same module-scope statements as its bindings (idb, broadcast channel, sync, auth). They couldn't be split because they were the same statements.

The fix was structural. Three files per app:

```
apps/fuji/src/lib/fuji/
├── index.ts       ← isomorphic doc factory   (open<App>())
├── browser.ts     ← env factory              (open<App>({ auth }))
└── client.ts      ← singleton + auth + lifecycle
```

`index.ts` is pure construction : `new Y.Doc`, encryption, tables, kv. No IndexedDB, no WebSocket, no `chrome.*`, no `node:*`. Anyone : Node, browser, test, codegen : can import it.

`browser.ts` (or `tauri.ts`, `extension.ts`) takes the iso doc and adds the env-bound attachments. `attachIndexedDb`, `attachBroadcastChannel`, `attachSync`. Takes injected dependencies (like `{ auth }`) so it stays a pure factory with no side effects.

`client.ts` is the only file with side effects. It calls `createAuth`, instantiates the singleton, wires `onSessionChange`, registers HMR teardown. Browser apps import the singleton from here.

`openFuji()` came back. Not as encapsulation : there's no encapsulation; the body is plain `attach*` calls in sequence. As a *seam*. The function exists so the caller can choose when and where construction happens, separately from when and where bindings happen, separately from when and where the singleton happens.

If you'd asked me at v3 whether I'd put the wrapper back I would have argued the case for keeping it deleted. "It's called exactly once." "Singleton enforced by module loading." "The module IS the workspace." All true at the time, all wrong as soon as a second consumer existed.

## What I learned about pulling the trigger

Each rewrite came from a moment where I noticed the code was lying to me about what it was.

For v1, the lie was "this is composition" when it was a script with a string-keyed registry. I sat with that one for months before I pulled the trigger, and I only did when the CLI refused to fit. An abstraction that works for one consumer and breaks for the second one is usually not an abstraction : it's the first consumer's code with `export` slapped on it.

For v2, there wasn't really a lie; the split into "define schema" + "attach lifecycle" was honest. What I missed was that I'd already written the merged version for content docs and hadn't noticed. Content docs were the counter-evidence. Having the same team write the same pattern two different ways is a smell, even when both ways are technically fine.

For v3, the trigger was reading my own code. The body of `defineWorkspace` was 33 lines of `new Y.Doc` + attach calls + return bundle. That's what content-doc factories were already doing. I'd built a function to save the caller from writing code that the caller was already writing, somewhere else, with a different name.

Deleting the wrapper also surfaced a few latent issues that had been quiet the whole time : a reentrance bug where calling `attachTable` twice silently gave you two out-of-sync wrappers, an encryption store array that was easy to accidentally leave incomplete, and a lifecycle promise vocabulary where every primitive picked its own noun (`whenLoaded` vs `whenConnected` vs `whenReady`). None of those were caused by the wrapper. The wrapper was just composing everything correctly behind the curtain so no one had to notice. Fixing them was worth doing anyway.

For v4, the trigger was writing the docstring. When every type's purpose is "the other type needs it," none of them are doing real work. They were a mutually-supporting structure built around one genuinely useful piece : the refcount cache : that I'd surrounded with framing because I thought a cache for "Y.Docs in particular" was different from a cache for "anything Disposable." It wasn't. The framing was costing me the right to use the cache for the next thing I actually wanted to share.

For v5, the trigger was the second consumer. v3's "delete the wrapper" rested on "called exactly once" : which was a true claim about the system at v3. The moment a Node tool needed to import the workspace without dragging in IndexedDB, "called exactly once" became "called from two places, one of which can't tolerate the other's imports." The same lines of code that were unused encapsulation in v3 were load-bearing seams in v5. I hadn't been wrong at v3. The system had grown past the test I'd used.

## Abstractions earn their keep or they don't

The version-three cost was real: about 40 lines per app instead of 30. The version-five cost is two extra files per app on top of that. More ceremony at the call site, less in the framework. That feels like a regression until you look at what the extra lines are doing : they're either the thing the abstraction was going to do for you, now written where you can see it, or the thing the abstraction was preventing you from doing, now possible because the seam exists.

I don't think every framework should collapse like this, and I don't think every collapse should be re-expanded later. An abstraction that hides a hard problem earns its weight : `createDisposableCache` earns its weight because the refcounted cache with grace-period teardown is genuinely hard, and now it earns it for resources that aren't even Y.Docs. `defineWorkspace` didn't earn its weight because it was wrapping a sequence of function calls with no logic of its own. `openFuji()` didn't earn its weight at v3 : and then earned it at v5 because a second consumer appeared and the wrapper was the only place to put the seam.

A thing I had to keep asking myself across all five versions was whether the next layer was adding semantics or just naming conventions. `createDisposableCache` adds semantics : lifetime, identity, invariants. `defineWorkspace` added a name. The iso/env/client split adds semantics too: it draws a line between "things that can run anywhere" and "things bound to this binding," and that line keeps a Node config out of `y-indexeddb`'s import graph. The line is the abstraction; the function name is just the syntax that lets the caller cross it intentionally.

The honest test isn't "is this called more than once?" It's "would removing this make a forbidden import possible?" By that test, `defineWorkspace` failed and got deleted. By that test, `openFuji()` failed at v3 and got deleted, then passed at v5 and came back. The test changes as the system grows. The wrapper that was unused encapsulation last quarter is the seam that prevents bundle bleed this quarter. Counting callers is the wrong measure.

The full migration spans several specs on the `drop-document-factory` branch : `20260424T180000-drop-document-factory-attach-everything.md` is the v4 reasoning, `20260425T225350-app-workspace-folder-env-split.md` is the v5 reasoning, and the iso/env/client convention is codified at `.claude/skills/workspace-app-composition/SKILL.md`.
